"use client";

import { useEffect, useRef, useState } from "react";
import { Plus } from "lucide-react";
import type { ItemType } from "@/db/schema";
import { ITEM_TYPE_LABEL } from "@/lib/items/typeLabel";
import { INSERT_MENU_COMMON, INSERT_MENU_MORE, filterInsertTypes } from "@/lib/authoring/insertTypes";

const optionClass =
  "block w-full rounded px-2 py-1 text-left text-sm hover:bg-accent focus-visible:bg-accent focus-visible:outline-none";

/**
 * R-6 (docs/editor-redesign-design.md, Phase 4 slice B), new editor only: the
 * "+" between blocks of the question list, and the "/" menu it opens (also
 * opened by typing "/" on a question card outside a text field). Six common
 * types first, the rest under "More types"; typing filters every type. The
 * new question goes in exactly where the "+" sits (UX3-4).
 */
export function InsertQuestionMenu({
  open,
  onOpenChange,
  onInsert,
  disabled,
  busy,
  prominent = false,
  label,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onInsert: (type: ItemType) => void;
  disabled: boolean;
  busy: boolean;
  /** The end-of-list "+" reads "Add question"; the in-between ones are a small "+". */
  prominent?: boolean;
  /** The "+"'s accessible name, e.g. "Add a question before question 3". */
  label: string;
}) {
  const [query, setQuery] = useState("");
  const [more, setMore] = useState(false);
  const plusRef = useRef<HTMLButtonElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setQuery("");
      setMore(false);
      filterRef.current?.focus();
    }
  }, [open]);

  function close() {
    onOpenChange(false);
    plusRef.current?.focus();
  }

  function pick(type: ItemType) {
    onOpenChange(false);
    onInsert(type);
  }

  const filtered = query.trim() ? filterInsertTypes(query, (t) => ITEM_TYPE_LABEL[t]) : null;

  const option = (t: ItemType) => (
    <li key={t}>
      <button type="button" className={optionClass} onClick={() => pick(t)} disabled={busy}>
        {ITEM_TYPE_LABEL[t]}
      </button>
    </li>
  );

  return (
    <div className="relative">
      {prominent ? (
        <button
          ref={plusRef}
          type="button"
          className="flex w-full items-center justify-center gap-1 rounded-lg border border-dashed border-border py-2 text-sm text-muted-foreground hover:bg-accent disabled:opacity-50"
          aria-expanded={open}
          aria-label={label}
          disabled={disabled || busy}
          onClick={() => onOpenChange(!open)}
        >
          <Plus className="size-4" aria-hidden />
          {busy ? "Adding…" : "Add question"}
        </button>
      ) : (
        <div className="group flex items-center gap-2">
          <span className="h-px flex-1 bg-border opacity-0 group-focus-within:opacity-100 group-hover:opacity-100" />
          <button
            ref={plusRef}
            type="button"
            className="rounded-full border border-border bg-card p-0.5 text-muted-foreground opacity-60 hover:bg-accent hover:opacity-100 focus-visible:opacity-100 disabled:opacity-30"
            aria-expanded={open}
            aria-label={label}
            title="Add a question here"
            disabled={disabled || busy}
            onClick={() => onOpenChange(!open)}
          >
            <Plus className="size-4" aria-hidden />
          </button>
          <span className="h-px flex-1 bg-border opacity-0 group-focus-within:opacity-100 group-hover:opacity-100" />
        </div>
      )}
      {open ? (
        <div
          role="dialog"
          aria-label="Add a question"
          className="absolute left-1/2 z-20 mt-1 w-64 -translate-x-1/2 rounded-lg border bg-popover p-2 text-popover-foreground shadow-md"
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              close();
            }
          }}
        >
          <input
            ref={filterRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && filtered && filtered.length > 0) {
                e.preventDefault();
                pick(filtered[0]!);
              }
            }}
            placeholder="Type to find a question type"
            aria-label="Find a question type"
            className="mb-1 w-full rounded-md border border-border bg-transparent px-2 py-1 text-sm"
          />
          {filtered ? (
            filtered.length > 0 ? (
              <ul>{filtered.map(option)}</ul>
            ) : (
              <p className="px-2 py-1 text-sm text-muted-foreground">No type matches.</p>
            )
          ) : (
            <>
              <ul>{INSERT_MENU_COMMON.map(option)}</ul>
              <button
                type="button"
                className={`${optionClass} mt-1 text-muted-foreground`}
                aria-expanded={more}
                onClick={() => setMore((v) => !v)}
              >
                {more ? "Fewer types" : "More types…"}
              </button>
              {more ? <ul>{INSERT_MENU_MORE.map(option)}</ul> : null}
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
