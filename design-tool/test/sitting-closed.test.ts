// Close session ends the sitting (docs/close-session-ends-attempts-design.md,
// D-1…D-3): once a sitting is closed or expired, the student plane refuses
// every write from its attempts with 409 `sitting_closed` — and refuses it
// without the deadline's grace. The attempt itself is untouched: still
// in_progress, still resumable through a later sitting, still the teacher's to
// hand in.
//
// Same harness as attempt-deadline.test.ts (a real student principal against
// the test DB, routes driven in process).
import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { closeDb, getDb } from "../db/client";
import {
  assessments,
  attempt_events,
  attempts,
  items,
  response_uploads,
  responses,
  students,
  test_sessions,
} from "../db/schema";
import { SESSION_COOKIE_NAME } from "../lib/auth/session";
import * as sessionMod from "../lib/auth/session";
import {
  STUDENT,
  TEACHER_EMAIL,
  clearRoster,
  seedRoster,
  staffPrincipal,
  studentPrincipal,
} from "./helpers/roster";

const expectTestDb = () => {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.includes("secure_test_design_tool_test")) {
    throw new Error(`sitting-closed tests require the test DB; got: ${url}`);
  }
};

const OWNER = "closed-sitting-teacher";
type Principal = { sub: string; role: string; email?: string } | null;
let principal: Principal = studentPrincipal();

mock.module("next/headers", () => ({
  headers: async () => new Headers(),
  cookies: async () => ({
    get: (name: string) =>
      principal && name === SESSION_COOKIE_NAME ? { value: "x" } : undefined,
  }),
}));

mock.module("../lib/auth/session", () => ({
  ...sessionMod,
  readSessionFromCookies: async () => principal,
}));

let originalSecret: string | undefined;
let originalStorageRoot: string | undefined;

beforeAll(async () => {
  expectTestDb();
  await seedRoster();
  originalSecret = process.env.DESIGN_TOOL_SESSION_SECRET;
  process.env.DESIGN_TOOL_SESSION_SECRET ||= "sitting-closed-test-secret-do-not-use";
  originalStorageRoot = process.env.STORAGE_LOCAL_ROOT;
  process.env.STORAGE_LOCAL_ROOT = "./storage-test";
});

afterEach(async () => {
  principal = studentPrincipal();
  const db = getDb();
  await db.execute(sql`truncate table assessments restart identity cascade`);
  await db.execute(sql`truncate table students restart identity cascade`);
});

afterAll(async () => {
  await clearRoster();
  await closeDb();
  if (originalSecret === undefined) delete process.env.DESIGN_TOOL_SESSION_SECRET;
  else process.env.DESIGN_TOOL_SESSION_SECRET = originalSecret;
  if (originalStorageRoot === undefined) delete process.env.STORAGE_LOCAL_ROOT;
  else process.env.STORAGE_LOCAL_ROOT = originalStorageRoot;
});

type Sitting = "open" | "closed" | "expired" | "none";

let codeSeq = 0;

/**
 * @param sitting which clock the attempt sits under. "none" is the `--token`
 *   dev posture and the seeder: an attempt with no sitting at all.
 * @param timeLimitSeconds so one case can prove the sitting check runs BEFORE
 *   the deadline check.
 */
async function scenario(opts: {
  sitting: Sitting;
  timeLimitSeconds?: number | null;
  elapsedSeconds?: number;
}) {
  const db = getDb();
  const [assessment] = await db
    .insert(assessments)
    .values({
      owner_sub: OWNER,
      name: "Closable",
      status: "published",
      time_limit_seconds: opts.timeLimitSeconds ?? null,
    })
    .returning();
  const [mc] = await db
    .insert(items)
    .values({
      assessment_id: assessment!.id,
      position: 0,
      type: "multiple_choice_single",
      stem: "Pick one",
      choices: [
        { id: "c1", text: "one" },
        { id: "c2", text: "two" },
      ],
      correct_choice_ids: ["c1"],
    })
    .returning();
  const [drawing] = await db
    .insert(items)
    .values({
      assessment_id: assessment!.id,
      position: 1,
      type: "drawing_upload",
      stem: "Sketch it",
    })
    .returning();

  let sittingRow: { id: string } | null = null;
  if (opts.sitting !== "none") {
    const [row] = await db
      .insert(test_sessions)
      .values({
        assessment_id: assessment!.id,
        owner_sub: OWNER,
        owner_email: TEACHER_EMAIL,
        code: `CL${(codeSeq++).toString().padStart(4, "0")}`,
        status: opts.sitting === "closed" ? "closed" : "open",
        expires_at:
          opts.sitting === "expired"
            ? new Date(Date.now() - 60_000)
            : new Date(Date.now() + 60 * 60_000),
      })
      .returning();
    sittingRow = row!;
  }

  const [student] = await db
    .insert(students)
    .values({
      owner_sub: OWNER,
      ssid: STUDENT.ssid,
      roster_ps_id: STUDENT.ps_id,
      name: STUDENT.name,
    })
    .returning();
  const [attempt] = await db
    .insert(attempts)
    .values({
      assessment_id: assessment!.id,
      student_id: student!.id,
      test_session_id: sittingRow?.id ?? null,
      status: "in_progress",
      started_at: new Date(Date.now() - (opts.elapsedSeconds ?? 60) * 1000),
    })
    .returning();

  return {
    assessment: assessment!,
    mc: mc!,
    drawing: drawing!,
    sitting: sittingRow,
    attempt: attempt!,
  };
}

const PICK = { type: "multiple_choice_single", choice_id: "c1" };

async function put(attemptId: string, itemId: string, response: unknown = PICK) {
  const { PUT } = await import("../app/api/attempts/[attemptId]/responses/[itemId]/route");
  return PUT(
    new Request("http://localhost/x", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ response }),
    }),
    { params: Promise.resolve({ attemptId, itemId }) },
  );
}

async function del(attemptId: string, itemId: string) {
  const { DELETE } = await import("../app/api/attempts/[attemptId]/responses/[itemId]/route");
  return DELETE(new Request("http://localhost/x", { method: "DELETE" }), {
    params: Promise.resolve({ attemptId, itemId }),
  });
}

async function submit(attemptId: string) {
  const { POST } = await import("../app/api/attempts/[attemptId]/submit/route");
  return POST(new Request("http://localhost/x", { method: "POST" }), {
    params: Promise.resolve({ attemptId }),
  });
}

async function mintSlot(attemptId: string, itemId: string) {
  const { POST } = await import(
    "../app/api/attempts/[attemptId]/responses/[itemId]/upload-url/route"
  );
  return POST(
    new Request("http://localhost/x", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content_type: "image/png", content_length: 7 }),
    }),
    { params: Promise.resolve({ attemptId, itemId }) },
  );
}

async function uploadBytes(attemptId: string, itemId: string, uploadId: string) {
  const { PUT } = await import(
    "../app/api/attempts/[attemptId]/responses/[itemId]/upload/route"
  );
  return PUT(
    new Request(`http://localhost/x?upload_id=${uploadId}`, {
      method: "PUT",
      body: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]),
    }),
    { params: Promise.resolve({ attemptId, itemId }) },
  );
}

async function registerSlot(attemptId: string, itemId: string) {
  const [upload] = await getDb()
    .insert(response_uploads)
    .values({
      attempt_id: attemptId,
      item_id: itemId,
      storage_provider: "local-fs",
      storage_key: `responses/${attemptId}/${itemId}/${crypto.randomUUID()}`,
      content_type: "image/png",
      status: "pending",
    })
    .returning();
  return upload!;
}

async function peekPending(attemptId: string) {
  const { GET } = await import("../app/api/attempts/[attemptId]/peek/pending/route");
  return GET(new Request("http://localhost/x"), {
    params: Promise.resolve({ attemptId }),
  });
}

async function closeSitting(sessionId: string) {
  principal = staffPrincipal(OWNER, TEACHER_EMAIL);
  const { POST } = await import("../app/api/test-sessions/[sessionId]/close/route");
  const res = await POST(new Request("http://localhost/x", { method: "POST" }), {
    params: Promise.resolve({ sessionId }),
  });
  principal = studentPrincipal();
  return res;
}

async function postEvent(attemptId: string, kind: string) {
  const { POST } = await import("../app/api/attempts/[attemptId]/events/route");
  return POST(
    new Request("http://localhost/x", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind }),
    }),
    { params: Promise.resolve({ attemptId }) },
  );
}

describe("an open sitting changes nothing", () => {
  test("responses, withdrawals, the drawing slot and submit all work", async () => {
    const s = await scenario({ sitting: "open" });
    expect((await put(s.attempt.id, s.mc.id)).status).toBe(200);
    expect((await del(s.attempt.id, s.mc.id)).status).toBe(204);
    const minted = await mintSlot(s.attempt.id, s.drawing.id);
    expect(minted.status).toBe(201);
    const slotId = ((await minted.json()) as { upload_id: string }).upload_id;
    expect((await uploadBytes(s.attempt.id, s.drawing.id, slotId)).status).toBe(200);
    expect((await submit(s.attempt.id)).status).toBe(200);
  });
});

describe("409 sitting_closed on the student plane", () => {
  for (const sitting of ["closed", "expired"] as const) {
    test(`a ${sitting} sitting refuses a response, and nothing is written`, async () => {
      const s = await scenario({ sitting });
      const res = await put(s.attempt.id, s.mc.id);
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ ok: false, error: "sitting_closed" });
      const rows = await getDb()
        .select()
        .from(responses)
        .where(eq(responses.attempt_id, s.attempt.id));
      expect(rows).toHaveLength(0);
    });

    test(`a ${sitting} sitting refuses a withdrawal, leaving the saved answer standing`, async () => {
      const s = await scenario({ sitting: "open" });
      expect((await put(s.attempt.id, s.mc.id)).status).toBe(200);
      await overSitting(s.sitting!.id, sitting);
      const res = await del(s.attempt.id, s.mc.id);
      expect(res.status).toBe(409);
      expect((await res.json()).error).toBe("sitting_closed");
      const rows = await getDb()
        .select()
        .from(responses)
        .where(eq(responses.attempt_id, s.attempt.id));
      expect(rows).toHaveLength(1);
    });

    test(`a ${sitting} sitting refuses both halves of the drawing upload`, async () => {
      const s = await scenario({ sitting: "open" });
      const pending = await registerSlot(s.attempt.id, s.drawing.id);
      await overSitting(s.sitting!.id, sitting);

      const minted = await mintSlot(s.attempt.id, s.drawing.id);
      expect(minted.status).toBe(409);
      expect((await minted.json()).error).toBe("sitting_closed");

      const settled = await uploadBytes(s.attempt.id, s.drawing.id, pending.id);
      expect(settled.status).toBe(409);
      expect((await settled.json()).error).toBe("sitting_closed");
      const [row] = await getDb()
        .select()
        .from(response_uploads)
        .where(eq(response_uploads.id, pending.id));
      expect(row!.status).toBe("pending");
    });

    // D-1: finalising is the teacher's, through the hand-in route. A student
    // submit after the close is refused and the attempt stays resumable.
    test(`a ${sitting} sitting refuses the student's own submit and the attempt stays in progress`, async () => {
      const s = await scenario({ sitting });
      const res = await submit(s.attempt.id);
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ ok: false, error: "sitting_closed" });
      const [row] = await getDb().select().from(attempts).where(eq(attempts.id, s.attempt.id));
      expect(row!.status).toBe("in_progress");
      expect(row!.submitted_at).toBeNull();
    });
  }

  // D-3: no grace. The deadline's 30 seconds cover an autosave in flight at
  // the buzzer; a Close is immediate, and an autosave in flight at that moment
  // is accepted as lost.
  test("a sitting that expired one second ago already refuses", async () => {
    const s = await scenario({ sitting: "open" });
    await getDb()
      .update(test_sessions)
      .set({ expires_at: new Date(Date.now() - 1000) })
      .where(eq(test_sessions.id, s.sitting!.id));
    expect((await put(s.attempt.id, s.mc.id)).status).toBe(409);
  });

  // The sitting check runs FIRST, so the client is told which clock stopped it
  // — and the closed sitting is the one that matters (an expired deadline
  // leaves the attempt unresumable-looking; a closed sitting does not).
  test("a closed sitting reports sitting_closed even when the deadline has also passed", async () => {
    const s = await scenario({
      sitting: "closed",
      timeLimitSeconds: 600,
      elapsedSeconds: 700,
    });
    const res = await put(s.attempt.id, s.mc.id);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("sitting_closed");
    const submitRes = await submit(s.attempt.id);
    expect((await submitRes.json()).error).toBe("sitting_closed");
  });

  // Time-limit rows are untouched: an OPEN sitting still reports the deadline.
  test("an open sitting past the deadline still reports time_expired", async () => {
    const s = await scenario({
      sitting: "open",
      timeLimitSeconds: 600,
      elapsedSeconds: 700,
    });
    const res = await put(s.attempt.id, s.mc.id);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("time_expired");
  });
});

describe("an attempt with no sitting is untouched", () => {
  test("the --token dev posture and the seeder keep working", async () => {
    const s = await scenario({ sitting: "none" });
    expect(s.attempt.test_session_id).toBeNull();
    expect((await put(s.attempt.id, s.mc.id)).status).toBe(200);
    expect((await del(s.attempt.id, s.mc.id)).status).toBe(204);
    expect((await submit(s.attempt.id)).status).toBe(200);
  });

  test("its peek poll reports the sitting open", async () => {
    const s = await scenario({ sitting: "none" });
    const body = (await (await peekPending(s.attempt.id)).json()) as { sitting: string };
    expect(body.sitting).toBe("open");
  });
});

describe("the peek poll carries the sitting state (D-5)", () => {
  test("open while the sitting is open, closed after Close, and pending is unchanged", async () => {
    const s = await scenario({ sitting: "open" });
    const before = (await (await peekPending(s.attempt.id)).json()) as {
      ok: boolean;
      pending: unknown;
      sitting: string;
    };
    expect(before).toEqual({ ok: true, pending: null, sitting: "open" });

    expect((await closeSitting(s.sitting!.id)).status).toBe(200);
    const after = (await (await peekPending(s.attempt.id)).json()) as { sitting: string };
    expect(after.sitting).toBe("closed");
  });

  test("an expired sitting reads closed without anyone having pressed Close", async () => {
    const s = await scenario({ sitting: "expired" });
    const body = (await (await peekPending(s.attempt.id)).json()) as { sitting: string };
    expect(body.sitting).toBe("closed");
  });
});

describe("the close route (D-6)", () => {
  test("reports how many students were still working, and stays idempotent", async () => {
    const s = await scenario({ sitting: "open" });
    const first = await closeSitting(s.sitting!.id);
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as {
      test_session: { status: string };
      in_progress: number;
    };
    expect(firstBody.test_session.status).toBe("closed");
    expect(firstBody.in_progress).toBe(1);

    // A second Close is a no-op, not an error — and still names the count.
    const second = await closeSitting(s.sitting!.id);
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as {
      test_session: { status: string };
      in_progress: number;
    };
    expect(secondBody.test_session.status).toBe("closed");
    expect(secondBody.in_progress).toBe(1);

    // D-1: closing the sitting did NOT touch the attempt.
    const [row] = await getDb().select().from(attempts).where(eq(attempts.id, s.attempt.id));
    expect(row!.status).toBe("in_progress");
    expect(row!.submitted_at).toBeNull();
  });

  test("a sitting whose students have all handed in reports zero", async () => {
    const s = await scenario({ sitting: "open" });
    await getDb()
      .update(attempts)
      .set({ status: "submitted", submitted_at: new Date() })
      .where(eq(attempts.id, s.attempt.id));
    const body = (await (await closeSitting(s.sitting!.id)).json()) as {
      in_progress: number;
    };
    expect(body.in_progress).toBe(0);
  });
});

describe("the teacher's hand-in is unchanged by a closed sitting", () => {
  test("Hand in finalises the work as it stood", async () => {
    const s = await scenario({ sitting: "open" });
    expect((await put(s.attempt.id, s.mc.id)).status).toBe(200);
    expect((await closeSitting(s.sitting!.id)).status).toBe(200);

    principal = staffPrincipal(OWNER, TEACHER_EMAIL);
    const { POST } = await import("../app/api/attempts/[attemptId]/hand-in/route");
    const res = await POST(new Request("http://localhost/x", { method: "POST" }), {
      params: Promise.resolve({ attemptId: s.attempt.id }),
    });
    principal = studentPrincipal();
    expect(res.status).toBe(200);
    const [row] = await getDb().select().from(attempts).where(eq(attempts.id, s.attempt.id));
    expect(row!.status).toBe("submitted");
    expect(row!.submitted_by_sub).toBe(OWNER);
    const saved = await getDb()
      .select()
      .from(responses)
      .where(eq(responses.attempt_id, s.attempt.id));
    expect(saved).toHaveLength(1);
  });
});

describe("the sitting_closed attempt event", () => {
  test("the client may post it, and it lands", async () => {
    const s = await scenario({ sitting: "closed" });
    const res = await postEvent(s.attempt.id, "sitting_closed");
    expect(res.status).toBe(201);
    const rows = await getDb()
      .select()
      .from(attempt_events)
      .where(eq(attempt_events.attempt_id, s.attempt.id));
    expect(rows.map((r) => r.kind)).toEqual(["sitting_closed"]);
  });
});

/** Push an open sitting into the given over state. */
async function overSitting(sittingId: string, into: "closed" | "expired") {
  await getDb()
    .update(test_sessions)
    .set(
      into === "closed"
        ? { status: "closed" }
        : { expires_at: new Date(Date.now() - 60_000) },
    )
    .where(eq(test_sessions.id, sittingId));
}
