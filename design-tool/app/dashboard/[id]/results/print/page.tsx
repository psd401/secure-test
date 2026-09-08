import { notFound, redirect } from "next/navigation";
import { asc, eq, inArray } from "drizzle-orm";
import { getDb } from "@/db/client";
import { assessments, attempt_events } from "@/db/schema";
import { readStaffSessionFromCookies } from "@/lib/auth/session";
import { formatMean } from "@/lib/reporting/analytics";
import { formatIntegrityLine } from "@/lib/reporting/printIntegrity";
import { itemTypeLabel, summarizeCohort } from "@/lib/reporting/printSummary";
import { buildResults, type ResultsCell, type ResultsRow } from "@/lib/scoring/results";
import { formatDate, formatDateTime } from "@/lib/ui/format";
import { UUID_RE } from "@/lib/uuid";
import { loadItemAnalytics } from "../analyticsQuery";

/**
 * R2 print report (docs/reporting-design.md), ADR 0013 pattern: there is no
 * headless Chrome here and no PDF library, so "PDF" is a print-CSS page the
 * teacher Save-as-PDFs from their own browser — the same bargain
 * `/preview/[id]?print=1` struck for the paper form. It reuses that idea and
 * none of that code: `renderHtml.ts` renders a blank test to write on; this
 * renders results.
 *
 * FERPA posture (design page): owner-only — every failure is `notFound()`, so
 * the URL cannot be used to probe for assessments; `no-store` (see
 * `dynamic` below); student numbers and names only where the results matrix
 * already shows them; and NEVER a free-text response — this page prints marks
 * and totals, never what a student wrote.
 *
 * URL contract:
 *   /dashboard/<assessmentId>/results/print
 *     ?section=<label>    only students whose resolved section label matches
 *     ?attempt=<uuid>     that one student's page alone, no summary page —
 *                         the family-facing report
 *
 * Server component, no client JS: the only script on the page is the one line
 * that wires the "Print / Save as PDF" button to `window.print()`.
 */

// force-dynamic is what keeps this out of every cache, including the browser's:
// Next answers an uncached dynamic render with
// `Cache-Control: private, no-cache, no-store, max-age=0, must-revalidate`.
// A page cannot set response headers itself (that lives in a route handler or
// the proxy), and this must not be a route handler — it is a React page.
export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}

function firstParam(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

/** Marks only. "AI ⏳" is a proposal awaiting review — never counted (R0). */
function markText(cell: ResultsCell): string {
  switch (cell.status) {
    case "final":
      return `${cell.points}/${cell.max_points}`;
    case "proposed_pending":
      return "AI ⏳";
    case "unscored":
    case "no_response":
      return "—";
  }
}

function printDate(iso: string | null): string {
  return iso ? formatDate(iso) : "—";
}

function printWhen(iso: string | null): string {
  // A printed record always carries the date (formatWhen would drop it for
  // a same-day hand-in).
  return iso ? formatDateTime(iso) : "—";
}

function scoreLine(row: ResultsRow): string {
  const base = `${row.total_points} / ${row.max_points}`;
  if (row.unscored_count > 0) {
    return `${base} · ${row.unscored_count} unscored`;
  }
  return row.percent === null ? base : `${base} · ${row.percent}%`;
}

// Black on white, 11pt, table borders, one page per student. Screen keeps the
// same document and only adds the top bar, so what the teacher reads is what
// prints. Hides the app shell's <header> in print (it is rendered by
// app/dashboard/layout.tsx, above this page).
const PRINT_CSS = `
.report { color: #000; background: #fff; font-size: 11pt; line-height: 1.45;
  max-width: 52rem; margin: 0 auto; padding: 1.5rem; }
.report h1 { font-size: 15pt; margin: 0 0 .25rem; }
.report h2 { font-size: 13pt; margin: 0 0 .25rem; }
.report .meta { margin: 0 0 .15rem; }
.report .muted { color: #333; }
.report table { border-collapse: collapse; width: 100%; margin-top: .75rem; }
.report th, .report td { border: 1px solid #000; padding: .25rem .4rem;
  text-align: left; vertical-align: top; }
.report th.num, .report td.num { text-align: right; }
.report .student-page { margin-top: 2rem; }
.report .integrity { margin-top: .75rem; }
.report .toolbar { margin: 0 auto 1rem; max-width: 52rem; padding: 1rem 1.5rem 0;
  display: flex; gap: 1rem; align-items: center; }
@media print {
  header, nav, .toolbar { display: none !important; }
  .report { max-width: none; padding: 0; font-size: 11pt; }
  .report .student-page { page-break-before: always; break-before: page;
    margin-top: 0; }
  .report .student-page:first-child { page-break-before: auto; break-before: auto; }
  @page { margin: 0.6in; }
}
`;

const PRINT_SCRIPT = `document.addEventListener("click",function(e){
var b=e.target&&e.target.closest&&e.target.closest("[data-print]");
if(b){window.print();}});`;

export default async function ResultsPrintPage({ params, searchParams }: PageProps) {
  const session = await readStaffSessionFromCookies();
  if (!session) {
    redirect("/login?next=/dashboard");
  }
  const { id } = await params;
  if (!UUID_RE.test(id)) {
    notFound();
  }
  const sp = await searchParams;
  const sectionFilter = firstParam(sp.section);
  const attemptFilter = firstParam(sp.attempt);

  const db = getDb();
  const [assessment] = await db
    .select()
    .from(assessments)
    .where(eq(assessments.id, id))
    .limit(1);
  // Owner-only, and a non-owner gets the SAME answer as a missing row: this
  // URL must not tell a stranger that an assessment exists.
  if (!assessment || assessment.owner_sub !== session.sub) {
    notFound();
  }

  const results = await buildResults(id, session.sub, session.email);
  let rows = results.rows;
  if (sectionFilter) {
    rows = rows.filter((r) => r.student.section === sectionFilter);
  }
  const singleStudent = attemptFilter !== null;
  if (singleStudent) {
    rows = rows.filter((r) => r.attempt_id === attemptFilter);
  }

  const cohort = summarizeCohort(rows);
  // P5-3: the same numbers the results page's footer shows — assessment-wide,
  // not scoped to `?section=` (see the note printed beside the table below).
  const { analytics, submitted_count } = await loadItemAnalytics(id);

  // The integrity line reads `attempt_events` for the attempts on THIS page
  // only — one query, scoped to attempt ids that already came out of the
  // owner-scoped `buildResults`.
  const eventRows =
    rows.length > 0
      ? await db
          .select({ attempt_id: attempt_events.attempt_id, kind: attempt_events.kind })
          .from(attempt_events)
          .where(
            inArray(
              attempt_events.attempt_id,
              rows.map((r) => r.attempt_id),
            ),
          )
          .orderBy(asc(attempt_events.at))
      : [];
  const eventsByAttempt = new Map<string, Array<{ kind: string }>>();
  for (const e of eventRows) {
    const list = eventsByAttempt.get(e.attempt_id) ?? [];
    list.push({ kind: e.kind });
    eventsByAttempt.set(e.attempt_id, list);
  }

  const sectionText = sectionFilter ?? "All sections";
  const dateRange =
    cohort.first_submitted === null
      ? "—"
      : cohort.first_submitted === cohort.last_submitted
        ? printDate(cohort.first_submitted)
        : `${printDate(cohort.first_submitted)} – ${printDate(cohort.last_submitted)}`;

  return (
    <>
      <style>{PRINT_CSS}</style>
      <div className="toolbar">
        <button type="button" data-print className="rounded-md border px-3 py-1.5 text-sm">
          Print / Save as PDF
        </button>
        <a href={`/dashboard/${assessment.id}/results`} className="text-sm underline">
          Back to results
        </a>
      </div>
      <main className="report">
        {singleStudent ? null : (
          <section aria-label="Summary">
            <h1>{assessment.name}</h1>
            <p className="meta">{sectionText}</p>
            <p className="meta">Handed in: {dateRange}</p>
            <p className="meta">{cohort.handed_in} handed in</p>
            <p className="meta">
              Mean total:{" "}
              {cohort.mean_total === null
                ? "—"
                : `${cohort.mean_total} / ${cohort.max_points}`}
              {" · "}
              Mean percent:{" "}
              {cohort.mean_percent === null ? "—" : `${cohort.mean_percent}%`}
            </p>
            {cohort.incomplete_count > 0 ? (
              <p className="meta muted">
                {cohort.incomplete_count} of {cohort.handed_in} still have unscored
                items — the means are over the {cohort.complete_count} complete.
              </p>
            ) : null}
            <p className="meta muted">
              Per-question numbers are across all {submitted_count} handed-in
              attempt{submitted_count === 1 ? "" : "s"} for the whole
              assessment; the section filter narrows the student pages below,
              not these.
            </p>
            <table>
              <caption className="sr-only">Per-question summary</caption>
              <thead>
                <tr>
                  <th scope="col">Q</th>
                  <th scope="col">Type</th>
                  <th scope="col" className="num">
                    Max
                  </th>
                  <th scope="col" className="num">
                    Mean points
                  </th>
                  <th scope="col" className="num">
                    p-value
                  </th>
                </tr>
              </thead>
              <tbody>
                {analytics.map((stat) => (
                  <tr key={stat.item_id}>
                    <th scope="row">Q{stat.position + 1}</th>
                    <td>{itemTypeLabel(stat.type)}</td>
                    <td className="num">{stat.max_points}</td>
                    <td className="num">{formatMean(stat.mean_points)}</td>
                    <td className="num">
                      {stat.p_value === null ? "—" : `${stat.p_value}%`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}

        {rows.length === 0 ? (
          <p className="meta">No handed-in attempts to report.</p>
        ) : null}

        {rows.map((row) => (
          <section
            key={row.attempt_id}
            className="student-page"
            aria-label={`Report for ${row.student.name}`}
          >
            <h2>
              {[row.student.name, row.student.student_number, row.student.section]
                .filter(Boolean)
                .join(" · ")}
            </h2>
            <p className="meta muted">
              {assessment.name}
              {singleStudent && sectionFilter ? ` · ${sectionFilter}` : ""}
            </p>
            <p className="meta">Handed in {printWhen(row.submitted_at)}</p>
            <p className="meta">{scoreLine(row)}</p>
            <table>
              <caption className="sr-only">Marks per question</caption>
              <thead>
                <tr>
                  {results.items.map((item) => (
                    <th key={item.id} scope="col" className="num">
                      Q{item.position + 1}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                <tr>
                  {row.cells.map((cell, i) => (
                    <td key={results.items[i]?.id ?? i} className="num">
                      {markText(cell)}
                    </td>
                  ))}
                </tr>
              </tbody>
            </table>
            <p className="integrity">
              Integrity: {formatIntegrityLine(eventsByAttempt.get(row.attempt_id) ?? [])}
            </p>
          </section>
        ))}
      </main>
      {/* The one script on the page: the Print button. Everything else is
          server-rendered HTML, so the report prints identically with JS off. */}
      <script dangerouslySetInnerHTML={{ __html: PRINT_SCRIPT }} />
    </>
  );
}
