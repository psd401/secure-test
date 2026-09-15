import { and, asc, eq, gte, inArray } from "drizzle-orm";
import type { ScoringMethod } from "@secure-test/schema";
import type { getDb } from "@/db/client";
import {
  assessments,
  attempts,
  items,
  responses,
  scores,
  scoring_runs,
  type ItemRow,
  type ItemType,
  type ResponseRow,
  type ScoringRunRow,
} from "@/db/schema";
import { getEssayScorerProvider } from "@/lib/ai/essayScorer/provider";
import type { EssayScorerProvider } from "@/lib/ai/essayScorer/types";
import { effectiveScoringMethod } from "@/lib/api/items";
import {
  runEssayScorer,
  type UnscorableReason,
} from "@/lib/scoring/aiScoreResponse";
import { UUID_RE } from "@/lib/uuid";

// Slice 2 of docs/scoring-corpus-design.md: the corpus runner's logic.
// scripts/score-corpus.ts is the thin CLI over this file.
//
// Two rules the note is explicit about and this file enforces:
//   - a run is identified by its LABEL and a label is used once — re-running
//     the same label refuses rather than doubling a data set;
//   - the provider runs through the SAME guarded path the live route uses
//     (`runEssayScorer`, guardrail surface `essay-score`, ownerSub = the
//     assessment owner so `ai_usage` attributes spend as today). Only the
//     persistence differs: a `research` row carrying run_id, prompt_version
//     and the item's rubric as rubric_snapshot.
//
// Nothing here prints or reads a student identifier — response, item and
// attempt ids only (the note's last "deliberately does not do").

type Db = ReturnType<typeof getDb>;

export const CORPUS_PROVIDERS = ["mock", "bedrock"] as const;
export type CorpusProviderName = (typeof CORPUS_PROVIDERS)[number];

/** The effective scoring methods a corpus run re-scores. `human` is the point
 * of the exercise: those are the essays a teacher has already settled. */
export const CORPUS_METHODS: readonly ScoringMethod[] = ["ai", "hybrid", "human"];

export const MAX_CONCURRENCY = 4;

export class CorpusArgsError extends Error {
  readonly name = "CorpusArgsError";
}

export class DuplicateRunLabelError extends Error {
  readonly name = "DuplicateRunLabelError";
  constructor(readonly label: string) {
    super(`a scoring run labelled "${label}" already exists — pick a new label`);
  }
}

export interface CorpusOptions {
  label: string;
  assessment?: string;
  item?: string;
  owner?: string;
  withHumanFinal: boolean;
  since?: Date;
  limit?: number;
  provider: CorpusProviderName;
  model?: string;
  concurrency: number;
  dryRun: boolean;
}

const VALUE_FLAGS = [
  "--label",
  "--assessment",
  "--item",
  "--owner",
  "--since",
  "--limit",
  "--provider",
  "--model",
  "--concurrency",
] as const;
const BOOL_FLAGS = ["--with-human-final", "--dry-run"] as const;

/**
 * Parse the runner's argv (already sliced past `bun script.ts`).
 *
 * Unknown flags are rejected rather than ignored: a typo'd `--assessments`
 * that silently widened a Bedrock run to every essay in the database is the
 * exact mistake worth failing on.
 */
export function parseCorpusArgs(argv: readonly string[]): CorpusOptions {
  const raw = new Map<string, string>();
  const flags = new Set<string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) {
      throw new CorpusArgsError(`unexpected argument "${arg}" — every input is a --flag`);
    }
    // --flag=value as well as --flag value.
    const eq = arg.indexOf("=");
    const name = eq === -1 ? arg : arg.slice(0, eq);
    if ((BOOL_FLAGS as readonly string[]).includes(name)) {
      if (eq !== -1) {
        throw new CorpusArgsError(`${name} takes no value`);
      }
      flags.add(name);
      continue;
    }
    if (!(VALUE_FLAGS as readonly string[]).includes(name)) {
      throw new CorpusArgsError(
        `unknown flag "${name}". Known flags: ${[...VALUE_FLAGS, ...BOOL_FLAGS].join(", ")}`,
      );
    }
    const value = eq === -1 ? argv[++i] : arg.slice(eq + 1);
    if (value === undefined || value.startsWith("--")) {
      throw new CorpusArgsError(`${name} needs a value`);
    }
    if (raw.has(name)) {
      throw new CorpusArgsError(`${name} given twice`);
    }
    raw.set(name, value);
  }

  const label = raw.get("--label")?.trim();
  if (!label) {
    throw new CorpusArgsError("--label is required — it is the run's identity");
  }

  const uuidOpt = (name: string): string | undefined => {
    const value = raw.get(name);
    if (value === undefined) return undefined;
    if (!UUID_RE.test(value)) {
      throw new CorpusArgsError(`${name} must be a uuid; got "${value}"`);
    }
    return value;
  };

  let since: Date | undefined;
  const sinceRaw = raw.get("--since");
  if (sinceRaw !== undefined) {
    const parsed = new Date(sinceRaw);
    if (Number.isNaN(parsed.getTime())) {
      throw new CorpusArgsError(`--since must be a date; got "${sinceRaw}"`);
    }
    since = parsed;
  }

  let limit: number | undefined;
  const limitRaw = raw.get("--limit");
  if (limitRaw !== undefined) {
    limit = Number(limitRaw);
    if (!Number.isInteger(limit) || limit < 1) {
      throw new CorpusArgsError(`--limit must be a positive integer; got "${limitRaw}"`);
    }
  }

  const providerRaw =
    raw.get("--provider") ?? process.env.ESSAY_SCORER_PROVIDER ?? "mock";
  if (!(CORPUS_PROVIDERS as readonly string[]).includes(providerRaw)) {
    throw new CorpusArgsError(
      `--provider must be one of ${CORPUS_PROVIDERS.join(", ")}; got "${providerRaw}"`,
    );
  }

  let concurrency = 1;
  const concurrencyRaw = raw.get("--concurrency");
  if (concurrencyRaw !== undefined) {
    concurrency = Number(concurrencyRaw);
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > MAX_CONCURRENCY) {
      throw new CorpusArgsError(
        `--concurrency must be an integer 1-${MAX_CONCURRENCY}; got "${concurrencyRaw}"`,
      );
    }
  }

  const model = raw.get("--model");
  if (model !== undefined && providerRaw !== "bedrock") {
    throw new CorpusArgsError("--model only applies to --provider bedrock");
  }

  const assessment = uuidOpt("--assessment");
  const item = uuidOpt("--item");
  const owner = raw.get("--owner")?.trim();

  return {
    label,
    ...(assessment ? { assessment } : {}),
    ...(item ? { item } : {}),
    ...(owner ? { owner } : {}),
    withHumanFinal: flags.has("--with-human-final"),
    ...(since ? { since } : {}),
    ...(limit !== undefined ? { limit } : {}),
    provider: providerRaw as CorpusProviderName,
    ...(model !== undefined ? { model } : {}),
    concurrency,
    dryRun: flags.has("--dry-run"),
  };
}

/**
 * The provider the run uses. `--model` is applied by setting
 * BEDROCK_ESSAY_SCORE_MODEL for the process — the Bedrock provider reads it
 * lazily (both for the model id it calls and for its own `id`, which becomes
 * `scores.scorer`), so there is no second way in.
 */
export function resolveCorpusProvider(opts: {
  provider: CorpusProviderName;
  model?: string;
}): EssayScorerProvider {
  process.env.ESSAY_SCORER_PROVIDER = opts.provider;
  if (opts.model) process.env.BEDROCK_ESSAY_SCORE_MODEL = opts.model;
  return getEssayScorerProvider();
}

/** The selection, recorded verbatim on the run row (never replayed). */
export function corpusFilter(opts: CorpusOptions): Record<string, unknown> {
  return {
    ...(opts.assessment ? { assessment: opts.assessment } : {}),
    ...(opts.item ? { item: opts.item } : {}),
    ...(opts.owner ? { owner: opts.owner } : {}),
    with_human_final: opts.withHumanFinal,
    ...(opts.since ? { since: opts.since.toISOString() } : {}),
    ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
    methods: CORPUS_METHODS,
  };
}

/** A human final as the comparison needs it — points and the rationale that
 * may carry `criterion_scores`. No student identity. */
export interface HumanFinal {
  score_id: string;
  points: number;
  max_points: number;
  rationale: unknown;
}

export interface CorpusRow {
  response: ResponseRow;
  item: ItemRow;
  /** The assessment owner — the guardrail's / ai_usage's `ownerSub`. */
  ownerSub: string;
  attemptId: string;
  method: ScoringMethod;
  humanFinal: HumanFinal | null;
}

export interface SelectCorpusOptions
  extends Pick<
    CorpusOptions,
    "assessment" | "item" | "owner" | "withHumanFinal" | "since" | "limit"
  > {
  /**
   * When given, responses that already carry a `research` row for THIS run are
   * excluded. That is the runner's idempotency: a run interrupted halfway can
   * be resumed against its own row without re-billing what it already scored.
   */
  runId?: string;
}

/**
 * Essay responses eligible for a corpus run.
 *
 * The scoring-method test is `effectiveScoringMethod`, which reads the item's
 * config in TypeScript (defaults per type, the table special case), so it
 * cannot be pushed into SQL — the SQL narrows to submitted attempts and essay
 * items and the method / human-final / already-scored tests run in JS over
 * that candidate set. `--limit` is applied LAST, after every filter, so it
 * means "score at most N of the matching essays" rather than "look at N rows".
 */
export async function selectCorpusResponses(
  db: Db,
  opts: SelectCorpusOptions,
): Promise<CorpusRow[]> {
  const where = [eq(attempts.status, "submitted"), eq(items.type, "essay")];
  if (opts.assessment) where.push(eq(items.assessment_id, opts.assessment));
  if (opts.item) where.push(eq(items.id, opts.item));
  if (opts.owner) where.push(eq(assessments.owner_sub, opts.owner));
  if (opts.since) where.push(gte(attempts.submitted_at, opts.since));

  const candidates = await db
    .select({
      response: responses,
      item: items,
      ownerSub: assessments.owner_sub,
      attemptId: attempts.id,
    })
    .from(responses)
    .innerJoin(attempts, eq(attempts.id, responses.attempt_id))
    .innerJoin(items, eq(items.id, responses.item_id))
    .innerJoin(assessments, eq(assessments.id, items.assessment_id))
    .where(and(...where))
    .orderBy(asc(responses.created_at), asc(responses.id));

  if (candidates.length === 0) return [];

  const scoreRows = await db
    .select({
      id: scores.id,
      response_id: scores.response_id,
      method: scores.method,
      status: scores.status,
      points: scores.points,
      max_points: scores.max_points,
      rationale: scores.rationale,
      run_id: scores.run_id,
    })
    .from(scores)
    .where(inArray(scores.response_id, candidates.map((c) => c.response.id)));

  const finalByResponse = new Map<string, HumanFinal>();
  const alreadyInRun = new Set<string>();
  for (const s of scoreRows) {
    if (s.method === "human" && s.status === "final") {
      finalByResponse.set(s.response_id, {
        score_id: s.id,
        points: s.points,
        max_points: s.max_points,
        rationale: s.rationale,
      });
    }
    if (opts.runId && s.status === "research" && s.run_id === opts.runId) {
      alreadyInRun.add(s.response_id);
    }
  }

  const rows: CorpusRow[] = [];
  for (const c of candidates) {
    const method = effectiveScoringMethod(c.item.type as ItemType, c.item.config);
    if (!CORPUS_METHODS.includes(method)) continue;
    if (alreadyInRun.has(c.response.id)) continue;
    const humanFinal = finalByResponse.get(c.response.id) ?? null;
    if (opts.withHumanFinal && !humanFinal) continue;
    rows.push({
      response: c.response,
      item: c.item,
      ownerSub: c.ownerSub,
      attemptId: c.attemptId,
      method,
      humanFinal,
    });
    if (opts.limit !== undefined && rows.length >= opts.limit) break;
  }
  return rows;
}

export async function createRun(
  db: Db,
  opts: {
    label: string;
    providerId: string;
    promptVersion: string;
    filter: Record<string, unknown>;
    createdBy: string;
  },
): Promise<ScoringRunRow> {
  const existing = await db
    .select({ id: scoring_runs.id })
    .from(scoring_runs)
    .where(eq(scoring_runs.label, opts.label))
    .limit(1);
  if (existing.length > 0) throw new DuplicateRunLabelError(opts.label);
  // The unique index is the real guard — the select above only turns the
  // common case into a named error instead of a Postgres message.
  const [run] = await db
    .insert(scoring_runs)
    .values({
      label: opts.label,
      provider_id: opts.providerId,
      prompt_version: opts.promptVersion,
      filter: opts.filter,
      created_by: opts.createdBy,
    })
    .onConflictDoNothing()
    .returning();
  if (!run) throw new DuplicateRunLabelError(opts.label);
  return run;
}

export type CorpusOutcome =
  | { kind: "scored"; score_id: string; points: number; max_points: number }
  | { kind: "unscorable"; reason: UnscorableReason | "not_essay_method" }
  | { kind: "blocked" }
  | { kind: "provider_error" }
  | { kind: "bounds"; reason: string };

export type CorpusOutcomeKind = CorpusOutcome["kind"];

/**
 * Score one corpus row and persist it as a `research` row.
 *
 * `status: 'research'` never collides with the one-final-per-response index
 * and every teacher-facing reader excludes it (slice 1's sweep), so this can
 * run over essays that already carry a teacher's final — which is the
 * population the study wants and the two live routes refuse.
 */
export async function scoreForCorpus(opts: {
  db: Db;
  run: Pick<ScoringRunRow, "id">;
  row: CorpusRow;
  provider: EssayScorerProvider;
}): Promise<CorpusOutcome> {
  const { db, run, row, provider } = opts;
  const attempt = await runEssayScorer({
    item: row.item,
    response: row.response,
    ownerSub: row.ownerSub,
    allowedMethods: CORPUS_METHODS,
    provider,
  });
  if (attempt.kind === "not_ai") {
    return { kind: "unscorable", reason: "not_essay_method" };
  }
  if (attempt.kind !== "ok") return attempt;

  const { result } = attempt;
  const [inserted] = await db
    .insert(scores)
    .values({
      response_id: row.response.id,
      method: "ai",
      points: result.points,
      max_points: result.max_points,
      rationale: {
        criterion_scores: result.criterion_scores,
        overall_rationale: result.overall_rationale,
        confidence: result.confidence,
      },
      scorer: provider.id,
      status: "research",
      run_id: run.id,
      prompt_version: provider.promptVersion,
      // The rubric AS AUTHORED at run time: items' rubrics are edited in
      // place, so the run keeps its own copy of what it scored against.
      rubric_snapshot: attempt.rubric,
    })
    .returning({ id: scores.id });
  return {
    kind: "scored",
    score_id: inserted!.id,
    points: result.points,
    max_points: result.max_points,
  };
}

export type OutcomeTally = Record<CorpusOutcomeKind, number> & { total: number };

export function summarizeOutcomes(outcomes: readonly CorpusOutcome[]): {
  tally: OutcomeTally;
  notes: string;
} {
  const tally: OutcomeTally = {
    total: outcomes.length,
    scored: 0,
    unscorable: 0,
    blocked: 0,
    provider_error: 0,
    bounds: 0,
  };
  for (const o of outcomes) tally[o.kind] += 1;
  const notes = [
    `${tally.scored} scored`,
    `${tally.unscorable} unscorable`,
    `${tally.blocked} blocked`,
    `${tally.provider_error} provider errors`,
    `${tally.bounds} bounds failures`,
    `of ${tally.total}`,
  ].join(", ");
  return { tally, notes };
}

export async function setRunNotes(
  db: Db,
  runId: string,
  notes: string,
): Promise<void> {
  await db.update(scoring_runs).set({ notes }).where(eq(scoring_runs.id, runId));
}
