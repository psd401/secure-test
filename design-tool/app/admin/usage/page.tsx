import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getDb } from "@/db/client";
import { isAdmin } from "@/lib/auth/admin";
import { readStaffSessionFromCookies } from "@/lib/auth/session";
import {
  USAGE_WINDOW_LABELS,
  USAGE_WINDOWS,
  parseUsageParams,
  sortUsage,
  teacherUsage,
  windowSince,
  type UsageSort,
  type UsageWindow,
} from "@/lib/admin/teacherUsage";
import { formatDate } from "@/lib/ui/format";
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
export const metadata: Metadata = { title: "Teacher usage" };

interface PageProps {
  searchParams: Promise<{ sort?: string; window?: string }>;
}

const COLUMNS: { sort: UsageSort; label: string }[] = [
  { sort: "students", label: "Students tested" },
  { sort: "attempts", label: "Attempts submitted" },
  { sort: "sittings", label: "Sittings run" },
  { sort: "assessments", label: "Assessments created" },
  { sort: "last_active", label: "Last active" },
];

function href(sort: UsageSort, window: UsageWindow): string {
  return `/admin/usage?sort=${sort}&window=${window}`;
}

/**
 * Who uses SecureTest the most (lib/admin/teacherUsage.ts). Same gate as
 * `/admin`: 404 for a non-admin, and gone while an admin is acting as a
 * teacher. Sorting and the window are links, so the page needs no client JS.
 */
export default async function AdminUsagePage({ searchParams }: PageProps) {
  const session = await readStaffSessionFromCookies();
  if (!session) {
    redirect("/login?next=/admin/usage");
  }
  if (!isAdmin(session)) notFound();

  const { sort, window } = parseUsageParams(await searchParams);
  const rows = sortUsage(
    await teacherUsage(getDb(), { since: windowSince(window, new Date()) }),
    sort,
  );

  return (
    <main className="mx-auto max-w-6xl space-y-6 px-6 py-12">
      <PageHeader
        title="Teacher usage"
        description={`${rows.length} staff with activity · ${USAGE_WINDOW_LABELS[window].toLowerCase()}`}
      />

      <p className="text-sm">
        <Link href="/admin" className="font-medium underline">
          Admin
        </Link>
      </p>

      <nav aria-label="Time window" className="flex flex-wrap gap-3 text-sm">
        {USAGE_WINDOWS.map((w) =>
          w === window ? (
            <span key={w} aria-current="page" className="font-semibold">
              {USAGE_WINDOW_LABELS[w]}
            </span>
          ) : (
            <Link key={w} href={href(sort, w)} className="underline">
              {USAGE_WINDOW_LABELS[w]}
            </Link>
          ),
        )}
      </nav>

      <p className="text-xs text-muted-foreground">
        Counts class sittings only (practice excluded), credited to the sitting&apos;s owner.
        Students tested counts distinct students with a submitted attempt.
      </p>

      {rows.length === 0 ? (
        <EmptyState title="No activity in this window." />
      ) : (
        <div className="overflow-x-auto rounded-lg border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Teacher</TableHead>
                {COLUMNS.map((c) => (
                  <TableHead
                    key={c.sort}
                    className="text-right"
                    aria-sort={c.sort === sort ? "descending" : undefined}
                  >
                    {c.sort === sort ? (
                      <span className="font-semibold">{c.label} ↓</span>
                    ) : (
                      <Link href={href(c.sort, window)} className="underline">
                        {c.label}
                      </Link>
                    )}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.sub}>
                  <TableCell className="w-full max-w-0 truncate" title={r.email ?? r.sub}>
                    {r.email ?? r.sub}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{r.students}</TableCell>
                  <TableCell className="text-right tabular-nums">{r.attempts}</TableCell>
                  <TableCell className="text-right tabular-nums">{r.sittings}</TableCell>
                  <TableCell className="text-right tabular-nums">{r.assessments}</TableCell>
                  <TableCell className="whitespace-nowrap text-right text-muted-foreground">
                    {r.lastActive ? formatDate(r.lastActive) : "—"}
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
