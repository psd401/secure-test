import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { assessments, test_sessions } from "@/db/schema";
import { readStaffSessionFromCookies } from "@/lib/auth/session";
import { UUID_RE } from "@/lib/uuid";
import { MonitorView } from "./MonitorView";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Monitor" };

interface PageProps {
  params: Promise<{ id: string; sittingId: string }>;
}

// Slice 87: the proctoring view for one sitting — full width, one card per
// student, the code large enough for a projector. Owner-only: a sitting that
// is not the caller's (or not this assessment's) is a 404, the same posture
// as the sitting API routes.
export default async function MonitorPage({ params }: PageProps) {
  const session = await readStaffSessionFromCookies();
  const { id, sittingId } = await params;
  if (!session) {
    redirect(`/login?next=/dashboard/${id}/monitor/${sittingId}`);
  }
  if (!UUID_RE.test(id) || !UUID_RE.test(sittingId)) notFound();

  const db = getDb();
  const [row] = await db
    .select({ assessment: assessments, sitting: test_sessions })
    .from(test_sessions)
    .innerJoin(assessments, eq(assessments.id, test_sessions.assessment_id))
    .where(
      and(
        eq(test_sessions.id, sittingId),
        eq(test_sessions.assessment_id, id),
        eq(test_sessions.owner_sub, session.sub),
      ),
    )
    .limit(1);
  if (!row) notFound();

  return (
    <MonitorView
      assessmentId={row.assessment.id}
      assessmentName={row.assessment.name}
      sittingId={row.sitting.id}
      code={row.sitting.code}
      status={row.sitting.status}
      expiresAt={row.sitting.expires_at.toISOString()}
    />
  );
}
