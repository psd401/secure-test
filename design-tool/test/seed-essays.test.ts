// Pilot essay seeding (lib/dev/seedEssays.ts).
//
// This seeder writes to the PRODUCTION database by design — it is how the
// pilot's "Score with AI" path gets essays to score without five real
// sittings — so the refusals matter more than the happy path. Every test
// below that expects a refusal also asserts that NOTHING was written: a
// half-seeded class on the origin is the failure this design is shaped
// against.
//
//   DATABASE_URL=postgres://$USER@localhost:5432/secure_test_design_tool_test \
//     bun test test/seed-essays.test.ts
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { closeDb, getDb } from "../db/client";
import {
  assessments,
  attempt_events,
  attempts,
  items,
  responses,
  students,
  test_sessions,
  roster_students,
} from "../db/schema";
import { SAMPLE_ESSAYS } from "../lib/dev/sampleEssays";
import {
  SeedEssaysError,
  seedEssays,
  type SeedEssaysStudent,
} from "../lib/dev/seedEssays";

const OWNER = "seed-essays-owner-sub";
// Repeated-digit placeholders, the shape the repo uses everywhere a real
// identifier would otherwise sit (see test/roster-fixture-synthetic-ids).
const ALPHA = "55555";
const BETA = "66666";

const expectTestDb = () => {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.includes("secure_test_design_tool_test")) {
    throw new Error(`seed-essays tests require the test DB; got: ${url}`);
  }
};

const db = () => getDb();

beforeAll(() => {
  expectTestDb();
});

afterEach(async () => {
  await db().execute(
    sql`truncate table assessments, students, roster_students restart identity cascade`,
  );
});

afterAll(async () => {
  await closeDb();
});

async function seedRosterStudent(ps_id: string) {
  await db()
    .insert(roster_students)
    .values({
      ps_id,
      ssid: null,
      email: `student-${ps_id}@edtools.psd401.net`,
      first_name: "Fixture",
      last_name: `Student ${ps_id}`,
      enroll_status: 0,
      last_seen_snapshot_id: "seed-essays-test",
    });
}

type SceneOptions = {
  status?: string;
  sittingStatus?: string;
  code?: string;
  expiresAt?: Date;
  /** Item types on the assessment, in position order. */
  itemTypes?: string[];
};

async function scene(opts: SceneOptions = {}) {
  const [assessment] = await db()
    .insert(assessments)
    .values({
      owner_sub: OWNER,
      name: "Pilot essay fixture",
      status: opts.status ?? "published",
    })
    .returning();
  const itemTypes = opts.itemTypes ?? ["essay"];
  const itemRows = await db()
    .insert(items)
    .values(
      itemTypes.map((type, i) => ({
        assessment_id: assessment!.id,
        position: i + 1,
        type,
        stem: `Item ${i + 1}`,
        config: {},
      })),
    )
    .returning();
  const [sitting] = await db()
    .insert(test_sessions)
    .values({
      assessment_id: assessment!.id,
      owner_sub: OWNER,
      owner_email: "teacher.one@psd401.net",
      code: opts.code ?? "ABC123",
      status: opts.sittingStatus ?? "open",
      expires_at: opts.expiresAt ?? new Date(Date.now() + 60 * 60 * 1000),
    })
    .returning();
  return { assessment: assessment!, items: itemRows, sitting: sitting! };
}

const run = (
  assessmentId: string,
  studentList: SeedEssaysStudent[],
  extra: { sessionCode?: string; dryRun?: boolean } = {},
) =>
  seedEssays(db(), {
    assessmentId,
    sessionCode: extra.sessionCode ?? "ABC123",
    students: studentList,
    dryRun: extra.dryRun,
  });

async function attemptCount(): Promise<number> {
  const rows = await db().select({ id: attempts.id }).from(attempts);
  return rows.length;
}

describe("seedEssays — the happy path mirrors join + answer + hand in", () => {
  test("writes one submitted attempt with the sample essay on it", async () => {
    const { assessment, items: itemRows, sitting } = await scene();
    await seedRosterStudent(ALPHA);

    const result = await run(assessment.id, [
      { studentNumber: ALPHA, quality: "high" },
    ]);

    expect(result.dryRun).toBe(false);
    expect(result.written).toHaveLength(1);
    expect(result.essayItemIds).toEqual([itemRows[0]!.id]);
    expect(result.skippedItems).toEqual([]);

    const [attempt] = await db()
      .select()
      .from(attempts)
      .where(eq(attempts.id, result.written[0]!.attemptId));
    expect(attempt!.status).toBe("submitted");
    expect(attempt!.submitted_at).not.toBeNull();
    // The teacher did not hand this in — the column that says so stays null.
    expect(attempt!.submitted_by_sub).toBeNull();
    expect(attempt!.test_session_id).toBe(sitting.id);
    expect(attempt!.assessment_id).toBe(assessment.id);

    const answerRows = await db()
      .select()
      .from(responses)
      .where(eq(responses.attempt_id, attempt!.id));
    expect(answerRows).toHaveLength(1);
    expect(answerRows[0]!.item_id).toBe(itemRows[0]!.id);
    expect(answerRows[0]!.response).toEqual({
      type: "essay",
      text: SAMPLE_ESSAYS.high.text,
    });

    // The overlay row the join route would have created, bound to the roster
    // student and owned by the assessment's owner.
    const [overlay] = await db()
      .select()
      .from(students)
      .where(eq(students.id, attempt!.student_id));
    expect(overlay!.owner_sub).toBe(OWNER);
    expect(overlay!.roster_ps_id).toBe(ALPHA);

    const events = await db()
      .select()
      .from(attempt_events)
      .where(eq(attempt_events.attempt_id, attempt!.id));
    expect(events.map((e) => e.kind).sort()).toEqual(["lockdown_begin", "lockdown_end"]);
  });

  test("seeds several students at different qualities and reuses an existing overlay row", async () => {
    const { assessment } = await scene();
    await seedRosterStudent(ALPHA);
    await seedRosterStudent(BETA);
    // ALPHA already has this teacher's student row (a previous sitting).
    const [existingOverlay] = await db()
      .insert(students)
      .values({ owner_sub: OWNER, roster_ps_id: ALPHA, name: "Fixture Student" })
      .returning();

    const result = await run(assessment.id, [
      { studentNumber: ALPHA, quality: "brief" },
      { studentNumber: BETA, quality: "offtopic" },
    ]);

    expect(result.written).toHaveLength(2);
    expect(result.written[0]!.studentId).toBe(existingOverlay!.id);
    expect(result.written[0]!.quality).toBe("brief");
    expect(result.written[1]!.quality).toBe("offtopic");
    expect(result.written[0]!.words).toBeLessThan(result.written[1]!.words);
    expect(await attemptCount()).toBe(2);
  });

  test("non-essay items are skipped, not answered", async () => {
    const { assessment, items: itemRows } = await scene({
      itemTypes: ["multiple_choice_single", "essay"],
    });
    await seedRosterStudent(ALPHA);

    const result = await run(assessment.id, [{ studentNumber: ALPHA, quality: "mid" }]);

    expect(result.essayItemIds).toEqual([itemRows[1]!.id]);
    expect(result.skippedItems).toEqual([
      { id: itemRows[0]!.id, type: "multiple_choice_single", position: 1 },
    ]);
    const answerRows = await db().select().from(responses);
    expect(answerRows).toHaveLength(1);
    expect(answerRows[0]!.item_id).toBe(itemRows[1]!.id);
  });
});

describe("seedEssays — --dry-run", () => {
  test("validates and writes nothing at all", async () => {
    const { assessment } = await scene();
    await seedRosterStudent(ALPHA);

    const result = await run(
      assessment.id,
      [{ studentNumber: ALPHA, quality: "low" }],
      { dryRun: true },
    );

    expect(result.dryRun).toBe(true);
    expect(result.written).toEqual([]);
    expect(result.planned).toHaveLength(1);
    expect(result.planned[0]!.overlayWillBeCreated).toBe(true);
    expect(result.planned[0]!.studentId).toBeNull();
    expect(await attemptCount()).toBe(0);
    expect(await db().select().from(students)).toHaveLength(0);
    expect(await db().select().from(responses)).toHaveLength(0);
  });

  test("a dry run still refuses what the real run would refuse", async () => {
    const { assessment } = await scene();
    // No roster row for ALPHA.
    await expect(
      run(assessment.id, [{ studentNumber: ALPHA, quality: "low" }], { dryRun: true }),
    ).rejects.toThrow(SeedEssaysError);
  });
});

describe("seedEssays — refusals leave the database untouched", () => {
  test("a closed sitting", async () => {
    const { assessment } = await scene({ sittingStatus: "closed" });
    await seedRosterStudent(ALPHA);
    await expect(
      run(assessment.id, [{ studentNumber: ALPHA, quality: "high" }]),
    ).rejects.toThrow(/no OPEN sitting/);
    expect(await attemptCount()).toBe(0);
  });

  test("an expired sitting", async () => {
    const { assessment } = await scene({ expiresAt: new Date(Date.now() - 1000) });
    await seedRosterStudent(ALPHA);
    await expect(
      run(assessment.id, [{ studentNumber: ALPHA, quality: "high" }]),
    ).rejects.toThrow(/expired/);
    expect(await attemptCount()).toBe(0);
  });

  test("the wrong session code", async () => {
    const { assessment } = await scene({ code: "ABC123" });
    await seedRosterStudent(ALPHA);
    await expect(
      run(assessment.id, [{ studentNumber: ALPHA, quality: "high" }], {
        sessionCode: "ZZZ999",
      }),
    ).rejects.toThrow(/no OPEN sitting with code "ZZZ999"/);
    expect(await attemptCount()).toBe(0);
  });

  test("an assessment that is still a draft", async () => {
    const { assessment } = await scene({ status: "draft" });
    await seedRosterStudent(ALPHA);
    await expect(
      run(assessment.id, [{ studentNumber: ALPHA, quality: "high" }]),
    ).rejects.toThrow(/publish it first/);
    expect(await attemptCount()).toBe(0);
  });

  test("an assessment id nobody has", async () => {
    await expect(
      run("00000000-0000-4000-8000-000000000000", [
        { studentNumber: ALPHA, quality: "high" },
      ]),
    ).rejects.toThrow(/not found/);
  });

  test("an assessment with no essay items", async () => {
    const { assessment } = await scene({ itemTypes: ["multiple_choice_single"] });
    await seedRosterStudent(ALPHA);
    await expect(
      run(assessment.id, [{ studentNumber: ALPHA, quality: "high" }]),
    ).rejects.toThrow(/no essay items/);
    expect(await attemptCount()).toBe(0);
  });

  test("a student number that is not on the roster", async () => {
    const { assessment } = await scene();
    await expect(
      run(assessment.id, [{ studentNumber: ALPHA, quality: "high" }]),
    ).rejects.toThrow(/not on the roster/);
    expect(await attemptCount()).toBe(0);
  });

  test("a student who already has an attempt — named, so it can be deleted", async () => {
    const { assessment } = await scene();
    await seedRosterStudent(ALPHA);
    const first = await run(assessment.id, [{ studentNumber: ALPHA, quality: "high" }]);
    const attemptId = first.written[0]!.attemptId;

    await expect(
      run(assessment.id, [{ studentNumber: ALPHA, quality: "mid" }]),
    ).rejects.toThrow(new RegExp(attemptId));
    expect(await attemptCount()).toBe(1);
  });

  test("one bad student in the list writes NOTHING for the good ones", async () => {
    const { assessment } = await scene();
    await seedRosterStudent(ALPHA);
    // BETA has no roster row.
    await expect(
      run(assessment.id, [
        { studentNumber: ALPHA, quality: "high" },
        { studentNumber: BETA, quality: "mid" },
      ]),
    ).rejects.toThrow(/not on the roster/);
    expect(await attemptCount()).toBe(0);
    expect(await db().select().from(students)).toHaveLength(0);
  });

  test("a student number that is not 5-8 digits", async () => {
    const { assessment } = await scene();
    await expect(
      run(assessment.id, [{ studentNumber: "42", quality: "high" }]),
    ).rejects.toThrow(/not a student number/);
  });

  test("the same student twice", async () => {
    const { assessment } = await scene();
    await seedRosterStudent(ALPHA);
    await expect(
      run(assessment.id, [
        { studentNumber: ALPHA, quality: "high" },
        { studentNumber: ALPHA, quality: "low" },
      ]),
    ).rejects.toThrow(/given twice/);
    expect(await attemptCount()).toBe(0);
  });

  test("an unknown quality", async () => {
    const { assessment } = await scene();
    await seedRosterStudent(ALPHA);
    await expect(
      run(assessment.id, [
        { studentNumber: ALPHA, quality: "excellent" as unknown as "high" },
      ]),
    ).rejects.toThrow(/unknown quality "excellent"/);
    expect(await attemptCount()).toBe(0);
  });

  test("no students at all", async () => {
    const { assessment } = await scene();
    await expect(run(assessment.id, [])).rejects.toThrow(/no --student given/);
  });
});
