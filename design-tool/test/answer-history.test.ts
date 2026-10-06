// Answer history (docs/answer-history-design.md): the D-2 capture rule, the
// per-student page's words, and the D-3 sweep.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { closeDb, getDb } from "../db/client";
import { assessments, attempts, items, response_revisions, responses, students } from "../db/schema";
import { answerLength, captureBeforeWrite, captureReason } from "../lib/api/answerHistory";
import {
  revisionMeasure,
  revisionReasonNote,
  revisionText,
} from "../lib/reporting/answerHistoryView";
import { sweepAnswerHistory } from "../lib/retention/sweep";

const NOW = new Date("2026-10-06T15:00:00Z");
const secondsAgo = (s: number) => new Date(NOW.getTime() - s * 1000);
const essay = (text: string) => ({ type: "essay", text });

describe("captureReason (D-2)", () => {
  test("a withdrawal always keeps a non-blank answer", () => {
    expect(captureReason(essay("words"), null, secondsAgo(1), NOW)).toBe("withdrawn");
  });

  test("a blank or unchanged old value is never kept", () => {
    expect(captureReason(essay(""), essay("new"), null, NOW)).toBeNull();
    expect(captureReason(essay(""), null, null, NOW)).toBeNull();
    expect(captureReason(essay("same"), essay("same"), null, NOW)).toBeNull();
  });

  test("under half the length is a shrink, whatever the last copy", () => {
    expect(captureReason(essay("abcdefghij"), essay("abcd"), secondsAgo(1), NOW)).toBe("shrink");
    expect(captureReason(essay("abcdefghij"), essay(""), secondsAgo(1), NOW)).toBe("shrink");
    // Exactly half is not a shrink; inside the minute it is not kept at all.
    expect(captureReason(essay("abcdefghij"), essay("abcde"), secondsAgo(1), NOW)).toBeNull();
  });

  test("otherwise once a minute", () => {
    expect(captureReason(essay("a"), essay("ab"), null, NOW)).toBe("interval");
    expect(captureReason(essay("a"), essay("ab"), secondsAgo(59), NOW)).toBeNull();
    expect(captureReason(essay("a"), essay("ab"), secondsAgo(60), NOW)).toBe("interval");
  });

  test("a table is measured by its cell text", () => {
    const before = { type: "table", cells: { r1: { c1: "12345", c2: "678" } } };
    const after = { type: "table", cells: { r1: { c1: "1" } } };
    expect(answerLength(before)).toBe(8);
    expect(captureReason(before, after, secondsAgo(1), NOW)).toBe("shrink");
  });
});

describe("the per-student page's words", () => {
  test("text, measure and reason", () => {
    expect(revisionText(essay("Hello there"))).toBe("Hello there");
    expect(revisionMeasure(essay("  Hello there  "))).toBe("2 words");
    expect(revisionMeasure(essay("Hi"))).toBe("1 word");
    expect(revisionReasonNote("shrink")).toBe("kept before a large deletion");
    expect(revisionReasonNote("withdrawn")).toBe("kept before the answer was cleared");
    expect(revisionReasonNote("interval")).toBeNull();
  });

  test("a table copies as tab-separated rows with labels", () => {
    const config = {
      columns: [
        { id: "c1", label: "Mass" },
        { id: "c2", label: "Volume" },
      ],
      rows: [
        { id: "r1", label: "Trial 1" },
        { id: "r2", label: "Trial 2" },
      ],
    };
    const response = { type: "table", cells: { r1: { c1: "4", c2: "2" }, r2: { c1: "6" } } };
    expect(revisionText(response, config)).toBe("\tMass\tVolume\nTrial 1\t4\t2\nTrial 2\t6\t");
    expect(revisionMeasure(response)).toBe("3 cells filled");
  });
});

const expectTestDb = () => {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.includes("secure_test_design_tool_test")) {
    throw new Error(`answer-history tests require the test DB; got: ${url}`);
  }
};

describe("sweepAnswerHistory (D-3)", () => {
  beforeAll(expectTestDb);
  afterEach(async () => {
    await getDb().execute(sql`truncate table assessments restart identity cascade`);
    await getDb().execute(sql`truncate table students restart identity cascade`);
  });
  afterAll(closeDb);

  const DAY = 24 * 60 * 60 * 1000;

  async function attemptWithHistory(status: "submitted" | "in_progress", submittedDaysAgo: number | null) {
    const db = getDb();
    const [assessment] = await db
      .insert(assessments)
      .values({ owner_sub: "history-teacher", name: "History" })
      .returning();
    const [item] = await db
      .insert(items)
      .values({ assessment_id: assessment!.id, position: 0, type: "essay", stem: "Write" })
      .returning();
    const [student] = await db
      .insert(students)
      .values({ owner_sub: "history-teacher", name: "S" })
      .returning();
    const [attempt] = await db
      .insert(attempts)
      .values({
        assessment_id: assessment!.id,
        student_id: student!.id,
        status,
        submitted_at:
          submittedDaysAgo === null ? null : new Date(NOW.getTime() - submittedDaysAgo * DAY),
      })
      .returning();
    await db.insert(response_revisions).values({
      attempt_id: attempt!.id,
      item_id: item!.id,
      response: { type: "essay", text: "kept" },
      saved_at: NOW,
      reason: "shrink",
    });
    return attempt!.id;
  }

  // 6.1 (James, 2026-10-06): history is best-effort. A failing capture rolls
  // back to its savepoint and the student's write in the same transaction
  // still commits.
  test("a failing capture never blocks the write beside it", async () => {
    const attemptId = await attemptWithHistory("in_progress", null);
    const db = getDb();
    await db.execute(sql`delete from response_revisions`);
    const [item] = await db.select().from(items).limit(1);
    await db
      .insert(responses)
      .values({ attempt_id: attemptId, item_id: item!.id, response: { type: "essay", text: "old text" } });

    await db.transaction(async (tx) => {
      // An invalid `now` makes the revision insert throw inside the savepoint.
      const kept = await captureBeforeWrite(
        tx,
        attemptId,
        { id: item!.id, type: "essay" },
        { type: "essay", text: "old text, longer" },
        new Date(Number.NaN),
      );
      expect(kept).toBeNull();
      await tx
        .update(responses)
        .set({ response: { type: "essay", text: "new text" } })
        .where(sql`${responses.attempt_id} = ${attemptId}`);
    });

    const [row] = await db.select().from(responses);
    expect((row!.response as { text: string }).text).toBe("new text");
    expect((await db.select().from(response_revisions)).length).toBe(0);
  });

  test("deletes history only for attempts handed in more than 30 days ago", async () => {
    const old = await attemptWithHistory("submitted", 31);
    const recent = await attemptWithHistory("submitted", 29);
    const open = await attemptWithHistory("in_progress", null);

    const counts = await sweepAnswerHistory(getDb(), NOW);
    expect(counts.response_revisions).toBe(1);

    const left = (await getDb().select().from(response_revisions)).map((r) => r.attempt_id);
    expect(left).not.toContain(old);
    expect(left).toContain(recent);
    expect(left).toContain(open);
  });
});
