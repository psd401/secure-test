import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { ItemBundleSchema } from "@secure-test/schema";
import { readStaffSessionFromCookies } from "@/lib/auth/session";
import {
  importBundleForOwner,
  isImportBundleError,
} from "@/lib/api/importBundle";
import { importErrorCopy } from "@/lib/ui/errorCopy";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PageHeader } from "@/components/app/PageHeader";
import { SubmitButton } from "@/components/app/SubmitButton";

export const metadata: Metadata = { title: "Import assessment file" };

// Slice 15: matches the API route's bump from 1 MB to 50 MB so bundled
// image blobs (5 MB per asset cap × ~10 assets) can round-trip.
const MAX_BYTES = 50 * 1024 * 1024;

async function importAssessment(formData: FormData) {
  "use server";
  const session = await readStaffSessionFromCookies();
  if (!session) {
    redirect("/login?next=/dashboard/import");
  }
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) {
    redirect("/dashboard/import?error=no_file_selected");
  }
  const blobFile = file as File;
  if (blobFile.size > MAX_BYTES) {
    redirect("/dashboard/import?error=file_too_large");
  }
  let text: string;
  try {
    text = await blobFile.text();
  } catch {
    redirect("/dashboard/import?error=read_failed");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    redirect("/dashboard/import?error=invalid_json");
  }
  const result = ItemBundleSchema.safeParse(parsed);
  if (!result.success) {
    const firstIssue = result.error.issues[0];
    const msg = firstIssue
      ? `schema_invalid:${firstIssue.path.join(".")}:${firstIssue.message}`
      : "schema_invalid";
    redirect(`/dashboard/import?error=${encodeURIComponent(msg)}`);
  }
  const bundle = result.data;
  const imported = await importBundleForOwner(bundle, session!.sub);
  if (isImportBundleError(imported)) {
    redirect(`/dashboard/import?error=${encodeURIComponent(imported.error)}`);
  }
  redirect(`/dashboard/${imported.assessment_id}`);
}

interface ImportPageProps {
  searchParams: Promise<{ error?: string }>;
}

export default async function ImportPage({ searchParams }: ImportPageProps) {
  const { error } = await searchParams;
  const copy = error ? importErrorCopy(error) : null;
  return (
    <main className="mx-auto max-w-xl px-6 py-12">
      <PageHeader
        crumbs={[{ label: "Assessments", href: "/dashboard" }]}
        title="Import assessment file"
        description="Bring in an assessment exported from Secure-Test (.json). Its questions and images come along, and the copy is yours to edit."
      />

      {copy ? (
        <Alert variant="destructive" className="mt-6">
          <AlertTitle>{copy.message}</AlertTitle>
          {copy.showCode ? (
            <AlertDescription>
              <code className="text-xs break-all">{error}</code>
            </AlertDescription>
          ) : null}
        </Alert>
      ) : null}

      <form action={importAssessment} encType="multipart/form-data" className="mt-8 space-y-5">
        <div className="space-y-2">
          <Label htmlFor="file">Assessment file (.json)</Label>
          <Input id="file" type="file" name="file" accept="application/json,.json" required />
        </div>
        <div className="flex items-center gap-3">
          <SubmitButton pendingLabel="Importing…">Import</SubmitButton>
          <Button asChild variant="ghost">
            <Link href="/dashboard">Cancel</Link>
          </Button>
        </div>
      </form>
    </main>
  );
}
