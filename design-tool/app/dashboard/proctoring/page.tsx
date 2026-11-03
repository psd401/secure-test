import { redirect } from "next/navigation";
import { getDb } from "@/db/client";
import { readStaffSessionFromCookies } from "@/lib/auth/session";
import { normalizeEmail } from "@/lib/roster/queries";
import { loadProctorCases } from "@/lib/competency/proctoring";
import { PageHeader } from "@/components/app/PageHeader";
import { ProctoringList } from "./ProctoringList";

export const dynamic = "force-dynamic";

export const metadata = { title: "Competency assessments" };

// CBA slice 4 (docs/competency-assessment-design.md): the proctor's list —
// the students assigned to me, their option and status, and Start session /
// Monitor. Keyed on the caller's own email; empty for anyone who proctors
// nobody.
export default async function ProctoringPage() {
  const session = await readStaffSessionFromCookies();
  if (!session) {
    redirect("/login?next=/dashboard/proctoring");
  }
  const groups = await loadProctorCases(getDb(), normalizeEmail(session.email), session.sub);
  return (
    <main className="mx-auto max-w-4xl space-y-8 px-6 py-12">
      <PageHeader
        crumbs={[{ label: "Assessments", href: "/dashboard" }]}
        title="Competency assessments"
        description="Students assigned to you as proctor. Start a session for the ones in the room, read out the code, and close it when they are done."
      />
      <ProctoringList groups={groups} />
    </main>
  );
}
