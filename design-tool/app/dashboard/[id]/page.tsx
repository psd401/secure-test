import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { and, asc, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { assessments, items, type ItemType } from "@/db/schema";
import { loadItemSetsInOrder } from "@/lib/api/itemSets";
import { readStaffSessionFromCookies } from "@/lib/auth/session";
import { AssessmentEditor } from "./AssessmentEditor";
import { UUID_RE } from "@/lib/uuid";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ id: string }>;
}

// UX pass 1, slice 2: the tab is named after the assessment — for its owner
// only, so a guessed id learns nothing from the title either.
export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const session = await readStaffSessionFromCookies();
  const { id } = await params;
  if (!session || !UUID_RE.test(id)) return { title: "Assessment" };
  const [row] = await getDb()
    .select({ name: assessments.name })
    .from(assessments)
    .where(and(eq(assessments.id, id), eq(assessments.owner_sub, session.sub)))
    .limit(1);
  return { title: row?.name ?? "Assessment" };
}

export default async function AssessmentEditorPage({ params }: PageProps) {
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
  // UX pass 1, slice 3: someone else's assessment is a 404, the same posture
  // as the API routes — a guessed id learns nothing.
  if (assessment.owner_sub !== session.sub) {
    notFound();
  }

  const itemRows = await db
    .select()
    .from(items)
    .where(eq(items.assessment_id, id))
    .orderBy(asc(items.position));
  // E5 slice 1: the stimulus sets, in assessment order.
  const itemSetRows = await loadItemSetsInOrder(id);

  return (
    <main className="mx-auto max-w-4xl px-6 py-10">
      <AssessmentEditor
        initialItemSets={itemSetRows.map((s) => ({
          id: s.id,
          stimulus_text: s.stimulus_text,
          layout: s.layout as "inline" | "own_page",
          source: s.source,
        }))}
        assessment={{
          id: assessment.id,
          name: assessment.name,
          description: assessment.description,
          status: assessment.status,
          allow_llm_authoring: assessment.allow_llm_authoring,
          time_limit_seconds: assessment.time_limit_seconds,
          student_layout: assessment.student_layout as "scroll" | "paged",
          allowed_accommodations: (assessment.allowed_accommodations ??
            []) as string[],
          construct_altering: (assessment.construct_altering ?? []) as string[],
        }}
        initialItems={itemRows.map((r) => ({
          id: r.id,
          position: r.position,
          item_set_id: r.item_set_id,
          type: r.type as ItemType,
          stem: r.stem,
          choices: (r.choices ?? []) as { id: string; text: string }[],
          correct_choice_ids: (r.correct_choice_ids ?? []) as string[],
          correct_answer: r.correct_answer,
          max_word_count: r.config?.max_word_count ?? null,
          placeholder: r.config?.placeholder ?? null,
          rubric: r.config?.rubric ?? null,
          pairs: r.config?.pairs ?? null,
          sequence: r.config?.sequence ?? null,
          image_asset_id: r.config?.image_asset_id ?? null,
          regions: r.config?.regions ?? null,
          correct_region_ids: r.config?.correct_region_ids ?? null,
          prompt_asset_id: r.config?.prompt_asset_id ?? null,
          canvas: r.config?.canvas ?? null,
          columns: r.config?.columns ?? null,
          rows: r.config?.rows ?? null,
          corner: r.config?.corner ?? null,
          cell_keys: r.config?.cell_keys ?? null,
          scoring_method: r.config?.scoring_method ?? null,
        }))}
      />
    </main>
  );
}
