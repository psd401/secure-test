// Row GD slice 3 (docs/google-docs-release-design.md): the Doc's content,
// the Drive client, the release itself against the test DB with a fake
// Drive, and `POST /api/assessments/[id]/google-docs`.
import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import type { Rubric } from "@secure-test/schema";
import { closeDb, getDb } from "../db/client";
import {
  assessments,
  attempts,
  google_doc_folders,
  google_doc_releases,
  item_sets,
  items,
  responses,
  safeguarding_alerts,
  scores,
  students,
} from "../db/schema";
import { SESSION_COOKIE_NAME } from "../lib/auth/session";
import * as sessionMod from "../lib/auth/session";
import { setLogSink } from "../lib/log";
import {
  PARAGRAPH_OPEN,
  buildDocHtml,
  docTitle,
  plainContent,
  releaseStamp,
  type ReleaseContents,
} from "../lib/googleDocs/content";
import {
  DriveAuthError,
  DriveError,
  createDriveClient,
  type DriveClient,
} from "../lib/googleDocs/drive";
import { DRIVE_TOKEN_COOKIE_NAME, mintDriveTokenCookie } from "../lib/googleDocs/driveAuth";
import { releaseToGoogleDocs, type ReleaseOptions } from "../lib/googleDocs/release";
import { buildResults } from "../lib/scoring/results";
import { OTHER_STUDENT, STUDENT, TEACHER_EMAIL, clearRoster, seedRoster } from "./helpers/roster";

const expectTestDb = () => {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.includes("secure_test_design_tool_test")) {
    throw new Error(`google-docs-release tests require the test DB; got: ${url}`);
  }
};

const OWNER = "gd-owner-sub";
const OTHER = "gd-other-teacher";
type Principal = { sub: string; role: string; email?: string; actor_sub?: string } | null;
let principal: Principal = { sub: OWNER, role: "staff", email: TEACHER_EMAIL };

mock.module("next/headers", () => ({
  headers: async () => new Headers(),
  cookies: async () => ({
    get: (name: string) => (principal && name === SESSION_COOKIE_NAME ? { value: "x" } : undefined),
  }),
}));

mock.module("../lib/auth/session", () => ({
  ...sessionMod,
  readSessionFromCookies: async () => principal,
}));

const restoreSink = setLogSink(() => {});
const realFetch = globalThis.fetch;
let originalSecret: string | undefined;

beforeAll(async () => {
  expectTestDb();
  originalSecret = process.env.DESIGN_TOOL_SESSION_SECRET;
  process.env.DESIGN_TOOL_SESSION_SECRET ||= "gd-release-test-secret-do-not-use";
  await seedRoster();
});

afterEach(async () => {
  principal = { sub: OWNER, role: "staff", email: TEACHER_EMAIL };
  globalThis.fetch = realFetch;
  const db = getDb();
  await db.execute(sql`truncate table google_doc_folders, google_doc_releases`);
  await db.execute(sql`truncate table assessments restart identity cascade`);
  await db.execute(sql`truncate table students restart identity cascade`);
});

afterAll(async () => {
  setLogSink(restoreSink);
  await clearRoster();
  await closeDb();
  if (originalSecret === undefined) delete process.env.DESIGN_TOOL_SESSION_SECRET;
  else process.env.DESIGN_TOOL_SESSION_SECRET = originalSecret;
});

const ALL: ReleaseContents = {
  prompt: true,
  sources: true,
  score: true,
  teacher_feedback: true,
  ai_feedback: true,
};
const NONE: ReleaseContents = {
  prompt: false,
  sources: false,
  score: false,
  teacher_feedback: false,
  ai_feedback: false,
};

// ── content ──────────────────────────────────────────────────────────────────

describe("content", () => {
  const at = new Date("2026-10-05T21:30:00Z"); // 14:30 Pacific

  test("title and stamp use Pacific 24-hour time (D-5)", () => {
    expect(releaseStamp(at)).toBe("2026-10-05 14:30");
    expect(docTitle("Ada Fixture", "Unit 3", at)).toBe("Ada Fixture – Unit 3 – 2026-10-05 14:30");
  });

  test("pictures become [Image: alt]; text is escaped", () => {
    expect(plainContent("See ![a chart](asset:11111111-1111-4111-8111-111111111111) now")).toBe(
      "See [Image: a chart] now",
    );
    const html = buildDocHtml({
      studentName: "A <b>",
      assessmentName: "T",
      draftAsOf: null,
      essays: [{ number: 1, stem: "x", stimulus: null, sources: [], answer: "1 < 2 & 3", score: null }],
      contents: NONE,
    });
    expect(html).toContain("A &lt;b&gt;");
    expect(html).toContain("1 &lt; 2 &amp; 3");
  });

  const essay = {
    number: 2,
    stem: "Argue it.",
    stimulus: "Read both.",
    sources: [{ label: "Source A", text: "Alpha text" }],
    answer: "Para one line one.\nLine two.\n\nPara two.",
    score: {
      points: 3,
      max_points: 4,
      teacher_note: "See me.",
      criteria: [{ name: "Claim", level: "Proficient", points: 3, rationale: "Clear claim." }],
      ai_overall: "Solid overall.",
      from_ai: true,
    },
  };

  test("the essay alone when every box is off; paragraphs and line breaks kept", () => {
    const html = buildDocHtml({ studentName: "S", assessmentName: "T", draftAsOf: null, essays: [essay], contents: NONE });
    // GD-1: each body paragraph carries its own space after.
    expect(html).toContain(`${PARAGRAPH_OPEN}Para one line one.<br>Line two.</p>`);
    expect(html).toContain(`${PARAGRAPH_OPEN}Para two.</p>`);
    for (const absent of ["Argue it.", "Read both.", "Alpha text", "3 of 4", "See me.", "Solid overall.", "Clear claim."]) {
      expect(html).not.toContain(absent);
    }
    expect(html).not.toContain("Question 2"); // one essay: no question heading
  });

  test("each box adds its part", () => {
    const html = buildDocHtml({ studentName: "S", assessmentName: "T", draftAsOf: null, essays: [essay], contents: ALL });
    for (const present of ["Argue it.", "Read both.", "Source A", "Alpha text", "3 of 4", "Proficient", "Clear claim.", "Solid overall.", "See me."]) {
      expect(html).toContain(present);
    }
    const scoreOnly = buildDocHtml({ studentName: "S", assessmentName: "T", draftAsOf: null, essays: [essay], contents: { ...NONE, score: true } });
    expect(scoreOnly).toContain("3 of 4");
    expect(scoreOnly).not.toContain("Clear claim.");
    expect(scoreOnly).not.toContain("See me.");
  });

  test("AI feedback is never shown for a score that did not come from the AI", () => {
    const human = { ...essay, score: { ...essay.score, from_ai: false } };
    const html = buildDocHtml({ studentName: "S", assessmentName: "T", draftAsOf: null, essays: [human], contents: { ...NONE, ai_feedback: true } });
    expect(html).not.toContain("Clear claim.");
    expect(html).not.toContain("Solid overall.");
  });

  test("a draft says so; two essays get question headings", () => {
    const html = buildDocHtml({
      studentName: "S",
      assessmentName: "T",
      draftAsOf: at,
      essays: [essay, { ...essay, number: 4, answer: null }],
      contents: NONE,
    });
    expect(html).toContain("Draft — not handed in as of 2026-10-05 14:30");
    expect(html).toContain("Question 2");
    expect(html).toContain("Question 4");
    expect(html).toContain("No response.");
  });
});

// ── Drive client ─────────────────────────────────────────────────────────────

describe("Drive client", () => {
  test("retries a rate limit, then succeeds", async () => {
    let calls = 0;
    const client = createDriveClient("tok", {
      sleep: async () => {},
      fetchImpl: (async () => {
        calls++;
        return calls === 1
          ? Response.json({ error: { errors: [{ reason: "userRateLimitExceeded" }] } }, { status: 403 })
          : Response.json({ id: "folder-1" });
      }) as unknown as typeof fetch,
    });
    expect(await client.createFolder("x", null)).toBe("folder-1");
    expect(calls).toBe(2);
  });

  test("the transfer PATCHes the student's permission to owner", async () => {
    let seen: { url: string; method?: string; body?: string } | null = null;
    const client = createDriveClient("tok", {
      fetchImpl: (async (url: string, init: RequestInit) => {
        seen = { url, method: init.method, body: String(init.body) };
        return Response.json({ id: "p1" });
      }) as unknown as typeof fetch,
    });
    await client.transferOwnership("f1", "p1");
    expect(seen!.method).toBe("PATCH");
    expect(seen!.url).toBe("https://www.googleapis.com/drive/v3/files/f1/permissions/p1?transferOwnership=true&fields=id");
    expect(JSON.parse(seen!.body!)).toEqual({ role: "owner" });
  });

  test("401 is DriveAuthError; other refusals carry the reason; a 404 folder is unusable", async () => {
    const respond = (res: Response) =>
      createDriveClient("tok", { sleep: async () => {}, fetchImpl: (async () => res.clone()) as unknown as typeof fetch });
    await expect(respond(new Response("", { status: 401 })).createFolder("x", null)).rejects.toBeInstanceOf(DriveAuthError);
    const err = await respond(Response.json({ error: { errors: [{ reason: "insufficientFilePermissions" }] } }, { status: 403 }))
      .shareWriter("f", "s@example.org")
      .catch((e) => e);
    expect(err).toBeInstanceOf(DriveError);
    expect((err as DriveError).code).toBe("insufficientFilePermissions");
    expect(await respond(new Response("{}", { status: 404 })).folderUsable("gone")).toBe(false);
    expect(await respond(Response.json({ id: "f", trashed: true })).folderUsable("f")).toBe(false);
  });
});

// ── release ──────────────────────────────────────────────────────────────────

const RUBRIC: Rubric = {
  style: "analytic",
  criteria: [
    {
      id: "claim",
      name: "Claim",
      levels: [
        { id: "c1", label: "Emerging", points: 1 },
        { id: "c2", label: "Proficient", points: 2 },
      ],
    },
  ],
};

class FakeDrive implements DriveClient {
  folders: Array<{ id: string; name: string; parent: string | null }> = [];
  docs: Array<{ id: string; name: string; parent: string; html: string }> = [];
  shares: Array<{ fileId: string; email: string }> = [];
  trashed = new Set<string>();
  failUploadAt: number | null = null;
  failWith: Error | null = null;
  private n = 0;
  async createFolder(name: string, parent: string | null) {
    const id = `folder-${++this.n}`;
    this.folders.push({ id, name, parent });
    return id;
  }
  async folderUsable(id: string) {
    return this.folders.some((f) => f.id === id) && !this.trashed.has(id);
  }
  async uploadDoc(name: string, parent: string, html: string) {
    if (this.failUploadAt !== null && this.docs.length + 1 >= this.failUploadAt) throw this.failWith!;
    const id = `doc-${++this.n}`;
    this.docs.push({ id, name, parent, html });
    return id;
  }
  async shareWriter(fileId: string, email: string) {
    this.shares.push({ fileId, email });
    return `perm-${fileId}`;
  }
  transfers: Array<{ fileId: string; permissionId: string }> = [];
  failTransferWith: Error | null = null;
  async transferOwnership(fileId: string, permissionId: string) {
    if (this.failTransferWith) throw this.failTransferWith;
    this.transfers.push({ fileId, permissionId });
  }
}

async function bindStudent(who: { ps_id: string; ssid: string }, name: string) {
  const [s] = await getDb()
    .insert(students)
    .values({ owner_sub: OWNER, ssid: who.ssid, roster_ps_id: who.ps_id, name })
    .returning();
  return s!;
}

/** Two roster-bound students who handed in one essay each (plus an MC). */
async function scene(opts: { essays?: number } = {}) {
  const db = getDb();
  const [a] = await db
    .insert(assessments)
    .values({ owner_sub: OWNER, owner_email: TEACHER_EMAIL, name: "Unit 3 essay" })
    .returning();
  const [set] = await db
    .insert(item_sets)
    .values({
      assessment_id: a!.id,
      stimulus_text: "Read the sources.",
      sources: [{ label: "Source A", text: "Alpha says so." }],
    })
    .returning();
  await db.insert(items).values({
    assessment_id: a!.id,
    position: 0,
    type: "multiple_choice_single",
    stem: "Pick one",
    choices: [{ id: "c1", text: "one" }],
    correct_choice_ids: ["c1"],
  });
  const essayItems = [];
  for (let i = 0; i < (opts.essays ?? 1); i++) {
    const [it] = await db
      .insert(items)
      .values({
        assessment_id: a!.id,
        position: 1 + i,
        type: "essay",
        stem: `Argue point ${i + 1}.`,
        item_set_id: set!.id,
        config: { rubric: RUBRIC },
      })
      .returning();
    essayItems.push(it!);
  }
  const ada = await bindStudent(STUDENT, "Ada Fixture");
  const ben = await bindStudent(OTHER_STUDENT, "Ben Sample");
  const made = [];
  for (const s of [ada, ben]) {
    const [at] = await db
      .insert(attempts)
      .values({ assessment_id: a!.id, student_id: s.id, status: "submitted", submitted_at: new Date() })
      .returning();
    const resp = [];
    for (const it of essayItems) {
      const [r] = await db
        .insert(responses)
        .values({ attempt_id: at!.id, item_id: it.id, response: { type: "essay", text: `${s.name} writes.` } })
        .returning();
      resp.push(r!);
    }
    made.push({ attempt: at!, responses: resp });
  }
  const results = await buildResults(a!.id);
  const section = results.rows[0]!.student.section!;
  return { assessment: a!, essayItems, ada: made[0]!, ben: made[1]!, section };
}

const OPTS: ReleaseOptions = { contents: NONE, mode: "skip", includeDrafts: false };

describe("releaseToGoogleDocs", () => {
  test("a section send: one Doc each in secure-test / assessment / section, shared as writer", async () => {
    const s = await scene();
    const drive = new FakeDrive();
    const r = await releaseToGoogleDocs(getDb(), {
      assessment: s.assessment,
      senderSub: OWNER,
      scope: { section: s.section },
      options: OPTS,
      drive,
    });
    if (!r.ok) throw new Error(r.error);
    expect(r.outcomes.map((o) => o.status)).toEqual(["sent", "sent"]);
    expect(drive.folders.map((f) => f.name)).toEqual(["SecureTest", "Unit 3 essay", s.section]);
    expect(drive.folders[1]!.parent).toBe(drive.folders[0]!.id);
    expect(drive.docs.every((d) => d.parent === drive.folders[2]!.id)).toBe(true);
    expect(drive.shares.map((x) => x.email).sort()).toEqual([OTHER_STUDENT.email, STUDENT.email].sort());
    expect(drive.docs[0]!.name).toMatch(/^Ada Fixture – Unit 3 essay – \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    expect(r.outcomes[0]!.url).toBe(`https://docs.google.com/document/d/${drive.docs[0]!.id}/edit`);
    expect((await getDb().select().from(google_doc_releases)).length).toBe(2);
  });

  // RT slice 2 (docs/rich-text-essay-design.md): a formatted essay goes into
  // the Doc formatted (its stored html re-cleaned), a plain one as before;
  // D-10 double spacing reaches both.
  test("a formatted essay keeps its formatting in the Doc; double spacing reaches every essay", async () => {
    const s = await scene();
    await getDb()
      .update(responses)
      .set({
        response: {
          type: "essay",
          text: "Ada bold.",
          html: '<p data-indent="first"><strong>Ada bold.</strong><script>alert(1)</script></p>',
        },
      })
      .where(eq(responses.id, s.ada.responses[0]!.id));
    const drive = new FakeDrive();
    const r = await releaseToGoogleDocs(getDb(), {
      assessment: s.assessment,
      senderSub: OWNER,
      scope: { section: s.section },
      options: { ...OPTS, doubleSpace: true },
      drive,
    });
    if (!r.ok) throw new Error(r.error);
    const ada = drive.docs.find((d) => d.name.startsWith("Ada"))!.html;
    const ben = drive.docs.find((d) => d.name.startsWith("Ben"))!.html;
    expect(ada).toContain('<p style="margin:0;text-indent:36pt;line-height:2.0"><b>Ada bold.</b></p>');
    expect(ada).not.toContain("script");
    expect(ben).toContain('<p style="margin:0 0 10pt 0;line-height:2.0">Ben Sample writes.</p>');

    // Off (the default): no line spacing, the formatting still there.
    const single = new FakeDrive();
    await releaseToGoogleDocs(getDb(), {
      assessment: s.assessment,
      senderSub: OWNER,
      scope: { section: s.section },
      options: { ...OPTS, mode: "new" },
      drive: single,
    });
    expect(single.docs.every((d) => !d.html.includes("line-height"))).toBe(true);
    expect(single.docs.find((d) => d.name.startsWith("Ada"))!.html).toContain("<b>Ada bold.</b>");
  });

  test("skip vs new on a re-send; folders are reused, and remade when trashed", async () => {
    const s = await scene();
    const drive = new FakeDrive();
    const send = (mode: "skip" | "new") =>
      releaseToGoogleDocs(getDb(), {
        assessment: s.assessment,
        senderSub: OWNER,
        scope: { section: s.section },
        options: { ...OPTS, mode },
        drive,
      });
    await send("skip");
    const again = await send("skip");
    if (!again.ok) throw new Error(again.error);
    expect(again.outcomes.map((o) => o.reason)).toEqual(["already_released", "already_released"]);
    expect(drive.docs.length).toBe(2);
    expect(drive.folders.length).toBe(3);

    const fresh = await send("new");
    if (!fresh.ok) throw new Error(fresh.error);
    expect(fresh.outcomes.map((o) => o.status)).toEqual(["sent", "sent"]);
    expect(drive.folders.length).toBe(3);

    drive.trashed.add(drive.folders[2]!.id);
    await send("new");
    expect(drive.folders.length).toBe(4);
    const [row] = await getDb()
      .select()
      .from(google_doc_folders)
      .where(eq(google_doc_folders.scope_key, `a:${s.assessment.id}:s:${s.section}`));
    expect(row!.drive_folder_id).toBe(drive.folders[3]!.id);
  });

  test("drafts are skipped unless asked for, and marked as drafts (D-12)", async () => {
    const s = await scene();
    await getDb().update(attempts).set({ status: "in_progress", submitted_at: null }).where(eq(attempts.id, s.ben.attempt.id));
    const drive = new FakeDrive();
    const run = (includeDrafts: boolean) =>
      releaseToGoogleDocs(getDb(), {
        assessment: s.assessment,
        senderSub: OWNER,
        scope: { section: s.section },
        options: { ...OPTS, mode: "new", includeDrafts },
        drive,
      });
    const without = await run(false);
    if (!without.ok) throw new Error(without.error);
    expect(without.outcomes.find((o) => o.attempt_id === s.ben.attempt.id)!.reason).toBe("not_handed_in");
    await run(true);
    expect(drive.docs.filter((d) => d.html.includes("Draft — not handed in")).length).toBe(1);
    const rows = await getDb().select().from(google_doc_releases).where(eq(google_doc_releases.attempt_id, s.ben.attempt.id));
    expect(rows[0]!.was_draft).toBe(true);
  });

  test("an open safeguarding alert holds the Doc back until acknowledged (D-6)", async () => {
    const s = await scene();
    const [alert] = await getDb()
      .insert(safeguarding_alerts)
      .values({
        response_id: s.ada.responses[0]!.id,
        attempt_id: s.ada.attempt.id,
        assessment_id: s.assessment.id,
        item_id: s.essayItems[0]!.id,
        kind: "wellbeing",
        category: "self_harm",
        detector: "mock",
      })
      .returning();
    const drive = new FakeDrive();
    const run = () =>
      releaseToGoogleDocs(getDb(), {
        assessment: s.assessment,
        senderSub: OWNER,
        scope: { attemptId: s.ada.attempt.id },
        options: OPTS,
        drive,
      });
    const held = await run();
    if (!held.ok) throw new Error(held.error);
    expect(held.outcomes[0]!.reason).toBe("safeguarding_alert");
    expect(drive.folders.length).toBe(0); // nothing touched Drive
    await getDb().update(safeguarding_alerts).set({ acknowledged_at: new Date() }).where(eq(safeguarding_alerts.id, alert!.id));
    const sent = await run();
    if (!sent.ok) throw new Error(sent.error);
    expect(sent.outcomes[0]!.status).toBe("sent");
  });

  test("one Doc holds every essay, sources once, approved scores only (D-10, D-13)", async () => {
    const s = await scene({ essays: 2 });
    const db = getDb();
    await db.insert(scores).values([
      {
        response_id: s.ada.responses[0]!.id,
        method: "ai",
        points: 2,
        max_points: 2,
        scorer: "mock",
        status: "final",
        rationale: { criterion_scores: [{ criterion_id: "claim", level_id: "c2", points: 2, rationale: "Strong claim." }], overall_rationale: "Well argued." },
      },
      { response_id: s.ada.responses[1]!.id, method: "ai", points: 1, max_points: 2, scorer: "mock", status: "proposed" },
    ]);
    const drive = new FakeDrive();
    await releaseToGoogleDocs(db, {
      assessment: s.assessment,
      senderSub: OWNER,
      scope: { attemptId: s.ada.attempt.id },
      options: { ...OPTS, contents: ALL },
      drive,
    });
    expect(drive.docs.length).toBe(1);
    const html = drive.docs[0]!.html;
    expect(html).toContain("Question 2");
    expect(html).toContain("Question 3");
    expect(html.split("Alpha says so.").length - 1).toBe(1);
    expect(html).toContain("2 of 2");
    expect(html).toContain("Strong claim.");
    expect(html).not.toContain("1 of 2"); // the proposal is never released
  });

  test("blank essays, no email, no essays on the assessment, a foreign attempt", async () => {
    const s = await scene();
    const db = getDb();
    await db.update(responses).set({ response: { type: "essay", text: "  " } }).where(eq(responses.id, s.ada.responses[0]!.id));
    await db.update(students).set({ roster_ps_id: null }).where(eq(students.name, "Ben Sample"));
    const drive = new FakeDrive();
    const ada = await releaseToGoogleDocs(db, {
      assessment: s.assessment, senderSub: OWNER, scope: { attemptId: s.ada.attempt.id }, options: OPTS, drive,
    });
    if (!ada.ok) throw new Error(ada.error);
    expect(ada.outcomes[0]!.reason).toBe("no_essay");
    const ben = await releaseToGoogleDocs(db, {
      assessment: s.assessment, senderSub: OWNER, scope: { attemptId: s.ben.attempt.id }, options: OPTS, drive,
    });
    if (!ben.ok) throw new Error(ben.error);
    expect(ben.outcomes[0]!.reason).toBe("no_email");
    const foreign = await releaseToGoogleDocs(db, {
      assessment: s.assessment, senderSub: OWNER, scope: { attemptId: "11111111-1111-4111-8111-111111111111" }, options: OPTS, drive,
    });
    expect(foreign).toEqual({ ok: false, error: "attempt_not_found" });
    await db.delete(items).where(eq(items.type, "essay"));
    const none = await releaseToGoogleDocs(db, {
      assessment: s.assessment, senderSub: OWNER, scope: { section: s.section }, options: OPTS, drive,
    });
    expect(none).toEqual({ ok: false, error: "no_essays" });
  });

  test("ownership transfer: done after the share, recorded on the row (slice 5)", async () => {
    const s = await scene();
    const drive = new FakeDrive();
    const r = await releaseToGoogleDocs(getDb(), {
      assessment: s.assessment,
      senderSub: OWNER,
      scope: { attemptId: s.ada.attempt.id },
      options: { ...OPTS, transferOwnership: true },
      drive,
    });
    if (!r.ok) throw new Error(r.error);
    expect(r.outcomes[0]).toMatchObject({ status: "sent", ownership: "transferred" });
    expect(drive.transfers).toEqual([{ fileId: drive.docs[0]!.id, permissionId: `perm-${drive.docs[0]!.id}` }]);
    const [row] = await getDb().select().from(google_doc_releases);
    expect(row!.ownership_transferred_at).not.toBeNull();
  });

  test("a refused transfer still counts as sent, shared as editor (slice 5)", async () => {
    const s = await scene();
    const drive = new FakeDrive();
    drive.failTransferWith = new DriveError(403, "consentRequiredForOwnershipTransfer");
    const r = await releaseToGoogleDocs(getDb(), {
      assessment: s.assessment,
      senderSub: OWNER,
      scope: { attemptId: s.ada.attempt.id },
      options: { ...OPTS, transferOwnership: true },
      drive,
    });
    if (!r.ok) throw new Error(r.error);
    expect(r.outcomes[0]).toMatchObject({
      status: "sent",
      ownership: "not_transferred",
      ownership_error: "consentRequiredForOwnershipTransfer",
    });
    const [row] = await getDb().select().from(google_doc_releases);
    expect(row!.ownership_transferred_at).toBeNull();
  });

  test("no transfer unless asked", async () => {
    const s = await scene();
    const drive = new FakeDrive();
    const r = await releaseToGoogleDocs(getDb(), {
      assessment: s.assessment, senderSub: OWNER, scope: { attemptId: s.ada.attempt.id }, options: OPTS, drive,
    });
    if (!r.ok) throw new Error(r.error);
    expect(drive.transfers.length).toBe(0);
    expect(r.outcomes[0]!.ownership).toBeUndefined();
  });

  test("a lost token mid-send stops the rest; another refusal fails that student only", async () => {
    const s = await scene();
    const lost = new FakeDrive();
    lost.failUploadAt = 2;
    lost.failWith = new DriveAuthError();
    const r = await releaseToGoogleDocs(getDb(), {
      assessment: s.assessment, senderSub: OWNER, scope: { section: s.section }, options: OPTS, drive: lost,
    });
    if (!r.ok) throw new Error(r.error);
    expect(r.drive_auth_needed).toBe(true);
    expect(r.outcomes.filter((o) => o.reason === "drive_auth_expired").length).toBe(1);

    await getDb().execute(sql`truncate table google_doc_releases`);
    const refused = new FakeDrive();
    refused.failUploadAt = 1;
    refused.failWith = new DriveError(403, "storageQuotaExceeded");
    const f = await releaseToGoogleDocs(getDb(), {
      assessment: s.assessment, senderSub: OWNER, scope: { section: s.section }, options: OPTS, drive: refused,
    });
    if (!f.ok) throw new Error(f.error);
    expect(f.outcomes.every((o) => o.status === "failed" && o.reason === "storageQuotaExceeded")).toBe(true);
  });
});

// ── route ────────────────────────────────────────────────────────────────────

async function post(assessmentId: string, body: unknown, cookie?: string) {
  const { POST } = await import("../app/api/assessments/[id]/google-docs/route");
  const headers = new Headers({ "content-type": "application/json" });
  if (cookie) headers.set("cookie", `${DRIVE_TOKEN_COOKIE_NAME}=${encodeURIComponent(cookie)}`);
  const res = await POST(
    new Request(`http://localhost/api/assessments/${assessmentId}/google-docs`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: assessmentId }) },
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe("POST /api/assessments/[id]/google-docs", () => {
  const body = (over: Record<string, unknown> = {}) => ({
    contents: NONE,
    mode: "skip",
    include_drafts: false,
    ...over,
  });

  test("refusals: no Drive token, another teacher, act-as, a bad body", async () => {
    const s = await scene();
    expect((await post(s.assessment.id, body({ section: s.section }))).body.error).toBe("drive_auth_needed");
    const cookie = await mintDriveTokenCookie("ya29.t", OWNER, 600);
    expect((await post(s.assessment.id, body({ section: s.section, attempt_id: s.ada.attempt.id }), cookie)).status).toBe(400);
    principal = { sub: OTHER, role: "staff", email: "other@example.org" };
    expect((await post(s.assessment.id, body({ section: s.section }), cookie)).status).toBe(404);
    principal = { sub: OWNER, role: "staff", email: TEACHER_EMAIL, actor_sub: "admin" };
    expect((await post(s.assessment.id, body({ section: s.section }), cookie)).status).toBe(403);
  });

  test("a token minted for another session is no token", async () => {
    const s = await scene();
    const cookie = await mintDriveTokenCookie("ya29.t", OTHER, 600);
    expect((await post(s.assessment.id, body({ section: s.section }), cookie)).status).toBe(401);
  });

  test("double_space reaches the uploaded Doc; absent means single (RT D-10)", async () => {
    const s = await scene();
    const uploads: string[] = [];
    let n = 0;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("/upload/")) uploads.push(String(init?.body ?? ""));
      return Response.json({ id: `id-${++n}` });
    }) as typeof fetch;
    const cookie = await mintDriveTokenCookie("ya29.t", OWNER, 600);
    const res = await post(s.assessment.id, body({ section: s.section, double_space: true }), cookie);
    expect(res.status).toBe(200);
    expect(uploads.length).toBe(2);
    expect(uploads.every((u) => u.includes("line-height:2.0"))).toBe(true);

    uploads.length = 0;
    const again = await post(s.assessment.id, body({ section: s.section, mode: "new" }), cookie);
    expect(again.status).toBe(200);
    expect(uploads.length).toBe(2);
    expect(uploads.some((u) => u.includes("line-height"))).toBe(false);
    expect((await post(s.assessment.id, body({ section: s.section, double_space: "yes" }), cookie)).status).toBe(400);
  });

  test("sends through real Drive calls (stubbed fetch)", async () => {
    const s = await scene();
    const seen: string[] = [];
    let n = 0;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      seen.push(`${init?.method ?? "GET"} ${url.split("?")[0]}`);
      expect((init?.headers as Record<string, string>).authorization).toBe("Bearer ya29.t");
      return Response.json({ id: `id-${++n}` });
    }) as typeof fetch;
    const cookie = await mintDriveTokenCookie("ya29.t", OWNER, 600);
    const lines: Array<Record<string, unknown>> = [];
    const prior = setLogSink((line) => lines.push(JSON.parse(line)));
    const res = await post(s.assessment.id, body({ section: s.section }), cookie);
    setLogSink(prior);
    expect(res.status).toBe(200);
    // Row 444 (b): the send's wall time is on the log line, nothing about a student.
    const logged = lines.find((l) => l.event === "google_docs_released")!;
    expect(logged).toMatchObject({ sent: 2, skipped: 0, failed: 0 });
    expect(typeof logged.duration_ms).toBe("number");
    expect(JSON.stringify(logged)).not.toContain("Ada");
    expect((res.body.outcomes as Array<{ status: string }>).map((o) => o.status)).toEqual(["sent", "sent"]);
    expect(seen.filter((x) => x.startsWith("POST https://www.googleapis.com/upload/")).length).toBe(2);
    expect(seen.filter((x) => x.includes("/permissions")).length).toBe(2);
  });
});
