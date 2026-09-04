import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getDb } from "@/db/client";
import { readStaffSessionFromCookies } from "@/lib/auth/session";
import { pendingTideDiffs } from "@/lib/accommodations/pendingDiffs";
import { PageHeader } from "@/components/app/PageHeader";
import { DiffReviewPanel } from "./DiffReviewPanel";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Review TIDE changes" };

export default async function DiffReviewPage() {
  const session = await readStaffSessionFromCookies();
  if (!session) {
    redirect("/login?next=/dashboard/accommodations/import/review");
  }
  const rows = await pendingTideDiffs(getDb(), session.sub);

  return (
    <main className="mx-auto max-w-4xl space-y-6 px-6 py-12">
      <PageHeader
        crumbs={[
          { label: "Students", href: "/dashboard/accommodations" },
          { label: "Import TIDE settings", href: "/dashboard/accommodations/import" },
        ]}
        title="Review TIDE changes"
        description="Settings you had changed that a later TIDE import disagrees with. Your value stays in effect until you choose TIDE's."
      />
      <DiffReviewPanel rows={rows} />
    </main>
  );
}
