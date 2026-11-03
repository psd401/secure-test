import { notFound, redirect } from "next/navigation";
import { getDb } from "@/db/client";
import { readStaffSessionFromCookies } from "@/lib/auth/session";
import { UUID_RE } from "@/lib/uuid";
import { authorizeCompetency } from "@/lib/competency/assignments";
import { AssignmentsPanel } from "./AssignmentsPanel";

export const dynamic = "force-dynamic";

// F-7 (CBA hand-run): a tab title that says which task. Only for someone the
// page itself admits; anyone else gets the generic title, like the 404.
export async function generateMetadata({ params }: PageProps) {
  const session = await readStaffSessionFromCookies();
  const { id } = await params;
  if (!session || !UUID_RE.test(id)) return { title: "Assignments" };
  const access = await authorizeCompetency(getDb(), session, id, "read");
  return { title: access.ok ? `Assignments · ${access.assessment.name}` : "Assignments" };
}

interface PageProps {
  params: Promise<{ id: string }>;
}

// CBA slice 2 (docs/competency-assessment-design.md): Assessment staff assign
// a student an option and a proctor, and withdraw or re-proctor a case; slice
// 8 lets a counselor do the same for their school's students. Same gate as
// the routes behind it; anyone else gets a 404.
export default async function AssignmentsPage({ params }: PageProps) {
  const session = await readStaffSessionFromCookies();
  if (!session) {
    redirect("/login?next=/dashboard");
  }
  const { id } = await params;
  if (!UUID_RE.test(id)) {
    notFound();
  }
  const access = await authorizeCompetency(getDb(), session, id, "read");
  if (!access.ok) {
    notFound();
  }
  return (
    <main className="mx-auto max-w-4xl px-6 py-10">
      <AssignmentsPanel
        assessmentId={access.assessment.id}
        assessmentName={access.assessment.name}
        counselor={access.schools !== null}
      />
    </main>
  );
}
