"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { StatusLine, type SaveState } from "@/components/app/StatusLine";

const MAX_MESSAGE = 2000;

/**
 * Batch 3 slice 3 (docs/observability-design.md, D-2/D-9): "Send feedback"
 * from the teacher header. Staff-only (the button that opens this lives in
 * AppHeader, which is itself staff-only). Radix's Dialog already handles
 * Escape-to-close and a focus trap; `onOpenAutoFocus` moves focus into the
 * textarea specifically, per the accessibility ask.
 */
export function FeedbackDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const pathname = usePathname();
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<SaveState>({ kind: "idle" });
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!open) return;
    setMessage("");
    setStatus({ kind: "idle" });
  }, [open]);

  async function send() {
    setBusy(true);
    setStatus({ kind: "saving" });
    try {
      const res = await fetch("/api/feedback", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message, path: pathname }),
      });
      const body = (await res.json().catch(() => null)) as { ok?: boolean } | null;
      if (!res.ok || !body?.ok) throw new Error(`HTTP ${res.status}`);
      setStatus({ kind: "success", message: "Thanks — sent." });
      setTimeout(() => onOpenChange(false), 900);
    } catch {
      setStatus({ kind: "failed", message: "Could not send. Try again." });
    } finally {
      setBusy(false);
    }
  }

  const trimmed = message.trim();
  const canSend = !busy && trimmed.length > 0 && trimmed.length <= MAX_MESSAGE;

  return (
    <Dialog open={open} onOpenChange={(o) => (!busy ? onOpenChange(o) : null)}>
      <DialogContent
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          textareaRef.current?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>Send feedback</DialogTitle>
          <DialogDescription>
            Tell us what happened. This goes straight to the team building the app.
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (canSend) void send();
          }}
        >
          <div>
            <Label htmlFor="feedback-path">Page</Label>
            <input
              id="feedback-path"
              readOnly
              value={pathname}
              className="mt-1 block w-full rounded-md border border-input bg-muted px-3 py-2 text-sm text-muted-foreground"
            />
          </div>
          <div>
            <Label htmlFor="feedback-message">What happened?</Label>
            <Textarea
              id="feedback-message"
              ref={textareaRef}
              value={message}
              onChange={(e) => setMessage(e.target.value.slice(0, MAX_MESSAGE))}
              disabled={busy}
              rows={5}
              maxLength={MAX_MESSAGE}
              className="mt-1"
            />
            <div className="mt-1 text-right text-xs text-muted-foreground">
              {message.length} / {MAX_MESSAGE}
            </div>
          </div>
        </form>
        <StatusLine state={status} />
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button type="button" onClick={() => void send()} disabled={!canSend}>
            Send
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
