import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { and, asc, eq, isNull } from "drizzle-orm";
import { getDb } from "@/db/client";
import { students, student_accommodations } from "@/db/schema";
import { readStaffSessionFromCookies } from "@/lib/auth/session";
import { studentHeading } from "@/lib/ui/format";
import { PageHeader } from "@/components/app/PageHeader";
import { StudentEditor } from "./StudentEditor";
import { UUID_RE } from "@/lib/uuid";

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
  const [student] = await db
    .select()
    .from(students)
    .where(eq(students.id, studentId))
    .limit(1);
  if (!student) notFound();
  // UX pass 1, slice 3's posture: someone else's record is a 404.
  if (student.owner_sub !== session.sub) notFound();
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
