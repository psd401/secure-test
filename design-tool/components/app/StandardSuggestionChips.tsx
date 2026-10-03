"use client";

import { Check, X } from "lucide-react";
import { chipLabel } from "@/lib/standards/tags";
import type { SuggestEntry, SuggestedTag } from "@/lib/ai/suggestForm";

// BG slice 5: the AI's suggested standards on one untagged question's card.
// Each chip is a proposal, not a tag — Accept adds it through the editor's
// ordinary save, Dismiss drops it. Page state only (1.1).

export function StandardSuggestionChips({
  suggestions,
  entries,
  busy,
  onAccept,
  onDismiss,
}: {
  suggestions: SuggestedTag[];
  entries: Record<string, SuggestEntry>;
  /** The card is saving: Accept waits so two accepts cannot race one save. */
  busy?: boolean;
  onAccept: (tag: string) => void;
  onDismiss: (tag: string) => void;
}) {
  if (suggestions.length === 0) return null;
  return (
    <div className="mt-3">
      <p className="text-sm font-medium">
        Suggested standards <span className="font-normal text-muted-foreground">(AI — check before accepting)</span>
      </p>
      <ul className="mt-1 space-y-1.5" aria-label="Suggested standards for this question">
        {suggestions.map((s) => {
          const label = chipLabel(s.tag, entries[s.tag]);
          return (
            <li
              key={s.tag}
              title={label.title}
              className="flex flex-wrap items-center gap-2 rounded-md border border-dashed border-border px-2 py-1 text-xs"
            >
              <span className="font-medium">{label.code}</span>
              {label.text ? <span className="text-muted-foreground">{label.text}</span> : null}
              {s.reason ? <span className="basis-full text-muted-foreground">{s.reason}</span> : null}
              <span className="ml-auto flex gap-1">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => onAccept(s.tag)}
                  className="inline-flex items-center gap-1 rounded-sm border border-border px-1.5 py-0.5 hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50"
                  aria-label={`Accept ${label.code}`}
                >
                  <Check className="size-3" aria-hidden />
                  Accept
                </button>
                <button
                  type="button"
                  onClick={() => onDismiss(s.tag)}
                  className="inline-flex items-center gap-1 rounded-sm border border-border px-1.5 py-0.5 hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
                  aria-label={`Dismiss ${label.code}`}
                >
                  <X className="size-3" aria-hidden />
                  Dismiss
                </button>
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
