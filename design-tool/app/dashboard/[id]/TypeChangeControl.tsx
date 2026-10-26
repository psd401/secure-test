"use client";

import { useState } from "react";
import type { ItemType } from "@/db/schema";
import { Button } from "@/components/ui/button";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { ITEM_TYPE_LABEL } from "@/lib/items/typeLabel";
import type { TypeTarget } from "@/lib/authoring/typeChange";

/**
 * R-6 (docs/editor-redesign-design.md, Phase 4 slice B), new editor only:
 * change a question's type in place. `preview(target)` says what the change
 * would remove; when that is anything, the change waits for the teacher to
 * confirm a warning that names it (above all an answer key).
 */
export function TypeChangeControl({
  itemLabel,
  type,
  targets,
  disabled,
  preview,
  onChange,
}: {
  /** "question 3", for the select's accessible name. */
  itemLabel: string;
  type: ItemType;
  targets: TypeTarget[];
  disabled: boolean;
  preview: (target: ItemType) => { lost: string[]; keyLost: boolean };
  onChange: (target: ItemType) => void;
}) {
  const [pending, setPending] = useState<{ target: ItemType; lost: string[]; keyLost: boolean } | null>(null);

  function choose(target: ItemType) {
    if (target === type) return;
    const p = preview(target);
    if (p.lost.length === 0) onChange(target);
    else setPending({ target, ...p });
  }

  return (
    <div>
      <NativeSelect
        size="sm"
        aria-label={`Type of ${itemLabel}`}
        value={pending?.target ?? type}
        disabled={disabled}
        onChange={(e) => choose(e.target.value as ItemType)}
      >
        <NativeSelectOption value={type}>{ITEM_TYPE_LABEL[type]}</NativeSelectOption>
        {targets.map((t) => (
          <NativeSelectOption key={t.type} value={t.type} disabled={!t.available}>
            {t.available ? `Change to ${ITEM_TYPE_LABEL[t.type]}` : `${ITEM_TYPE_LABEL[t.type]} (${t.reason})`}
          </NativeSelectOption>
        ))}
      </NativeSelect>
      {pending ? (
        <div
          role="alertdialog"
          aria-label={`Change ${itemLabel} to ${ITEM_TYPE_LABEL[pending.target]}?`}
          className="mt-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900"
        >
          <p className="font-medium">
            {pending.keyLost ? "This removes the answer key. " : ""}Changing to {ITEM_TYPE_LABEL[pending.target]} removes:
          </p>
          <ul className="mt-1 list-disc pl-5">
            {pending.lost.map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
          <p className="mt-1">The question text stays. You can bring the old version back from History.</p>
          <div className="mt-2 flex gap-2">
            <Button
              type="button"
              size="sm"
              onClick={() => {
                const target = pending.target;
                setPending(null);
                onChange(target);
              }}
            >
              Change type
            </Button>
            <Button type="button" size="sm" variant="outline" autoFocus onClick={() => setPending(null)}>
              Keep {ITEM_TYPE_LABEL[type]}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
