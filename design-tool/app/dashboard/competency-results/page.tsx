import { redirect } from "next/navigation";
import { getDb } from "@/db/client";
import { readStaffSessionFromCookies } from "@/lib/auth/session";
import { PageHeader } from "@/components/app/PageHeader";
import { counselorSchoolIds, releasedResultsForSchools } from "@/lib/competency/counselors";
import { RESULT_LABEL } from "@/lib/competency/labels";
import { formatDate } from "@/lib/ui/format";

export const dynamic = "force-dynamic";

export const metadata = { title: "Competency results" };

// CBA slice 6 (docs/competency-assessment-design.md, D-13, James 6.3): a
// counselor's list of released results for their school(s) — the result
// only. They tell the registrar; no PowerSchool push. Keyed on the caller's
// own live school grants; empty for anyone without one.
export default async function CompetencyResultsPage() {
  const session = await readStaffSessionFromCookies();
  if (!session) {
    redirect("/login?next=/dashboard/competency-results");
  }
  const db = getDb();
  const rows = await releasedResultsForSchools(db, await counselorSchoolIds(db, session.email));
  return (
    <main className="mx-auto max-w-4xl space-y-8 px-6 py-12">
      <PageHeader
        crumbs={[{ label: "Assessments", href: "/dashboard" }]}
        title="Competency results"
        description="Released results for students at your school. Pass the results to the registrar; the student's response stays in SecureTest."
      />
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">No released results yet.</p>
      ) : (
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">Student</th>
                <th className="px-3 py-2 font-medium">Task</th>
                <th className="px-3 py-2 font-medium">Option</th>
                <th className="px-3 py-2 font-medium">Result</th>
                <th className="px-3 py-2 font-medium">Released</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {rows.map((r) => (
                <tr key={r.assignment_id}>
                  <td className="px-3 py-2">
                    {r.student_name}
                    {r.grade ? <span className="text-muted-foreground"> · {r.grade}</span> : null}
                  </td>
                  <td className="px-3 py-2">{r.assessment_name}</td>
                  <td className="px-3 py-2">{r.option_label}</td>
                  <td className="px-3 py-2 font-medium">{RESULT_LABEL[r.result] ?? r.result}</td>
                  <td className="px-3 py-2">{formatDate(r.released_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
