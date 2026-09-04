"use client";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { formatTime } from "@/lib/ui/format";

/**
 * UX pass 1, slice 7 (SM-20): the one still from a student's screen, in a
 * real dialog (focus trap, Esc, focus return). The frame lives only in the
 * caller's state while this is open — the server deleted its copy the moment
 * it was collected (docs/on-demand-peek-design.md) — and closing discards it.
 */
export function ViewScreenDialog({
  open,
  onOpenChange,
  studentName,
  imageBase64,
  capturedAt,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  studentName: string;
  imageBase64: string | null;
  capturedAt: Date | null;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] overflow-auto sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>
            {studentName}&apos;s screen{capturedAt ? ` · taken ${formatTime(capturedAt)}` : ""}
          </DialogTitle>
          <DialogDescription>
            One still, taken when you asked; the student saw a notice. Closing discards it.
          </DialogDescription>
        </DialogHeader>
        {imageBase64 ? (
          // base64 straight from the collect route; never a URL, never cached
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={`data:image/jpeg;base64,${imageBase64}`}
            alt={`${studentName}'s test screen`}
            className="max-w-full rounded-md border"
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
