// Batch 3 slice 2: `onRequestError`'s body — one log line and one row per
// unhandled server error, joined by the request id, and never a body, a query
// string or a header value in either.
//
// No database here: the writer is injected, which is the whole reason
// `recordServerError` lives apart from `instrumentation.ts`.
import { afterEach, describe, expect, test } from "bun:test";
import { setLogSink } from "../lib/log";
import {
  hashStack,
  recordServerError,
  requestIdFrom,
  type ServerErrorRequest,
} from "../lib/observability/serverError";
import { REQUEST_ID_HEADER } from "../lib/observability/requestId";
import type { ServerErrorEventInsert } from "../db/schema";

let lines: Record<string, unknown>[] = [];
const restore = setLogSink((line) => lines.push(JSON.parse(line)));
process.on("exit", () => setLogSink(restore));

let rows: ServerErrorEventInsert[] = [];
const writeRow = async (row: ServerErrorEventInsert) => {
  rows.push(row);
};
// The session lookup is a JWT verify against an env secret in real life; here
// it is the injected seam, so the tests say who is signed in directly.
const noSub = async () => null;

afterEach(() => {
  lines = [];
  rows = [];
});

function request(over: Partial<ServerErrorRequest> = {}): ServerErrorRequest {
  return {
    path: "/dashboard/abc",
    method: "GET",
    headers: { [REQUEST_ID_HEADER]: "req-1" },
    ...over,
  };
}

describe("recordServerError", () => {
  test("writes one error line and one row carrying the same fields", async () => {
    const err = Object.assign(new Error("boom"), { digest: "1234567890" });
    await recordServerError(err, request(), { routePath: "/dashboard/[id]", routeType: "render" }, {
      writeRow,
      resolveSub: async () => "google-sub-1",
    });

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      level: "error",
      event: "request_error",
      route: "/dashboard/abc",
      method: "GET",
      status: 500,
      digest: "1234567890",
      message: "boom",
      request_id: "req-1",
      sub: "google-sub-1",
      route_path: "/dashboard/[id]",
      route_type: "render",
    });
    expect(typeof lines[0]!.stack_hash).toBe("string");

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      request_id: "req-1",
      route: "/dashboard/abc",
      method: "GET",
      status: 500,
      digest: "1234567890",
      message: "boom",
      sub: "google-sub-1",
    });
    expect(rows[0]!.stack_hash).toBe(lines[0]!.stack_hash as string);
    expect(rows[0]!.stack).toContain("Error: boom");
  });

  test("the query string never reaches the line or the row", async () => {
    await recordServerError(
      new Error("boom"),
      request({ path: "/dashboard?student=Ada&token=abc" }),
      {},
      { writeRow, resolveSub: noSub },
    );
    expect(lines[0]!.route).toBe("/dashboard");
    expect(rows[0]!.route).toBe("/dashboard");
    expect(JSON.stringify(lines[0])).not.toContain("Ada");
    expect(JSON.stringify(rows[0])).not.toContain("token=abc");
  });

  test("a non-Error throw is described, never serialised", async () => {
    await recordServerError({ body: { answer: "42" } }, request(), {}, {
      writeRow,
      resolveSub: noSub,
    });
    expect(rows[0]!.message).toBe("non-error thrown: [object Object]");
    expect(JSON.stringify(rows[0])).not.toContain("42");
    expect(rows[0]!.stack).toBeNull();
    expect(rows[0]!.digest).toBeNull();
  });

  test("a message and a stack longer than the ceiling are truncated", async () => {
    const err = new Error("m".repeat(5000));
    err.stack = "s".repeat(9000);
    await recordServerError(err, request(), {}, { writeRow, resolveSub: noSub });
    expect(rows[0]!.message!.length).toBe(2000);
    expect(rows[0]!.stack!.length).toBe(2000);
  });

  test("a failing row write is swallowed and logged, never rethrown", async () => {
    await expect(
      recordServerError(new Error("boom"), request(), {}, {
        writeRow: async () => {
          throw new Error("connection refused");
        },
        resolveSub: noSub,
      }),
    ).resolves.toBeUndefined();

    expect(lines.map((l) => l.event)).toEqual(["request_error", "request_error_not_recorded"]);
    expect(lines[1]).toMatchObject({ request_id: "req-1", reason: "connection refused" });
  });

  test("a session lookup that throws still produces the line and the row", async () => {
    await recordServerError(new Error("boom"), request(), {}, {
      writeRow,
      resolveSub: async () => {
        throw new Error("no secret");
      },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.sub).toBeNull();
  });
});

describe("requestIdFrom", () => {
  test("prefers x-request-id, falls back to the ALB trace header, else null", () => {
    expect(requestIdFrom({ "x-request-id": "a", "x-amzn-trace-id": "b" })).toBe("a");
    expect(requestIdFrom({ "x-amzn-trace-id": "Root=1-abc" })).toBe("Root=1-abc");
    expect(requestIdFrom({})).toBeNull();
    expect(requestIdFrom({ "x-request-id": ["a", "b"] })).toBe("a");
  });
});

describe("hashStack", () => {
  test("two throws from the same line hash alike; a different one does not", () => {
    const a = hashStack("Error: x\n    at f (/app/lib/a.ts:10:5)\n    at g (/app/lib/b.ts:2:1)");
    const b = hashStack("Error: x\n    at f (/other/root/lib/a.ts:10:9)\n    at g (/other/root/lib/b.ts:2:4)");
    const c = hashStack("Error: x\n    at h (/app/lib/c.ts:10:5)");
    expect(a).toBe(b!);
    expect(a).not.toBe(c!);
    expect(a).toHaveLength(16);
    expect(hashStack(null)).toBeNull();
  });
});
