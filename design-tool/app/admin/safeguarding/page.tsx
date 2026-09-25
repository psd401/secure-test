import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getDb } from "@/db/client";
import { isAdmin } from "@/lib/auth/admin";
import { readStaffSessionFromCookies } from "@/lib/auth/session";
import { listDistrictAlerts } from "@/lib/safeguarding/alertQueries";
import { ALERT_DISCLAIMER, alertHeading, isOpenAlert } from "@/lib/safeguarding/alertView";
import { formatDateTime } from "@/lib/ui/format";
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
export const metadata: Metadata = { title: "Safeguarding alerts" };

interface PageProps {
  searchParams: Promise<{ show?: string }>;
}

/**
 * "open" unless `?show=all` — the default is the list that still needs
 * somebody. Pure so it is testable without a DOM.
 */
export function adminAlertMode(searchParams: { show?: string }): "open" | "all" {
  return searchParams.show === "all" ? "all" : "open";
}

/**
 * Safeguarding alerts slice 2 (docs/safeguarding-alerts-design.md, D-7): the
 * system admin's district-wide list — every alert, newest first, with where it
 * came from and whether the teacher has acknowledged it.
 *
 * Each row links to the per-student results page directly: an admin already
 * resolves view on every assessment (`authorizeAssessment`, via "admin"), the
 * same path `/admin`'s Monitor links use, so no Act as is needed to READ it.
 * Acknowledge is not offered to the admin there — it is the teacher's (access-model D-6).
 *
 * 404 for a non-admin and while impersonating, like `/admin` itself.
 */
export default async function AdminSafeguardingPage({ searchParams }: PageProps) {
  const session = await readStaffSessionFromCookies();
  if (!session) {
    redirect("/login?next=/admin/safeguarding");
  }
  if (!isAdmin(session)) notFound();

  const mode = adminAlertMode(await searchParams);
  const alerts = await listDistrictAlerts(getDb(), { openOnly: mode === "open" });

  return (
    <main className="mx-auto max-w-6xl space-y-6 px-6 py-12">
      <div>
        <Link href="/admin" className="text-sm text-muted-foreground underline">
          ← Back to admin
        </Link>
      </div>
      <PageHeader
        title="Safeguarding alerts"
        description={
          mode === "open"
            ? `Not yet acknowledged, across the district (${alerts.length})`
            : `Every alert, across the district (${alerts.length})`
        }
      />
      <div className="flex gap-2">
        <Button asChild variant={mode === "open" ? "default" : "outline"} size="sm">
          <Link href="/admin/safeguarding">Open only</Link>
        </Button>
        <Button asChild variant={mode === "all" ? "default" : "outline"} size="sm">
          <Link href="/admin/safeguarding?show=all">All</Link>
        </Button>
      </div>

      {alerts.length === 0 ? (
        <EmptyState
          title={mode === "open" ? "No open safeguarding alerts." : "No safeguarding alerts yet."}
        />
      ) : (
        <div className="overflow-x-auto rounded-lg border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Flagged</TableHead>
                <TableHead>Concern</TableHead>
                <TableHead>Assessment</TableHead>
                <TableHead>Teacher</TableHead>
                <TableHead>Student</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {alerts.map((a) => (
                <TableRow key={a.id}>
                  <TableCell className="whitespace-nowrap text-muted-foreground">
                    {formatDateTime(a.created_at)}
                  </TableCell>
                  <TableCell className="whitespace-normal">{alertHeading(a.category)}</TableCell>
                  <TableCell className="w-full max-w-0">
                    <span
                      className="block truncate font-medium"
                      title={a.assessment_name ?? undefined}
                    >
                      {a.assessment_name ?? "(deleted assessment)"}
                    </span>
                  </TableCell>
                  <TableCell
                    className="w-56 max-w-56 truncate text-muted-foreground"
                    title={a.owner_email ?? undefined}
                  >
                    {a.owner_email ?? "—"}
                  </TableCell>
                  <TableCell className="whitespace-nowrap">
                    {a.student.name}
                    {a.student.section ? (
                      <div className="text-xs text-muted-foreground">{a.student.section}</div>
                    ) : null}
                  </TableCell>
                  <TableCell className="whitespace-nowrap">
                    {isOpenAlert(a) ? (
                      <Badge variant="danger">Open</Badge>
                    ) : (
                      <span className="text-xs text-muted-foreground">
                        Acknowledged by {a.acknowledged_by_email ?? "a teacher"}
                        {a.acknowledged_at ? ` · ${formatDateTime(a.acknowledged_at)}` : ""}
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    {a.assessment_id && a.attempt_id ? (
                      <Button asChild variant="outline" size="sm">
                        <Link href={`/dashboard/${a.assessment_id}/results/${a.attempt_id}`}>
                          Open
                        </Link>
                      </Button>
                    ) : null}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      <p className="text-xs text-muted-foreground">{ALERT_DISCLAIMER}</p>
    </main>
  );
}
