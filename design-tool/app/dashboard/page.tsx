import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { and, count, desc, eq, gt, isNotNull, isNull } from "drizzle-orm";
import { FilePlus2 } from "lucide-react";
import { getDb } from "@/db/client";
import { assessments, attempts, items, test_sessions } from "@/db/schema";
import { listSharesForRecipient } from "@/lib/api/shares";
import { visibleAssessmentScope } from "@/lib/api/visibleAssessments";
import { AcceptShareButton } from "@/components/app/AcceptShareButton";
import { ArchiveAssessmentButton } from "./ArchiveAssessmentButton";
import { DeleteDraftButton } from "./DeleteDraftButton";
import { DuplicateAssessmentButton } from "./DuplicateAssessmentButton";
import { readStaffSessionFromCookies } from "@/lib/auth/session";
import { closesAt, formatDate } from "@/lib/ui/format";
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
interface PageProps {
  searchParams: Promise<{ archived?: string }>;
}

export default async function DashboardPage({ searchParams }: PageProps) {
  const session = await readStaffSessionFromCookies();
  if (!session) {
    redirect("/login?next=/dashboard");
  }

  // D-4 (docs/archive-and-delete-design.md): a server component, so the
  // archived/live views are two page loads (`?archived=1`) rather than
  // client state — the same split as GET /api/assessments.
  const { archived: archivedParam } = await searchParams;
  const showArchived = archivedParam === "1";

  const db = getDb();
  const now = new Date();
  // Access slice 2 (docs/access-model-design.md): every query on this page is
  // scoped to "assessments I can see" = owned ∪ granted, through the one shared
  // fragment — so the list, the counts and the Open-now strip cannot disagree
  // about what the caller may see.
  const visible = await visibleAssessmentScope(db, session);
  const [rows, archivedCount, openSessions, questionCounts, attemptCounts] = await Promise.all([
    db
      .select()
      .from(assessments)
      .where(
        and(
          visible.condition,
          showArchived ? isNotNull(assessments.archived_at) : isNull(assessments.archived_at),
        ),
      )
      .orderBy(desc(assessments.updated_at)),
    db
      .select({ n: count() })
      .from(assessments)
      .where(and(visible.condition, isNotNull(assessments.archived_at)))
      .then((r) => r[0]?.n ?? 0),
    // Same predicate as GET /api/test-sessions — sittings whose ASSESSMENT the
    // caller can see — narrowed to sessions whose window is still running,
    // which is the monitor's own definition of open.
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
          visible.condition,
          eq(test_sessions.status, "open"),
          gt(test_sessions.expires_at, now),
        ),
      )
      .orderBy(desc(test_sessions.created_at)),
    db
      .select({ assessment_id: items.assessment_id, n: count() })
      .from(items)
      .innerJoin(assessments, eq(assessments.id, items.assessment_id))
      .where(visible.condition)
      .groupBy(items.assessment_id),
    // D-1 / D-4 (docs/archive-and-delete-design.md): the row-level Delete
    // action needs this to disable itself and show "N attempts — archive
    // instead" without a round trip to the DELETE route first.
    db
      .select({ assessment_id: attempts.assessment_id, n: count() })
      .from(attempts)
      .innerJoin(assessments, eq(assessments.id, attempts.assessment_id))
      .where(visible.condition)
      .groupBy(attempts.assessment_id),
  ]);
  // Slice 3 renders the label; slice 2 makes the fact available on every row.
  const accessFor = new Map(rows.map((a) => [a.id, visible.annotate(a)]));
  const questionsFor = new Map(questionCounts.map((c) => [c.assessment_id, c.n]));
  const attemptsFor = new Map(attemptCounts.map((c) => [c.assessment_id, c.n]));
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
          {openSessions.map((s) => {
            // Access slice 3: a sitting on a co-teacher's assessment shows up
            // here too (the query is "sittings whose assessment I can see" —
            // slice 2) — the same label as the list row, so it reads the
            // same wherever it shows up.
            const sessionAccess = accessFor.get(s.assessment_id);
            return (
              <Card key={s.id}>
                <CardContent className="flex flex-wrap items-center gap-x-6 gap-y-3">
                  <SessionCode code={s.code} size="row" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium">{s.assessment_name}</div>
                    <div className="text-sm text-muted-foreground">{closesAt(s.expires_at, now)}</div>
                    {sessionAccess?.via === "grant" ? (
                      <div className="truncate text-xs text-muted-foreground">
                        Shared with you as co-teacher
                        {sessionAccess.owner_email ? ` · by ${sessionAccess.owner_email}` : ""}
                      </div>
                    ) : null}
                  </div>
                  <Button asChild>
                    <Link href={`/dashboard/${s.assessment_id}/monitor/${s.id}`}>Monitor</Link>
                  </Button>
                </CardContent>
              </Card>
            );
          })}
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
          title={showArchived ? "No archived assessments." : "No assessments yet"}
          description={
            showArchived
              ? undefined
              : "Create one to start adding questions, or import a file you exported earlier."
          }
          action={
            showArchived ? undefined : (
              <Button asChild>
                <Link href="/dashboard/new">New assessment</Link>
              </Button>
            )
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
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((a) => {
                const code = openCodeFor.get(a.id);
                // Access slice 2: Duplicate / Archive / Delete all need `own`
                // (the note's ladder), so a row reached through a grant does not
                // offer a button whose route would 404. Slice 3 adds the
                // "Shared with you as co-teacher" label from the same fact.
                const ownsRow = accessFor.get(a.id)?.level === "own";
                const rowAccess = accessFor.get(a.id);
                return (
                  <TableRow key={a.id}>
                    {/* A-1: the name is the elastic column. Auto table layout
                        ignores max-width on a cell, so w-full + max-w-0 makes
                        this cell take whatever the fixed columns leave and the
                        block + truncate link shortens a long name (full name
                        in the title) instead of pushing the actions past the
                        card edge. */}
                    <TableCell className="w-full max-w-0">
                      <Link
                        href={`/dashboard/${a.id}`}
                        className="block truncate font-medium hover:underline"
                        title={a.name}
                      >
                        {a.name}
                      </Link>
                      {a.description ? (
                        <div className="truncate text-sm text-muted-foreground">{a.description}</div>
                      ) : null}
                      {/* Access slice 3 (docs/access-model-design.md, D-4 (b)):
                          `via: "grant"` is a co-teacher's own row — the ONLY
                          grant kind with UI so far, so the label doesn't need
                          to say which level. */}
                      {rowAccess?.via === "grant" ? (
                        <div className="truncate text-xs text-muted-foreground">
                          Shared with you as co-teacher
                          {rowAccess.owner_email ? ` · by ${rowAccess.owner_email}` : ""}
                        </div>
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
                        {/* D-2 / D-4 (docs/archive-and-delete-design.md): the
                            archived view's own badge — a timestamp rather than
                            a status change, so unarchiving restores the row
                            exactly. */}
                        {a.archived_at ? <Badge variant="neutral">Archived {formatDate(a.archived_at)}</Badge> : null}
                      </div>
                    </TableCell>
                    {/* A-1 (docs/archive-and-delete-design.md): the bare
                        number — the header says "Questions"; with three row
                        actions the "N questions" copy pushed the table past
                        the card and hid Delete behind a horizontal scroll. */}
                    <TableCell className="text-right tabular-nums">
                      {questionsFor.get(a.id) ?? 0}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-muted-foreground">
                      {formatDate(a.updated_at)}
                    </TableCell>
                    {/* R1 (docs/reporting-design.md): until this the results
                        matrix was reachable only from inside the editor, which
                        is the wrong place to look for "how did they do?".
                        Published only — a draft has no attempts to report on.
                        D-4: an archived row drops the Results shortcut — it's
                        still reachable from the editor, this list just stops
                        offering it as a live action. */}
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-2">
                        {!a.archived_at && a.status === "published" ? (
                          <Button asChild variant="outline" size="sm">
                            <Link href={`/dashboard/${a.id}/results`}>Results</Link>
                          </Button>
                        ) : null}
                        {/* Duplicate (2026-09-16): allowed on Draft,
                            Published and archived rows alike — the copy is a
                            fresh Draft, so nothing the publish lock or the
                            archived view protects is touched. */}
                        {ownsRow ? (
                          <>
                            <DuplicateAssessmentButton id={a.id} />
                            <ArchiveAssessmentButton id={a.id} archived={a.archived_at !== null} />
                            {/* D-1 / D-4: a row action beside Results, same
                                disabled-and-noted posture as the editor's
                                Settings-tab Delete draft. */}
                            <DeleteDraftButton
                              id={a.id}
                              name={a.name}
                              questionCount={questionsFor.get(a.id) ?? 0}
                              attemptCount={attemptsFor.get(a.id) ?? 0}
                              status={a.status}
                            />
                          </>
                        ) : null}
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}

      {/* D-4: the two lists partition the teacher's assessments; the count
          hides the link once there is nothing archived to switch to. */}
      {showArchived ? (
        <p className="text-sm">
          <Link href="/dashboard" className="text-muted-foreground hover:underline">
            Hide archived
          </Link>
        </p>
      ) : archivedCount > 0 ? (
        <p className="text-sm">
          <Link href="/dashboard?archived=1" className="text-muted-foreground hover:underline">
            Show archived ({archivedCount})
          </Link>
        </p>
      ) : null}
    </main>
  );
}
