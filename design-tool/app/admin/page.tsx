import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { and, count, desc, eq, gt, isNull } from "drizzle-orm";
import { getDb } from "@/db/client";
import { assessments, safeguarding_alerts, test_sessions } from "@/db/schema";
import { isAdmin } from "@/lib/auth/admin";
import { readStaffSessionFromCookies } from "@/lib/auth/session";
import { closesAt, formatDate } from "@/lib/ui/format";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { EmptyState } from "@/components/app/EmptyState";
import { PageHeader } from "@/components/app/PageHeader";
import { SessionCode } from "@/components/app/SessionCode";
import { ActAsButton } from "@/app/dashboard/ActAsButton";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Admin" };

/**
 * Access slice 5 (docs/access-model-design.md, D-6 / D-8): the system admin's
 * one page.
 *
 * It answers the question `ADMIN_EMAILS` exists for — "what is running in the
 * district right now?" — and offers the two actions that go with it: Monitor
 * (read, already resolved for an admin by `authorizeSitting`) and Act as
 * (write, the only admin write D-6 allows outside this surface).
 *
 * **The grants console is NOT here** — it is slice 5b, deferred with slice 6.
 * `/api/grants` exists and has no UI; that is deliberate, not an omission.
 *
 * 404 for a non-admin, matching `/api/grants` (D-3): a "Forbidden" page would
 * tell any teacher the admin surface exists and that they are not on the list.
 * An impersonated admin is not an admin (`isAdmin` is false while `actor_sub`
 * is set), so this page disappears for the duration of an act-as.
 */
export default async function AdminPage() {
  const session = await readStaffSessionFromCookies();
  if (!session) {
    redirect("/login?next=/admin");
  }
  if (!isAdmin(session)) notFound();

  const db = getDb();
  const now = new Date();
  // District-wide on purpose and with no scope fragment: this is the one
  // surface whose whole point is that it is not scoped. "Open" is the
  // monitor's own definition — status open AND the window still running.
  const rows = await db
    .select({
      id: test_sessions.id,
      code: test_sessions.code,
      owner_email: test_sessions.owner_email,
      section_ps_id: test_sessions.section_ps_id,
      created_at: test_sessions.created_at,
      expires_at: test_sessions.expires_at,
      assessment_id: test_sessions.assessment_id,
      assessment_name: assessments.name,
      // Practice sittings (docs/practice-sitting-design.md, D-5): labelled
      // district-wide too — an admin should see every open lock.
      kind: test_sessions.kind,
    })
    .from(test_sessions)
    .innerJoin(assessments, eq(assessments.id, test_sessions.assessment_id))
    .where(and(eq(test_sessions.status, "open"), gt(test_sessions.expires_at, now)))
    .orderBy(desc(test_sessions.created_at));
  const [{ n: openAlerts } = { n: 0 }] = await db
    .select({ n: count() })
    .from(safeguarding_alerts)
    .where(isNull(safeguarding_alerts.acknowledged_at));

  return (
    <main className="mx-auto max-w-6xl space-y-8 px-6 py-12">
      <PageHeader
        title="Admin"
        description={`Test sessions open across the district (${rows.length})`}
      />

      {/* Safeguarding alerts slice 2 (D-7): the district-wide list lives on
          its own page; this line says whether there is anything on it. */}
      <p className="text-sm">
        <Link href="/admin/safeguarding" className="font-medium underline">
          Safeguarding alerts
        </Link>{" "}
        <span className="text-muted-foreground">
          · {openAlerts === 0 ? "none open" : `${openAlerts} open`}
        </span>
      </p>

      {rows.length === 0 ? (
        <EmptyState title="No test sessions are open right now." />
      ) : (
        <div className="overflow-x-auto rounded-lg border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Session code</TableHead>
                <TableHead>Assessment</TableHead>
                <TableHead>Teacher</TableHead>
                <TableHead>Section</TableHead>
                <TableHead>Started</TableHead>
                <TableHead className="text-right">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((s) => (
                <TableRow key={s.id}>
                  <TableCell>
                    <SessionCode code={s.code} size="row" />
                  </TableCell>
                  {/* A-1's shape: the name is the elastic column, everything
                      else is fixed, or the actions get pushed past the card. */}
                  <TableCell className="w-full max-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate font-medium" title={s.assessment_name}>
                        {s.assessment_name}
                      </span>
                      {/* D-5: same badge idiom as the home page's Open now
                          strip. */}
                      {s.kind === "practice" ? <Badge variant="neutral">Practice</Badge> : null}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {closesAt(s.expires_at, now)}
                    </div>
                  </TableCell>
                  <TableCell
                    className="w-56 max-w-56 truncate text-muted-foreground"
                    title={s.owner_email ?? undefined}
                  >
                    {s.owner_email ?? "—"}
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-muted-foreground">
                    {/* D-5: a practice sitting has no section — say what it is
                        instead of a bare dash. */}
                    {s.kind === "practice" ? "Practice" : (s.section_ps_id ?? "—")}
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-muted-foreground">
                    {formatDate(s.created_at)}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-2">
                      <Button asChild variant="outline" size="sm">
                        <Link href={`/dashboard/${s.assessment_id}/monitor/${s.id}`}>
                          Monitor
                        </Link>
                      </Button>
                      {/* No Act as on your own sitting — the route refuses it
                          (`self`) and the button would be a dead end. */}
                      {s.owner_email && s.owner_email !== session.email ? (
                        <ActAsButton email={s.owner_email} />
                      ) : null}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </main>
  );
}
