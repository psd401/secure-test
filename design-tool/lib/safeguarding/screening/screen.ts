import { after } from "next/server";
import { and, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { ItemResponseSchema } from "@secure-test/schema";
import { getDb } from "@/db/client";
import {
  attempts,
  items,
  responses,
  safeguarding_alerts,
  type AttemptRow,
  type SafeguardingAlertInsert,
  type SafeguardingAlertKind,
} from "@/db/schema";
import { log, truncate } from "@/lib/log";
import { getGuardrailProvider } from "@/lib/safeguarding/provider";
import type { GuardrailProvider } from "@/lib/safeguarding/types";
import { getScreeningProvider } from "./provider";
import type { ScreeningProvider, ScreeningResult } from "./types";

// Safeguarding alerts slice 1 (docs/safeguarding-alerts-design.md): the
// screening pass. Runs over a handed-in attempt's essay / short-text answers
// (D-2, D-3) and writes one `safeguarding_alerts` row per concern:
//   - `wellbeing` when the screener names a category (D-10: any non-`none`
//     category alerts; no confidence threshold);
//   - `prompt_injection` when the screener's injection half OR the
//     guardrail's PROMPT_ATTACK filter fires (S-1 proposal 2 — OR, because
//     the two miss different things).
//
// Never throws, and never touches the hand-in: the callers schedule it after
// the response (scheduleAttemptScreening). A response whose screening fails
// keeps `safeguarding_screened_at` null, so the next pass — the lazy screen
// before a teacher's Score with AI, or a later hand-in after a pass back —
// tries it again.

type Db = ReturnType<typeof getDb>;

const SCREENED_TYPES = ["essay", "short_text"] as const;

export interface ScreeningDeps {
  /** Default: getScreeningProvider(). `null` = screening off. */
  screener?: ScreeningProvider | null;
  /** Default: getGuardrailProvider(). `null` = skip the PROMPT_ATTACK half. */
  guardrail?: GuardrailProvider | null;
}

export interface ScreeningSummary {
  screened: number;
  failed: number;
  alerts: number;
}

const EMPTY: ScreeningSummary = { screened: 0, failed: 0, alerts: 0 };

interface Candidate {
  response: typeof responses.$inferSelect;
  item: { id: string; type: string; stem: string };
  attempt: Pick<AttemptRow, "id" | "assessment_id" | "student_id">;
}

// Never screened, or edited since (a passed-back answer changed on the second
// go has a newer `updated_at`).
const stale = or(
  isNull(responses.safeguarding_screened_at),
  lt(responses.safeguarding_screened_at, responses.updated_at),
);

function resolveDeps(deps: ScreeningDeps): {
  screener: ScreeningProvider | null;
  guardrail: GuardrailProvider | null;
} {
  return {
    screener: deps.screener !== undefined ? deps.screener : getScreeningProvider(),
    guardrail: deps.guardrail !== undefined ? deps.guardrail : getGuardrailProvider(),
  };
}

function errorMessage(err: unknown): string {
  return truncate(err instanceof Error ? err.message : String(err));
}

/** Screen every eligible answer on one attempt. Practice attempts are skipped. */
export async function screenAttempt(
  db: Db,
  attemptId: string,
  deps: ScreeningDeps = {},
): Promise<ScreeningSummary> {
  try {
    const { screener, guardrail } = resolveDeps(deps);
    if (!screener) return { ...EMPTY };
    const [attempt] = await db
      .select()
      .from(attempts)
      .where(eq(attempts.id, attemptId))
      .limit(1);
    if (!attempt || attempt.practice) return { ...EMPTY };
    const rows = await db
      .select({
        response: responses,
        item: { id: items.id, type: items.type, stem: items.stem },
      })
      .from(responses)
      .innerJoin(items, eq(items.id, responses.item_id))
      .where(
        and(
          eq(responses.attempt_id, attempt.id),
          inArray(items.type, [...SCREENED_TYPES]),
          stale,
        ),
      );
    return await screenCandidates(
      db,
      rows.map((r) => ({ ...r, attempt })),
      screener,
      guardrail,
    );
  } catch (err) {
    log.error("safeguarding_check_failed", {
      attempt_id: attemptId,
      message: errorMessage(err),
    });
    return { ...EMPTY };
  }
}

/**
 * Screen one answer if it is eligible and unscreened (or stale). The lazy path
 * before a teacher's Score with AI: covers answers handed in before this
 * shipped and screenings that failed at hand-in. Never throws.
 */
export async function screenResponse(
  db: Db,
  responseId: string,
  deps: ScreeningDeps = {},
): Promise<ScreeningSummary> {
  try {
    const { screener, guardrail } = resolveDeps(deps);
    if (!screener) return { ...EMPTY };
    const rows = await db
      .select({
        response: responses,
        item: { id: items.id, type: items.type, stem: items.stem },
        attempt: {
          id: attempts.id,
          assessment_id: attempts.assessment_id,
          student_id: attempts.student_id,
          practice: attempts.practice,
        },
      })
      .from(responses)
      .innerJoin(items, eq(items.id, responses.item_id))
      .innerJoin(attempts, eq(attempts.id, responses.attempt_id))
      .where(
        and(
          eq(responses.id, responseId),
          inArray(items.type, [...SCREENED_TYPES]),
          eq(attempts.practice, false),
          stale,
        ),
      )
      .limit(1);
    return await screenCandidates(db, rows, screener, guardrail);
  } catch (err) {
    log.error("safeguarding_check_failed", {
      response_id: responseId,
      message: errorMessage(err),
    });
    return { ...EMPTY };
  }
}

async function screenCandidates(
  db: Db,
  candidates: Candidate[],
  screener: ScreeningProvider,
  guardrail: GuardrailProvider | null,
): Promise<ScreeningSummary> {
  const summary: ScreeningSummary = { ...EMPTY };
  for (const candidate of candidates) {
    const parsed = ItemResponseSchema.safeParse(candidate.response.response);
    if (!parsed.success) continue;
    const answer = parsed.data;
    if (answer.type !== "essay" && answer.type !== "short_text") continue;
    if (answer.text.trim().length === 0) continue;
    const outcome = await screenOne(db, candidate, answer.text, screener, guardrail);
    summary.alerts += outcome.alerts;
    if (outcome.ok) summary.screened++;
    else summary.failed++;
  }
  return summary;
}

// One answer: the screener and the guardrail run side by side. Whatever
// succeeded is recorded even if the other half failed (safety-first — a
// wellbeing alert must not wait on a guardrail outage); the answer is marked
// screened only when both halves answered, so a retry fills in the rest and
// the unacknowledged-duplicate rule keeps it from alerting twice.
async function screenOne(
  db: Db,
  { response, item, attempt }: Candidate,
  text: string,
  screener: ScreeningProvider,
  guardrail: GuardrailProvider | null,
): Promise<{ ok: boolean; alerts: number }> {
  const [screened, guarded] = await Promise.allSettled([
    screener.screen({ prompt: item.stem, text }),
    guardrail
      ? guardrail.check(text, { stage: "input", surface: "essay-score" })
      : Promise.resolve(null),
  ]);

  let ok = true;
  for (const [half, settled] of [
    ["screener", screened],
    ["guardrail", guarded],
  ] as const) {
    if (settled.status === "rejected") {
      ok = false;
      log.error("safeguarding_check_failed", {
        response_id: response.id,
        attempt_id: attempt.id,
        detector: half,
        message: errorMessage(settled.reason),
      });
    }
  }

  const result: ScreeningResult | null =
    screened.status === "fulfilled" ? screened.value : null;
  // The guardrail reports a prompt attack as a content filter of that type
  // (bedrockGuardrail.ts extractFindings); the category label is all we read.
  const guardrailInjection =
    guarded.status === "fulfilled" &&
    guarded.value !== null &&
    guarded.value.findings.some(
      (f) => f.type === "content_filter" && f.detail === "PROMPT_ATTACK",
    );

  const base = {
    response_id: response.id,
    attempt_id: attempt.id,
    assessment_id: attempt.assessment_id,
    student_id: attempt.student_id,
    item_id: item.id,
  };
  const inserts: SafeguardingAlertInsert[] = [];
  if (result && result.wellbeing.category !== "none") {
    inserts.push({
      ...base,
      kind: "wellbeing",
      category: result.wellbeing.category,
      confidence: result.wellbeing.confidence,
      evidence: result.wellbeing.evidence,
      detector: screener.id,
    });
  }
  const screenerInjection = result?.injection.detected === true;
  if (screenerInjection || guardrailInjection) {
    inserts.push({
      ...base,
      kind: "prompt_injection",
      category: "prompt_injection",
      confidence: null,
      evidence: screenerInjection ? result!.injection.evidence : "",
      detector:
        screenerInjection && guardrailInjection
          ? `${screener.id}+${guardrail!.id}`
          : screenerInjection
            ? screener.id
            : guardrail!.id,
    });
  }

  let written = 0;
  try {
    for (const row of inserts) {
      if (await hasOpenAlert(db, response.id, row.kind as SafeguardingAlertKind)) {
        continue;
      }
      await db.insert(safeguarding_alerts).values(row);
      written++;
    }
    if (ok) {
      await db
        .update(responses)
        .set({ safeguarding_screened_at: sql`now()` })
        .where(eq(responses.id, response.id));
    }
  } catch (err) {
    log.error("safeguarding_check_failed", {
      response_id: response.id,
      attempt_id: attempt.id,
      message: errorMessage(err),
    });
    return { ok: false, alerts: written };
  }
  return { ok, alerts: written };
}

// A rescreen after an edit must not raise the same concern twice while the
// first is still waiting for the teacher; once acknowledged, a new one may.
async function hasOpenAlert(
  db: Db,
  responseId: string,
  kind: SafeguardingAlertKind,
): Promise<boolean> {
  const [row] = await db
    .select({ id: safeguarding_alerts.id })
    .from(safeguarding_alerts)
    .where(
      and(
        eq(safeguarding_alerts.response_id, responseId),
        eq(safeguarding_alerts.kind, kind),
        isNull(safeguarding_alerts.acknowledged_at),
      ),
    )
    .limit(1);
  return row !== undefined;
}

/**
 * The hand-in hook (D-2). Runs `screenAttempt` after the response is sent, via
 * Next's `after()`, so a hand-in never waits on the screener or fails with it.
 * Outside a request scope (`after` throws — a route handler called directly
 * from a test, a script) it falls back to fire-and-forget. With screening off
 * it does nothing at all.
 */
export function scheduleAttemptScreening(attemptId: string, db: Db = getDb()): void {
  let screener: ScreeningProvider | null;
  try {
    screener = getScreeningProvider();
  } catch (err) {
    log.error("safeguarding_check_failed", {
      attempt_id: attemptId,
      message: errorMessage(err),
    });
    return;
  }
  if (!screener) return;
  const run = () => screenAttempt(db, attemptId, { screener });
  try {
    after(run);
  } catch {
    void run();
  }
}
