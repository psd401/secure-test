import { notFound, redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { assessments } from "@/db/schema";
import { readStaffSessionFromCookies } from "@/lib/auth/session";
import { ScoringQueue } from "./ScoringQueue";
import { UUID_RE } from "@/lib/uuid";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ id: string }>;
}

// Slice 39: the human review queue for one assessment — manual scoring of
// human-method items and approve/override/re-run of AI proposals.
export default async function ScoringPage({ params }: PageProps) {
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

  return (
    <main className="mx-auto max-w-4xl px-6 py-10">
      <ScoringQueue assessmentId={assessment.id} assessmentName={assessment.name} />
    </main>
  );
}
