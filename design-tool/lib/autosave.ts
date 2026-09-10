// Multi-source stimulus finding C-6 / decision D-8
// (docs/multi-source-stimulus-design.md): the Accommodations tab only
// persisted on an explicit "Save accommodations" click, so a teacher who
// ticked boxes and navigated away lost the change with no signal. This is a
// small, dependency-free debounced-autosave primitive: schedule(value)
// restarts a debounce timer; when it fires, at most one save is in flight at
// a time; a schedule that lands mid-flight is captured and re-run once as a
// single trailing save with the newest value (never two concurrent saves,
// never a stale value winning a race). Timers are injectable so tests can
// drive it without real waits.
export type AutosaveState = "idle" | "saving" | "saved" | "failed";

export interface CreateAutosaveOptions<T> {
  delayMs: number;
  save: (value: T) => Promise<void>;
  onState: (state: AutosaveState, err?: unknown) => void;
  setTimeout?: (fn: () => void, ms: number) => ReturnType<typeof globalThis.setTimeout>;
  clearTimeout?: (handle: ReturnType<typeof globalThis.setTimeout>) => void;
}

export interface Autosave<T> {
  /** Replace the pending value and restart the debounce timer. */
  schedule(value: T): void;
  /** Run any pending value immediately and await it (plus any in-flight / trailing save). */
  flush(): Promise<void>;
  /** Drop the pending debounced value without saving it. Does not affect a save already in flight. */
  cancel(): void;
}

export function createAutosave<T>({
  delayMs,
  save,
  onState,
  setTimeout: scheduleTimeout = globalThis.setTimeout.bind(globalThis),
  clearTimeout: cancelTimeout = globalThis.clearTimeout.bind(globalThis),
}: CreateAutosaveOptions<T>): Autosave<T> {
  let timer: ReturnType<typeof globalThis.setTimeout> | null = null;
  let pendingValue: T | undefined;

  let flightInProgress = false;
  let activePromise: Promise<void> = Promise.resolve();

  let trailingRequested = false;
  let trailingValue: T | undefined;

  function startFlight(value: T): Promise<void> {
    flightInProgress = true;
    onState("saving");
    const p = save(value).then(
      () => {
        flightInProgress = false;
        onState("saved");
        return runTrailingIfAny();
      },
      (err: unknown) => {
        flightInProgress = false;
        onState("failed", err);
        return runTrailingIfAny();
      },
    );
    activePromise = p;
    return p;
  }

  function runTrailingIfAny(): Promise<void> | void {
    if (trailingRequested) {
      trailingRequested = false;
      const value = trailingValue as T;
      trailingValue = undefined;
      return startFlight(value);
    }
  }

  function fire() {
    timer = null;
    const value = pendingValue as T;
    pendingValue = undefined;
    if (flightInProgress) {
      trailingRequested = true;
      trailingValue = value;
      return;
    }
    startFlight(value);
  }

  return {
    schedule(value: T) {
      pendingValue = value;
      if (timer !== null) cancelTimeout(timer);
      timer = scheduleTimeout(fire, delayMs);
    },
    async flush() {
      if (timer !== null) {
        cancelTimeout(timer);
        timer = null;
        fire();
      }
      await activePromise;
    },
    cancel() {
      if (timer !== null) {
        cancelTimeout(timer);
        timer = null;
      }
      pendingValue = undefined;
    },
  };
}
