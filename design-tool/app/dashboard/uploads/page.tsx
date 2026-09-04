import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { desc, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { assets } from "@/db/schema";
import { readStaffSessionFromCookies } from "@/lib/auth/session";
import { PageHeader } from "@/components/app/PageHeader";
import { UploadsPanel } from "./UploadsPanel";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Images" };

export default async function UploadsPage() {
  const session = await readStaffSessionFromCookies();
  if (!session) {
    redirect("/login?next=/dashboard/uploads");
  }
  const db = getDb();
  const rows = await db
    .select()
    .from(assets)
    .where(eq(assets.owner_sub, session.sub))
    .orderBy(desc(assets.created_at));

  return (
    <main className="mx-auto max-w-4xl px-6 py-10">
      <PageHeader
        crumbs={[{ label: "Assessments", href: "/dashboard" }]}
        title="Images"
        description="Images for your questions. PNG, JPG, GIF, WebP or SVG, up to 5 MB each. Pick one from inside a question with Choose image."
      />
      <UploadsPanel
        initialAssets={rows.map((r) => ({
          id: r.id,
          content_type: r.content_type,
          size_bytes: r.size_bytes,
          original_filename: r.original_filename,
          created_at: r.created_at.toISOString(),
        }))}
      />
    </main>
  );
}
