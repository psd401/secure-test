import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getDb } from "@/db/client";
import { PageHeader } from "@/components/app/PageHeader";
import { Button } from "@/components/ui/button";
import { readStaffSessionFromCookies } from "@/lib/auth/session";
import { isImpersonating } from "@/lib/auth/admin";
import { isNewAuthoringEnabled } from "@/lib/authoring/flag";

export const metadata: Metadata = { title: "Choose your editor" };

/**
 * R-12 (docs/editor-redesign-design.md): where a teacher picks the question
 * editor. Phase 9 cutover (2026-10-28): the new editor is the default, and
 * this page — linked from the editor — is the way back to the previous one
 * during the settling period. A plain form POST: it works without
 * JavaScript.
 */
export default async function NewEditorBetaPage() {
  const session = await readStaffSessionFromCookies();
  if (!session) redirect("/login?next=/dashboard/beta");
  const on = await isNewAuthoringEnabled(getDb(), session);
  const actingAs = isImpersonating(session);

  return (
    <main className="mx-auto max-w-xl space-y-6 px-6 py-12">
      <PageHeader
        crumbs={[{ label: "Assessments", href: "/dashboard" }]}
        title="Choose your editor"
        description="The redesigned question editor is now the default. You can switch to the previous editor and back at any time; your assessments are not changed by switching."
      />
      <p className="text-sm" role="status">
        {on ? (
          <>You are using the <strong>new</strong> editor.</>
        ) : (
          <>You are using the <strong>previous</strong> editor.</>
        )}
      </p>
      {actingAs ? (
        <p className="text-sm text-muted-foreground">
          This is the teacher&rsquo;s own choice; it can&rsquo;t be changed while acting as them.
        </p>
      ) : (
        <form action="/api/me/preferences" method="post">
          <input type="hidden" name="new_authoring" value={on ? "off" : "on"} />
          <Button type="submit" variant={on ? "outline" : "default"}>
            {on ? "Switch to the previous editor" : "Use the new editor"}
          </Button>
        </form>
      )}
    </main>
  );
}
