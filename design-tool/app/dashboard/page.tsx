import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { and, count, desc, eq, gt } from "drizzle-orm";
import { FilePlus2 } from "lucide-react";
import { getDb } from "@/db/client";
import { assessments, items, test_sessions } from "@/db/schema";
import { listSharesForRecipient } from "@/lib/api/shares";
import { AcceptShareButton } from "@/components/app/AcceptShareButton";
import { readStaffSessionFromCookies } from "@/lib/auth/session";
import { closesAt, formatDate, plural } from "@/lib/ui/format";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
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
import { AssessmentStatusBadge } from "@/components/app/StatusBadge";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Assessments" };

/**
 * UX pass 1, slice 3 (SH-01, SH-06..11): the home page answers "what is
 * running right now?" before "what have I made?". Open sessions sit in a
 * strip above the list with the code and a Monitor link — until this slice
 * neither sessions nor the monitor were reachable from here at all.
 */
export default async function DashboardPage() {
  const session = await readStaffSessionFromCookies();
  if (!session) {
    redirect("/login?next=/dashboard");
  }

  const db = getDb();
  const now = new Date();
  const [rows, openSessions, questionCounts] = await Promise.all([
    db
      .select()
      .from(assessments)
      .where(eq(assessments.owner_sub, session.sub))
      .orderBy(desc(assessments.updated_at)),
    // Same predicate as GET /api/test-sessions (owner) narrowed to sessions
    // whose window is still running — the monitor's own definition of open.
    db
      .select({
        id: test_sessions.id,
        code: test_sessions.code,
        expires_at: test_sessions.expires_at,
        assessment_id: test_sessions.assessment_id,
        assessment_name: assessments.name,
      })
      .from(test_sessions)
      .innerJoin(assessments, eq(assessments.id, test_sessions.assessment_id))
      .where(
        and(
          eq(test_sessions.owner_sub, session.sub),
          eq(test_sessions.status, "open"),
          gt(test_sessions.expires_at, now),
        ),
      )
      .orderBy(desc(test_sessions.created_at)),
    db
      .select({ assessment_id: items.assessment_id, n: count() })
      .from(items)
      .innerJoin(assessments, eq(assessments.id, items.assessment_id))
      .where(eq(assessments.owner_sub, session.sub))
      .groupBy(items.assessment_id),
  ]);
  const questionsFor = new Map(questionCounts.map((c) => [c.assessment_id, c.n]));
  // Slice C: offers from colleagues that have not been added yet. Accepted
  // ones already appear in the list below as the teacher's own copy.
  const pendingShares = session.email
    ? (await listSharesForRecipient(session.email)).filter((s) => !s.copied_assessment_id)
    : [];
  const openCodeFor = new Map<string, string>();
  for (const s of openSessions) {
    if (!openCodeFor.has(s.assessment_id)) openCodeFor.set(s.assessment_id, s.code);
  }

  return (
    <main className="mx-auto max-w-4xl space-y-8 px-6 py-12">
      <PageHeader
        title="Assessments"
        actions={
          <>
            <Button asChild variant="outline">
              <Link href="/dashboard/uploads">Images</Link>
            </Button>
            <Button asChild variant="outline">
              <Link href="/dashboard/import">Import assessment file</Link>
            </Button>
            <Button asChild>
              <Link href="/dashboard/new">New assessment</Link>
            </Button>
          </>
        }
      />

      {openSessions.length > 0 ? (
        <section aria-labelledby="open-now" className="space-y-3">
          <h2 id="open-now" className="text-xs font-semibold uppercase tracking-wider text-success-foreground">
            Open now
          </h2>
          {openSessions.map((s) => (
            <Card key={s.id}>
              <CardContent className="flex flex-wrap items-center gap-x-6 gap-y-3">
                <SessionCode code={s.code} size="row" />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{s.assessment_name}</div>
                  <div className="text-sm text-muted-foreground">{closesAt(s.expires_at, now)}</div>
                </div>
                <Button asChild>
                  <Link href={`/dashboard/${s.assessment_id}/monitor/${s.id}`}>Monitor</Link>
                </Button>
              </CardContent>
            </Card>
          ))}
        </section>
      ) : null}

      {pendingShares.length > 0 ? (
        <section aria-labelledby="shared-with-you" className="space-y-3">
          <h2 id="shared-with-you" className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Shared with you
          </h2>
          {pendingShares.map((s) => (
            <Card key={s.id}>
              <CardContent className="flex flex-wrap items-center gap-x-6 gap-y-3">
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{s.assessment_name}</div>
                  <div className="text-sm text-muted-foreground">
                    From {s.shared_by_email} · {formatDate(s.created_at)} · you get your own copy
                  </div>
                </div>
                <AcceptShareButton shareId={s.id} />
              </CardContent>
            </Card>
          ))}
        </section>
      ) : null}

      {rows.length === 0 ? (
        <EmptyState
          icon={<FilePlus2 />}
          title="No assessments yet"
          description="Create one to start adding questions, or import a file you exported earlier."
          action={
            <Button asChild>
              <Link href="/dashboard/new">New assessment</Link>
            </Button>
          }
        />
      ) : (
        <div className="overflow-x-auto rounded-lg border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Assessment</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Questions</TableHead>
                <TableHead>Updated</TableHead>
                <TableHead className="text-right">
                  <span className="sr-only">Results</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((a) => {
                const code = openCodeFor.get(a.id);
                return (
                  <TableRow key={a.id}>
                    <TableCell className="max-w-md">
                      <Link href={`/dashboard/${a.id}`} className="font-medium hover:underline">
                        {a.name}
                      </Link>
                      {a.description ? (
                        <div className="truncate text-sm text-muted-foreground">{a.description}</div>
                      ) : null}
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <AssessmentStatusBadge status={a.status} />
                        {code ? (
                          <Badge variant="info">
                            Open session · <span className="font-mono">{code}</span>
                          </Badge>
                        ) : null}
                      </div>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {plural(questionsFor.get(a.id) ?? 0, "question")}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-muted-foreground">
                      {formatDate(a.updated_at)}
                    </TableCell>
                    {/* R1 (docs/reporting-design.md): until this the results
                        matrix was reachable only from inside the editor, which
                        is the wrong place to look for "how did they do?".
                        Published only — a draft has no attempts to report on. */}
                    <TableCell className="text-right">
                      {a.status === "published" ? (
                        <Button asChild variant="outline" size="sm">
                          <Link href={`/dashboard/${a.id}/results`}>Results</Link>
                        </Button>
                      ) : null}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </main>
  );
}
