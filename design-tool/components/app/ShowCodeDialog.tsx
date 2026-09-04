"use client";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";

/**
 * UX pass 1, slice 6 (SM-03): the projector view. Nothing on it but the
 * assessment name, the code at ~20vh and the three-step join line — a
 * mirrored screen shows students the code, not the roster.
 */
export function ShowCodeDialog({
  open,
  onOpenChange,
  code,
  assessmentName,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  code: string;
  assessmentName: string;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="flex h-[92vh] w-[96vw] max-w-none flex-col items-center justify-center gap-8 border-0 bg-band text-band-foreground sm:max-w-none"
      >
        <DialogTitle className="text-center font-heading text-3xl font-bold md:text-4xl">
          {assessmentName}
        </DialogTitle>
        <p
          className="font-mono text-[18vh] font-semibold leading-none tracking-[0.25em] md:text-[22vh]"
          aria-label={`Session code ${code.split("").join(" ")}`}
        >
          {code}
        </p>
        <p className="max-w-3xl text-center text-2xl text-band-foreground/85 md:text-3xl">
          Open Secure Test, sign in with your school Google account, and enter this code.
        </p>
        <Button
          type="button"
          variant="outline"
          size="lg"
          className="mt-4 border-band-foreground/40 bg-transparent text-band-foreground hover:bg-band-foreground/10 hover:text-band-foreground"
          onClick={() => onOpenChange(false)}
        >
          Done
        </Button>
      </DialogContent>
    </Dialog>
  );
}
