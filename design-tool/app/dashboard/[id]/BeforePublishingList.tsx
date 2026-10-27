"use client";

import { CircleAlert } from "lucide-react";
import type { BeforePublishingEntry } from "./readiness";

/**
 * R-5 (docs/editor-redesign-design.md), behind the R-12 flag: the readiness
 * checks as a list of links. Each entry jumps to its question; nothing here
 * blocks — a keyless or unfinished question is a legal draft.
 */
export function BeforePublishingList({
  entries,
  onJump,
}: {
  entries: BeforePublishingEntry[];
  onJump: (itemId: string) => void;
}) {
  if (entries.length === 0) return null;
  return (
    <section aria-labelledby="before-publishing-heading" className="rounded-lg border border-warning-foreground/30 bg-warning p-3">
      <h3 id="before-publishing-heading" className="text-sm font-semibold">
        Before publishing
      </h3>
      <ul className="mt-2 space-y-1 text-sm">
        {entries.map((e, i) => (
          <li key={`${e.itemId}-${i}`} className="flex items-start gap-2">
            <CircleAlert className="mt-0.5 size-4 shrink-0 text-warning-foreground" aria-hidden />
            <button type="button" className="text-left underline" onClick={() => onJump(e.itemId)}>
              {e.label}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
