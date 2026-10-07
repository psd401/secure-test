// Answer history slice 2 (docs/answer-history-design.md): restore an earlier
// version — `lib/api/restoreAnswer.ts` and
// `POST /api/response-revisions/[revisionId]/restore`.
import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import { closeDb, getDb } from "../db/client";
import {
  assessments,
  attempt_events,
  attempts,
  items,
  response_revisions,
  responses,
  scores,
  students,
  test_sessions,
} from "../db/schema";
import { SESSION_COOKIE_NAME } from "../lib/auth/session";
import * as sessionMod from "../lib/auth/session";
import { listSupersededScores } from "../lib/scoring/supersededScores";
import { causeLine } from "../lib/scoring/changeScoreDialog";
import { restoreErrorCopy, restoreVersionCopy } from "../components/app/RestoreVersionControl";
import { OTHER_TEACHER_EMAIL, TEACHER_EMAIL, staffPrincipal } from "./helpers/roster";

const expectTestDb = () => {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.includes("secure_test_design_tool_test")) {
    throw new Error(`answer-restore tests require the test DB; got: ${url}`);
  }
};

const OWNER = "restore-teacher";
const OTHER = "restore-other-teacher";

type Principal = { sub: string; role: string; email?: string } | null;
let principal: Principal = staffPrincipal(OWNER);

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

beforeAll(expectTestDb);

afterEach(async () => {
  principal = staffPrincipal(OWNER);
  const db = getDb();
  await db.execute(sql`truncate table assessments restart identity cascade`);
  await db.execute(sql`truncate table students restart identity cascade`);
});

afterAll(closeDb);

let codeSeq = 0;
const essay = (text: string) => ({ type: "essay" as const, text });

async function scenario(opts: {
  status: "submitted" | "in_progress";
  sitting: "open" | "closed";
  current?: string | null;
}) {
  const db = getDb();
  const [assessment] = await db
    .insert(assessments)
    .values({ owner_sub: OWNER, owner_email: TEACHER_EMAIL, name: "Restore", status: "published" })
    .returning();
  const [item] = await db
    .insert(items)
    .values({ assessment_id: assessment!.id, position: 0, type: "essay", stem: "Write" })
    .returning();
  const [student] = await db
    .insert(students)
    .values({ owner_sub: OWNER, name: "S" })
    .returning();
  const [sitting] = await db
    .insert(test_sessions)
    .values({
      assessment_id: assessment!.id,
      owner_sub: OWNER,
      owner_email: TEACHER_EMAIL,
      code: `RST${String(++codeSeq).padStart(3, "0")}`,
      status: opts.sitting,
      expires_at: new Date(Date.now() + 3_600_000),
    })
    .returning();
  const [attempt] = await db
    .insert(attempts)
    .values({
      assessment_id: assessment!.id,
      student_id: student!.id,
      test_session_id: sitting!.id,
      status: opts.status,
      submitted_at: opts.status === "submitted" ? new Date() : null,
    })
    .returning();
  let response = null;
  if (opts.current !== null) {
    [response] = await db
      .insert(responses)
      .values({ attempt_id: attempt!.id, item_id: item!.id, response: essay(opts.current ?? "") })
      .returning();
  }
  const [revision] = await db
    .insert(response_revisions)
    .values({
      attempt_id: attempt!.id,
      item_id: item!.id,
      response: essay("The full essay the student wrote."),
      saved_at: new Date(Date.now() - 600_000),
      reason: "shrink",
    })
    .returning();
  return { assessment: assessment!, item: item!, attempt: attempt!, response, revision: revision! };
}

async function restore(revisionId: string) {
  const { POST } = await import("../app/api/response-revisions/[revisionId]/restore/route");
  return POST(new Request("http://localhost/x", { method: "POST" }), {
    params: Promise.resolve({ revisionId }),
  });
}

async function currentText(attemptId: string) {
  const [row] = await getDb().select().from(responses).where(eq(responses.attempt_id, attemptId));
  return (row?.response as { text?: string } | undefined)?.text;
}

describe("POST /api/response-revisions/[revisionId]/restore", () => {
  test("a handed-in emptied essay: restored, scores set aside, current kept, event written", async () => {
    const s = await scenario({ status: "submitted", sitting: "open", current: "x" });
    const db = getDb();
    const [score] = await db
      .insert(scores)
      .values({
        response_id: s.response!.id,
        method: "human",
        points: 0,
        max_points: 4,
        scorer: OWNER,
        status: "final",
      })
      .returning();

    // An open sitting does not hold a handed-in attempt: nobody is typing.
    const res = await restore(s.revision.id);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.superseded_scores).toBe(1);
    expect(await currentText(s.attempt.id)).toBe("The full essay the student wrote.");

    const [flipped] = await db.select().from(scores).where(eq(scores.id, score!.id));
    expect(flipped!.status).toBe("superseded");
    const earlier = await listSupersededScores(db, s.attempt.id);
    expect(earlier[0]!.cause).toBe("restored");
    expect(causeLine(earlier[0]!)).toBe("set aside when an earlier answer was restored");

    const kept = await db
      .select()
      .from(response_revisions)
      .where(eq(response_revisions.reason, "restored"));
    expect(kept.length).toBe(1);
    expect((kept[0]!.response as { text: string }).text).toBe("x");

    const events = await db
      .select()
      .from(attempt_events)
      .where(
        and(eq(attempt_events.attempt_id, s.attempt.id), eq(attempt_events.kind, "answer_restored")),
      );
    expect(events.length).toBe(1);
    expect((events[0]!.detail as { revision_id: string }).revision_id).toBe(s.revision.id);
  });

  test("a withdrawn answer comes back as a new row", async () => {
    const s = await scenario({ status: "in_progress", sitting: "closed", current: null });
    expect((await restore(s.revision.id)).status).toBe(200);
    expect(await currentText(s.attempt.id)).toBe("The full essay the student wrote.");
  });

  test("a blank current answer is not kept; restoring the same text twice changes nothing", async () => {
    const s = await scenario({ status: "in_progress", sitting: "closed", current: "" });
    expect((await restore(s.revision.id)).status).toBe(200);
    const again = await (await restore(s.revision.id)).json();
    expect(again.unchanged).toBe(true);
    const restoredRows = await getDb()
      .select()
      .from(response_revisions)
      .where(eq(response_revisions.reason, "restored"));
    expect(restoredRows.length).toBe(0);
  });

  // RT slice 1 (docs/rich-text-essay-design.md): a kept version of a
  // formatted essay carries its html, and restoring it brings the html back.
  test("a formatted essay's kept version restores its html too", async () => {
    const s = await scenario({ status: "in_progress", sitting: "closed", current: "" });
    const formatted = {
      type: "essay" as const,
      text: "Bold claim\n• first",
      html: "<p><strong>Bold</strong> claim</p><ul><li>first</li></ul>",
    };
    const db = getDb();
    await db
      .update(response_revisions)
      .set({ response: formatted })
      .where(eq(response_revisions.id, s.revision.id));
    expect((await restore(s.revision.id)).status).toBe(200);
    const [row] = await db.select().from(responses).where(eq(responses.attempt_id, s.attempt.id));
    expect(row!.response).toEqual(formatted);
  });

  test("refused while an open sitting holds an in-progress attempt", async () => {
    const s = await scenario({ status: "in_progress", sitting: "open", current: "" });
    const res = await restore(s.revision.id);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("session_open");
    expect(await currentText(s.attempt.id)).toBe("");
  });

  test("another teacher gets 404, and so does an unknown id", async () => {
    const s = await scenario({ status: "submitted", sitting: "closed", current: "" });
    principal = staffPrincipal(OTHER, OTHER_TEACHER_EMAIL);
    expect((await restore(s.revision.id)).status).toBe(404);
    principal = staffPrincipal(OWNER);
    expect((await restore("00000000-0000-4000-8000-000000000000")).status).toBe(404);
    expect(await currentText(s.attempt.id)).toBe("");
  });
});

describe("the restore dialog's words", () => {
  test("copy and refusals", () => {
    expect(restoreVersionCopy(true)).toContain("use Pass back");
    expect(restoreVersionCopy(false)).toContain("next open the test");
    expect(restoreErrorCopy("session_open")).toBe("End the test session first, then restore.");
  });
});
