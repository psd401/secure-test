import type { Metadata } from "next";
import { PageHeader } from "@/components/app/PageHeader";
import { Alert, AlertTitle } from "@/components/ui/alert";
import { getDb } from "@/db/client";
import { readStaffSessionFromCookies } from "@/lib/auth/session";
import { isNewAuthoringEnabled } from "@/lib/authoring/flag";
import { startTemplates } from "@/lib/authoring/templates";
import { importErrorCopy } from "@/lib/ui/errorCopy";
import { NewAssessmentForm } from "./NewAssessmentForm";
import { StartScreen } from "./StartScreen";

export const metadata: Metadata = { title: "New assessment" };

interface PageProps {
  searchParams: Promise<{ error?: string }>;
}

export default async function NewAssessmentPage({ searchParams }: PageProps) {
  // Editor redesign Phase 8 (D-5): flagged staff get the start screen; everyone
  // else gets today's form, unchanged.
  const session = await readStaffSessionFromCookies();
  const newAuthoring = session ? await isNewAuthoringEnabled(getDb(), session) : false;
  if (newAuthoring) {
    const { error } = await searchParams;
    const copy = error ? importErrorCopy(error) : null;
    return (
      <main className="mx-auto max-w-4xl px-6 py-12">
        <PageHeader
          crumbs={[{ label: "Assessments", href: "/dashboard" }]}
          title="New assessment"
          description="Choose how to start. Every choice makes a draft you can change."
        />
        {copy ? (
          <Alert variant="destructive" className="mt-6">
            <AlertTitle>{copy.message}</AlertTitle>
          </Alert>
        ) : null}
        <StartScreen templates={startTemplates()} />
      </main>
    );
  }
  return (
    <main className="mx-auto max-w-xl px-6 py-12">
      <PageHeader
        crumbs={[{ label: "Assessments", href: "/dashboard" }]}
        title="New assessment"
        description="Start a draft. You'll add questions and settings inside it."
      />
      <NewAssessmentForm />
    </main>
  );
}
