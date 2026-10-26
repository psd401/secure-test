import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getDb } from "@/db/client";
import { PageHeader } from "@/components/app/PageHeader";
import { Button } from "@/components/ui/button";
import { readStaffSessionFromCookies } from "@/lib/auth/session";
import { isImpersonating } from "@/lib/auth/admin";
import { isNewAuthoringEnabled } from "@/lib/authoring/flag";

export const metadata: Metadata = { title: "New editor (beta)" };

/**
 * R-12 (docs/editor-redesign-design.md): where a pilot teacher opts in to the
 * new authoring experience, and back out. Deliberately linked from nowhere in
 * the app while the flag defaults off, so a teacher who has not been sent the
 * address sees nothing new (D-9). A plain form POST: it works without
 * JavaScript and is the way back to the current editor.
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
        title="New editor (beta)"
        description="Try the redesigned question editor. You can switch back at any time; your assessments are not changed by switching."
      />
      <p className="text-sm" role="status">
        {on ? (
          <>The new editor is <strong>on</strong> for your account.</>
        ) : (
          <>You are using the <strong>current</strong> editor.</>
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
            {on ? "Switch back to the current editor" : "Try the new editor (beta)"}
          </Button>
        </form>
      )}
    </main>
  );
}
