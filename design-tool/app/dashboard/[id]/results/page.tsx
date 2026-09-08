import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { assessments } from "@/db/schema";
import { readStaffSessionFromCookies } from "@/lib/auth/session";
import { buildResults, type ResultsCell } from "@/lib/scoring/results";
import { UUID_RE } from "@/lib/uuid";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ id: string }>;
}

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

// Slice 40: teacher-facing results matrix. Server-rendered — no
// interactivity beyond the CSV download link. Finals only; pending AI
// proposals are visible as state, never counted.
export default async function ResultsPage({ params }: PageProps) {
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
        <div className="flex flex-wrap items-center gap-2">
          <a
            href={`/api/assessments/${assessment.id}/results?format=csv`}
            className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-accent"
          >
            Download CSV
          </a>
          {/* R2 print report (docs/reporting-design.md): a print-CSS page the
              teacher Save-as-PDFs — summary page then one page per student. */}
          <a
            href={`/dashboard/${assessment.id}/results/print`}
            className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-accent"
          >
            Print report
          </a>
        </div>
      </div>
      <p className="mt-2 text-sm text-muted-foreground">
        Final scores only. &ldquo;AI ⏳&rdquo; marks proposals still awaiting
        review in the{" "}
        <Link href={`/dashboard/${assessment.id}/scoring`} className="underline">
          scoring queue
        </Link>
        ; they are not counted in totals.
      </p>

      {results.rows.length === 0 ? (
        <p className="mt-8 text-sm text-muted-foreground">
          No submitted attempts yet.
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
                <th className="px-2 py-2 text-right font-medium">Pending</th>
              </tr>
            </thead>
            <tbody>
              {results.rows.map((row) => (
                <tr
                  key={row.attempt_id}
                  className="border-b border-border"
                >
                  <td className="py-2 pr-4">
                    {row.student.name || row.student.ssid}
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
                  <td className="px-2 py-2 text-right text-muted-foreground">
                    {row.unscored_count > 0 ? row.unscored_count : ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
