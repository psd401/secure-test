// Slice 2 of docs/scoring-corpus-design.md: the corpus runner end to end on
// the test DB with the mock provider — selection, run creation, the research
// row's provenance, idempotency, and the slice-1 guarantee that a run changes
// nothing a teacher sees.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import type { Rubric } from "@secure-test/schema";
import { closeDb, getDb } from "../db/client";
import {
  assessments,
  attempts,
  items,
  responses,
  scores,
  scoring_runs,
  students,
  type ItemRow,
  type ResponseRow,
} from "../db/schema";
import { buildResults, resultsToCsv } from "../lib/scoring/results";
import {
  DuplicateRunLabelError,
  createRun,
  resolveCorpusProvider,
  scoreForCorpus,
  selectCorpusResponses,
  summarizeOutcomes,
} from "../lib/scoring/corpus";

const expectTestDb = () => {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.includes("secure_test_design_tool_test")) {
    throw new Error(`corpus-runner tests require the test DB DATABASE_URL; got: ${url}`);
  }
};

const OWNER = "corpus-runner-teacher";

const RUBRIC: Rubric = {
  style: "analytic",
  criteria: [
    {
      id: "focus",
      name: "Focus",
      levels: [
        { id: "f0", label: "Below", points: 0 },
        { id: "f1", label: "Approaching", points: 1 },
        { id: "f2", label: "Meets", points: 2 },
      ],
    },
    {
      id: "evidence",
      name: "Evidence",
      levels: [
        { id: "e0", label: "Below", points: 0 },
        { id: "e1", label: "Approaching", points: 1 },
        { id: "e2", label: "Meets", points: 2 },
      ],
    },
  ],
};
// The mock provider picks each criterion's MIDDLE level: 1 + 1 of 4.
const MOCK_POINTS = 2;
const RUBRIC_MAX = 4;

let savedProvider: string | undefined;
let savedModel: string | undefined;

beforeAll(() => {
  expectTestDb();
  savedProvider = process.env.ESSAY_SCORER_PROVIDER;
  savedModel = process.env.BEDROCK_ESSAY_SCORE_MODEL;
});

afterEach(async () => {
  const db = getDb();
  await db.execute(sql`truncate table assessments restart identity cascade`);
  await db.execute(sql`truncate table students restart identity cascade`);
  await db.execute(sql`truncate table scoring_runs restart identity cascade`);
});

afterAll(async () => {
  await closeDb();
  if (savedProvider === undefined) delete process.env.ESSAY_SCORER_PROVIDER;
  else process.env.ESSAY_SCORER_PROVIDER = savedProvider;
  if (savedModel === undefined) delete process.env.BEDROCK_ESSAY_SCORE_MODEL;
  else process.env.BEDROCK_ESSAY_SCORE_MODEL = savedModel;
});

interface Seeded {
  assessmentId: string;
  attemptId: string;
  item: ItemRow;
  response: ResponseRow;
}

/**
 * One submitted essay answer, optionally with the teacher's final already on
 * it. `ssid` distinguishes the seeded students; no real identifier anywhere.
 */
async function seedEssay(opts: {
  ssid: string;
  scoring_method?: "ai" | "hybrid" | "human";
  rubric?: Rubric | null;
  humanFinalPoints?: number;
  humanCriterionLevels?: Record<string, string>;
  assessmentId?: string;
  position?: number;
}): Promise<Seeded> {
  const db = getDb();
  let assessmentId = opts.assessmentId;
  if (!assessmentId) {
    const [assessment] = await db
      .insert(assessments)
      .values({ owner_sub: OWNER, name: "Corpus runner" })
      .returning();
    assessmentId = assessment!.id;
  }
  const rubric = opts.rubric === undefined ? RUBRIC : opts.rubric;
  const [item] = await db
    .insert(items)
    .values({
      assessment_id: assessmentId,
      position: opts.position ?? 0,
      type: "essay",
      stem: "Explain the water cycle.",
      config: {
        scoring_method: opts.scoring_method ?? "ai",
        ...(rubric ? { rubric } : {}),
      },
    })
    .returning();
  const [student] = await db
    .insert(students)
    .values({ owner_sub: OWNER, ssid: opts.ssid, name: `Seed ${opts.ssid}` })
    .returning();
  const [attempt] = await db
    .insert(attempts)
    .values({
      assessment_id: assessmentId,
      student_id: student!.id,
      status: "submitted",
      submitted_at: new Date(),
    })
    .returning();
  const [response] = await db
    .insert(responses)
    .values({
      attempt_id: attempt!.id,
      item_id: item!.id,
      response: { type: "essay", text: "Water evaporates, condenses and falls." },
    })
    .returning();
  if (opts.humanFinalPoints !== undefined) {
    await db.insert(scores).values({
      response_id: response!.id,
      method: "human",
      points: opts.humanFinalPoints,
      max_points: RUBRIC_MAX,
      rationale: {
        ...(opts.humanCriterionLevels
          ? {
              criterion_scores: Object.entries(opts.humanCriterionLevels).map(
                ([criterion_id, level_id]) => ({
                  criterion_id,
                  level_id,
                  points: 1,
                  rationale: "",
                }),
              ),
            }
          : {}),
        note: "seen",
      },
      scorer: OWNER,
      status: "final",
      reviewed_by_sub: OWNER,
    });
  }
  return {
    assessmentId,
    attemptId: attempt!.id,
    item: item!,
    response: response!,
  };
}

const mockProvider = () => resolveCorpusProvider({ provider: "mock" });

describe("selectCorpusResponses", () => {
  test("takes submitted essays on ai / hybrid / human items and skips the rest", async () => {
    const db = getDb();
    const ai = await seedEssay({ ssid: "S1", scoring_method: "ai" });
    await seedEssay({ ssid: "S2", scoring_method: "hybrid", assessmentId: ai.assessmentId, position: 1 });
    await seedEssay({ ssid: "S3", scoring_method: "human", assessmentId: ai.assessmentId, position: 2 });
    // An in-progress attempt on the same assessment: not a corpus row.
    const [student] = await db
      .insert(students)
      .values({ owner_sub: OWNER, ssid: "S4", name: "Seed S4" })
      .returning();
    const [openAttempt] = await db
      .insert(attempts)
      .values({ assessment_id: ai.assessmentId, student_id: student!.id, status: "in_progress" })
      .returning();
    await db.insert(responses).values({
      attempt_id: openAttempt!.id,
      item_id: ai.item.id,
      response: { type: "essay", text: "half written" },
    });
    // A non-essay item's answer is never a corpus row.
    const [mc] = await db
      .insert(items)
      .values({
        assessment_id: ai.assessmentId,
        position: 3,
        type: "multiple_choice_single",
        stem: "Pick one",
        choices: [{ id: "a", text: "A" }],
        correct_choice_ids: ["a"],
      })
      .returning();
    await db.insert(responses).values({
      attempt_id: ai.attemptId,
      item_id: mc!.id,
      response: { type: "multiple_choice_single", choice_id: "a" },
    });

    const rows = await selectCorpusResponses(db, { withHumanFinal: false });
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.method).sort()).toEqual(["ai", "human", "hybrid"]);
    expect(new Set(rows.map((r) => r.ownerSub))).toEqual(new Set([OWNER]));
  });

  test("--with-human-final keeps only the essays a teacher has settled", async () => {
    const db = getDb();
    const settled = await seedEssay({ ssid: "S1", humanFinalPoints: 3 });
    await seedEssay({ ssid: "S2", assessmentId: settled.assessmentId, position: 1 });

    const all = await selectCorpusResponses(db, { withHumanFinal: false });
    expect(all).toHaveLength(2);
    const withFinal = await selectCorpusResponses(db, { withHumanFinal: true });
    expect(withFinal).toHaveLength(1);
    expect(withFinal[0]!.response.id).toBe(settled.response.id);
    expect(withFinal[0]!.humanFinal).toMatchObject({ points: 3, max_points: RUBRIC_MAX });
  });

  test("the assessment / item / owner / since / limit filters narrow it", async () => {
    const db = getDb();
    const a = await seedEssay({ ssid: "S1" });
    const b = await seedEssay({ ssid: "S2" }); // its own assessment
    // Another teacher's essay.
    const [other] = await db
      .insert(assessments)
      .values({ owner_sub: "another-teacher", name: "Theirs" })
      .returning();
    await seedEssay({ ssid: "S3", assessmentId: other!.id });

    expect(await selectCorpusResponses(db, { withHumanFinal: false })).toHaveLength(3);
    expect(
      await selectCorpusResponses(db, { withHumanFinal: false, assessment: a.assessmentId }),
    ).toHaveLength(1);
    expect(
      await selectCorpusResponses(db, { withHumanFinal: false, item: b.item.id }),
    ).toHaveLength(1);
    expect(
      await selectCorpusResponses(db, { withHumanFinal: false, owner: OWNER }),
    ).toHaveLength(2);
    expect(
      await selectCorpusResponses(db, { withHumanFinal: false, limit: 2 }),
    ).toHaveLength(2);
    // Every seeded attempt was submitted just now, so tomorrow excludes them.
    const tomorrow = new Date(Date.now() + 24 * 3600 * 1000);
    expect(
      await selectCorpusResponses(db, { withHumanFinal: false, since: tomorrow }),
    ).toHaveLength(0);
  });
});

describe("createRun", () => {
  test("records the provider, prompt version and filter; a used label refuses", async () => {
    const db = getDb();
    const provider = mockProvider();
    const run = await createRun(db, {
      label: "mock vs finals",
      providerId: provider.id,
      promptVersion: provider.promptVersion,
      filter: { with_human_final: true },
      createdBy: "cli:test",
    });
    expect(run.provider_id).toBe("mock");
    expect(run.prompt_version).toBe(provider.promptVersion);
    expect(run.filter).toEqual({ with_human_final: true });
    expect(run.created_by).toBe("cli:test");

    await expect(
      createRun(db, {
        label: "mock vs finals",
        providerId: "mock",
        promptVersion: provider.promptVersion,
        filter: {},
        createdBy: "cli:test",
      }),
    ).rejects.toBeInstanceOf(DuplicateRunLabelError);
  });
});

describe("scoreForCorpus", () => {
  test("writes a research row carrying run_id, prompt_version and the rubric snapshot", async () => {
    const db = getDb();
    const provider = mockProvider();
    const seeded = await seedEssay({ ssid: "S1", humanFinalPoints: 4 });
    const [row] = await selectCorpusResponses(db, { withHumanFinal: true });
    const run = await createRun(db, {
      label: "run one",
      providerId: provider.id,
      promptVersion: provider.promptVersion,
      filter: {},
      createdBy: "cli:test",
    });

    const outcome = await scoreForCorpus({ db, run, row: row!, provider });
    expect(outcome.kind).toBe("scored");

    const written = await db
      .select()
      .from(scores)
      .where(eq(scores.response_id, seeded.response.id));
    const research = written.filter((s) => s.status === "research");
    expect(research).toHaveLength(1);
    const r = research[0]!;
    expect(r.method).toBe("ai");
    expect(r.status).toBe("research");
    expect(r.run_id).toBe(run.id);
    expect(r.scorer).toBe("mock");
    expect(r.prompt_version).toBe(provider.promptVersion);
    expect(r.rubric_snapshot).toEqual(RUBRIC);
    expect(r.points).toBe(MOCK_POINTS);
    expect(r.max_points).toBe(RUBRIC_MAX);
    expect(
      (r.rationale as { criterion_scores: unknown[] }).criterion_scores,
    ).toHaveLength(2);
    expect((r.rationale as { confidence: number }).confidence).toBeGreaterThan(0);
    // The teacher's final is untouched and still the only final.
    expect(written.filter((s) => s.status === "final")).toHaveLength(1);
  });

  test("a research row on a HUMAN-method essay with a final — the population the live routes refuse", async () => {
    const db = getDb();
    const provider = mockProvider();
    await seedEssay({ ssid: "S1", scoring_method: "human", humanFinalPoints: 3 });
    const [row] = await selectCorpusResponses(db, { withHumanFinal: true });
    expect(row!.method).toBe("human");
    const run = await createRun(db, {
      label: "human essays",
      providerId: provider.id,
      promptVersion: provider.promptVersion,
      filter: {},
      createdBy: "cli:test",
    });
    expect((await scoreForCorpus({ db, run, row: row!, provider })).kind).toBe("scored");
  });

  test("an essay whose item has no rubric is unscorable, not an error", async () => {
    const db = getDb();
    const provider = mockProvider();
    await seedEssay({ ssid: "S1", scoring_method: "human", rubric: null });
    const [row] = await selectCorpusResponses(db, { withHumanFinal: false });
    const run = await createRun(db, {
      label: "no rubric",
      providerId: provider.id,
      promptVersion: provider.promptVersion,
      filter: {},
      createdBy: "cli:test",
    });
    const outcome = await scoreForCorpus({ db, run, row: row!, provider });
    expect(outcome.kind).toBe("unscorable");
    expect(await db.select().from(scores)).toHaveLength(0);
    expect(summarizeOutcomes([outcome]).notes).toContain("0 scored, 1 unscorable");
  });

  test("idempotency: the run's own rows drop out of a second selection", async () => {
    const db = getDb();
    const provider = mockProvider();
    const first = await seedEssay({ ssid: "S1" });
    await seedEssay({ ssid: "S2", assessmentId: first.assessmentId, position: 1 });
    const run = await createRun(db, {
      label: "resumable",
      providerId: provider.id,
      promptVersion: provider.promptVersion,
      filter: {},
      createdBy: "cli:test",
    });

    const rows = await selectCorpusResponses(db, { withHumanFinal: false, runId: run.id });
    expect(rows).toHaveLength(2);
    await scoreForCorpus({ db, run, row: rows[0]!, provider });

    const remaining = await selectCorpusResponses(db, {
      withHumanFinal: false,
      runId: run.id,
    });
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.response.id).toBe(rows[1]!.response.id);
    // Without the run id (or under a different run) the response is a
    // candidate again — a second run re-scores the same corpus on purpose.
    expect(await selectCorpusResponses(db, { withHumanFinal: false })).toHaveLength(2);
    const [other] = await db
      .insert(scoring_runs)
      .values({
        label: "another",
        provider_id: "mock",
        prompt_version: provider.promptVersion,
        created_by: "cli:test",
      })
      .returning();
    expect(
      await selectCorpusResponses(db, { withHumanFinal: false, runId: other!.id }),
    ).toHaveLength(2);
  });
});

describe("the slice-1 guarantee", () => {
  test("buildResults and its CSV are byte-identical before and after a run", async () => {
    const db = getDb();
    const provider = mockProvider();
    const seeded = await seedEssay({
      ssid: "S1",
      humanFinalPoints: 3,
      humanCriterionLevels: { focus: "f2", evidence: "e1" },
    });
    await seedEssay({ ssid: "S2", assessmentId: seeded.assessmentId, position: 1 });

    const before = await buildResults(seeded.assessmentId, OWNER);
    const beforeCsv = resultsToCsv(before);

    const run = await createRun(db, {
      label: "invisible",
      providerId: provider.id,
      promptVersion: provider.promptVersion,
      filter: {},
      createdBy: "cli:test",
    });
    const rows = await selectCorpusResponses(db, { withHumanFinal: false, runId: run.id });
    const outcomes = [];
    for (const row of rows) {
      outcomes.push(await scoreForCorpus({ db, run, row, provider }));
    }
    expect(summarizeOutcomes(outcomes).tally.scored).toBe(2);

    const after = await buildResults(seeded.assessmentId, OWNER);
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
    expect(resultsToCsv(after)).toBe(beforeCsv);
  });
});
