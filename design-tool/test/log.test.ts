// Batch 3 slice 2: the JSON-lines logger's shape — one line per call, `level`
// and `event` always present, undefined fields dropped, free text capped.
import { afterEach, describe, expect, test } from "bun:test";
import { LOG_TEXT_MAX, log, routeOf, setLogSink, truncate } from "../lib/log";

let lines: string[] = [];
const restore = setLogSink((line) => lines.push(line));

afterEach(() => {
  lines = [];
});

// Put the real sink back once the file is done so a later test file that
// happens to log does not write into this array.
process.on("exit", () => setLogSink(restore));

function only(): Record<string, unknown> {
  expect(lines).toHaveLength(1);
  return JSON.parse(lines[0]!) as Record<string, unknown>;
}

describe("log", () => {
  test("writes one JSON object per call with level and event first", () => {
    log.error("request_error", { route: "/dashboard", status: 500 });
    const line = only();
    expect(line).toEqual({
      level: "error",
      event: "request_error",
      route: "/dashboard",
      status: 500,
    });
    expect(Object.keys(line).slice(0, 2)).toEqual(["level", "event"]);
  });

  test("each level is its own line and its own level value", () => {
    log.warn("client_errors_received", { count: 3 });
    log.info("started", {});
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!).level).toBe("warn");
    expect(JSON.parse(lines[1]!)).toEqual({ level: "info", event: "started" });
  });

  test("undefined fields are dropped rather than serialised", () => {
    log.error("request_error", { route: "/x", digest: undefined, sub: undefined });
    expect(only()).toEqual({ level: "error", event: "request_error", route: "/x" });
  });

  test("an unserialisable field degrades to a marker instead of throwing", () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(() => log.error("request_error", { cycle })).not.toThrow();
    expect(only()).toEqual({
      level: "error",
      event: "request_error",
      log_error: "unserialisable_fields",
    });
  });
});

describe("the redaction helpers", () => {
  test("routeOf drops the query string and the fragment", () => {
    expect(routeOf("/dashboard/abc")).toBe("/dashboard/abc");
    expect(routeOf("/dashboard?student=Ada&q=secret")).toBe("/dashboard");
    expect(routeOf("/preview/1#frag")).toBe("/preview/1");
    expect(routeOf("/a?b#c")).toBe("/a");
  });

  test("truncate caps at the contract's ceiling and marks the cut", () => {
    expect(truncate("short")).toBe("short");
    const long = "x".repeat(LOG_TEXT_MAX + 500);
    const cut = truncate(long);
    expect(cut).toHaveLength(LOG_TEXT_MAX);
    expect(cut.endsWith("…")).toBe(true);
    expect(truncate("abcdef", 3)).toBe("ab…");
  });
});
