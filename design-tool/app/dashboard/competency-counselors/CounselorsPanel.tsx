"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";

interface Counselor {
  id: string;
  grantee_email: string;
  school_id: string;
  can_assign: boolean;
}

interface School {
  school_id: string;
  students: number;
}

/** What each refusal from the counselor routes means to Assessment staff. */
export function counselorErrorCopy(code: string): string {
  switch (code) {
    case "invalid_email":
    case "grantee_not_staff":
      return "The counselor must be a staff email.";
    case "self_grant":
      return "You cannot add yourself.";
    case "already_granted":
      return "That counselor is already on this school.";
    case "unknown_school":
      return "That school is not on the current roster.";
    default:
      return "That did not save. Try again.";
  }
}

export function CounselorsPanel() {
  const [counselors, setCounselors] = useState<Counselor[]>([]);
  const [schools, setSchools] = useState<School[]>([]);
  const [email, setEmail] = useState("");
  const [school, setSchool] = useState("");
  const [canAssign, setCanAssign] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    const res = await fetch("/api/competency/counselors");
    if (!res.ok) return;
    const body = (await res.json()) as { counselors: Counselor[]; schools: School[] };
    setCounselors(body.counselors);
    setSchools(body.schools);
  }

  useEffect(() => {
    void load();
  }, []);

  async function add() {
    setBusy("add");
    setError(null);
    try {
      const res = await fetch("/api/competency/counselors", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ grantee_email: email.trim().toLowerCase(), school_id: school, can_assign: canAssign }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(counselorErrorCopy(body.error ?? ""));
        return;
      }
      setEmail("");
      // F-4 (CBA hand-run): never carry assigning over to the next counselor.
      setCanAssign(false);
      await load();
    } finally {
      setBusy(null);
    }
  }

  async function remove(id: string) {
    setBusy(id);
    setError(null);
    try {
      await fetch(`/api/competency/counselors/${id}`, { method: "DELETE" });
      await load();
    } finally {
      setBusy(null);
    }
  }

  const canAdd = email.trim().length > 0 && school !== "" && busy === null;

  return (
    <div className="space-y-6">
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (canAdd) void add();
        }}
      >
        <div className="min-w-56 flex-1">
          <Label htmlFor="counselor-email">Counselor email</Label>
          <Input
            id="counselor-email"
            type="email"
            autoComplete="off"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>
        <div>
          <Label htmlFor="counselor-school">School</Label>
          <NativeSelect id="counselor-school" value={school} onChange={(e) => setSchool(e.target.value)}>
            <option value="">Choose a school</option>
            {schools.map((s) => (
              <option key={s.school_id} value={s.school_id}>
                School {s.school_id} ({s.students} {s.students === 1 ? "student" : "students"})
              </option>
            ))}
          </NativeSelect>
        </div>
        <label className="flex items-center gap-2 pb-2 text-sm">
          <input type="checkbox" checked={canAssign} onChange={(e) => setCanAssign(e.target.checked)} />
          Can assign students
        </label>
        <Button type="submit" disabled={!canAdd}>
          {busy === "add" ? "Adding…" : "Add counselor"}
        </Button>
      </form>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      {counselors.length === 0 ? (
        <p className="text-sm text-muted-foreground">No counselors yet.</p>
      ) : (
        <ul className="divide-y rounded-md border text-sm">
          {counselors.map((c) => (
            <li key={c.id} className="flex items-center justify-between gap-3 px-3 py-2">
              <span>
                <span className="font-medium">{c.grantee_email}</span>
                <span className="text-muted-foreground">
                  {" "}
                  · School {c.school_id} · {c.can_assign ? "results and assigning" : "results"}
                </span>
              </span>
              <Button variant="ghost" size="sm" disabled={busy !== null} onClick={() => void remove(c.id)}>
                {busy === c.id ? "Removing…" : "Remove"}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
