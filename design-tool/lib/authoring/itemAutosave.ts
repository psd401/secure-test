import { createAutosave, type Autosave, type CreateAutosaveOptions } from "@/lib/autosave";

/**
 * R-5 (docs/editor-redesign-design.md): autosave for the new editor's
 * question cards, one debounce per item on top of `createAutosave` (so each
 * item has at most one PATCH in flight and a trailing save carries the newest
 * value).
 *
 * The editor calls `sync` after every render with each card's state. A card
 * is scheduled when it is `pending` (dirty and allowed to save) with a
 * fingerprint it has not been scheduled with before, so:
 * - typing restarts that card's timer only, never another card's;
 * - a save that failed is not retried for the same content (no loop of
 *   failing PATCHes); the next edit, or `retry`, sends it again;
 * - a card edited back to its saved content before the timer fires has the
 *   pending save dropped, so the in-between text is never written.
 */
export interface ItemAutosaveEntry<T> {
  id: string;
  fingerprint: string;
  value: T;
  pending: boolean;
}

export interface ItemAutosaver<T> {
  sync(entries: ItemAutosaveEntry<T>[]): void;
  /** Send a card's pending save now (e.g. before a restore or on unmount). */
  flush(id: string): Promise<void>;
  flushAll(): Promise<void>;
  /** Drop a card's pending save (deleted card, restore replacing it). */
  cancel(id: string): void;
  /**
   * Drop a card's pending save and schedule nothing for it until `release`:
   * while a restore or type change is in flight, the card shows content its
   * own PATCH (with `restore`) is sending, and an ordinary autosave of that
   * same content must not race it — or, if it fails, outlive it.
   */
  hold(id: string): void;
  release(id: string): void;
  /** Send this value now even if the same content was already attempted. */
  retry(id: string, value: T): Promise<void>;
}

export const ITEM_AUTOSAVE_DELAY_MS = 1000;

export function createItemAutosaver<T>({
  delayMs = ITEM_AUTOSAVE_DELAY_MS,
  save,
  setTimeout,
  clearTimeout,
}: {
  delayMs?: number;
  save: (id: string, value: T) => Promise<void>;
  setTimeout?: CreateAutosaveOptions<T>["setTimeout"];
  clearTimeout?: CreateAutosaveOptions<T>["clearTimeout"];
}): ItemAutosaver<T> {
  const savers = new Map<string, Autosave<T>>();
  const scheduled = new Map<string, string>();
  const held = new Set<string>();

  function saverFor(id: string): Autosave<T> {
    let s = savers.get(id);
    if (!s) {
      s = createAutosave<T>({
        delayMs,
        save: (value) => save(id, value),
        // The editor's own save path reports saving / saved / failed.
        onState: () => {},
        setTimeout,
        clearTimeout,
      });
      savers.set(id, s);
    }
    return s;
  }

  return {
    sync(entries) {
      for (const e of entries) {
        if (!e.pending || held.has(e.id)) {
          if (scheduled.has(e.id)) {
            scheduled.delete(e.id);
            savers.get(e.id)?.cancel();
          }
          continue;
        }
        if (scheduled.get(e.id) === e.fingerprint) continue;
        scheduled.set(e.id, e.fingerprint);
        saverFor(e.id).schedule(e.value);
      }
    },
    async flush(id) {
      await savers.get(id)?.flush();
    },
    async flushAll() {
      await Promise.all([...savers.values()].map((s) => s.flush()));
    },
    cancel(id) {
      scheduled.delete(id);
      savers.get(id)?.cancel();
    },
    hold(id) {
      held.add(id);
      scheduled.delete(id);
      savers.get(id)?.cancel();
    },
    release(id) {
      held.delete(id);
    },
    async retry(id, value) {
      const s = saverFor(id);
      s.schedule(value);
      await s.flush();
    },
  };
}

/** What the new editor's one save indicator says. */
export type AutosaveSummary =
  | { kind: "saved" }
  | { kind: "saving" }
  | { kind: "error"; itemIds: string[] }
  | { kind: "blocked"; itemIds: string[] }
  /** `creditIds`: the held cards that wait on an unfinished AI short-answer
   * key (hand-check row 836); the rest wait on a deleted blank (F-5). */
  | { kind: "waiting"; itemIds: string[]; creditIds?: string[] };

/**
 * Pure: the indicator for the whole question list. An error outranks
 * everything (a teacher must not read "All changes saved" while one card
 * failed); then edits a published assessment will not take ("blocked"); then
 * cards held back until the teacher finishes a step — a deleted blank to put
 * back or remove, or an AI short-answer key with an empty level ("waiting");
 * then anything dirty or in flight reads
 * "Saving…".
 */
export function autosaveSummary(
  cards: {
    id: string;
    dirty: boolean;
    saving: boolean;
    failed: boolean;
    blocked: boolean;
    /** Held until the teacher finishes a step: true or "blank" = a deleted
     * blank to put back or remove; "credit" = an empty credit level. */
    waiting?: boolean | "blank" | "credit";
  }[],
): AutosaveSummary {
  const failed = cards.filter((c) => c.failed && c.dirty).map((c) => c.id);
  if (failed.length > 0) return { kind: "error", itemIds: failed };
  const blocked = cards.filter((c) => c.blocked && c.dirty).map((c) => c.id);
  if (blocked.length > 0) return { kind: "blocked", itemIds: blocked };
  const held = cards.filter((c) => c.waiting && c.dirty);
  if (held.length > 0) {
    const creditIds = held.filter((c) => c.waiting === "credit").map((c) => c.id);
    return {
      kind: "waiting",
      itemIds: held.map((c) => c.id),
      ...(creditIds.length > 0 ? { creditIds } : {}),
    };
  }
  if (cards.some((c) => c.saving || c.dirty)) return { kind: "saving" };
  return { kind: "saved" };
}
