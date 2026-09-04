"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";

/** Slice C: turn a colleague's offer into my own copy, then open it. */
export function AcceptShareButton({ shareId }: { shareId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function accept() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/shares/${shareId}/accept`, { method: "POST" });
      const body = (await res.json().catch(() => null)) as
        | { ok: boolean; assessment_id?: string; error?: string; detail?: string }
        | null;
      if (!res.ok || !body?.ok || !body.assessment_id) {
        throw new Error(body?.error ?? `HTTP ${res.status}`);
      }
      router.push(`/dashboard/${body.assessment_id}`);
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <Button type="button" onClick={() => void accept()} disabled={busy}>
        {busy ? "Adding…" : "Add to my assessments"}
      </Button>
      {error ? <span className="text-xs text-destructive">{error}</span> : null}
    </div>
  );
}
