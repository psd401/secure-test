import { and, count, desc, eq, inArray, isNull, type SQL } from "drizzle-orm";
import type { getDb } from "@/db/client";
import {
  assessments,
  safeguarding_alerts,
  students,
  type SafeguardingAlertRow,
} from "@/db/schema";
import type { SessionPayload } from "@/lib/auth/session";
import { assessmentOwner, buildResults } from "@/lib/scoring/results";

// Safeguarding alerts slice 2 (docs/safeguarding-alerts-design.md): the reads
// the teacher and admin surfaces share, and the one write (Acknowledge). Every
// function here assumes its caller already cleared access — the per-assessment
// ones through `authorizeAssessment` / `pageAssessment` (view), the district
// ones through `isAdmin` — the same precondition `buildResults` carries.

type Db = ReturnType<typeof getDb>;

/** One alert as the routes return it. Instants are ISO strings. */
export interface AlertView {
  id: string;
  kind: string;
  category: string;
  confidence: number | null;
  evidence: string;
  detector: string;
  created_at: string;
  acknowledged_at: string | null;
  acknowledged_by_email: string | null;
  ai_forced_at: string | null;
  response_id: string | null;
  attempt_id: string | null;
  item_id: string | null;
  /** 0-based, like `items.position`; null when the item has since been removed. */
  item_position: number | null;
  student: { name: string; section: string | null };
}

/** The admin list adds where the alert came from. */
export interface DistrictAlertView extends AlertView {
  assessment_id: string | null;
  assessment_name: string | null;
  owner_email: string | null;
}

function iso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

/** An alert with nothing resolved yet — the name / section / item are filled later. */
function baseView(row: SafeguardingAlertRow): Omit<AlertView, "item_position" | "student"> {
  return {
    id: row.id,
    kind: row.kind,
    category: row.category,
    confidence: row.confidence,
    evidence: row.evidence,
    detector: row.detector,
    created_at: row.created_at.toISOString(),
    acknowledged_at: iso(row.acknowledged_at),
    acknowledged_by_email: row.acknowledged_by_email,
    ai_forced_at: iso(row.ai_forced_at),
    response_id: row.response_id,
    attempt_id: row.attempt_id,
    item_id: row.item_id,
  };
}

const UNKNOWN_STUDENT = { name: "(unknown)", section: null } as const;

/**
 * Names, sections and question numbers for one assessment's alerts.
 *
 * Identity comes from `buildResults` — the same owner-scoped resolution the
 * results matrix and the per-student page use, so an alert can never name a
 * student differently from the row it links to. An alert whose attempt has
 * since been deleted (D-6 keeps the alert) falls back to the owner's overlay
 * row by `student_id`, with no section; a student row that is gone too reads
 * "(unknown)".
 */
async function resolveForAssessment(
  db: Db,
  assessmentId: string,
  rows: SafeguardingAlertRow[],
): Promise<AlertView[]> {
  if (rows.length === 0) return [];
  const results = await buildResults(assessmentId, { include_in_progress: true });
  const byAttempt = new Map(
    results.rows.map((r) => [
      r.attempt_id,
      { name: r.student.name || r.student.ssid || "(unknown)", section: r.student.section },
    ]),
  );
  const positionByItem = new Map(results.items.map((i) => [i.id, i.position]));

  const orphanStudentIds = [
    ...new Set(
      rows
        .filter((r) => !r.attempt_id || !byAttempt.has(r.attempt_id))
        .map((r) => r.student_id)
        .filter((v): v is string => !!v),
    ),
  ];
  const orphanNames = new Map<string, string>();
  if (orphanStudentIds.length > 0) {
    const { ownerSub } = await assessmentOwner(db, assessmentId);
    const found = await db
      .select({ id: students.id, name: students.name, ssid: students.ssid })
      .from(students)
      .where(and(eq(students.owner_sub, ownerSub), inArray(students.id, orphanStudentIds)));
    for (const s of found) orphanNames.set(s.id, s.name || s.ssid || "(unknown)");
  }

  return rows.map((row) => {
    const fromResults = row.attempt_id ? byAttempt.get(row.attempt_id) : undefined;
    const orphan = row.student_id ? orphanNames.get(row.student_id) : undefined;
    return {
      ...baseView(row),
      item_position: row.item_id ? (positionByItem.get(row.item_id) ?? null) : null,
      student: fromResults ?? (orphan ? { name: orphan, section: null } : { ...UNKNOWN_STUDENT }),
    };
  });
}

/** One assessment's alerts, newest first; `openOnly` = unacknowledged only. */
export async function listAssessmentAlerts(
  db: Db,
  assessmentId: string,
  options: { openOnly?: boolean } = {},
): Promise<AlertView[]> {
  const rows = await db
    .select()
    .from(safeguarding_alerts)
    .where(
      and(
        eq(safeguarding_alerts.assessment_id, assessmentId),
        options.openOnly ? isNull(safeguarding_alerts.acknowledged_at) : undefined,
      ),
    )
    .orderBy(desc(safeguarding_alerts.created_at), desc(safeguarding_alerts.id));
  return resolveForAssessment(db, assessmentId, rows);
}

/**
 * Every alert in the district, newest first, for the system admin (D-7).
 * Resolved one assessment at a time through the same path as the teacher
 * list, then merged back into one newest-first list. An alert whose
 * assessment has been deleted (D-6: the alert survives it) keeps its date,
 * category and evidence and reads "(unknown)" for everything else.
 */
export async function listDistrictAlerts(
  db: Db,
  options: { openOnly?: boolean } = {},
): Promise<DistrictAlertView[]> {
  const rows = await db
    .select()
    .from(safeguarding_alerts)
    .where(options.openOnly ? isNull(safeguarding_alerts.acknowledged_at) : undefined)
    .orderBy(desc(safeguarding_alerts.created_at), desc(safeguarding_alerts.id));
  if (rows.length === 0) return [];

  const assessmentIds = [
    ...new Set(rows.map((r) => r.assessment_id).filter((v): v is string => !!v)),
  ];
  const assessmentRows =
    assessmentIds.length > 0
      ? await db
          .select({ id: assessments.id, name: assessments.name })
          .from(assessments)
          .where(inArray(assessments.id, assessmentIds))
      : [];
  const nameById = new Map(assessmentRows.map((a) => [a.id, a.name]));

  const resolved = new Map<string, DistrictAlertView>();
  for (const assessmentId of nameById.keys()) {
    const own = rows.filter((r) => r.assessment_id === assessmentId);
    const { ownerEmail } = await assessmentOwner(db, assessmentId);
    for (const view of await resolveForAssessment(db, assessmentId, own)) {
      resolved.set(view.id, {
        ...view,
        assessment_id: assessmentId,
        assessment_name: nameById.get(assessmentId) ?? null,
        owner_email: ownerEmail,
      });
    }
  }

  return rows.map(
    (row) =>
      resolved.get(row.id) ?? {
        ...baseView(row),
        item_position: null,
        student: { ...UNKNOWN_STUDENT },
        assessment_id: row.assessment_id,
        assessment_name: null,
        owner_email: null,
      },
  );
}

/**
 * One attempt's alerts, newest first, open and acknowledged — the
 * per-student page's panel. Raw rows: that page already holds the student's
 * identity and the item list.
 */
export async function alertsForAttempt(
  db: Db,
  attemptId: string,
): Promise<SafeguardingAlertRow[]> {
  return db
    .select()
    .from(safeguarding_alerts)
    .where(eq(safeguarding_alerts.attempt_id, attemptId))
    .orderBy(desc(safeguarding_alerts.created_at), desc(safeguarding_alerts.id));
}

/** Every alert on these answers, newest first per answer — the scoring queue. */
export async function alertsForResponses(
  db: Db,
  responseIds: string[],
): Promise<Map<string, SafeguardingAlertRow[]>> {
  const out = new Map<string, SafeguardingAlertRow[]>();
  if (responseIds.length === 0) return out;
  const rows = await db
    .select()
    .from(safeguarding_alerts)
    .where(inArray(safeguarding_alerts.response_id, responseIds))
    .orderBy(desc(safeguarding_alerts.created_at), desc(safeguarding_alerts.id));
  for (const row of rows) {
    if (!row.response_id) continue;
    const list = out.get(row.response_id);
    if (list) list.push(row);
    else out.set(row.response_id, [row]);
  }
  return out;
}

/** Open-alert counts per attempt — the matrix and Monitor badges. */
export async function openAlertCountsByAttempt(
  db: Db,
  attemptIds: string[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const ids = [...new Set(attemptIds)];
  if (ids.length === 0) return out;
  const rows = await db
    .select({ attempt_id: safeguarding_alerts.attempt_id, n: count() })
    .from(safeguarding_alerts)
    .where(
      and(
        inArray(safeguarding_alerts.attempt_id, ids),
        isNull(safeguarding_alerts.acknowledged_at),
      ),
    )
    .groupBy(safeguarding_alerts.attempt_id);
  for (const r of rows) if (r.attempt_id) out.set(r.attempt_id, r.n);
  return out;
}

/**
 * Open-alert counts per assessment, limited to the assessments `visible`
 * admits — the home list's badge. `visible` is the page's own scope
 * fragment (`visibleAssessmentScope(...).condition`), so a count can never
 * leak an assessment the list does not show.
 */
export async function openAlertCountsByAssessment(
  db: Db,
  visible: SQL | undefined,
): Promise<Map<string, number>> {
  const rows = await db
    .select({ assessment_id: safeguarding_alerts.assessment_id, n: count() })
    .from(safeguarding_alerts)
    .innerJoin(assessments, eq(assessments.id, safeguarding_alerts.assessment_id))
    .where(and(visible, isNull(safeguarding_alerts.acknowledged_at)))
    .groupBy(safeguarding_alerts.assessment_id);
  const out = new Map<string, number>();
  for (const r of rows) if (r.assessment_id) out.set(r.assessment_id, r.n);
  return out;
}

/** The alert row, or null — the acknowledge route resolves the assessment from it. */
export async function loadAlert(db: Db, alertId: string): Promise<SafeguardingAlertRow | null> {
  const [row] = await db
    .select()
    .from(safeguarding_alerts)
    .where(eq(safeguarding_alerts.id, alertId))
    .limit(1);
  return row ?? null;
}

/**
 * Acknowledge: who and when, once. Idempotent — an alert that is already
 * acknowledged keeps its FIRST acknowledgement and is returned as it is,
 * including when two teachers click at the same moment (the update only
 * matches an unacknowledged row, so the loser re-reads the winner's).
 *
 * Does NOT touch `ai_forced_at`: acknowledging a prompt-injection alert says
 * "I have seen this", not "score it anyway" — the AI score stays withheld
 * until the teacher asks for it explicitly (D-4).
 */
export async function acknowledgeAlert(
  db: Db,
  alertId: string,
  session: Pick<SessionPayload, "sub" | "email">,
  now: Date = new Date(),
): Promise<SafeguardingAlertRow | null> {
  const [updated] = await db
    .update(safeguarding_alerts)
    .set({
      acknowledged_at: now,
      acknowledged_by_sub: session.sub,
      acknowledged_by_email: session.email ?? null,
    })
    .where(and(eq(safeguarding_alerts.id, alertId), isNull(safeguarding_alerts.acknowledged_at)))
    .returning();
  return updated ?? loadAlert(db, alertId);
}

