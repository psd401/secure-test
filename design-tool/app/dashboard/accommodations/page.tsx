import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { ChevronRight, FileSpreadsheet, Users } from "lucide-react";
import { getDb } from "@/db/client";
import { readStaffSessionFromCookies } from "@/lib/auth/session";
import { pendingTideDiffs } from "@/lib/accommodations/pendingDiffs";
import {
  sectionLabel,
  studentDisplayName,
  teacherRoster,
  type OverlayInfo,
} from "@/lib/roster/teacherRoster";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Students" };

/**
 * Slice 79 (ADR 0017): the roster is the teacher's sections, from the
 * warehouse snapshot. Accommodations remain the per-teacher overlay
 * (`students` + `student_accommodations`: TIDE import, then teacher edits,
 * then manual entry — CLAUDE.md), shown against each roster student and,
 * for overlay rows that match nobody in the current sections, under their
 * own heading so nothing the teacher entered disappears from view.
 *
 * UX pass 1, slice 8: every rostered student is a link (a student with no
 * overlay row yet goes through /roster/<ps_id>, which binds one — ACC-01);
 * the count is supports that are ON, with the IEP/504 tier called out
 * (ACC-02/03); pending TIDE changes are announced here (ACC-13).
 */
export default async function StudentsPage() {
  const session = await readStaffSessionFromCookies();
  if (!session) {
    redirect("/login?next=/dashboard/accommodations");
  }
  const db = getDb();
  const [roster, diffs] = await Promise.all([
    teacherRoster(db, session.sub, session.email),
    pendingTideDiffs(db, session.sub),
  ]);
  const totalRostered = roster.sections.reduce((n, s) => n + s.students.length, 0);
  const diffsByStudent = new Map<string, number>();
  for (const d of diffs) diffsByStudent.set(d.student_id, (diffsByStudent.get(d.student_id) ?? 0) + 1);

  return (
    <main className="mx-auto max-w-4xl space-y-8 px-6 py-12">
      <PageHeader
        title="Students"
        description="Your class list comes from PowerSchool and refreshes each morning. Accommodations come from TIDE imports and anything you add here; your edits survive re-imports."
        actions={
          <Button asChild variant="outline">
            <Link href="/dashboard/accommodations/import">
              <FileSpreadsheet aria-hidden />
              Import TIDE settings
            </Link>
          </Button>
        }
      />

      {diffs.length > 0 ? (
        <Alert variant="warning">
          <AlertTitle>
            {diffs.length} change{diffs.length === 1 ? "" : "s"} to review from the last TIDE import.
          </AlertTitle>
          <AlertDescription>
            <p>TIDE now says something different from a setting you had changed. Your value is still in effect.</p>
            <Button asChild size="sm" className="mt-2">
              <Link href="/dashboard/accommodations/import/review">Review changes</Link>
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}

      {roster.teacherEmail === null ? (
        <Alert variant="destructive">
          <AlertTitle>Your sign-in has no email address, so no sections can be looked up.</AlertTitle>
          <AlertDescription>Sign out and back in.</AlertDescription>
        </Alert>
      ) : roster.sections.length === 0 ? (
        <EmptyState
          icon={<Users />}
          title="Your class list hasn't arrived from PowerSchool yet"
          description={
            <>
              It updates each morning around 6 AM for <strong>{roster.teacherEmail}</strong>. If it is
              still empty tomorrow, let Research &amp; Assessment know.
            </>
          }
        />
      ) : (
        <div className="space-y-6">
          <p className="text-sm text-muted-foreground">
            {roster.sections.length} section{roster.sections.length === 1 ? "" : "s"} ·{" "}
            {totalRostered} enrollment{totalRostered === 1 ? "" : "s"}
          </p>
          {roster.sections.map(({ section, students }) => (
            <section key={section.ps_id} className="space-y-2">
              <h2 className="text-base font-semibold">
                {sectionLabel(section)}
                <span className="ml-2 font-normal text-muted-foreground">
                  {students.length} student{students.length === 1 ? "" : "s"}
                </span>
              </h2>
              <div className="overflow-x-auto rounded-lg border bg-card">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Student</TableHead>
                      <TableHead>Supports</TableHead>
                      <TableHead className="w-10"><span className="sr-only">Open</span></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {students.map(({ roster: s, overlay }) => (
                      <StudentRow
                        key={s.ps_id}
                        href={
                          overlay
                            ? `/dashboard/accommodations/${overlay.id}`
                            : `/dashboard/accommodations/roster/${encodeURIComponent(s.ps_id)}`
                        }
                        name={studentDisplayName(s)}
                        ssid={overlay?.ssid ?? s.ssid}
                        grade={overlay?.grade ?? s.grade}
                        overlay={overlay}
                        pending={overlay ? (diffsByStudent.get(overlay.id) ?? 0) : 0}
                      />
                    ))}
                  </TableBody>
                </Table>
              </div>
            </section>
          ))}
        </div>
      )}

      {roster.unlinked.length > 0 ? (
        <section className="space-y-2">
          <h2 className="text-base font-semibold">Not in your current sections</h2>
          <p className="text-sm text-muted-foreground">
            Accommodation records you imported or entered for students who are not in a section you
            currently teach. Kept as entered.
          </p>
          <div className="overflow-x-auto rounded-lg border bg-card">
            <Table>
              <TableBody>
                {roster.unlinked.map((o) => (
                  <StudentRow
                    key={o.id}
                    href={`/dashboard/accommodations/${o.id}`}
                    name={o.name}
                    ssid={o.ssid}
                    grade={o.grade}
                    overlay={o}
                    pending={diffsByStudent.get(o.id) ?? 0}
                  />
                ))}
              </TableBody>
            </Table>
          </div>
        </section>
      ) : null}
    </main>
  );
}

function StudentRow({
  href,
  name,
  ssid,
  grade,
  overlay,
  pending,
}: {
  href: string;
  name: string;
  ssid: string | null;
  grade: string | null;
  overlay: OverlayInfo | null;
  pending: number;
}) {
  const off = overlay ? overlay.accommodation_count - overlay.enabled_count : 0;
  return (
    <TableRow>
      <TableCell>
        <Link href={href} className="font-medium hover:underline">
          {name || <em className="text-muted-foreground">(no name)</em>}
        </Link>
        <div className="text-xs text-muted-foreground">
          SSID <code>{ssid ?? "—"}</code>
          {grade ? <> · grade {grade}</> : null}
        </div>
      </TableCell>
      <TableCell>
        <div className="flex flex-wrap items-center gap-1.5">
          {overlay && overlay.enabled_count > 0 ? (
            <Badge variant="success">
              {overlay.enabled_count} support{overlay.enabled_count === 1 ? "" : "s"} on
            </Badge>
          ) : (
            <Badge variant="neutral">0 supports on</Badge>
          )}
          {overlay && overlay.iep_count > 0 ? <Badge variant="info">IEP/504: {overlay.iep_count}</Badge> : null}
          {pending > 0 ? <Badge variant="warning">Review {pending}</Badge> : null}
          {off > 0 ? (
            <span className="text-xs text-muted-foreground">
              {off} TIDE setting{off === 1 ? "" : "s"} off
            </span>
          ) : null}
        </div>
      </TableCell>
      <TableCell className="text-right">
        <Link href={href} aria-label={`Open ${name || "student"}`} className="inline-flex text-muted-foreground">
          <ChevronRight className="size-4" aria-hidden />
        </Link>
      </TableCell>
    </TableRow>
  );
}
