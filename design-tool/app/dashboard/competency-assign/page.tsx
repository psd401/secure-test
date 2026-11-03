import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { and, asc, eq, isNull } from "drizzle-orm";
import { getDb } from "@/db/client";
import { assessments } from "@/db/schema";
import { readStaffSessionFromCookies } from "@/lib/auth/session";
import { schoolGrantSchools } from "@/lib/competency/schoolGrants";
import { PageHeader } from "@/components/app/PageHeader";
import { Card, CardContent } from "@/components/ui/card";

export const dynamic = "force-dynamic";

export const metadata = { title: "Assign competency assessments" };

// CBA slice 8 (docs/competency-assessment-design.md, D-8): a counselor's way
// in — every district assessment that is not archived, each opening its
// Assignments page scoped to the counselor's school. 404 without a `school`
// grant at `run`.
export default async function CompetencyAssignPage() {
  const session = await readStaffSessionFromCookies();
  if (!session) {
    redirect("/login?next=/dashboard/competency-assign");
  }
  const db = getDb();
  if ((await schoolGrantSchools(db, session.email, "run")).length === 0) notFound();
  const rows = await db
    .select({ id: assessments.id, name: assessments.name, status: assessments.status })
    .from(assessments)
    .where(and(eq(assessments.assigned_scope, "district"), isNull(assessments.archived_at)))
    .orderBy(asc(assessments.name));
  return (
    <main className="mx-auto max-w-4xl space-y-8 px-6 py-12">
      <PageHeader
        crumbs={[{ label: "Assessments", href: "/dashboard" }]}
        title="Assign competency assessments"
        description="Pick the task, then assign each student their option and proctor."
      />
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">No competency assessments yet.</p>
      ) : (
        <div className="space-y-2">
          {rows.map((a) => (
            <Card key={a.id}>
              <CardContent className="flex items-center justify-between gap-3">
                <span className="font-medium">{a.name}</span>
                <span className="flex items-center gap-3 text-sm">
                  {a.status !== "published" ? <span className="text-muted-foreground">Not published yet</span> : null}
                  <Link href={`/dashboard/${a.id}/assignments`} className="hover:underline">
                    Assignments
                  </Link>
                </span>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </main>
  );
}
