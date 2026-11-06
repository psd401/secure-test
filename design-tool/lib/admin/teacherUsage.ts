/**
 * Admin "Teacher usage" (`/admin/usage`): who uses SecureTest the most, so a
 * system admin can spot champions.
 *
 * Built from rows the app already writes — no tracking table. Every row is
 * keyed by the staff member's Google `sub` (the one id every table carries);
 * the email is only the label. Student data appears as counts, never rows.
 *
 * Volume columns (slice 1):
 * - assessments created (`assessments.owner_sub`)
 * - class sittings run (`test_sessions.owner_sub`, practice sittings excluded:
 *   they are a teacher trying the client, not a class being tested)
 * - students tested (distinct students with a SUBMITTED attempt in one of the
 *   teacher's class sittings)
 * - attempts submitted (same scope)
 * - last active (the newest of the timestamps behind the counts above)
 *
 * Breadth columns (slice 2), each a count of rows the staff member created:
 * gradebook pushes (`created_by_sub`, not the act-as `actor_sub`), shares
 * sent, class insight reports, competency assignments, in-app feedback sent.
 * `featuresUsed` is how many of those five are non-zero — a breadth measure
 * to sort by, deliberately not a weighted score.
 *
 * Credit goes to the sitting's OWNER, not `created_by_sub`: a substitute who
 * pressed the button for a teacher's class does not make the class theirs.
 */
import { and, count, countDistinct, eq, gte, isNotNull, max, sql } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import type { getDb } from "@/db/client";
import {
  assessment_shares,
  assessments,
  attempts,
  class_insight_reports,
  competency_assignments,
  feedback,
  gradebook_pushes,
  test_sessions,
} from "@/db/schema";
import { DISPLAY_TIME_ZONE, zonedWallTimeToIso } from "@/lib/timeZone";

type Db = ReturnType<typeof getDb>;

export interface TeacherUsageRow {
  sub: string;
  /** Latest known email for the sub; null when no table recorded one. */
  email: string | null;
  assessments: number;
  sittings: number;
  students: number;
  attempts: number;
  gradebookPushes: number;
  sharesSent: number;
  insightReports: number;
  competencyAssignments: number;
  feedbackSent: number;
  /** How many of the five breadth features above are non-zero (0–5). */
  featuresUsed: number;
  lastActive: Date | null;
}

export const USAGE_SORTS = [
  "students",
  "attempts",
  "sittings",
  "assessments",
  "features_used",
  "gradebook_pushes",
  "shares_sent",
  "insight_reports",
  "competency_assignments",
  "feedback_sent",
  "last_active",
] as const;
export type UsageSort = (typeof USAGE_SORTS)[number];

export const USAGE_WINDOWS = ["30d", "year", "all"] as const;
export type UsageWindow = (typeof USAGE_WINDOWS)[number];

export const USAGE_WINDOW_LABELS: Record<UsageWindow, string> = {
  "30d": "Last 30 days",
  year: "This school year",
  all: "All time",
};

/** Unknown or missing values fall back to the defaults (students, school year). */
export function parseUsageParams(params: { sort?: string; window?: string }): {
  sort: UsageSort;
  window: UsageWindow;
} {
  const sort = (USAGE_SORTS as readonly string[]).includes(params.sort ?? "")
    ? (params.sort as UsageSort)
    : "students";
  const window = (USAGE_WINDOWS as readonly string[]).includes(params.window ?? "")
    ? (params.window as UsageWindow)
    : "year";
  return { sort, window };
}

const YEAR_MONTH = new Intl.DateTimeFormat("en-US", {
  timeZone: DISPLAY_TIME_ZONE,
  year: "numeric",
  month: "numeric",
});

/**
 * The school year starts September 1 in the district's zone (Washington's
 * school year, Sept 1 – Aug 31). On Aug 31 the current year is still the one
 * that began the previous September.
 */
export function schoolYearStart(now: Date): Date {
  const parts = Object.fromEntries(YEAR_MONTH.formatToParts(now).map((p) => [p.type, p.value]));
  const year = Number(parts.year);
  const startYear = Number(parts.month) >= 9 ? year : year - 1;
  return new Date(zonedWallTimeToIso(`${startYear}-09-01T00:00`)!);
}

/** The lower bound for a window; null means no bound. */
export function windowSince(window: UsageWindow, now: Date): Date | null {
  if (window === "all") return null;
  if (window === "30d") return new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  return schoolYearStart(now);
}

function newer(a: Date | null, b: Date | null): Date | null {
  if (!a) return b;
  if (!b) return a;
  return a > b ? a : b;
}

export async function teacherUsage(
  db: Db,
  { since }: { since: Date | null },
): Promise<TeacherUsageRow[]> {
  const assessmentRows = await db
    .select({
      sub: assessments.owner_sub,
      email: max(assessments.owner_email),
      n: count(),
      last: max(assessments.created_at),
    })
    .from(assessments)
    .where(since ? gte(assessments.created_at, since) : undefined)
    .groupBy(assessments.owner_sub);

  const sittingRows = await db
    .select({
      sub: test_sessions.owner_sub,
      email: max(test_sessions.owner_email),
      n: count(),
      last: max(test_sessions.created_at),
    })
    .from(test_sessions)
    .where(
      and(
        eq(test_sessions.kind, "class"),
        since ? gte(test_sessions.created_at, since) : undefined,
      ),
    )
    .groupBy(test_sessions.owner_sub);

  const attemptRows = await db
    .select({
      sub: test_sessions.owner_sub,
      students: countDistinct(attempts.student_id),
      n: count(),
      last: max(attempts.submitted_at),
    })
    .from(attempts)
    .innerJoin(test_sessions, eq(test_sessions.id, attempts.test_session_id))
    .where(
      and(
        eq(test_sessions.kind, "class"),
        eq(attempts.status, "submitted"),
        isNotNull(attempts.submitted_at),
        since ? gte(attempts.submitted_at, since) : undefined,
      ),
    )
    .groupBy(test_sessions.owner_sub);

  /** One count-per-actor query over a table that records who created the row. */
  const perActor = (
    table: PgTable,
    actor: PgColumn,
    createdAt: PgColumn,
    email?: PgColumn,
  ): Promise<{ sub: string; email: string | null; n: number; last: Date | null }[]> =>
    // Generic PgColumn params lose drizzle's per-column result types; the
    // shape is fixed by the select below, so assert it once here.
    db
      .select({
        sub: actor,
        email: email ? max(email) : sql<string | null>`null`,
        n: count(),
        last: max(createdAt),
      })
      .from(table)
      .where(since ? gte(createdAt, since) : undefined)
      .groupBy(actor) as unknown as Promise<
      { sub: string; email: string | null; n: number; last: Date | null }[]
    >;

  const [pushRows, shareRows, insightRows, competencyRows, feedbackRows] = await Promise.all([
    perActor(gradebook_pushes, gradebook_pushes.created_by_sub, gradebook_pushes.created_at),
    perActor(
      assessment_shares,
      assessment_shares.shared_by_sub,
      assessment_shares.created_at,
      assessment_shares.shared_by_email,
    ),
    perActor(
      class_insight_reports,
      class_insight_reports.created_by_sub,
      class_insight_reports.created_at,
    ),
    perActor(
      competency_assignments,
      competency_assignments.assigned_by_sub,
      competency_assignments.created_at,
      competency_assignments.assigned_by_email,
    ),
    perActor(feedback, feedback.sub, feedback.created_at, feedback.email),
  ]);

  const bySub = new Map<string, TeacherUsageRow>();
  const row = (sub: string): TeacherUsageRow => {
    let r = bySub.get(sub);
    if (!r) {
      r = {
        sub,
        email: null,
        assessments: 0,
        sittings: 0,
        students: 0,
        attempts: 0,
        gradebookPushes: 0,
        sharesSent: 0,
        insightReports: 0,
        competencyAssignments: 0,
        feedbackSent: 0,
        featuresUsed: 0,
        lastActive: null,
      };
      bySub.set(sub, r);
    }
    return r;
  };
  // Sittings record the email from slice 78 on; assessments only once
  // backfilled — prefer the sitting's, fall back to the assessment's.
  for (const a of assessmentRows) {
    const r = row(a.sub);
    r.assessments = a.n;
    r.email ??= a.email;
    r.lastActive = newer(r.lastActive, a.last);
  }
  for (const s of sittingRows) {
    const r = row(s.sub);
    r.sittings = s.n;
    if (s.email) r.email = s.email;
    r.lastActive = newer(r.lastActive, s.last);
  }
  for (const t of attemptRows) {
    const r = row(t.sub);
    r.students = t.students;
    r.attempts = t.n;
    r.lastActive = newer(r.lastActive, t.last);
  }
  const breadth: [typeof pushRows, BreadthKey][] = [
    [pushRows, "gradebookPushes"],
    [shareRows, "sharesSent"],
    [insightRows, "insightReports"],
    [competencyRows, "competencyAssignments"],
    [feedbackRows, "feedbackSent"],
  ];
  for (const [rows, key] of breadth) {
    for (const b of rows) {
      const r = row(b.sub);
      r[key] = b.n;
      r.featuresUsed += 1;
      r.email ??= b.email;
      r.lastActive = newer(r.lastActive, b.last ? new Date(b.last) : null);
    }
  }
  return [...bySub.values()];
}

type BreadthKey =
  | "gradebookPushes"
  | "sharesSent"
  | "insightReports"
  | "competencyAssignments"
  | "feedbackSent";

const SORT_KEY: Record<Exclude<UsageSort, "last_active">, keyof TeacherUsageRow> = {
  students: "students",
  attempts: "attempts",
  sittings: "sittings",
  assessments: "assessments",
  features_used: "featuresUsed",
  gradebook_pushes: "gradebookPushes",
  shares_sent: "sharesSent",
  insight_reports: "insightReports",
  competency_assignments: "competencyAssignments",
  feedback_sent: "feedbackSent",
};

/** Descending on the chosen column; ties broken by email/sub so the order is stable. */
export function sortUsage(rows: TeacherUsageRow[], sort: UsageSort): TeacherUsageRow[] {
  const key = (r: TeacherUsageRow): number =>
    sort === "last_active" ? (r.lastActive?.getTime() ?? 0) : (r[SORT_KEY[sort]] as number);
  const label = (r: TeacherUsageRow) => r.email ?? r.sub;
  return [...rows].sort((a, b) => key(b) - key(a) || label(a).localeCompare(label(b)));
}
