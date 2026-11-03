"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { formatDate } from "@/lib/ui/format";

interface Option {
  item_set_id: string;
  label: string;
}

interface Assignment {
  id: string;
  student_ps_id: string;
  student_name: string;
  grade: string | null;
  item_set_id: string;
  option_label: string;
  proctor_email: string;
  status: string;
  result: string | null;
  created_at: string;
  withdrawn_at: string | null;
}

interface StudentHit {
  ps_id: string;
  name: string;
  grade: string | null;
}

/** Plain words for each status; the stored values are the design note's. */
export const STATUS_LABEL: Record<string, string> = {
  assigned: "Assigned",
  in_progress: "In progress",
  handed_in: "Handed in",
  scored: "Scored",
  released: "Released",
  withdrawn: "Withdrawn",
};

/** What each refusal from the assignment routes means to the person assigning. */
export function assignmentErrorCopy(code: string): string {
  switch (code) {
    case "already_assigned":
      return "This student already has an assignment on this assessment. Withdraw it first to switch options.";
    case "proctor_not_staff":
      return "The proctor must be a staff email.";
    case "unknown_student":
      return "That student is not on the current roster.";
    case "unknown_option":
      return "That option is no longer on this assessment. Reload the page.";
    case "assignment_withdrawn":
    case "assignment_changed":
      return "Someone else changed this assignment. Reload the page.";
    default:
      return "That did not save. Try again.";
  }
}

async function errorCode(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: unknown };
    return typeof body.error === "string" ? body.error : `http_${res.status}`;
  } catch {
    return `http_${res.status}`;
  }
}

export function AssignmentsPanel({ assessmentId, assessmentName }: { assessmentId: string; assessmentName: string }) {
  const base = `/api/assessments/${assessmentId}/competency`;
  const [options, setOptions] = useState<Option[]>([]);
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<StudentHit[]>([]);
  const [student, setStudent] = useState<StudentHit | null>(null);
  const [optionId, setOptionId] = useState("");
  const [proctor, setProctor] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showWithdrawn, setShowWithdrawn] = useState(false);

  async function load() {
    const res = await fetch(`${base}/assignments`);
    if (!res.ok) {
      setError(assignmentErrorCopy(await errorCode(res)));
      return;
    }
    const body = (await res.json()) as { options: Option[]; assignments: Assignment[] };
    setOptions(body.options);
    setAssignments(body.assignments);
    setLoaded(true);
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base]);

  // Name search, a beat after typing stops.
  useEffect(() => {
    if (student || query.trim().length < 2) {
      setHits([]);
      return;
    }
    const q = query.trim();
    const t = setTimeout(async () => {
      const res = await fetch(`${base}/students?q=${encodeURIComponent(q)}`);
      if (res.ok) setHits(((await res.json()) as { students: StudentHit[] }).students);
    }, 250);
    return () => clearTimeout(t);
  }, [base, query, student]);

  async function assign() {
    if (!student || !optionId || !proctor.trim()) return;
    setBusy("add");
    setError(null);
    try {
      const res = await fetch(`${base}/assignments`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          student_ps_id: student.ps_id,
          item_set_id: optionId,
          proctor_email: proctor.trim().toLowerCase(),
        }),
      });
      if (!res.ok) {
        setError(assignmentErrorCopy(await errorCode(res)));
        return;
      }
      setStudent(null);
      setQuery("");
      setOptionId("");
      await load();
    } finally {
      setBusy(null);
    }
  }

  async function patch(id: string, body: object) {
    setBusy(id);
    setError(null);
    try {
      const res = await fetch(`${base}/assignments/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) setError(assignmentErrorCopy(await errorCode(res)));
      await load();
    } finally {
      setBusy(null);
    }
  }

  function withdraw(a: Assignment) {
    if (!window.confirm(`Withdraw ${a.student_name}'s assignment? Their work on this option stays as the record.`)) return;
    void patch(a.id, { action: "withdraw" });
  }

  function changeProctor(a: Assignment) {
    const next = window.prompt(`New proctor for ${a.student_name}`, a.proctor_email);
    if (!next || next.trim().toLowerCase() === a.proctor_email) return;
    void patch(a.id, { action: "change_proctor", proctor_email: next.trim().toLowerCase() });
  }

  const live = assignments.filter((a) => a.status !== "withdrawn");
  const withdrawn = assignments.filter((a) => a.status === "withdrawn");
  const canAssign = student !== null && optionId !== "" && proctor.trim().length > 0 && busy === null;

  return (
    <div className="space-y-8">
      <div className="space-y-1">
        <p className="text-sm text-muted-foreground">
          <Link href={`/dashboard/${assessmentId}`} className="hover:underline">
            ← {assessmentName}
          </Link>
        </p>
        <h1 className="text-2xl font-semibold">Assignments</h1>
        <p className="text-sm text-muted-foreground">
          Each student takes one option, with one proctor who runs their sittings. To switch options, withdraw the
          assignment and make a new one; nothing carries over.
        </p>
      </div>

      <section className="space-y-3 rounded-md border p-4">
        <h2 className="text-sm font-semibold">Assign a student</h2>
        {options.length === 0 && loaded ? (
          <p className="text-sm text-muted-foreground">
            This assessment has no options yet. Add a question set for each option first.
          </p>
        ) : null}
        <form
          className="grid gap-3 sm:grid-cols-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (canAssign) void assign();
          }}
        >
          <div className="relative">
            <Label htmlFor="assign-student">Student</Label>
            {student ? (
              <div className="flex h-9 items-center justify-between gap-2 rounded-md border px-3 text-sm">
                <span className="truncate">
                  {student.name}
                  {student.grade ? ` (grade ${student.grade})` : ""}
                </span>
                <button
                  type="button"
                  className="text-xs text-muted-foreground hover:underline"
                  onClick={() => setStudent(null)}
                >
                  Change
                </button>
              </div>
            ) : (
              <Input
                id="assign-student"
                autoComplete="off"
                placeholder="Search by name"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            )}
            {!student && hits.length > 0 ? (
              <ul className="absolute z-10 mt-1 max-h-60 w-full overflow-auto rounded-md border bg-background text-sm shadow">
                {hits.map((h) => (
                  <li key={h.ps_id}>
                    <button
                      type="button"
                      className="w-full px-3 py-1.5 text-left hover:bg-muted"
                      onClick={() => setStudent(h)}
                    >
                      {h.name}
                      {h.grade ? <span className="text-muted-foreground"> · grade {h.grade}</span> : null}
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
          <div>
            <Label htmlFor="assign-option">Option</Label>
            <NativeSelect
              id="assign-option"
              className="w-full"
              value={optionId}
              onChange={(e) => setOptionId(e.target.value)}
            >
              <option value="">Choose an option</option>
              {options.map((o) => (
                <option key={o.item_set_id} value={o.item_set_id}>
                  {o.label}
                </option>
              ))}
            </NativeSelect>
          </div>
          <div>
            <Label htmlFor="assign-proctor">Proctor email</Label>
            <Input
              id="assign-proctor"
              type="email"
              autoComplete="off"
              value={proctor}
              onChange={(e) => setProctor(e.target.value)}
            />
          </div>
          <div className="sm:col-span-3">
            <Button type="submit" disabled={!canAssign}>
              {busy === "add" ? "Assigning…" : "Assign"}
            </Button>
          </div>
        </form>
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold">Current assignments ({live.length})</h2>
        {live.length === 0 ? (
          <p className="text-sm text-muted-foreground">{loaded ? "No students assigned yet." : "Loading…"}</p>
        ) : (
          <AssignmentTable rows={live} busy={busy} onWithdraw={withdraw} onChangeProctor={changeProctor} />
        )}
      </section>

      {withdrawn.length > 0 ? (
        <section className="space-y-3">
          <button
            type="button"
            className="text-sm text-muted-foreground hover:underline"
            onClick={() => setShowWithdrawn((v) => !v)}
          >
            {showWithdrawn ? "Hide" : "Show"} withdrawn ({withdrawn.length})
          </button>
          {showWithdrawn ? <AssignmentTable rows={withdrawn} busy={busy} /> : null}
        </section>
      ) : null}
    </div>
  );
}

function AssignmentTable({
  rows,
  busy,
  onWithdraw,
  onChangeProctor,
}: {
  rows: Assignment[];
  busy: string | null;
  onWithdraw?: (a: Assignment) => void;
  onChangeProctor?: (a: Assignment) => void;
}) {
  return (
    <div className="overflow-x-auto rounded-md border">
      <table className="w-full text-sm">
        <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
          <tr>
            <th className="px-3 py-2 font-medium">Student</th>
            <th className="px-3 py-2 font-medium">Option</th>
            <th className="px-3 py-2 font-medium">Proctor</th>
            <th className="px-3 py-2 font-medium">Status</th>
            <th className="px-3 py-2 font-medium">Assigned</th>
            {onWithdraw ? <th className="px-3 py-2" /> : null}
          </tr>
        </thead>
        <tbody className="divide-y">
          {rows.map((a) => (
            <tr key={a.id}>
              <td className="px-3 py-2">
                {a.student_name}
                {a.grade ? <span className="text-muted-foreground"> · {a.grade}</span> : null}
              </td>
              <td className="px-3 py-2">{a.option_label}</td>
              <td className="px-3 py-2">{a.proctor_email}</td>
              <td className="px-3 py-2">{STATUS_LABEL[a.status] ?? a.status}</td>
              <td className="px-3 py-2">{formatDate(a.created_at)}</td>
              {onWithdraw && onChangeProctor ? (
                <td className="space-x-2 whitespace-nowrap px-3 py-2 text-right">
                  <Button variant="ghost" size="sm" disabled={busy !== null} onClick={() => onChangeProctor(a)}>
                    Change proctor
                  </Button>
                  <Button variant="ghost" size="sm" disabled={busy !== null} onClick={() => onWithdraw(a)}>
                    {busy === a.id ? "Saving…" : "Withdraw"}
                  </Button>
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
