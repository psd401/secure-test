"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { Plus } from "lucide-react";
import { TIDE_SUBJECTS } from "@/db/schema";
import {
  ACCOMMODATION_CATALOG,
  type AccommodationCatalogEntry,
  type OspiTier,
} from "@/lib/accommodations/catalog";
import { isEnabledValue } from "@/lib/accommodations/effective";
import { tideValuesFor } from "@/lib/accommodations/tideCatalog";
import { ApiError, accommodationErrorCopy } from "@/lib/ui/errorCopy";
import { Alert, AlertTitle } from "@/components/ui/alert";
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect, NativeSelectOptGroup, NativeSelectOption } from "@/components/ui/native-select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { EmptyState } from "@/components/app/EmptyState";

interface AccRow {
  id: string;
  subject: string;
  tool_id: string;
  value: string;
  source: "tide_import" | "tide_then_edited" | "manual";
  tide_code: string | null;
}

interface Props {
  studentId: string;
  initial: AccRow[];
}

const SOURCE_LABEL: Record<AccRow["source"], string> = {
  tide_import: "TIDE",
  tide_then_edited: "TIDE, edited by you",
  manual: "Added by you",
};

const TIER_LABEL: Record<OspiTier, string> = {
  universal: "Universal tool",
  designated: "Designated support",
  accommodation: "IEP/504",
};
const TIER_ORDER: OspiTier[] = ["accommodation", "designated", "universal"];

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

/** The Value control: TIDE's own options for the pair, else On / Off. */
function ValueSelect({
  subject,
  toolId,
  value,
  onChange,
  id,
  disabled,
}: {
  subject: string;
  toolId: string;
  value: string;
  onChange: (v: string) => void;
  id?: string;
  disabled?: boolean;
}) {
  const options = useMemo(() => {
    const fromTide = tideValuesFor(subject, toolId);
    const base = fromTide.length > 0 ? fromTide : ["On", "Off"];
    return value && !base.includes(value) ? [value, ...base] : base;
  }, [subject, toolId, value]);
  return (
    <NativeSelect id={id} size="sm" value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled}>
      {value === "" ? <NativeSelectOption value="">Choose…</NativeSelectOption> : null}
      {options.map((v) => (
        <NativeSelectOption key={v} value={v}>
          {v}
        </NativeSelectOption>
      ))}
    </NativeSelect>
  );
}

export function StudentEditor({ studentId, initial }: Props) {
  const router = useRouter();
  const [rows, setRows] = useState(initial);
  const [addOpen, setAddOpen] = useState(false);
  const [draft, setDraft] = useState<{ subject: string; tool_id: string; value: string }>({
    subject: TIDE_SUBJECTS[0],
    tool_id: ACCOMMODATION_CATALOG[0]!.id,
    value: "",
  });
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [addError, setAddError] = useState<string | null>(null);
  const [pendingRemove, setPendingRemove] = useState<AccRow | null>(null);
  const [showOff, setShowOff] = useState(false);

  const catalogById = useMemo(() => {
    const m = new Map<string, AccommodationCatalogEntry>();
    for (const e of ACCOMMODATION_CATALOG) m.set(e.id, e);
    return m;
  }, []);

  const catalogByTier = useMemo(() => {
    const m = new Map<OspiTier, AccommodationCatalogEntry[]>();
    for (const e of ACCOMMODATION_CATALOG) {
      const arr = m.get(e.ospi_tier) ?? [];
      arr.push(e);
      m.set(e.ospi_tier, arr);
    }
    return m;
  }, []);

  async function addSupport() {
    if (!draft.value.trim()) {
      setAddError("Choose a value.");
      return;
    }
    setBusy(true);
    setAddError(null);
    try {
      const res = await fetch(`/api/students/${studentId}/accommodations`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(draft),
      });
      if (!res.ok) throw await readError(res);
      const { accommodation } = (await res.json()) as { accommodation: AccRow };
      setRows((prev) => [...prev, accommodation]);
      setDraft({ subject: TIDE_SUBJECTS[0], tool_id: ACCOMMODATION_CATALOG[0]!.id, value: "" });
      setAddOpen(false);
      router.refresh();
    } catch (err) {
      setAddError(describe(err));
    } finally {
      setBusy(false);
    }
  }

  async function saveEdit(row: AccRow) {
    if (!editValue.trim()) {
      setError("Choose a value.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/students/${studentId}/accommodations/${row.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ value: editValue }),
      });
      if (!res.ok) throw await readError(res);
      const { accommodation } = (await res.json()) as { accommodation: AccRow };
      setRows((prev) => prev.map((r) => (r.id === row.id ? accommodation : r)));
      setEditingId(null);
      router.refresh();
    } catch (err) {
      setError(describe(err));
    } finally {
      setBusy(false);
    }
  }

  async function confirmRemove() {
    const row = pendingRemove;
    if (!row) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/students/${studentId}/accommodations/${row.id}`, { method: "DELETE" });
      if (!res.ok) throw await readError(res);
      setRows((prev) => prev.filter((r) => r.id !== row.id));
      router.refresh();
    } catch (err) {
      setError(describe(err));
    } finally {
      setBusy(false);
      setPendingRemove(null);
    }
  }

  const grouped = useMemo(() => {
    const m = new Map<string, AccRow[]>();
    for (const r of rows) {
      const arr = m.get(r.subject) ?? [];
      arr.push(r);
      m.set(r.subject, arr);
    }
    for (const arr of m.values()) {
      arr.sort((a, b) => {
        const ea = isEnabledValue(a.value) ? 0 : 1;
        const eb = isEnabledValue(b.value) ? 0 : 1;
        if (ea !== eb) return ea - eb;
        const ta = TIER_ORDER.indexOf(catalogById.get(a.tool_id)?.ospi_tier ?? "universal");
        const tb = TIER_ORDER.indexOf(catalogById.get(b.tool_id)?.ospi_tier ?? "universal");
        if (ta !== tb) return ta - tb;
        return (catalogById.get(a.tool_id)?.label ?? a.tool_id).localeCompare(catalogById.get(b.tool_id)?.label ?? b.tool_id);
      });
    }
    return m;
  }, [rows, catalogById]);

  const onCount = rows.filter((r) => isEnabledValue(r.value)).length;
  const offCount = rows.length - onCount;

  return (
    <div className="space-y-6">
      {error ? (
        <Alert variant="destructive">
          <AlertTitle>{error}</AlertTitle>
        </Alert>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">
          Supports for this student{" "}
          <span className="font-normal text-muted-foreground">
            · {onCount} on
            {offCount > 0 ? ` · ${offCount} off` : ""}
          </span>
        </h2>
        <div className="flex items-center gap-2">
          {offCount > 0 ? (
            <Button type="button" variant="ghost" size="sm" onClick={() => setShowOff((v) => !v)} aria-pressed={showOff}>
              {showOff ? "Hide" : "Show"} {offCount} setting{offCount === 1 ? "" : "s"} that {offCount === 1 ? "is" : "are"} off
            </Button>
          ) : null}
          <Button type="button" onClick={() => setAddOpen(true)}>
            <Plus aria-hidden />
            Add support
          </Button>
        </div>
      </div>

      {rows.length === 0 ? (
        <EmptyState
          title="No supports on file"
          description="Anything TIDE lists for this student appears here after an import; you can add supports yourself too."
          action={
            <Button type="button" onClick={() => setAddOpen(true)}>
              <Plus aria-hidden />
              Add support
            </Button>
          }
        />
      ) : (
        [...grouped.entries()].map(([subject, accs]) => {
          const visible = showOff ? accs : accs.filter((r) => isEnabledValue(r.value));
          if (visible.length === 0) return null;
          return (
            <section key={subject} className="space-y-2">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{subject}</h3>
              <div className="overflow-x-auto rounded-lg border bg-card">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Tool</TableHead>
                      <TableHead>Setting</TableHead>
                      <TableHead>Kind</TableHead>
                      <TableHead>Source</TableHead>
                      <TableHead className="text-right">
                        <span className="sr-only">Actions</span>
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {visible.map((r) => {
                      const cat = catalogById.get(r.tool_id);
                      const on = isEnabledValue(r.value);
                      const editing = editingId === r.id;
                      const fromTide = r.source !== "manual";
                      return (
                        <TableRow key={r.id}>
                          <TableCell className="font-medium">{cat?.label ?? r.tool_id}</TableCell>
                          <TableCell>
                            {editing ? (
                              <ValueSelect
                                subject={r.subject}
                                toolId={r.tool_id}
                                value={editValue}
                                onChange={setEditValue}
                                disabled={busy}
                              />
                            ) : (
                              <Badge variant={on ? "success" : "neutral"}>{r.value}</Badge>
                            )}
                          </TableCell>
                          <TableCell>
                            {cat ? (
                              <Badge variant={cat.ospi_tier === "accommodation" ? "info" : "outline"}>
                                {TIER_LABEL[cat.ospi_tier]}
                              </Badge>
                            ) : null}
                          </TableCell>
                          <TableCell className="text-sm text-muted-foreground" title={r.tide_code ?? undefined}>
                            {SOURCE_LABEL[r.source]}
                          </TableCell>
                          <TableCell className="text-right">
                            {editing ? (
                              <span className="inline-flex gap-1">
                                <Button type="button" size="sm" disabled={busy} onClick={() => saveEdit(r)}>
                                  Save
                                </Button>
                                <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => setEditingId(null)}>
                                  Cancel
                                </Button>
                              </span>
                            ) : (
                              <span className="inline-flex gap-1">
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="sm"
                                  disabled={busy}
                                  aria-label={`Edit ${cat?.label ?? r.tool_id} for ${r.subject}`}
                                  onClick={() => {
                                    setEditingId(r.id);
                                    setEditValue(r.value);
                                  }}
                                >
                                  Edit
                                </Button>
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="sm"
                                  className="text-destructive hover:text-destructive"
                                  disabled={busy || fromTide}
                                  aria-label={`Remove ${cat?.label ?? r.tool_id} for ${r.subject}`}
                                  title={fromTide ? "Came from TIDE — set it to Off instead of removing it." : undefined}
                                  onClick={() => setPendingRemove(r)}
                                >
                                  Remove
                                </Button>
                              </span>
                            )}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            </section>
          );
        })
      )}

      <Dialog open={addOpen} onOpenChange={(o) => (!busy ? setAddOpen(o) : null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add a support</DialogTitle>
            <DialogDescription>
              For a subject and a tool, pick the setting TIDE would use. Anything you add here survives
              the next TIDE import.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="add-subject">Subject</Label>
              <NativeSelect
                id="add-subject"
                value={draft.subject}
                onChange={(e) => setDraft((p) => ({ ...p, subject: e.target.value, value: "" }))}
              >
                {TIDE_SUBJECTS.map((s) => (
                  <NativeSelectOption key={s} value={s}>
                    {s}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </div>
            <div className="space-y-2">
              <Label htmlFor="add-tool">Tool</Label>
              <NativeSelect
                id="add-tool"
                value={draft.tool_id}
                onChange={(e) => setDraft((p) => ({ ...p, tool_id: e.target.value, value: "" }))}
              >
                {TIER_ORDER.map((tier) => (
                  <NativeSelectOptGroup key={tier} label={TIER_LABEL[tier]}>
                    {(catalogByTier.get(tier) ?? []).map((e) => (
                      <NativeSelectOption key={e.id} value={e.id}>
                        {e.label}
                      </NativeSelectOption>
                    ))}
                  </NativeSelectOptGroup>
                ))}
              </NativeSelect>
            </div>
            <div className="space-y-2">
              <Label htmlFor="add-value">Setting</Label>
              <ValueSelect
                id="add-value"
                subject={draft.subject}
                toolId={draft.tool_id}
                value={draft.value}
                onChange={(v) => setDraft((p) => ({ ...p, value: v }))}
              />
            </div>
            {addError ? (
              <Alert variant="destructive">
                <AlertTitle>{addError}</AlertTitle>
              </Alert>
            ) : null}
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" disabled={busy} onClick={() => setAddOpen(false)}>
              Cancel
            </Button>
            <Button type="button" disabled={busy || !draft.value} onClick={addSupport}>
              {busy ? "Adding…" : "Add"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={pendingRemove !== null}
        onOpenChange={(o) => {
          if (!o && !busy) setPendingRemove(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Remove {pendingRemove ? (catalogById.get(pendingRemove.tool_id)?.label ?? pendingRemove.tool_id) : ""} for{" "}
              {pendingRemove?.subject}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              The student loses this support on every assessment. You can add it again later.
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
