"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  ACCOMMODATION_CATALOG,
  type AccommodationCatalogEntry,
} from "@/lib/accommodations/catalog";
import { tideValuesForTool } from "@/lib/accommodations/tideCatalog";
import { ApiError, accommodationErrorCopy } from "@/lib/ui/errorCopy";
import { studentHeading } from "@/lib/ui/format";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { EmptyState } from "@/components/app/EmptyState";

interface StudentSummary {
  id: string;
  ssid: string;
  name: string;
  grade: string | null;
  school: string | null;
  accommodation_count: number;
}

interface OverrideRow {
  id: string;
  student_id: string;
  student_ssid: string;
  student_name: string;
  tool_id: string;
  value: string;
}

interface Props {
  assessmentId: string;
  allowedAccommodations: readonly string[];
  isLocked: boolean;
  /** UX pass 1, slice 8 (SM-15): switches the editor to the tab that actually exists. */
  onOpenAccommodations?: () => void;
}

async function readError(res: Response): Promise<ApiError> {
  let code = `http_${res.status}`;
  try {
    const body = (await res.json()) as { error?: unknown };
    if (typeof body.error === "string") code = body.error;
  } catch {
    // not JSON
  }
  return new ApiError(code, res.status);
}

function describe(e: unknown): string {
  const code = e instanceof ApiError ? e.code : "network";
  const copy = accommodationErrorCopy(code);
  return copy.showCode ? `${copy.message} ${code}` : copy.message;
}

/**
 * Per-assessment, per-student accommodation overrides. The two lists here
 * read DIFFERENT sources on purpose: the student picker is the teacher's
 * accommodation records (/api/students — TIDE import + manual), not the
 * PowerSchool class list, because an override attaches to a record.
 */
export function OverridesPanel({ assessmentId, allowedAccommodations, isLocked, onOpenAccommodations }: Props) {
  const [students, setStudents] = useState<StudentSummary[]>([]);
  const [overrides, setOverrides] = useState<OverrideRow[]>([]);
  const [draft, setDraft] = useState<{ student_id: string; tool_id: string; value: string }>({
    student_id: "",
    tool_id: "",
    value: "",
  });
  const [loadState, setLoadState] = useState<"loading" | "error" | "ready">("loading");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingRemove, setPendingRemove] = useState<OverrideRow | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  // Filter the catalog to only the tools the assessment allows. Empty
  // allowedAccommodations → empty tool dropdown → CTA to add them first.
  const allowedCatalog: AccommodationCatalogEntry[] = useMemo(() => {
    const allowed = new Set(allowedAccommodations);
    return ACCOMMODATION_CATALOG.filter((e) => allowed.has(e.id));
  }, [allowedAccommodations]);

  const catalogById = useMemo(() => {
    const m = new Map<string, AccommodationCatalogEntry>();
    for (const e of ACCOMMODATION_CATALOG) m.set(e.id, e);
    return m;
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoadState("loading");
    (async () => {
      try {
        const [stuRes, ovRes] = await Promise.all([
          fetch(`/api/students`),
          fetch(`/api/assessments/${assessmentId}/overrides`),
        ]);
        if (!stuRes.ok) throw await readError(stuRes);
        if (!ovRes.ok) throw await readError(ovRes);
        const stuBody = (await stuRes.json()) as { students: StudentSummary[] };
        const ovBody = (await ovRes.json()) as { overrides: OverrideRow[] };
        if (cancelled) return;
        const sorted = [...stuBody.students].sort((a, b) =>
          studentHeading(a).localeCompare(studentHeading(b)),
        );
        setStudents(sorted);
        setOverrides(ovBody.overrides);
        // Seed defaults so the form is usable on first render.
        setDraft({
          student_id: sorted[0]?.id ?? "",
          tool_id: allowedCatalog[0]?.id ?? "",
          value: "",
        });
        setLoadState("ready");
      } catch (err) {
        if (!cancelled) {
          setLoadError(describe(err));
          setLoadState("error");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assessmentId, reloadKey]);

  const valueOptions = useMemo(() => {
    const fromTide = draft.tool_id ? tideValuesForTool(draft.tool_id) : [];
    return fromTide.length > 0 ? fromTide : ["On", "Off"];
  }, [draft.tool_id]);

  async function addOverride() {
    if (!draft.student_id || !draft.tool_id || !draft.value.trim()) {
      setError("Pick a student, a tool and a setting.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/assessments/${assessmentId}/overrides`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(draft),
      });
      if (!res.ok) throw await readError(res);
      // Reload overrides list (upsert may have replaced an existing row).
      const list = await fetch(`/api/assessments/${assessmentId}/overrides`);
      if (!list.ok) throw await readError(list);
      const body = (await list.json()) as { overrides: OverrideRow[] };
      setOverrides(body.overrides);
      setDraft((p) => ({ ...p, value: "" }));
    } catch (err) {
      setError(describe(err));
    } finally {
      setBusy(false);
    }
  }

  async function confirmRemove() {
    const target = pendingRemove;
    if (!target) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/assessments/${assessmentId}/overrides/${target.id}`, { method: "DELETE" });
      if (!res.ok) throw await readError(res);
      setOverrides((prev) => prev.filter((o) => o.id !== target.id));
    } catch (err) {
      setError(describe(err));
    } finally {
      setBusy(false);
      setPendingRemove(null);
    }
  }

  if (loadState === "loading") {
    return (
      <div className="space-y-3" aria-busy="true" aria-label="Loading student accommodations">
        <Skeleton className="h-36 w-full" />
        <Skeleton className="h-20 w-full" />
      </div>
    );
  }

  if (loadState === "error") {
    return (
      <Alert variant="destructive">
        <AlertTitle>Couldn&apos;t load student accommodations.</AlertTitle>
        <AlertDescription>
          <p>{loadError}</p>
          <Button type="button" variant="outline" size="sm" className="mt-2" onClick={() => setReloadKey((k) => k + 1)}>
            Retry
          </Button>
        </AlertDescription>
      </Alert>
    );
  }

  if (allowedCatalog.length === 0) {
    return (
      <EmptyState
        title="No accommodations are allowed on this assessment yet"
        description="A student override can only grant a tool the assessment already permits. Choose the allowed tools first."
        action={
          onOpenAccommodations ? (
            <Button type="button" onClick={onOpenAccommodations}>
              Open the Accommodations tab
            </Button>
          ) : undefined
        }
      />
    );
  }

  if (students.length === 0) {
    return (
      <EmptyState
        title="No accommodation records yet"
        description="Overrides attach to a student's accommodation record — the TIDE import or a support you added on the Students page, not the PowerSchool class list."
        action={
          <Button asChild variant="outline">
            <Link href={`/dashboard/accommodations/import?return=${encodeURIComponent(`/dashboard/${assessmentId}?tab=students`)}`}>
              Import TIDE settings
            </Link>
          </Button>
        }
      />
    );
  }

  return (
    <div className="space-y-6">
      <p className="text-sm text-muted-foreground">
        Grant or switch off one tool for one student on this assessment only; their record on the
        Students page is unchanged. Setting the same student and tool again replaces the earlier value.
      </p>

      {error ? (
        <Alert variant="destructive">
          <AlertTitle>{error}</AlertTitle>
        </Alert>
      ) : null}

      <Card>
        <CardContent className="space-y-4">
          <h3 className="font-semibold">Add an override</h3>
          <fieldset disabled={isLocked} className="grid grid-cols-1 gap-3 sm:grid-cols-4">
            <div className="space-y-1 sm:col-span-2">
              <Label htmlFor="ov-student">Student</Label>
              <NativeSelect
                id="ov-student"
                className="w-full"
                value={draft.student_id}
                onChange={(e) => setDraft((p) => ({ ...p, student_id: e.target.value }))}
              >
                {students.map((s) => (
                  <NativeSelectOption key={s.id} value={s.id}>
                    {studentHeading(s)} — {s.ssid}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </div>
            <div className="space-y-1">
              <Label htmlFor="ov-tool">Tool</Label>
              <NativeSelect
                id="ov-tool"
                value={draft.tool_id}
                onChange={(e) => setDraft((p) => ({ ...p, tool_id: e.target.value, value: "" }))}
              >
                {allowedCatalog.map((e) => (
                  <NativeSelectOption key={e.id} value={e.id}>
                    {e.label}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </div>
            <div className="space-y-1">
              <Label htmlFor="ov-value">Setting</Label>
              <NativeSelect
                id="ov-value"
                value={draft.value}
                onChange={(e) => setDraft((p) => ({ ...p, value: e.target.value }))}
              >
                <NativeSelectOption value="">Choose…</NativeSelectOption>
                {valueOptions.map((v) => (
                  <NativeSelectOption key={v} value={v}>
                    {v}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </div>
          </fieldset>
          <Button type="button" onClick={addOverride} disabled={busy || isLocked || !draft.value.trim()}>
            {busy ? "Saving…" : "Save"}
          </Button>
        </CardContent>
      </Card>

      <section className="space-y-2">
        <h3 className="font-semibold">Overrides on this assessment ({overrides.length})</h3>
        {overrides.length === 0 ? (
          <EmptyState title="No overrides yet" description="Every student gets the assessment's allowed tools as their own record sets them." />
        ) : (
          <div className="overflow-x-auto rounded-lg border bg-card">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Student</TableHead>
                  <TableHead>Tool</TableHead>
                  <TableHead>Setting</TableHead>
                  <TableHead className="text-right">
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {overrides.map((o) => {
                  const tool = catalogById.get(o.tool_id);
                  return (
                    <TableRow key={o.id}>
                      <TableCell>
                        <div className="font-medium">{studentHeading({ name: o.student_name, ssid: o.student_ssid })}</div>
                        <div className="text-xs text-muted-foreground">SSID {o.student_ssid}</div>
                      </TableCell>
                      <TableCell>{tool?.label ?? o.tool_id}</TableCell>
                      <TableCell>
                        <Badge variant="outline">{o.value}</Badge>
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="text-destructive hover:text-destructive"
                          disabled={busy || isLocked}
                          onClick={() => setPendingRemove(o)}
                        >
                          Remove
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </section>

      <AlertDialog
        open={pendingRemove !== null}
        onOpenChange={(o) => {
          if (!o && !busy) setPendingRemove(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Remove the {pendingRemove ? (catalogById.get(pendingRemove.tool_id)?.label ?? pendingRemove.tool_id) : ""} override
              for {pendingRemove ? studentHeading({ name: pendingRemove.student_name, ssid: pendingRemove.student_ssid }) : ""}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              On this assessment the student goes back to what their own record says.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={(e) => {
                e.preventDefault();
                void confirmRemove();
              }}
            >
              {busy ? "Removing…" : "Remove"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
