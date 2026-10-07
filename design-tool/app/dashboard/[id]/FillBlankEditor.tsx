"use client";

import type { FillBlankBlank, FillBlankDropdown, FillBlankText } from "@secure-test/schema";
import {
  MAX_BLANKS,
  MAX_KEYS,
  MAX_OPTIONS,
  MIN_OPTIONS,
  addBlankForMarker,
  blankCountLine,
  copyOptionsFrom,
  insertBlankAt,
  isInStem,
  marker,
  nextOptionId,
  orphanMarkers,
  removeBlank,
  removeMarker,
  restoreMarker,
  setBlankKind,
} from "@/lib/items/fillBlankEditor";

// FB slice 2 (docs/fill-in-blank-design.md): the per-blank panel for a
// fill-in-the-blank question. The sentence itself is the card's ordinary stem
// textarea; markers (`[[b1]]`) go in through "Insert blank" (InsertBlankButton,
// rendered in the stem toolbar), and ids are generated, never typed. The list
// below follows the stem's order, so "Blank n" here is "Blank n" for students
// and in every report. Kind, options and `exact_form` lock on a published
// test; the key (the correct option, the accepted answers) stays editable —
// the server's publish lock admits exactly that (slice 1).

export type FillBlankPatch = { stem?: string; blanks?: FillBlankBlank[] };

const INPUT = "w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm";
const SMALL_BUTTON = "shrink-0 rounded-md border border-border px-2 py-1 text-xs disabled:opacity-40";

interface InsertProps {
  itemId: string;
  stem: string;
  blanks: FillBlankBlank[];
  onChange: (patch: FillBlankPatch) => void;
  disabled: boolean;
}

/**
 * "Insert blank" beside Bold / Italic. Its mousedown is prevented so the
 * stem textarea keeps focus and selection (the EmphasisButtons rule): the
 * marker lands at the caret, or replaces the selection — which then becomes
 * the blank's first accepted answer. With the textarea not focused it goes
 * at the end of the sentence.
 */
export function InsertBlankButton({ itemId, stem, blanks, onChange, disabled }: InsertProps) {
  function onPress() {
    const el = document.getElementById(`stem-${itemId}`);
    const field = el instanceof HTMLTextAreaElement ? el : null;
    const focused = !!field && document.activeElement === field && field.value === stem;
    const start = focused ? (field.selectionStart ?? stem.length) : stem.length;
    const end = focused ? (field.selectionEnd ?? start) : stem.length;
    const out = insertBlankAt(stem, blanks, start, end);
    onChange({ stem: out.stem, blanks: out.blanks });
    if (field) {
      requestAnimationFrame(() => {
        field.focus();
        field.setSelectionRange(out.caret, out.caret);
      });
    }
  }
  const full = blanks.length >= MAX_BLANKS;
  return (
    <button
      type="button"
      className="mt-1 rounded border border-border px-2 py-0.5 text-xs hover:bg-accent disabled:opacity-40"
      disabled={disabled || full}
      title={full ? `A question allows at most ${MAX_BLANKS} blanks` : "Add a blank at the cursor"}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onPress}
    >
      Insert blank
    </button>
  );
}

interface Props {
  /** Scopes the radio groups: two questions may both have a blank b1. */
  itemId: string;
  stem: string;
  blanks: FillBlankBlank[];
  onChange: (patch: FillBlankPatch) => void;
  /** Published: structure locked, keys editable. */
  disabled: boolean;
}

export function FillBlankEditor({ itemId, stem, blanks, onChange, disabled }: Props) {
  const orphans = orphanMarkers(stem, blanks);

  function setBlank(i: number, next: FillBlankBlank) {
    onChange({ blanks: blanks.map((b, k) => (k === i ? next : b)) });
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        Each <code>[[b1]]</code> in the question marks a blank — use <strong>Insert blank</strong> to add
        one at the cursor (select a word first to make it the answer). Students see a menu or a box in
        its place.
      </p>

      {orphans.map((id) => (
        <div
          key={`orphan-${id}`}
          className="flex flex-wrap items-center gap-2 rounded-md border border-dashed border-border px-3 py-2 text-sm"
        >
          <span>
            <code>{marker(id)}</code> in the question has no blank.
          </span>
          <button
            type="button"
            className={SMALL_BUTTON}
            disabled={disabled}
            onClick={() => onChange({ blanks: addBlankForMarker(stem, blanks, id) })}
          >
            Add a blank for it
          </button>
          <button
            type="button"
            className={SMALL_BUTTON}
            disabled={disabled}
            onClick={() => onChange({ stem: removeMarker(stem, id) })}
          >
            Delete it from the question
          </button>
        </div>
      ))}

      {blanks.length === 0 ? (
        <p className="text-sm text-muted-foreground">No blanks yet — use Insert blank above.</p>
      ) : null}

      {blanks.map((b, i) => {
        const n = i + 1;
        const inStem = isInStem(stem, b.id);
        const otherDropdowns = blanks
          .map((x, k) => ({ x, k }))
          .filter(({ x, k }) => k !== i && x.kind === "dropdown") as { x: FillBlankDropdown; k: number }[];
        return (
          <fieldset key={b.id} className="space-y-2 rounded-md border border-border px-3 py-2">
            <legend className="px-1 text-sm font-medium">
              Blank {n} <code className="font-normal text-muted-foreground">{marker(b.id)}</code>
            </legend>

            {!inStem ? (
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className="text-destructive">Not in the question any more.</span>
                <button
                  type="button"
                  className={SMALL_BUTTON}
                  disabled={disabled}
                  onClick={() => onChange(restoreMarker(stem, blanks, b.id))}
                >
                  Put it back (at the end)
                </button>
              </div>
            ) : null}

            <div className="flex flex-wrap items-center gap-2">
              <label className="flex items-center gap-2 text-sm">
                <span>Kind</span>
                <select
                  value={b.kind}
                  disabled={disabled}
                  onChange={(e) => setBlank(i, setBlankKind(b, e.target.value as FillBlankBlank["kind"]))}
                  className="rounded-md border border-border bg-transparent px-2 py-1 text-sm"
                >
                  <option value="dropdown">Dropdown</option>
                  <option value="text">Typed answer</option>
                </select>
              </label>
              <button
                type="button"
                className={SMALL_BUTTON}
                disabled={disabled || blanks.length <= 1}
                title={blanks.length <= 1 ? "A question needs at least one blank" : "Remove this blank and its marker"}
                onClick={() => onChange(removeBlank(stem, blanks, b.id))}
              >
                Remove blank
              </button>
            </div>

            {b.kind === "dropdown" ? (
              <DropdownFields
                blank={b}
                n={n}
                radioName={`correct-${itemId}-${b.id}`}
                others={otherDropdowns}
                disabled={disabled}
                onChange={(next) => setBlank(i, next)}
              />
            ) : (
              <TypedFields blank={b} n={n} disabled={disabled} onChange={(next) => setBlank(i, next)} />
            )}
          </fieldset>
        );
      })}

      <p className="text-xs text-muted-foreground">{blankCountLine(blanks)}.</p>
    </div>
  );
}

function DropdownFields({
  blank,
  n,
  radioName,
  others,
  disabled,
  onChange,
}: {
  blank: FillBlankDropdown;
  n: number;
  radioName: string;
  others: { x: FillBlankDropdown; k: number }[];
  disabled: boolean;
  onChange: (next: FillBlankDropdown) => void;
}) {
  function setOptions(options: FillBlankDropdown["options"]) {
    const next: FillBlankDropdown = { ...blank, options };
    if (next.correct_option_id != null && !options.some((o) => o.id === next.correct_option_id)) {
      delete next.correct_option_id;
    }
    onChange(next);
  }
  function setCorrect(id: string | null) {
    const next: FillBlankDropdown = { ...blank };
    if (id == null) delete next.correct_option_id;
    else next.correct_option_id = id;
    onChange(next);
  }
  return (
    <div className="space-y-2">
      <div className="text-sm">
        Options{" "}
        <span className="text-muted-foreground">
          (in this order for students; mark the correct one — optional)
        </span>
      </div>
      {blank.options.map((o, oi) => (
        <div key={o.id} className="flex items-center gap-2">
          {/* The key: editable on a published test (slice 1's publish lock). */}
          <input
            type="radio"
            name={radioName}
            checked={blank.correct_option_id === o.id}
            aria-label={`Mark option ${oi + 1} of blank ${n} as correct`}
            title="Correct answer"
            onChange={() => setCorrect(o.id)}
          />
          <input
            value={o.text}
            disabled={disabled}
            placeholder={`Option ${oi + 1}`}
            aria-label={`Blank ${n} option ${oi + 1}`}
            onChange={(e) =>
              setOptions(blank.options.map((x, k) => (k === oi ? { ...x, text: e.target.value } : x)))
            }
            className={INPUT}
          />
          <button
            type="button"
            className={SMALL_BUTTON}
            disabled={disabled || blank.options.length <= MIN_OPTIONS}
            title={blank.options.length <= MIN_OPTIONS ? `A dropdown needs at least ${MIN_OPTIONS} options` : "Remove option"}
            onClick={() => setOptions(blank.options.filter((_, k) => k !== oi))}
          >
            Remove
          </button>
        </div>
      ))}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className={SMALL_BUTTON}
          disabled={disabled || blank.options.length >= MAX_OPTIONS}
          onClick={() => setOptions([...blank.options, { id: nextOptionId(blank.options), text: "" }])}
        >
          Add option
        </button>
        {blank.correct_option_id != null ? (
          <button type="button" className={SMALL_BUTTON} onClick={() => setCorrect(null)}>
            No correct option
          </button>
        ) : null}
        {others.length > 0 ? (
          <label className="flex items-center gap-2 text-xs">
            <span>Same options as</span>
            <select
              value=""
              disabled={disabled}
              onChange={(e) => {
                const src = others.find(({ k }) => String(k) === e.target.value);
                if (src) onChange(copyOptionsFrom(blank, src.x));
              }}
              className="rounded-md border border-border bg-transparent px-2 py-1 text-xs"
            >
              <option value="">choose a blank…</option>
              {others.map(({ k }) => (
                <option key={k} value={String(k)}>
                  Blank {k + 1}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </div>
    </div>
  );
}

function TypedFields({
  blank,
  n,
  disabled,
  onChange,
}: {
  blank: FillBlankText;
  n: number;
  disabled: boolean;
  onChange: (next: FillBlankText) => void;
}) {
  // An empty list shows one empty field; typing into it creates the key.
  const shown = blank.keys && blank.keys.length > 0 ? blank.keys : [""];
  function setKeys(keys: string[]) {
    const next: FillBlankText = { ...blank };
    if (keys.length === 0 || (keys.length === 1 && keys[0] === "")) delete next.keys;
    else next.keys = keys;
    onChange(next);
  }
  return (
    <div className="space-y-2">
      <div className="text-sm">
        Accepted answers{" "}
        <span className="text-muted-foreground">(optional — any one is accepted)</span>
      </div>
      {/* The accepted answers are the key: editable on a published test. */}
      {shown.map((k, ki) => (
        <div key={ki} className="flex items-center gap-2">
          <input
            value={k}
            placeholder={ki === 0 ? "e.g. leeward" : "another accepted answer"}
            aria-label={`Blank ${n} accepted answer ${ki + 1}`}
            onChange={(e) => setKeys(shown.map((x, j) => (j === ki ? e.target.value : x)))}
            className={INPUT}
          />
          {shown.length > 1 ? (
            <button
              type="button"
              className={SMALL_BUTTON}
              onClick={() => setKeys(shown.filter((_, j) => j !== ki))}
            >
              Remove
            </button>
          ) : null}
        </div>
      ))}
      <button
        type="button"
        className={SMALL_BUTTON}
        disabled={shown.length >= MAX_KEYS}
        onClick={() => setKeys([...shown, ""])}
      >
        Add another answer
      </button>
      {/* Same control and wording as the short-text item's (numeric
          equivalence, 2026-09-15); locked after publish like short text's. */}
      <span className="block text-xs text-muted-foreground">
        Equivalent numbers count: 1/2, 0.5 and 50/100 all match. Check this for tasks like &ldquo;in
        lowest terms&rdquo;.
      </span>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={blank.exact_form === true}
          disabled={disabled}
          onChange={(e) => {
            const next: FillBlankText = { ...blank };
            if (e.target.checked) next.exact_form = true;
            else delete next.exact_form;
            onChange(next);
          }}
        />
        <span>Answer form matters (exact match only)</span>
      </label>
    </div>
  );
}
