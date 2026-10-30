import { notFound, redirect } from "next/navigation";
import { getDb } from "@/db/client";
import { readStaffSessionFromCookies } from "@/lib/auth/session";
import { ScoringQueue } from "./ScoringQueue";
import { UUID_RE } from "@/lib/uuid";
import { authorizeAssessment } from "@/lib/api/access";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ section?: string | string[] }>;
}

// Slice 39: the human review queue for one assessment — manual scoring of
// human-method items and approve/override/re-run of AI proposals.
export default async function ScoringPage({ params, searchParams }: PageProps) {
  const session = await readStaffSessionFromCookies();
  if (!session) {
    redirect("/login?next=/dashboard");
  }
  const { id } = await params;
  if (!UUID_RE.test(id)) {
    notFound();
  }

  const db = getDb();
  // Access slice 1 (D-3): the Forbidden panel this used to render told a
  // stranger the assessment exists. A row the caller cannot reach is a 404,
  // the posture every other surface already had.
  const access = await authorizeAssessment(db, session, id, "edit", "read");
  if (!access.ok) {
    notFound();
  }
  const assessment = access.assessment;

  // Hybrid transparency slice 2 (5.4): the results page's "Review them"
  // carries its section filter here.
  const raw = (await searchParams).section;
  const initialSection = Array.isArray(raw) ? (raw[0] ?? "") : (raw ?? "");

  return (
    <main className="mx-auto max-w-4xl px-6 py-10">
      <ScoringQueue
        assessmentId={assessment.id}
        assessmentName={assessment.name}
        initialSection={initialSection}
        // FR: a non-impersonating admin reads feedback but cannot write it
        // (SEC-03, the routes refuse the same way), so the box is grayed out.
        canWriteFeedback={access.via !== "admin"}
      />
    </main>
  );
}
