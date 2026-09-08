import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { assessments } from "@/db/schema";
import { readStaffSessionFromCookies } from "@/lib/auth/session";
import { buildResults, type ResultsCell, type ResultsRow } from "@/lib/scoring/results";
import { formatMean } from "@/lib/reporting/analytics";
import { UUID_RE } from "@/lib/uuid";
import { loadItemAnalytics } from "./analyticsQuery";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}

/** The `?section=` value that means "the rows with no section resolved". */
const NO_SECTION = "__none__";

function cellText(cell: ResultsCell): string {
  switch (cell.status) {
    case "final":
      return `${cell.points}/${cell.max_points}`;
    case "proposed_pending":
      return "AI ⏳";
    case "unscored":
      return "—";
    case "no_response":
      return "·";
  }
}

const CELL_TITLE: Record<ResultsCell["status"], string> = {
  final: "Final score",
  proposed_pending: "AI proposal awaiting review (not counted)",
  unscored: "Awaiting scoring",
  no_response: "No response",
};

/** The distinct section labels on these rows, alphabetical, blanks last. */
function sectionOptions(rows: ResultsRow[]): { labels: string[]; hasBlank: boolean } {
  const labels = [
    ...new Set(rows.map((r) => r.student.section).filter((s): s is string => !!s)),
  ].sort((a, b) => a.localeCompare(b));
  return { labels, hasBlank: rows.some((r) => !r.student.section) };
}

// Slice 40 + R1 (docs/reporting-design.md): teacher-facing results matrix.
// Server-rendered — the only interactivity is the CSV link and the section
// filter, which is a plain GET form rather than a client component so the
// page needs no JavaScript at all. Finals only; pending AI proposals are
// visible as state, never counted.
export default async function ResultsPage({ params, searchParams }: PageProps) {
  const session = await readStaffSessionFromCookies();
  if (!session) {
    redirect("/login?next=/dashboard");
  }
  const { id } = await params;
  if (!UUID_RE.test(id)) {
    notFound();
  }

  const db = getDb();
  const [assessment] = await db
    .select()
    .from(assessments)
    .where(eq(assessments.id, id))
    .limit(1);
  if (!assessment) {
    notFound();
  }
  if (assessment.owner_sub !== session.sub) {
    return (
      <main className="mx-auto max-w-2xl px-6 py-16">
        <h1 className="text-2xl font-semibold">Forbidden</h1>
        <p className="mt-4 text-sm text-muted-foreground">
          You don&rsquo;t own this assessment.
        </p>
      </main>
    );
  }

  const results = await buildResults(id, session.sub, session.email);
  const { analytics, submitted_count } = await loadItemAnalytics(id);

  const raw = (await searchParams).section;
  const selectedSection = Array.isArray(raw) ? (raw[0] ?? "") : (raw ?? "");
  const { labels, hasBlank } = sectionOptions(results.rows);
  const filtered =
    selectedSection === ""
      ? results.rows
      : selectedSection === NO_SECTION
        ? results.rows.filter((r) => !r.student.section)
        : results.rows.filter((r) => r.student.section === selectedSection);

  return (
    <main className="mx-auto max-w-5xl px-6 py-10">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <Link
            href={`/dashboard/${assessment.id}`}
            className="text-sm text-muted-foreground underline"
          >
            ← Back to editor
          </Link>
          <h1 className="mt-2 text-2xl font-semibold">
            Results — {assessment.name}
          </h1>
        </div>
        <a
          href={`/api/assessments/${assessment.id}/results?format=csv`}
          className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-accent"
        >
          Download CSV
        </a>
      </div>
      <p className="mt-2 text-sm text-muted-foreground">
        Final scores only. &ldquo;AI ⏳&rdquo; marks proposals still awaiting
        review in the{" "}
        <Link href={`/dashboard/${assessment.id}/scoring`} className="underline">
          scoring queue
        </Link>
        ; they are not counted in totals. Open a student&rsquo;s name for their
        answers and their test-session history.
      </p>

      {labels.length > 0 || hasBlank ? (
        <form method="get" className="mt-6 flex flex-wrap items-center gap-2">
          <label htmlFor="section" className="text-sm">
            Section
          </label>
          <select
            id="section"
            name="section"
            defaultValue={selectedSection}
            className="rounded-md border border-border bg-transparent px-2 py-1 text-sm"
          >
            <option value="">All sections</option>
            {labels.map((label) => (
              <option key={label} value={label}>
                {label}
              </option>
            ))}
            {hasBlank ? <option value={NO_SECTION}>No section</option> : null}
          </select>
          <button
            type="submit"
            className="rounded-md border border-border px-3 py-1 text-sm hover:bg-accent"
          >
            Show
          </button>
          {selectedSection !== "" ? (
            <Link
              href={`/dashboard/${assessment.id}/results`}
              className="text-sm text-muted-foreground underline"
            >
              Clear
            </Link>
          ) : null}
        </form>
      ) : null}

      {results.rows.length === 0 ? (
        <p className="mt-8 text-sm text-muted-foreground">
          No submitted attempts yet.
        </p>
      ) : filtered.length === 0 ? (
        <p className="mt-8 text-sm text-muted-foreground">
          No handed-in work in that section.
        </p>
      ) : (
        <div className="mt-6 overflow-x-auto">
          <table className="w-full min-w-max border-collapse text-sm">
            <thead>
              <tr className="border-b border-border text-left">
                <th className="py-2 pr-4 font-medium">Student</th>
                {results.items.map((item) => (
                  <th
                    key={item.id}
                    className="px-2 py-2 text-center font-medium"
                    title={item.stem}
                  >
                    Q{item.position + 1}
                  </th>
                ))}
                <th className="px-2 py-2 text-right font-medium">Total</th>
                <th className="px-2 py-2 text-right font-medium">%</th>
                <th className="px-2 py-2 text-right font-medium">Scoring</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((row) => (
                <tr
                  key={row.attempt_id}
                  className="border-b border-border"
                >
                  <td className="py-2 pr-4">
                    <Link
                      href={`/dashboard/${assessment.id}/results/${row.attempt_id}`}
                      className="font-medium hover:underline"
                    >
                      {row.student.name || row.student.ssid}
                    </Link>
                    <span className="ml-2 text-xs text-muted-foreground">
                      {[row.student.student_number, row.student.section]
                        .filter(Boolean)
                        .join(" · ") || row.student.ssid}
                    </span>
                  </td>
                  {row.cells.map((cell, i) => (
                    <td
                      key={i}
                      className="px-2 py-2 text-center"
                      title={CELL_TITLE[cell.status]}
                    >
                      {cellText(cell)}
                    </td>
                  ))}
                  <td className="px-2 py-2 text-right font-medium">
                    {row.total_points}/{row.max_points}
                  </td>
                  <td className="px-2 py-2 text-right text-muted-foreground">
                    {row.percent === null ? "" : `${row.percent}%`}
                  </td>
                  {/* Text + a glyph, never colour alone: this cell is the
                      answer to "is this one finished?" and has to survive a
                      greyscale print and a colour-blind reader. */}
                  <td className="px-2 py-2 text-right whitespace-nowrap">
                    {row.unscored_count === 0 ? (
                      <span className="text-success-foreground">✓ Complete</span>
                    ) : (
                      <span className="text-muted-foreground">
                        {row.unscored_count} to score
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {results.rows.length > 0 ? (
        <section className="mt-12" aria-labelledby="item-analytics">
          <h2 id="item-analytics" className="text-lg font-semibold">
            How the class did, question by question
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Across all {submitted_count} handed-in attempt
            {submitted_count === 1 ? "" : "s"} — the section filter above does
            not narrow these numbers. Mean is over the answers that carry a
            final score; an AI proposal is not one.
          </p>
          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-max border-collapse text-sm">
              <thead>
                <tr className="border-b border-border text-left">
                  <th className="py-2 pr-4 font-medium">Question</th>
                  <th className="px-2 py-2 text-right font-medium">Mean</th>
                  <th className="px-2 py-2 text-right font-medium">p</th>
                  <th className="px-2 py-2 text-right font-medium">Answered</th>
                  <th className="px-2 py-2 text-left font-medium">Choices</th>
                </tr>
              </thead>
              <tbody>
                {analytics.map((a) => (
                  <tr key={a.item_id} className="border-b border-border align-top">
                    <td className="py-2 pr-4 whitespace-nowrap">
                      Q{a.position + 1}
                      <span className="ml-2 text-xs text-muted-foreground">{a.type}</span>
                    </td>
                    <td className="px-2 py-2 text-right tabular-nums">
                      {formatMean(a.mean_points)} / {a.max_points}
                      {a.unscored_count > 0 ? (
                        <span className="ml-1 text-xs text-muted-foreground">
                          ({a.unscored_count} unscored)
                        </span>
                      ) : null}
                    </td>
                    <td className="px-2 py-2 text-right tabular-nums">
                      {a.p_value === null ? "—" : `${a.p_value}%`}
                    </td>
                    <td className="px-2 py-2 text-right tabular-nums">
                      {a.answered_percent === null ? "—" : `${a.answered_percent}%`}
                      <span className="ml-1 text-xs text-muted-foreground">
                        ({a.answered_count} of {submitted_count})
                      </span>
                    </td>
                    <td className="px-2 py-2">
                      {a.choices ? (
                        <ul className="space-y-0.5">
                          {a.choices.map((c) => (
                            <li key={c.id} className="text-xs">
                              <span className="tabular-nums">{c.count}</span>
                              {" · "}
                              {c.text}
                              {c.is_key ? (
                                <span className="ml-1 font-medium" title="The answer key">
                                  ✓
                                </span>
                              ) : null}
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
    </main>
  );
}
