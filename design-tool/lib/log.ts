/**
 * Batch 3 slice 2 (docs/observability-design.md): the app's structured log.
 *
 * One JSON object per line on stdout, which is what the `awslogs` driver ships
 * to CloudWatch and what a metric filter can match on (`{ $.level = "error" }`
 * → alarm → the SNS topic, slice 1). The shape is deliberately the roster
 * importer's `consoleJsonLogger` shape — `event` plus flat fields — with a
 * `level` added, so the two sinks read the same in one log group.
 *
 * REDACTION CONTRACT. A log line may carry: `sub`, uuids (attempt, item,
 * assessment), route paths, HTTP methods and status codes, error digests,
 * counts, durations, messages and stacks truncated to 2 000 characters, and
 * stack hashes. It may NEVER carry: a request or response body, a query
 * string, a header (so never a cookie or a bearer token), response text, an
 * item stem or its choices, or a student's name or email. The rule is not
 * enforceable by types — every caller is responsible for what it passes — so
 * `redact()` below is offered for the two mechanical cases (dropping a query
 * string from a path, truncating free text) and the rest is review.
 */

/** Free-text ceiling, matching `OBSERVABILITY_TEXT_MAX` in db/schema.ts. */
export const LOG_TEXT_MAX = 2000;

export type LogLevel = "error" | "warn" | "info";

export interface LogFields {
  [key: string]: unknown;
}

export interface LogLine extends LogFields {
  level: LogLevel;
  event: string;
}

/** The sink. Injectable so tests can capture lines without touching stdout. */
export type LogSink = (line: string) => void;

let sink: LogSink = (line) => {
  // One `console.log` for every level: CloudWatch has no stderr/stdout
  // distinction worth the split, and `level` is the field a filter reads.
  console.log(line);
};

/** Test seam. Returns the previous sink so a caller can restore it. */
export function setLogSink(next: LogSink): LogSink {
  const previous = sink;
  sink = next;
  return previous;
}

/** Cuts free text to the contract's ceiling, marking that it was cut. */
export function truncate(value: string, max: number = LOG_TEXT_MAX): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

/** Path without its query string — the only part of a URL that may be logged. */
export function routeOf(pathOrUrl: string): string {
  const q = pathOrUrl.indexOf("?");
  const h = pathOrUrl.indexOf("#");
  const cut = [q, h].filter((i) => i >= 0).sort((a, b) => a - b)[0];
  return cut === undefined ? pathOrUrl : pathOrUrl.slice(0, cut);
}

function emit(level: LogLevel, event: string, fields: LogFields = {}): void {
  // `level` and `event` are written first so a line is readable unparsed, and
  // `undefined` fields are dropped rather than serialised as nothing useful.
  const line: LogLine = { level, event };
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    line[key] = value;
  }
  try {
    sink(JSON.stringify(line));
  } catch {
    // A field that cannot be serialised (a cycle, a BigInt) must not turn a
    // logged error into a thrown one.
    sink(JSON.stringify({ level, event, log_error: "unserialisable_fields" }));
  }
}

export const log = {
  error: (event: string, fields?: LogFields) => emit("error", event, fields),
  warn: (event: string, fields?: LogFields) => emit("warn", event, fields),
  info: (event: string, fields?: LogFields) => emit("info", event, fields),
};
