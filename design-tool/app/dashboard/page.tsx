import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { and, count, desc, eq, gt, isNotNull, isNull } from "drizzle-orm";
import { FilePlus2 } from "lucide-react";
import { getDb } from "@/db/client";
import { assessments, items, test_sessions } from "@/db/schema";
import { listSharesForRecipient } from "@/lib/api/shares";
import { unseenAssessmentGrantIds } from "@/lib/api/grants";
import { visibleAssessmentScope } from "@/lib/api/visibleAssessments";
import { AcceptShareButton } from "@/components/app/AcceptShareButton";
import { ArchiveAssessmentButton } from "./ArchiveAssessmentButton";
import { DeleteDraftButton } from "./DeleteDraftButton";
import { DuplicateAssessmentButton } from "./DuplicateAssessmentButton";
import { ActAsButton } from "./ActAsButton";
import { isAdmin } from "@/lib/auth/admin";
import { readStaffSessionFromCookies, type SessionPayload } from "@/lib/auth/session";
import { sittingVisibleToCaller } from "@/lib/api/testSessions";
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
import { proctorCaseCount } from "@/lib/competency/proctoring";
import { counselorSchoolIds } from "@/lib/competency/counselors";
import { schoolGrantSchools } from "@/lib/competency/schoolGrants";
import { normalizeEmail } from "@/lib/roster/queries";
import { SessionCode } from "@/components/app/SessionCode";
import { AssessmentStatusBadge } from "@/components/app/StatusBadge";
import { SafeguardingBadge } from "@/components/app/SafeguardingBadge";
import { openAlertCountsByAssessment } from "@/lib/safeguarding/alertQueries";
import { isNewAuthoringEnabled } from "@/lib/authoring/flag";
import { startTemplates } from "@/lib/authoring/templates";
import { StartScreen } from "./new/StartScreen";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import {
  DEFAULT_ALL_LIST_PARAMS,
  allListQueryEntries,
  filterAndSortAllList,
  hasActiveFilters,
  nextSort,
  ownerOptions,
  parseAllListParams,
  type AllListParams,
  type AllListSortKey,
} from "@/lib/ui/allTeachersList";
import { attemptStatsByAssessment } from "@/lib/api/teacherSummary";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Assessments" };

/**
 * UX pass 1, slice 3 (SH-01, SH-06..11): the home page answers "what is
 * running right now?" before "what have I made?". Open sessions sit in a
 * strip above the list with the code and a Monitor link — until this slice
 * neither sessions nor the monitor were reachable from here at all.
 */
interface PageProps {
  // q / owner / status / attempts / sort / dir: the admin all view's list
  // controls (lib/ui/allTeachersList.ts); ignored in the "mine" view.
  searchParams: Promise<Record<string, string | undefined>>;
}

/**
 * Slice 5a (docs/access-model-design.md, D-6 clarified 2026-09-21): only an
 * admin gets the "All teachers" toggle at all — a non-admin's `?all=1` is
 * silently ignored by `visibleAssessmentScope` itself, but the LINK should
 * never render for someone it does nothing for. Pure so it is testable
 * without a DOM.
 */
export function showAllTeachersToggle(
  session: Pick<SessionPayload, "email" | "actor_sub">,
): boolean {
  return isAdmin(session);
}

/**
 * A5-1 (docs/design-tool-manual-checks.md row 240): the Owner column read
 * "—" for a row the admin themselves owns, because `owner_email` is only
 * populated by `visibleAssessmentScope.annotate` for a row that is NOT the
 * caller's own (see RowAccess's doc comment) — so an admin's own row has a
 * null `owner_email` and looked foreign. `via === "owner"` is the actual
 * signal; "—" stays for a genuinely foreign row with no owner_email. Pure
 * so it is testable without a DOM.
 */
export function ownerCell(
  access: { via: string } | undefined,
  owner_email: string | null,
): string {
  if (access?.via === "owner") return "you";
  return owner_email ?? "—";
}

/**
 * "mine" is the default and the only mode a non-admin ever gets, even if
 * `?all=1` is in the URL by hand. Pure so it is testable without a DOM.
 */
export function homeListMode(
  searchParams: { all?: string },
  admin: boolean,
): "mine" | "all" {
  return admin && searchParams.all === "1" ? "all" : "mine";
}

export default async function DashboardPage({ searchParams }: PageProps) {
  const session = await readStaffSessionFromCookies();
  if (!session) {
    redirect("/login?next=/dashboard");
  }

  // D-4 (docs/archive-and-delete-design.md): a server component, so the
  // archived/live views are two page loads (`?archived=1`) rather than
  // client state — the same split as GET /api/assessments.
  const sp = await searchParams;
  const { archived: archivedParam, all: allParam } = sp;
  const showArchived = archivedParam === "1";
  const admin = showAllTeachersToggle(session);
  const listMode = homeListMode({ all: allParam }, admin);
  const showAll = listMode === "all";
  const listParams = showAll ? parseAllListParams(sp) : DEFAULT_ALL_LIST_PARAMS;

  const db = getDb();
  const now = new Date();
  // Access slice 2 (docs/access-model-design.md): every query on this page is
  // scoped to "assessments I can see" = owned ∪ granted, through the one shared
  // fragment — so the list, the counts and the Open-now strip cannot disagree
  // about what the caller may see. Slice 5a: `showAll` widens that scope to
  // every teacher's rows, admin-only (ignored otherwise by the scope itself).
  const visible = await visibleAssessmentScope(db, session, { all: showAll });
  // CBA slice 4: the proctor's cue to /dashboard/proctoring.
  const proctorCases = await proctorCaseCount(db, normalizeEmail(session.email));
  // CBA slice 6: a counselor's cue to their school's released results.
  const counselorSchools = await counselorSchoolIds(db, session.email);
  // CBA slice 8: a counselor who may also assign.
  const counselorAssigns = (await schoolGrantSchools(db, session.email, "run")).length > 0;
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
        // Practice sittings (docs/practice-sitting-design.md, D-5): label a
        // practice row on the strip too — an admin's "Open now" should show
        // every open lock, not just class ones.
        kind: test_sessions.kind,
      })
      .from(test_sessions)
      .innerJoin(assessments, eq(assessments.id, test_sessions.assessment_id))
      .where(
        and(
          visible.condition,
          // D-5: another teacher's practice sitting is theirs alone.
          sittingVisibleToCaller(session.sub),
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
    // The all view's Students / Submitted columns ride on the same query
    // (practice attempts excluded there; `n` counts every attempt).
    attemptStatsByAssessment(db, visible.condition),
  ]);
  // Slice 3 renders the label; slice 2 makes the fact available on every row.
  const accessFor = new Map(rows.map((a) => [a.id, visible.annotate(a)]));
  const questionsFor = new Map(questionCounts.map((c) => [c.assessment_id, c.n]));
  const attemptsFor = new Map(attemptCounts.map((c) => [c.assessment_id, c.n]));
  const attemptStatsFor = new Map(attemptCounts.map((c) => [c.assessment_id, c]));
  // The all view filters and sorts on the server from the URL params; the
  // mine view keeps its updated-desc order untouched.
  const shownRows = showAll
    ? filterAndSortAllList(
        rows.map((a) => ({
          ...a,
          questions: questionsFor.get(a.id) ?? 0,
          students: attemptStatsFor.get(a.id)?.students ?? 0,
          submitted: attemptStatsFor.get(a.id)?.submitted ?? 0,
        })),
        listParams,
      )
    : rows;
  const owners = showAll ? ownerOptions(rows) : [];
  const listHref = (p: AllListParams) =>
    dashboardHref({ archived: showArchived, all: showAll, list: p });
  // Safeguarding alerts slice 2 (docs/safeguarding-alerts-design.md): open
  // alerts per row, through the same scope fragment as the list itself.
  const openAlertsFor = await openAlertCountsByAssessment(db, visible.condition);
  // Slice C: offers from colleagues that have not been added yet. Accepted
  // ones already appear in the list below as the teacher's own copy.
  const pendingShares = session.email
    ? (await listSharesForRecipient(session.email)).filter((s) => !s.copied_assessment_id)
    : [];
  // Share notifications (docs/share-notifications-design.md): a co-teach grant
  // the teacher has not opened yet carries "New" on its row.
  const unseenGrants = await unseenAssessmentGrantIds(db, session.email);
  // Editor redesign Phase 8 (D-5): with the R-12 flag on, a teacher with no
  // assessments yet gets the start screen in place of the empty state.
  const startScreenHere =
    rows.length === 0 && !showArchived && !showAll && (await isNewAuthoringEnabled(db, session));
  const openCodeFor = new Map<string, string>();
  for (const s of openSessions) {
    if (!openCodeFor.has(s.assessment_id)) openCodeFor.set(s.assessment_id, s.code);
  }

  // A5-3: the all view carries an Owner column the 4xl card cannot fit
  // beside the actions, so it gets the wider container.
  return (
    <main className={`mx-auto ${showAll ? "max-w-7xl" : "max-w-4xl"} space-y-8 px-6 py-12`}>
      <PageHeader
        title={
          showAll
            ? `All teachers' assessments (${
                shownRows.length === rows.length ? rows.length : `${shownRows.length} of ${rows.length}`
              })`
            : "Assessments"
        }
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

      {proctorCases > 0 ? (
        <Card>
          <CardContent className="flex flex-wrap items-center justify-between gap-3">
            <div className="text-sm">
              <span className="font-medium">Competency assessments</span>
              <span className="text-muted-foreground">
                {" "}
                · {proctorCases} {proctorCases === 1 ? "student" : "students"} assigned to you as proctor
              </span>
            </div>
            <Button asChild variant="outline">
              <Link href="/dashboard/proctoring">Open</Link>
            </Button>
          </CardContent>
        </Card>
      ) : null}

      {counselorSchools.length > 0 ? (
        <Card>
          <CardContent className="flex flex-wrap items-center justify-between gap-3">
            <div className="text-sm">
              <span className="font-medium">Competency results</span>
              <span className="text-muted-foreground"> · released results for your school</span>
            </div>
            <div className="flex gap-2">
              {counselorAssigns ? (
                <Button asChild variant="outline">
                  <Link href="/dashboard/competency-assign">Assign students</Link>
                </Button>
              ) : null}
              <Button asChild variant="outline">
                <Link href="/dashboard/competency-results">Open</Link>
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : null}

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
                    <div className="flex items-center gap-1.5">
                      <span className="truncate font-medium">{s.assessment_name}</span>
                      {/* D-5: same badge idiom as the list row's Open session
                          chip below. */}
                      {s.kind === "practice" ? <Badge variant="neutral">Practice</Badge> : null}
                    </div>
                    <div className="text-sm text-muted-foreground">{closesAt(s.expires_at, now)}</div>
                    {sessionAccess?.via === "grant" ? (
                      <div className="truncate text-xs text-muted-foreground">
                        Shared with you as co-teacher
                        {sessionAccess.owner_email ? ` · by ${sessionAccess.owner_email}` : ""}
                      </div>
                    ) : null}
                    {/* Slice 5a: the "All teachers" view's Open-now strip
                        names whose sitting this is — there is no other owner
                        cue on a card, unlike the list rows' Owner column. */}
                    {sessionAccess?.via === "admin" && sessionAccess.owner_email ? (
                      <div className="truncate text-xs text-muted-foreground">
                        {sessionAccess.owner_email}
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
                  <div className="flex items-center gap-1.5">
                    <span className="truncate font-medium">{s.assessment_name}</span>
                    <Badge variant="info">New</Badge>
                  </div>
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

      {startScreenHere ? (
        <StartScreen templates={startTemplates()} showCancel={false} />
      ) : rows.length === 0 ? (
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
        <div className="space-y-3">
        {showAll ? (
          <AllListFilters
            params={listParams}
            owners={owners}
            archived={showArchived}
            clearHref={listHref({ ...DEFAULT_ALL_LIST_PARAMS, sort: listParams.sort, dir: listParams.dir })}
          />
        ) : null}
        {shownRows.length === 0 ? (
          <p className="rounded-lg border bg-card px-4 py-8 text-center text-sm text-muted-foreground">
            No assessments match these filters.
          </p>
        ) : (
        <div className="overflow-x-auto rounded-lg border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                {showAll ? (
                  <>
                    <SortHead label="Assessment" k="name" params={listParams} href={listHref} />
                    <SortHead label="Owner" k="owner" params={listParams} href={listHref} />
                    <SortHead label="Status" k="status" params={listParams} href={listHref} />
                    <SortHead label="Questions" k="questions" params={listParams} href={listHref} right />
                    <SortHead label="Students" k="students" params={listParams} href={listHref} right />
                    <SortHead label="Submitted" k="submitted" params={listParams} href={listHref} right />
                    <SortHead label="Created" k="created" params={listParams} href={listHref} />
                    <SortHead label="Updated" k="updated" params={listParams} href={listHref} />
                  </>
                ) : (
                  <>
                    <TableHead>Assessment</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Questions</TableHead>
                    <TableHead>Updated</TableHead>
                  </>
                )}
                <TableHead className="text-right">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {shownRows.map((a) => {
                const code = openCodeFor.get(a.id);
                // Access slice 2/5a: Duplicate / Archive / Delete all need
                // `own` (the note's ladder), but the gate here is the
                // NARROWER `via`, not `level` — an admin also resolves to
                // `own` (via "admin") on rows it does not own, and D-6 keeps
                // admin writes to the admin surface (same rule the editor's
                // `isOwnerAccess` applies). A row reached through a co-teach
                // grant does not offer a button whose route would 404 either.
                const ownsRow = accessFor.get(a.id)?.via === "owner";
                const rowAccess = accessFor.get(a.id);
                // Slice 5b (docs/competency-assessment-design.md): a scorer's
                // row opens the scoring page — the editor needs `edit`.
                const scorerRow = rowAccess?.via === "grant" && rowAccess.level === "score";
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
                        href={scorerRow ? `/dashboard/${a.id}/scoring` : `/dashboard/${a.id}`}
                        className="block truncate font-medium hover:underline"
                        title={a.name}
                      >
                        {a.name}
                      </Link>
                      {a.description ? (
                        <div className="truncate text-sm text-muted-foreground">{a.description}</div>
                      ) : null}
                      {/* Access slice 3 (docs/access-model-design.md, D-4 (b)):
                          `via: "grant"` is a co-teacher's own row, or since
                          slice 5b a scorer's — the two grant kinds with UI. */}
                      {rowAccess?.via === "grant" ? (
                        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                          <span className="truncate">
                            {scorerRow ? "Shared with you as scorer" : "Shared with you as co-teacher"}
                            {rowAccess.owner_email ? ` · by ${rowAccess.owner_email}` : ""}
                          </span>
                          {unseenGrants.has(a.id.toLowerCase()) ? <Badge variant="info">New</Badge> : null}
                        </div>
                      ) : null}
                    </TableCell>
                    {/* Slice 5a: only in the "All teachers" view. A5-2: the
                        extra column pushed the table past the card, hiding
                        Delete behind a horizontal scroll — same fix as A-1's
                        name cell (max-w-0 + truncate; auto table layout
                        otherwise ignores max-width on a cell), full address
                        in the title since the cell can now clip it. A5-3
                        (rev 44 re-check): two `w-full max-w-0` cells split
                        the flexible width and the address clipped to four
                        characters — the owner cell gets a fixed width and
                        the name cell keeps the flex. */}
                    {showAll ? (
                      <TableCell
                        className="w-56 max-w-56 truncate text-muted-foreground"
                        title={rowAccess?.via === "owner" ? undefined : (a.owner_email ?? undefined)}
                      >
                        {/* Clicking an owner narrows the list to their work. */}
                        {a.owner_email ? (
                          <Link
                            href={listHref({ ...listParams, owner: a.owner_email.toLowerCase() })}
                            className="hover:underline"
                          >
                            {ownerCell(rowAccess, a.owner_email)}
                          </Link>
                        ) : (
                          ownerCell(rowAccess, a.owner_email)
                        )}
                      </TableCell>
                    ) : null}
                    <TableCell>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <AssessmentStatusBadge status={a.status} />
                        {openAlertsFor.get(a.id) ? (
                          <Link href={`/dashboard/${a.id}/results`} className="no-underline">
                            <SafeguardingBadge
                              count={openAlertsFor.get(a.id) ?? 0}
                              title="A safeguarding check flagged an answer on this assessment. Open Results to read it."
                            />
                          </Link>
                        ) : null}
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
                    {showAll ? (
                      <>
                        <TableCell className="text-right tabular-nums">
                          {attemptStatsFor.get(a.id)?.students ?? 0}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {attemptStatsFor.get(a.id)?.submitted ?? 0}
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-muted-foreground">
                          {formatDate(a.created_at)}
                        </TableCell>
                      </>
                    ) : null}
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
                        {/* Slice 5 (D-8): act-as, only in the all view and
                            only on a row the admin does NOT own — the entry
                            point to the one write path D-6 allows an admin
                            outside the admin surface. `via === "admin"` is
                            exactly "this row resolved because I am an admin",
                            and `owner_email` is the address to act as; a row
                            with none cannot be resolved to a sub anyway. */}
                        {rowAccess?.via === "admin" && a.owner_email ? (
                          <ActAsButton email={a.owner_email} />
                        ) : null}
                        {/* The all view is for surveying everyone's work: it
                            shows Results and Act as only. An admin's own
                            Duplicate / Archive / Delete stay in My
                            assessments — four buttons here squeezed the name
                            column to ~100px at 1440px and pushed Delete past
                            the card edge (James, 2026-11-05). */}
                        {ownsRow && !showAll ? (
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
        </div>
      )}

      {/* D-4: the two lists partition the teacher's assessments; the count
          hides the link once there is nothing archived to switch to. Slice
          5a: the admin-only "All teachers" toggle sits beside it and is
          composable with `?archived=1` — flipping one param keeps the
          other. */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        {showArchived ? (
          <p className="text-sm">
            <Link
              href={dashboardHref({ archived: false, all: showAll, list: listParams })}
              className="text-muted-foreground hover:underline"
            >
              Hide archived
            </Link>
          </p>
        ) : archivedCount > 0 ? (
          <p className="text-sm">
            <Link
              href={dashboardHref({ archived: true, all: showAll, list: listParams })}
              className="text-muted-foreground hover:underline"
            >
              Show archived ({archivedCount})
            </Link>
          </p>
        ) : null}
        {admin ? (
          <p className="text-sm">
            <Link
              href={dashboardHref({ archived: showArchived, all: !showAll })}
              className="text-muted-foreground hover:underline"
            >
              {showAll ? "My assessments" : "All teachers"}
            </Link>
          </p>
        ) : null}
      </div>
    </main>
  );
}

/**
 * `/dashboard` with `?archived=1` / `?all=1` set from booleans, composable —
 * flipping one param (the archived toggle, the slice 5a admin toggle) never
 * drops the other. The all view's list params (search, filters, sort) ride
 * along only while `all` is on, so leaving the all view drops them. Pure so
 * it is testable without a DOM.
 */
export function dashboardHref(params: {
  archived: boolean;
  all: boolean;
  list?: AllListParams;
}): string {
  const qs = new URLSearchParams();
  if (params.archived) qs.set("archived", "1");
  if (params.all) {
    qs.set("all", "1");
    if (params.list) for (const [k, v] of allListQueryEntries(params.list)) qs.set(k, v);
  }
  const s = qs.toString();
  return s ? `/dashboard?${s}` : "/dashboard";
}

/** A sortable header for the all view: a link to the same view, re-sorted. */
function SortHead({
  label,
  k,
  params,
  href,
  right,
}: {
  label: string;
  k: AllListSortKey;
  params: AllListParams;
  href: (p: AllListParams) => string;
  right?: boolean;
}) {
  const active = params.sort === k;
  const arrow = active ? (params.dir === "asc" ? " ▲" : " ▼") : "";
  return (
    <TableHead
      className={right ? "text-right" : undefined}
      aria-sort={active ? (params.dir === "asc" ? "ascending" : "descending") : undefined}
    >
      <Link href={href(nextSort(params, k))} className="whitespace-nowrap hover:underline">
        {label}
        {arrow}
      </Link>
    </TableHead>
  );
}

/**
 * The all view's filter bar: a plain GET form, so the filters land in the
 * URL with no client JS. Sort and the archived toggle ride as hidden fields.
 */
function AllListFilters({
  params,
  owners,
  archived,
  clearHref,
}: {
  params: AllListParams;
  owners: string[];
  archived: boolean;
  clearHref: string;
}) {
  return (
    // key: a Link (owner link, sort header, Clear) navigates client-side and
    // keeps this form mounted, so defaultValue would show the OLD filters.
    // Keying on the params remounts it with the current ones.
    <form key={JSON.stringify(params)} method="get" action="/dashboard" className="flex flex-wrap items-end gap-2">
      <input type="hidden" name="all" value="1" />
      {archived ? <input type="hidden" name="archived" value="1" /> : null}
      <input type="hidden" name="sort" value={params.sort} />
      <input type="hidden" name="dir" value={params.dir} />
      <Input
        type="search"
        name="q"
        defaultValue={params.q}
        placeholder="Search name or owner"
        aria-label="Search name or owner"
        className="w-64"
      />
      <NativeSelect name="owner" defaultValue={params.owner} aria-label="Owner">
        <option value="">All owners</option>
        {owners.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </NativeSelect>
      <NativeSelect name="status" defaultValue={params.status} aria-label="Status">
        <option value="">Any status</option>
        <option value="draft">Draft</option>
        <option value="published">Published</option>
      </NativeSelect>
      <NativeSelect name="attempts" defaultValue={params.attempts} aria-label="Student attempts">
        <option value="">With or without students</option>
        <option value="yes">Has students</option>
        <option value="no">No students yet</option>
      </NativeSelect>
      <Button type="submit" variant="outline">
        Apply
      </Button>
      {hasActiveFilters(params) ? (
        <Link href={clearHref} className="self-center text-sm text-muted-foreground hover:underline">
          Clear filters
        </Link>
      ) : null}
    </form>
  );
}
