import { notFound, redirect } from "next/navigation";
import { readStaffSessionFromCookies } from "@/lib/auth/session";
import { isCompetencyAdmin } from "@/lib/auth/admin";
import { PageHeader } from "@/components/app/PageHeader";
import { CounselorsPanel } from "./CounselorsPanel";

export const dynamic = "force-dynamic";

export const metadata = { title: "Counselors" };

// CBA slice 6 (docs/competency-assessment-design.md, James 6.2): Assessment
// staff name the counselors who see each school's released results.
export default async function CounselorsPage() {
  const session = await readStaffSessionFromCookies();
  if (!session) {
    redirect("/login?next=/dashboard/competency-counselors");
  }
  if (!isCompetencyAdmin(session)) notFound();
  return (
    <main className="mx-auto max-w-4xl space-y-8 px-6 py-12">
      <PageHeader
        crumbs={[{ label: "Assessments", href: "/dashboard" }]}
        title="Counselors"
        description="A counselor sees the released competency results of students at their school — the result only, not the response. Nothing else in SecureTest opens to them."
      />
      <CounselorsPanel />
    </main>
  );
}
