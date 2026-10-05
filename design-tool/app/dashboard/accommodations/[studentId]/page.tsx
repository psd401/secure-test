import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { and, asc, eq, isNull } from "drizzle-orm";
import { getDb } from "@/db/client";
import { roster_students, student_accommodations } from "@/db/schema";
import { readStaffSessionFromCookies } from "@/lib/auth/session";
import { studentHeading } from "@/lib/ui/format";
import { PageHeader } from "@/components/app/PageHeader";
import { StudentEditor } from "./StudentEditor";
import { UUID_RE } from "@/lib/uuid";
import { pageStudent } from "@/lib/api/access";
import { otherTeachersRecords } from "@/lib/accommodations/sharedRecords";
import { alsoOnRecordLine } from "@/lib/accommodations/previewView";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Student" };

interface PageProps {
  params: Promise<{ studentId: string }>;
}

export default async function StudentDetailPage({ params }: PageProps) {
  const session = await readStaffSessionFromCookies();
  if (!session) {
    redirect("/login?next=/dashboard/accommodations");
  }
  const { studentId } = await params;
  if (!UUID_RE.test(studentId)) {
    notFound();
  }
  const db = getDb();
  // UX pass 1, slice 3's posture: someone else's record is a 404 — the rule
  // access slice 1 (D-3) made universal.
  // The accommodations overlay is per-TEACHER, not per-assessment, so it stays
  // owner-only: no assessment grant reaches it (access slice 2).
  const student = await pageStudent(db, session, studentId, "own");
  if (!student) notFound();
  const accs = await db
    .select()
    .from(student_accommodations)
    .where(
      and(
        eq(student_accommodations.student_id, studentId),
        isNull(student_accommodations.removed_at),
      ),
    )
    .orderBy(
      asc(student_accommodations.subject),
      asc(student_accommodations.tool_id),
    );

  // U-17 (D-3): co-teachers' records for this child, read-only. An unbound
  // TIDE row is tied to the roster through its SSID.
  let psId = student.roster_ps_id;
  if (!psId && student.ssid) {
    const [r] = await db
      .select({ ps_id: roster_students.ps_id })
      .from(roster_students)
      .where(eq(roster_students.ssid, student.ssid))
      .limit(1);
    psId = r?.ps_id ?? null;
  }
  const others = psId
    ? ((await otherTeachersRecords(db, { sub: session.sub, email: session.email ?? null }, [psId])).get(psId) ?? [])
    : [];

  const heading = studentHeading(student);
  return (
    <main className="mx-auto max-w-4xl space-y-6 px-6 py-12">
      <PageHeader
        crumbs={[{ label: "Students", href: "/dashboard/accommodations" }]}
        title={heading}
        description={
          <>
            SSID <code>{student.ssid ?? "—"}</code>
            {student.grade ? <> · grade {student.grade}</> : null}
            {student.school ? <> · {student.school}</> : null}
          </>
        }
      />

      {others.length > 0 ? (
        <div className="space-y-1 rounded-lg border bg-card px-4 py-3 text-sm">
          {others.map((o) => (
            <p key={o.email}>{alsoOnRecordLine(o)}</p>
          ))}
          <p className="text-xs text-muted-foreground">
            A co-teacher&apos;s record counts on the tests you share, alongside this one. Change it on their
            Students page.
          </p>
        </div>
      ) : null}

      <StudentEditor
        studentId={student.id}
        initial={accs.map((a) => ({
          id: a.id,
          subject: a.subject,
          tool_id: a.tool_id,
          value: a.value,
          source: a.source as "tide_import" | "tide_then_edited" | "manual",
          tide_code: a.tide_code,
        }))}
      />
    </main>
  );
}
