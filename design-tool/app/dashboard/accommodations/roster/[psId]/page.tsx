import { notFound, redirect } from "next/navigation";
import { getDb } from "@/db/client";
import { readStaffSessionFromCookies } from "@/lib/auth/session";
import { findOrBindOverlay } from "@/lib/api/resolveStudent";
import { teacherRoster } from "@/lib/roster/teacherRoster";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { PageHeader } from "@/components/app/PageHeader";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ psId: string }>;
}

/**
 * UX pass 1, slice 8 (ACC-01, open question 4.1 taken as the proposal's
 * primary path): a rostered student with no overlay row yet is opened here.
 * The row is created — or an SSID-only TIDE row bound — by the same helper a
 * first join uses (lib/api/resolveStudent.ts, slice 78), so there is exactly
 * one way an overlay row comes into being, then the teacher lands on the
 * student page. Only a student in one of the teacher's current sections
 * qualifies; anything else is a 404.
 */
export default async function BindRosterStudentPage({ params }: PageProps) {
  const session = await readStaffSessionFromCookies();
  const { psId } = await params;
  if (!session) {
    redirect(`/login?next=/dashboard/accommodations`);
  }
  const db = getDb();
  const roster = await teacherRoster(db, session.sub, session.email);
  const hit = roster.sections.flatMap((s) => s.students).find((x) => x.roster.ps_id === psId);
  if (!hit) notFound();
  if (hit.overlay) redirect(`/dashboard/accommodations/${hit.overlay.id}`);

  const bound = await findOrBindOverlay(db, session.sub, hit.roster, true);
  if (!bound.ok) {
    return (
      <main className="mx-auto max-w-3xl space-y-6 px-6 py-12">
        <PageHeader crumbs={[{ label: "Students", href: "/dashboard/accommodations" }]} title="This student's records don't match up" />
        <Alert variant="destructive">
          <AlertTitle>Two records claim the same student.</AlertTitle>
          <AlertDescription>
            The class list and a TIDE record disagree about who this is, so nothing was changed. Let
            Research &amp; Assessment know which student this is (PowerSchool number {psId}).
          </AlertDescription>
        </Alert>
      </main>
    );
  }
  redirect(`/dashboard/accommodations/${bound.student.id}`);
}
