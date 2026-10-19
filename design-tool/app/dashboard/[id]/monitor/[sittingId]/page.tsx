import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { getDb } from "@/db/client";
import { readStaffSessionFromCookies } from "@/lib/auth/session";
import { UUID_RE } from "@/lib/uuid";
import { pageSitting } from "@/lib/api/access";
import { MonitorView } from "./MonitorView";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Monitor" };

interface PageProps {
  params: Promise<{ id: string; sittingId: string }>;
  /** Row ES: `?code=1` — arrived from "Continue in a new session"; open the code. */
  searchParams: Promise<{ code?: string | string[] }>;
}

// Slice 87: the proctoring view for one sitting — full width, one card per
// student, the code large enough for a projector. Owner-only: a sitting that
// is not the caller's (or not this assessment's) is a 404, the same posture
// as the sitting API routes.
export default async function MonitorPage({ params, searchParams }: PageProps) {
  const session = await readStaffSessionFromCookies();
  const { id, sittingId } = await params;
  const { code: codeParam } = await searchParams;
  if (!session) {
    redirect(`/login?next=/dashboard/${id}/monitor/${sittingId}`);
  }
  if (!UUID_RE.test(id) || !UUID_RE.test(sittingId)) notFound();

  const db = getDb();
  const row = await pageSitting(db, session, sittingId, "run");
  // The sitting must be the one this URL names, not merely one the caller may
  // monitor — the assessment id in the path is part of the address.
  if (!row || row.sitting.assessment_id !== id) notFound();

  return (
    <MonitorView
      assessmentId={row.assessment.id}
      assessmentName={row.assessment.name}
      sittingId={row.sitting.id}
      code={row.sitting.code}
      status={row.sitting.status}
      expiresAt={row.sitting.expires_at.toISOString()}
      kind={row.sitting.kind}
      sectionPsId={row.sitting.section_ps_id}
      studentPsIds={row.sitting.student_ps_ids}
      openCodeOnLoad={codeParam === "1"}
      assessmentUntimed={(row.assessment.time_limit_seconds ?? 0) <= 0}
    />
  );
}
