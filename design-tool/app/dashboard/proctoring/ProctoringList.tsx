"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import type { ProctorAssessment } from "@/lib/competency/proctoring";
import { formatDateTime } from "@/lib/ui/format";
import { STATUS_LABEL } from "@/app/dashboard/[id]/assignments/AssignmentsPanel";

/** What each refusal from POST /api/test-sessions means to a proctor. */
export function startErrorCopy(code: string): string {
  switch (code) {
    case "not_published":
      return "This assessment is not published yet. Ask Assessment to publish it.";
    case "archived":
      return "This assessment has been archived.";
    case "students_not_taught":
      return "One of these students is no longer assigned to you. Reload the page.";
    default:
      return "The session did not start. Try again.";
  }
}

export function ProctoringList({ groups }: { groups: ProctorAssessment[] }) {
  if (groups.length === 0) {
    return <p className="text-sm text-muted-foreground">No students are assigned to you.</p>;
  }
  return (
    <div className="space-y-6">
      {groups.map((g) => (
        <AssessmentCard key={g.id} group={g} />
      ))}
    </div>
  );
}

function AssessmentCard({ group }: { group: ProctorAssessment }) {
  const router = useRouter();
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function toggle(ps: string) {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(ps)) next.delete(ps);
      else next.add(ps);
      return next;
    });
  }

  async function start() {
    if (picked.size === 0) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/test-sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ assessment_id: group.id, student_ps_ids: [...picked] }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        test_session?: { id: string };
        test_session_id?: string;
        error?: string;
      };
      // U-13: the same list already open is that sitting, not an error.
      const sittingId = body.test_session?.id ?? (body.error === "sitting_already_open" ? body.test_session_id : undefined);
      if (sittingId) {
        router.push(`/dashboard/${group.id}/monitor/${sittingId}?code=1`);
        return;
      }
      setError(startErrorCopy(body.error ?? ""));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardContent className="space-y-4">
        <h2 className="text-lg font-semibold">{group.name}</h2>
        {!group.published ? (
          <p className="text-sm text-muted-foreground">Not published yet — sessions open once Assessment publishes it.</p>
        ) : null}

        {group.open_sittings.length > 0 ? (
          <ul className="space-y-2">
            {group.open_sittings.map((t) => (
              <li key={t.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm">
                <span>
                  Open session <span className="font-mono tracking-wider">{t.code}</span> · {t.student_ps_ids.length}{" "}
                  {t.student_ps_ids.length === 1 ? "student" : "students"} · closes {formatDateTime(t.expires_at)}
                </span>
                <Button asChild size="sm">
                  <Link href={`/dashboard/${group.id}/monitor/${t.id}`}>Monitor</Link>
                </Button>
              </li>
            ))}
          </ul>
        ) : null}

        <fieldset className="space-y-1">
          <legend className="text-sm font-medium">Students</legend>
          <ul className="divide-y rounded-md border text-sm">
            {group.students.map((s) => (
              <li key={s.assignment_id} className="flex items-center gap-3 px-3 py-2">
                <input
                  type="checkbox"
                  id={`pick-${s.assignment_id}`}
                  checked={picked.has(s.ps_id)}
                  onChange={() => toggle(s.ps_id)}
                  disabled={!group.published || busy}
                />
                <label htmlFor={`pick-${s.assignment_id}`} className="min-w-0 flex-1">
                  <span className="font-medium">{s.name}</span>
                  {s.grade ? <span className="text-muted-foreground"> · grade {s.grade}</span> : null}
                  <span className="block text-xs text-muted-foreground">{s.option_label}</span>
                </label>
                <span className="text-xs text-muted-foreground">{STATUS_LABEL[s.status] ?? s.status}</span>
              </li>
            ))}
          </ul>
        </fieldset>

        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={() => void start()} disabled={!group.published || busy || picked.size === 0}>
            {busy ? "Starting…" : picked.size > 1 ? `Start session for ${picked.size} students` : "Start session"}
          </Button>
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
        </div>
      </CardContent>
    </Card>
  );
}
