// R-5 (docs/editor-redesign-design.md, Phase 4 slice A): the new editor's
// pure autosave and history logic — no DB, no fetch, fake timers.
//
// - createItemAutosaver: one debounce per question card, so typing in one card
//   never delays another, a failed save is not retried in a loop, an edit
//   undone before the timer fires is never written, and a held card (restore
//   in flight) is never autosaved.
// - autosaveSummary: what the one save indicator says.
// - shouldCapture: when an item PATCH keeps a history copy.
// - beforePublishing: the readiness checks as links to questions.
import { describe, expect, test } from "bun:test";
import { autosaveSummary, createItemAutosaver } from "../lib/authoring/itemAutosave";
import { SNAPSHOT_INTERVAL_MS, shouldCapture } from "../lib/authoring/itemHistory";
import { beforePublishing, type ReadinessItem } from "../app/dashboard/[id]/readiness";
import { versionExcerpt, versionHeading } from "../app/dashboard/[id]/ItemHistoryDialog";
import type { ItemSnapshotContent } from "../db/schema";

/** setTimeout / clearTimeout that only fire on tick() (as test/autosave.test.ts). */
function makeClock() {
  let nextId = 1;
  const pending = new Map<number, { at: number; fn: () => void }>();
  let now = 0;
  return {
    setTimeout(fn: () => void, ms: number) {
      const id = nextId++;
      pending.set(id, { at: now + ms, fn });
      return id as unknown as ReturnType<typeof globalThis.setTimeout>;
    },
    clearTimeout(id: ReturnType<typeof globalThis.setTimeout>) {
      pending.delete(id as unknown as number);
    },
    tick(ms: number) {
      now += ms;
      const due = [...pending.entries()].filter(([, t]) => t.at <= now).sort((a, b) => a[1].at - b[1].at);
      for (const [id, t] of due) {
        pending.delete(id);
        t.fn();
      }
    },
  };
}

const flushMicrotasks = () => new Promise((r) => setTimeout(r, 0));

function setup() {
  const clock = makeClock();
  const calls: [string, string][] = [];
  let fail = false;
  const saver = createItemAutosaver<string>({
    delayMs: 1000,
    save: async (id, value) => {
      calls.push([id, value]);
      if (fail) throw new Error("boom");
    },
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
  });
  const entry = (id: string, value: string, pending = true) => ({ id, fingerprint: value, value, pending });
  return { clock, calls, saver, entry, setFail: (f: boolean) => (fail = f) };
}

describe("createItemAutosaver (debounce per card)", () => {
  test("a burst of edits saves once, a second after the last one", async () => {
    const { clock, calls, saver, entry } = setup();
    saver.sync([entry("q1", "a")]);
    clock.tick(500);
    saver.sync([entry("q1", "ab")]);
    clock.tick(500);
    saver.sync([entry("q1", "abc")]);
    clock.tick(999);
    expect(calls).toEqual([]);
    clock.tick(1);
    await flushMicrotasks();
    expect(calls).toEqual([["q1", "abc"]]);
  });

  test("re-syncing the same content does not restart the timer", async () => {
    const { clock, calls, saver, entry } = setup();
    saver.sync([entry("q1", "a")]);
    clock.tick(600);
    // Another card's edit re-renders the editor; q1 is unchanged.
    saver.sync([entry("q1", "a"), entry("q2", "x")]);
    clock.tick(400);
    await flushMicrotasks();
    expect(calls).toEqual([["q1", "a"]]);
    clock.tick(600);
    await flushMicrotasks();
    expect(calls).toEqual([["q1", "a"], ["q2", "x"]]);
  });

  test("typing in one card never delays another", async () => {
    const { clock, calls, saver, entry } = setup();
    saver.sync([entry("q1", "a"), entry("q2", "x")]);
    clock.tick(800);
    saver.sync([entry("q1", "a"), entry("q2", "xy")]);
    clock.tick(200);
    await flushMicrotasks();
    expect(calls).toEqual([["q1", "a"]]);
  });

  test("an edit undone before the timer fires is never written", async () => {
    const { clock, calls, saver, entry } = setup();
    saver.sync([entry("q1", "oops")]);
    clock.tick(500);
    saver.sync([entry("q1", "saved text", false)]);
    clock.tick(5000);
    await flushMicrotasks();
    expect(calls).toEqual([]);
  });

  test("a failed save is not retried for the same content; the next edit or retry sends it", async () => {
    const { clock, calls, saver, entry, setFail } = setup();
    setFail(true);
    saver.sync([entry("q1", "a")]);
    clock.tick(1000);
    await flushMicrotasks();
    expect(calls.length).toBe(1);
    // Still dirty after the failure, same content: no loop.
    saver.sync([entry("q1", "a")]);
    clock.tick(5000);
    await flushMicrotasks();
    expect(calls.length).toBe(1);
    setFail(false);
    await saver.retry("q1", "a");
    expect(calls).toEqual([["q1", "a"], ["q1", "a"]]);
    saver.sync([entry("q1", "ab")]);
    clock.tick(1000);
    await flushMicrotasks();
    expect(calls.at(-1)).toEqual(["q1", "ab"]);
  });

  test("cancel drops a pending save (a deleted card); flush sends it now", async () => {
    const { clock, calls, saver, entry } = setup();
    saver.sync([entry("q1", "a"), entry("q2", "x")]);
    saver.cancel("q1");
    await saver.flush("q2");
    expect(calls).toEqual([["q2", "x"]]);
    clock.tick(5000);
    await flushMicrotasks();
    expect(calls).toEqual([["q2", "x"]]);
  });

  test("a held card (restore / type change in flight) schedules nothing until released", async () => {
    // Review finding: the restored content on the card must not go out as an
    // ordinary autosave (no `restore`, so no copy of what it replaces).
    const { clock, calls, saver, entry } = setup();
    saver.sync([entry("q1", "current")]);
    saver.hold("q1");
    saver.sync([entry("q1", "restored"), entry("q2", "x")]);
    clock.tick(5000);
    await flushMicrotasks();
    expect(calls).toEqual([["q2", "x"]]);
    // Released after a refused restore with the current content back on the
    // card: its own pending edit (if any) saves as usual.
    saver.release("q1");
    saver.sync([entry("q1", "current")]);
    clock.tick(1000);
    await flushMicrotasks();
    expect(calls).toEqual([["q2", "x"], ["q1", "current"]]);
  });

  test("an edit typed while a save is in flight goes out after it, never alongside", async () => {
    const clock = makeClock();
    const calls: string[] = [];
    let release: (() => void) | null = null;
    const saver = createItemAutosaver<string>({
      delayMs: 1000,
      save: (_id, v) =>
        new Promise<void>((r) => {
          calls.push(v);
          release = r;
        }),
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    });
    saver.sync([{ id: "q1", fingerprint: "a", value: "a", pending: true }]);
    clock.tick(1000);
    saver.sync([{ id: "q1", fingerprint: "ab", value: "ab", pending: true }]);
    clock.tick(1000);
    expect(calls).toEqual(["a"]);
    release!();
    await flushMicrotasks();
    expect(calls).toEqual(["a", "ab"]);
  });
});

describe("autosaveSummary", () => {
  const card = (
    over: Partial<{ id: string; dirty: boolean; saving: boolean; failed: boolean; blocked: boolean; waiting: boolean }>,
  ) => ({
    id: "q1",
    dirty: false,
    saving: false,
    failed: false,
    blocked: false,
    ...over,
  });
  test("all clean reads All changes saved", () => {
    expect(autosaveSummary([card({}), card({ id: "q2" })])).toEqual({ kind: "saved" });
    expect(autosaveSummary([])).toEqual({ kind: "saved" });
  });
  test("dirty or in flight reads Saving…", () => {
    expect(autosaveSummary([card({ dirty: true })])).toEqual({ kind: "saving" });
    expect(autosaveSummary([card({ saving: true })])).toEqual({ kind: "saving" });
  });
  test("a failure outranks saving and names the card", () => {
    expect(
      autosaveSummary([card({ dirty: true }), card({ id: "q2", dirty: true, failed: true })]),
    ).toEqual({ kind: "error", itemIds: ["q2"] });
  });
  test("a failure that was since saved (not dirty) is not reported", () => {
    expect(autosaveSummary([card({ failed: true })])).toEqual({ kind: "saved" });
  });
  test("a published card's edit the lock refuses is blocked, not saving", () => {
    expect(autosaveSummary([card({ dirty: true, blocked: true })])).toEqual({ kind: "blocked", itemIds: ["q1"] });
  });
  // F-5 (2026-10-27): a fill-in-the-blank card with a deleted blank is held,
  // not failed — it reads "waiting", below an error or the publish lock.
  test("a card held on a deleted blank is waiting, not saving or failed", () => {
    expect(autosaveSummary([card({ dirty: true, waiting: true })])).toEqual({ kind: "waiting", itemIds: ["q1"] });
    expect(autosaveSummary([card({ waiting: true })])).toEqual({ kind: "saved" });
    expect(
      autosaveSummary([card({ dirty: true, waiting: true }), card({ id: "q2", dirty: true, failed: true })]),
    ).toEqual({ kind: "error", itemIds: ["q2"] });
  });
});

describe("shouldCapture (item history)", () => {
  const content = (stem: string): ItemSnapshotContent => ({
    type: "short_text",
    stem,
    choices: [],
    correct_choice_ids: [],
    correct_answer: "4",
    config: {},
    standards: [],
  });
  const now = new Date("2026-10-26T12:00:00Z");
  const ago = (ms: number) => new Date(now.getTime() - ms);

  test("the first change of an item keeps the version it replaces", () => {
    expect(shouldCapture({ before: content("a"), after: content("b"), latest: null, now })).toBe(true);
  });
  test("a write that changes nothing keeps nothing", () => {
    expect(shouldCapture({ before: content("a"), after: content("a"), latest: null, now, force: true })).toBe(false);
  });
  test("within the interval, autosaves coalesce into the copy already kept", () => {
    const latest = { content: content("old"), captured_at: ago(SNAPSHOT_INTERVAL_MS - 1) };
    expect(shouldCapture({ before: content("a"), after: content("b"), latest, now })).toBe(false);
  });
  test("after the interval, the next change keeps a new copy", () => {
    const latest = { content: content("old"), captured_at: ago(SNAPSHOT_INTERVAL_MS) };
    expect(shouldCapture({ before: content("a"), after: content("b"), latest, now })).toBe(true);
  });
  test("a restore always keeps the version it replaces", () => {
    const latest = { content: content("old"), captured_at: ago(1000) };
    expect(shouldCapture({ before: content("a"), after: content("old"), latest, now, force: true })).toBe(true);
  });
  test("never a duplicate of the newest copy", () => {
    const latest = { content: content("a"), captured_at: ago(SNAPSHOT_INTERVAL_MS * 10) };
    expect(shouldCapture({ before: content("a"), after: content("b"), latest, now, force: true })).toBe(false);
  });
  test("key order does not make equal content look different", () => {
    const a = { ...content("a"), config: { exact_form: true, scoring_method: "auto" as const } };
    const b = { ...content("a"), config: { scoring_method: "auto" as const, exact_form: true } };
    expect(shouldCapture({ before: a, after: b, latest: null, now })).toBe(false);
  });
});

describe("beforePublishing", () => {
  const item = (id: string, over: Partial<ReadinessItem> = {}): ReadinessItem & { id: string } => ({
    id,
    type: "short_text",
    stem: "What is 2 + 2?",
    item_set_id: null,
    choices: [],
    correct_choice_ids: [],
    correct_answer: "4",
    pairs: null,
    sequence: null,
    image_asset_id: null,
    correct_region_ids: null,
    ...over,
  });

  test("a complete assessment has nothing to fix", () => {
    expect(beforePublishing([item("q1"), item("q2")])).toEqual([]);
  });

  test("each incomplete question is an entry naming the question to jump to", () => {
    const entries = beforePublishing([item("q1"), item("q2", { correct_answer: "" }), item("q3", { stem: "" })]);
    expect(entries.map((e) => e.itemId)).toEqual(["q2", "q3"]);
    expect(entries[0]!.label).toMatch(/^Question 2 /);
    expect(entries[1]!.label).toMatch(/^Question 3 /);
  });

  test("no cut-off: every gap is listed (the publish dialog stops at five)", () => {
    const many = Array.from({ length: 8 }, (_, i) => item(`q${i}`, { correct_answer: "" }));
    expect(beforePublishing(many).length).toBe(8);
  });

  test("a stimulus gap jumps to the first question of its set", () => {
    const entries = beforePublishing(
      [item("q1"), item("q2", { item_set_id: "s1" }), item("q3", { item_set_id: "s1" })],
      [{ id: "s1", stimulus_text: "  " }],
    );
    expect(entries).toEqual([{ itemId: "q2", label: "Stimulus for question 2 is empty" }]);
  });
});

describe("versionExcerpt", () => {
  test("flattens whitespace and shortens long text", () => {
    expect(versionExcerpt("a\n\n  b")).toBe("a b");
    expect(versionExcerpt("x".repeat(130), 120)).toBe(`${"x".repeat(120)}…`);
    expect(versionExcerpt("   ")).toBe("(no question text)");
  });
});

// F-3 (2026-10-27): versions either side of a type change looked identical.
describe("versionHeading", () => {
  test("names the version's question type after its time", () => {
    const at = "2026-10-27T17:24:00Z";
    const multi = versionHeading({ saved_at: at, item: { type: "multiple_choice_multi" } });
    const single = versionHeading({ saved_at: at, item: { type: "multiple_choice_single" } });
    expect(multi).toEndWith(" · Multiple select");
    expect(single).toEndWith(" · Multiple choice");
    expect(multi).not.toBe(single);
  });
});
