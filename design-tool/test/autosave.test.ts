// Multi-source stimulus finding C-6 / decision D-8
// (docs/multi-source-stimulus-design.md): createAutosave() is a pure,
// timer-injectable debounced-autosave primitive backing the Accommodations
// tab's autosave (AssessmentEditor.tsx). No DB, no fetch — just fake timers.
import { describe, expect, test } from "bun:test";
import { createAutosave, type AutosaveState } from "../lib/autosave";

/** A hand-rolled fake clock: setTimeout/clearTimeout that only fire on tick(). */
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
    /** Advance the clock and synchronously run any timers now due. */
    tick(ms: number) {
      now += ms;
      const due = [...pending.entries()]
        .filter(([, t]) => t.at <= now)
        .sort((a, b) => a[1].at - b[1].at);
      for (const [id, t] of due) {
        pending.delete(id);
        t.fn();
      }
    },
  };
}

/** A save() stand-in that resolves/rejects on demand and records calls. */
function makeDeferredSave<T>() {
  const calls: T[] = [];
  let resolveCurrent: (() => void) | null = null;
  let rejectCurrent: ((e: unknown) => void) | null = null;
  const save = (value: T) =>
    new Promise<void>((resolve, reject) => {
      calls.push(value);
      resolveCurrent = resolve;
      rejectCurrent = reject;
    });
  return {
    save,
    calls,
    resolve() {
      const r = resolveCurrent;
      resolveCurrent = null;
      rejectCurrent = null;
      r?.();
    },
    reject(e: unknown) {
      const r = rejectCurrent;
      resolveCurrent = null;
      rejectCurrent = null;
      r?.(e);
    },
  };
}

function stateRecorder() {
  const states: { state: AutosaveState; err?: unknown }[] = [];
  return { states, onState: (state: AutosaveState, err?: unknown) => states.push({ state, err }) };
}

describe("createAutosave", () => {
  test("debounce coalesces rapid schedules into a single save with the last value", async () => {
    const clock = makeClock();
    const { save, calls, resolve } = makeDeferredSave<number>();
    const { states, onState } = stateRecorder();
    const autosave = createAutosave<number>({
      delayMs: 600,
      save,
      onState,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    });

    autosave.schedule(1);
    clock.tick(200);
    autosave.schedule(2);
    clock.tick(200);
    autosave.schedule(3);
    // Not yet 600ms since the last schedule — no save fired.
    clock.tick(599);
    expect(calls).toEqual([]);

    clock.tick(1);
    expect(calls).toEqual([3]);
    expect(states[0]).toEqual({ state: "saving", err: undefined });

    resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(states.at(-1)?.state).toBe("saved");
    expect(calls).toEqual([3]);
  });

  test("single flight + trailing run: a schedule during a save is captured and run once after", async () => {
    const clock = makeClock();
    const { save, calls, resolve } = makeDeferredSave<number>();
    const { states, onState } = stateRecorder();
    const autosave = createAutosave<number>({
      delayMs: 600,
      save,
      onState,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    });

    autosave.schedule(1);
    clock.tick(600);
    expect(calls).toEqual([1]);

    // Two more edits land while the first save is still in flight.
    autosave.schedule(2);
    clock.tick(600);
    autosave.schedule(3);
    clock.tick(600);
    // Still only the original save in flight — no concurrent save started.
    expect(calls).toEqual([1]);

    resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    // Exactly one trailing save, with the newest value — never both 2 and 3.
    expect(calls).toEqual([1, 3]);

    resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(states.map((s) => s.state)).toEqual(["saving", "saved", "saving", "saved"]);
  });

  test("flush runs a pending debounced value immediately and awaits it", async () => {
    const clock = makeClock();
    const { save, calls, resolve } = makeDeferredSave<number>();
    const { onState } = stateRecorder();
    const autosave = createAutosave<number>({
      delayMs: 600,
      save,
      onState,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    });

    autosave.schedule(42);
    // No tick — the debounce timer never fires on its own.
    expect(calls).toEqual([]);

    const flushed = autosave.flush();
    expect(calls).toEqual([42]);
    resolve();
    await flushed;
  });

  test("flush awaits an in-flight save plus any trailing save it queued", async () => {
    const clock = makeClock();
    const { save, calls, resolve } = makeDeferredSave<number>();
    const { onState } = stateRecorder();
    const autosave = createAutosave<number>({
      delayMs: 600,
      save,
      onState,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    });

    autosave.schedule(1);
    clock.tick(600);
    expect(calls).toEqual([1]);
    autosave.schedule(2); // lands mid-flight, restarts the debounce timer

    const flushed = autosave.flush();
    // flush must not leave `2` stranded behind a timer that never fires.
    let settled = false;
    void flushed.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false); // still waiting on the first save

    resolve(); // first save (1) resolves -> trailing save (2) starts
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toEqual([1, 2]);
    expect(settled).toBe(false);

    resolve(); // trailing save resolves
    await flushed;
    expect(settled).toBe(true);
  });

  test("a failed save reports 'failed' with the error and does not retry automatically", async () => {
    const clock = makeClock();
    const { save, calls, reject } = makeDeferredSave<number>();
    const { states, onState } = stateRecorder();
    const autosave = createAutosave<number>({
      delayMs: 600,
      save,
      onState,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    });

    autosave.schedule(7);
    clock.tick(600);
    const boom = new Error("network down");
    reject(boom);
    await Promise.resolve();
    await Promise.resolve();

    expect(states.at(-1)).toEqual({ state: "failed", err: boom });
    expect(calls).toEqual([7]);

    // No automatic retry: advancing the clock does nothing further.
    clock.tick(10_000);
    expect(calls).toEqual([7]);

    // The latest value is still available for the next schedule.
    autosave.schedule(8);
    clock.tick(600);
    expect(calls).toEqual([7, 8]);
  });

  test("cancel drops a pending debounced value without saving it", async () => {
    const clock = makeClock();
    const { save, calls } = makeDeferredSave<number>();
    const { onState } = stateRecorder();
    const autosave = createAutosave<number>({
      delayMs: 600,
      save,
      onState,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    });

    autosave.schedule(1);
    autosave.cancel();
    clock.tick(10_000);
    expect(calls).toEqual([]);

    // A fresh schedule after cancel still works normally.
    autosave.schedule(2);
    clock.tick(600);
    expect(calls).toEqual([2]);
  });
});
