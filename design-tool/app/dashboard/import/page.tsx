import type { Metadata } from "next";
import { readStaffSessionFromCookies } from "@/lib/auth/session";
import { PRODUCT_NAME } from "@/lib/brand";
import { importErrorCopy } from "@/lib/ui/errorCopy";
import { getDb } from "@/db/client";
import { isNewAuthoringEnabled } from "@/lib/authoring/flag";
import { ImportForm } from "./ImportForm";
import { ImportPreviewFlow } from "./ImportPreviewFlow";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { PageHeader } from "@/components/app/PageHeader";

export const metadata: Metadata = { title: "Import assessment file" };

interface ImportPageProps {
  searchParams: Promise<{ error?: string }>;
}

export default async function ImportPage({ searchParams }: ImportPageProps) {
  const { error } = await searchParams;
  const copy = error ? importErrorCopy(error) : null;
  // Editor redesign Phase 7 slice C (R-9): flagged staff see what the file
  // will create before Create; everyone else gets today's direct import.
  const session = await readStaffSessionFromCookies();
  const newAuthoring = session ? await isNewAuthoringEnabled(getDb(), session) : false;
  return (
    <main className={`mx-auto px-6 py-12 ${newAuthoring ? "max-w-screen-2xl" : "max-w-xl"}`}>
      <PageHeader
        crumbs={[{ label: "Assessments", href: "/dashboard" }]}
        title="Import assessment file"
        description={`Bring in an assessment exported from ${PRODUCT_NAME} (.json). Its questions and images come along, and the copy is yours to edit.`}
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

      {/* Beta report (2026-10-27): both forms post the file to the import
          route from the browser (useImportAction), not through a server
          action, whose 1 MB body cap refused files with large pictures. */}
      {newAuthoring ? <ImportPreviewFlow /> : <ImportForm />}
    </main>
  );
}
