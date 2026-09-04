import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { readStaffSessionFromCookies } from "@/lib/auth/session";
import { PageHeader } from "@/components/app/PageHeader";
import { ImportTidePanel } from "./ImportTidePanel";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Import TIDE settings" };

interface PageProps {
  /** `?return=/dashboard/<id>?tab=students` brings the teacher back to the assessment they came from. */
  searchParams: Promise<{ return?: string }>;
}

export default async function ImportTidePage({ searchParams }: PageProps) {
  const session = await readStaffSessionFromCookies();
  if (!session) {
    redirect("/login?next=/dashboard/accommodations/import");
  }
  const { return: ret } = await searchParams;
  const returnTo = ret && ret.startsWith("/dashboard/") ? ret : null;
  return (
    <main className="mx-auto max-w-2xl space-y-6 px-6 py-12">
      <PageHeader
        crumbs={[{ label: "Students", href: "/dashboard/accommodations" }]}
        title="Import TIDE settings"
        description="Upload the Student Settings export from TIDE (.xlsx). New students are added, TIDE's settings are taken as-is, settings you had changed are kept for you to review, and settings TIDE no longer lists are turned off."
      />
      <ImportTidePanel returnTo={returnTo} />
    </main>
  );
}
