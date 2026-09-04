"use client";

// E6 follow-up (2026-09-02): Bold / Italic beside Image… / Math…, so the
// `**bold**` / `_italic_` markup is discoverable instead of typed from
// memory. Wraps the CURRENT SELECTION of the field the teacher is in (the
// button's mousedown is prevented, so focus and selection stay in the
// field); with nothing selected it inserts a placeholder at the caret;
// with no field focused it appends one to this row's own field. The guard
// against wrapping the wrong field: the focused element's value must
// equal the value this row's updater sees — otherwise fall back to append.

export type Emphasis = "bold" | "italic";

const MARK: Record<Emphasis, { open: string; close: string; placeholder: string }> = {
  bold: { open: "**", close: "**", placeholder: "bold" },
  italic: { open: "_", close: "_", placeholder: "italic" },
};

/** Pure: apply `kind` to `value` at [start, end) (a selection) or at a caret. */
export function applyEmphasis(value: string, kind: Emphasis, start: number, end: number): string {
  const m = MARK[kind];
  const s = Math.max(0, Math.min(start, value.length));
  const e = Math.max(s, Math.min(end, value.length));
  const inner = e > s ? value.slice(s, e) : m.placeholder;
  // An italic run must open at a word boundary and close before one
  // (renderItemContent's rule); pad with a space where the neighbour is a
  // word character so the markup renders rather than staying literal.
  const before = value.slice(0, s);
  const after = value.slice(e);
  const padL = kind === "italic" && /\w$/.test(before) ? " " : "";
  const padR = kind === "italic" && /^\w/.test(after) ? " " : "";
  return `${before}${padL}${m.open}${inner}${m.close}${padR}${after}`;
}

/** Append a placeholder run to a value that has no caret to use. */
export function appendEmphasis(value: string, kind: Emphasis): string {
  const m = MARK[kind];
  const run = `${m.open}${m.placeholder}${m.close}`;
  return value ? `${value} ${run}` : run;
}

interface Props {
  /** Receives a function from the field's current value to its new value. */
  apply: (next: (value: string) => string) => void;
  disabled?: boolean;
}

function isTextField(el: Element | null): el is HTMLTextAreaElement | HTMLInputElement {
  return (
    !!el &&
    (el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement && el.type === "text"))
  );
}

export function EmphasisButtons({ apply, disabled }: Props) {
  function onPress(kind: Emphasis) {
    const el = document.activeElement;
    if (isTextField(el)) {
      const focusedValue = el.value;
      const start = el.selectionStart ?? focusedValue.length;
      const end = el.selectionEnd ?? start;
      apply((value) => (value === focusedValue ? applyEmphasis(value, kind, start, end) : appendEmphasis(value, kind)));
      return;
    }
    apply((value) => appendEmphasis(value, kind));
  }
  const cls = "rounded border border-border px-2 py-0.5 text-xs hover:bg-accent disabled:opacity-40";
  return (
    <div className="mt-1 flex items-center gap-1">
      <button
        type="button"
        className={cls}
        disabled={disabled}
        title="Bold the selected text (**like this**)"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => onPress("bold")}
      >
        <strong>B</strong>
      </button>
      <button
        type="button"
        className={cls}
        disabled={disabled}
        title="Italicise the selected text (_like this_)"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => onPress("italic")}
      >
        <em>I</em>
      </button>
    </div>
  );
}
