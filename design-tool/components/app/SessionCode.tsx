"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * UX pass 1 (docs/ux-pass-1-proposal.md §1.3): the session code is the hero
 * wherever it appears — mono, tracked wide, sized for reading aloud. `size`
 * picks the row, header or projector treatment; Copy is the one action that
 * belongs beside it everywhere.
 */
export function SessionCode({
  code,
  size = "row",
  copy = true,
  className,
}: {
  code: string;
  size?: "row" | "header" | "projector";
  copy?: boolean;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);

  async function onCopy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard access denied (insecure context, permissions): the code is
      // still on screen to read aloud, which is its primary use.
    }
  }

  return (
    <span className={cn("inline-flex items-center gap-2", className)}>
      <span
        className={cn(
          "font-mono font-semibold tracking-[0.2em]",
          size === "row" && "text-2xl",
          size === "header" && "text-5xl tracking-[0.3em]",
          size === "projector" && "text-[20vh] leading-none tracking-[0.25em]",
        )}
      >
        {code}
      </span>
      {copy ? (
        <Button
          type="button"
          variant="ghost"
          size={size === "row" ? "icon-sm" : "icon"}
          onClick={onCopy}
          aria-label={copied ? "Copied" : `Copy session code ${code}`}
          title="Copy code"
        >
          {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
        </Button>
      ) : null}
    </span>
  );
}
