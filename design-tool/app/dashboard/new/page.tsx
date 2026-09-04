import type { Metadata } from "next";
import { PageHeader } from "@/components/app/PageHeader";
import { NewAssessmentForm } from "./NewAssessmentForm";

export const metadata: Metadata = { title: "New assessment" };

export default function NewAssessmentPage() {
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
