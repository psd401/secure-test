// Batch 3 slice 2: the client's out-of-attempt error drain
// (docs/observability-design.md). Student session required, batch capped,
// messages truncated, `sub` taken from the session and never from the body.
import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { desc, sql } from "drizzle-orm";
import { closeDb, getDb } from "../db/client";
import { client_error_events } from "../db/schema";
import { SESSION_COOKIE_NAME } from "../lib/auth/session";
import * as sessionMod from "../lib/auth/session";
import { setLogSink } from "../lib/log";
import {
  STUDENT,
  TEACHER_EMAIL,
  clearRoster,
  seedRoster,
  staffPrincipal,
  studentPrincipal,
} from "./helpers/roster";

const expectTestDb = () => {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.includes("secure_test_design_tool_test")) {
    throw new Error(`client-errors tests require the test DB; got: ${url}`);
  }
};

type Principal = { sub: string; role: string; email?: string } | null;
let principal: Principal = null;

mock.module("next/headers", () => ({
  headers: async () => new Headers(),
  cookies: async () => ({
    get: (name: string) =>
      principal && name === SESSION_COOKIE_NAME ? { value: "x" } : undefined,
  }),
}));

mock.module("../lib/auth/session", () => ({
  ...sessionMod,
  readSessionFromCookies: async () => principal,
}));

// The route logs one line per batch; swallow it so the suite's output stays
// readable, and restore the real sink when the file is done.
const restoreSink = setLogSink(() => {});

beforeAll(async () => {
  expectTestDb();
  await seedRoster();
});

afterEach(async () => {
  principal = null;
  await getDb().execute(sql`truncate table client_error_events`);
});

afterAll(async () => {
  setLogSink(restoreSink);
  await clearRoster();
  await closeDb();
});

function entry(over: Record<string, unknown> = {}) {
  return {
    kind: "bundle_rejected",
    message: "BUNDLE REJECTED: unknown item type",
    occurred_at: "2026-09-06T18:22:04.000Z",
    app_version: "1.0.0",
    app_commit: "abc1234",
    ...over,
  };
}

async function post(body: unknown) {
  const { POST } = await import("../app/api/client-errors/route");
  return POST(
    new Request("http://localhost/api/client-errors", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

const rows = () =>
  getDb()
    .select()
    .from(client_error_events)
    .orderBy(desc(client_error_events.received_at));

describe("POST /api/client-errors", () => {
  test("stores a batch and answers with the count accepted", async () => {
    principal = studentPrincipal(STUDENT.email);
    const res = await post({
      errors: [entry(), entry({ kind: "signal_SIGABRT", message: "crashed" })],
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ accepted: 2 });

    const stored = await rows();
    expect(stored).toHaveLength(2);
    expect(stored.map((r) => r.kind).sort()).toEqual(["bundle_rejected", "signal_SIGABRT"]);
    const one = stored.find((r) => r.kind === "bundle_rejected")!;
    expect(one.app_version).toBe("1.0.0");
    expect(one.app_commit).toBe("abc1234");
    expect(one.occurred_at.toISOString()).toBe("2026-09-06T18:22:04.000Z");
    // Server-stamped, and independent of the client's clock.
    expect(one.received_at.getTime()).toBeGreaterThan(one.occurred_at.getTime());
  });

  test("sub comes from the session, never from the body", async () => {
    principal = studentPrincipal(STUDENT.email);
    const sub = principal!.sub;
    await post({ errors: [entry({ sub: "somebody-else" })] });
    const stored = await rows();
    expect(stored[0]!.sub).toBe(sub);
  });

  test("keeps a small context bag and replaces one over 4 KB", async () => {
    principal = studentPrincipal(STUDENT.email);
    await post({
      errors: [
        entry({ context: { attempt_id: "11111111-1111-1111-1111-111111111111", retries: 3 } }),
        entry({ kind: "big", context: { blob: "x".repeat(5000) } }),
      ],
    });
    const stored = await rows();
    const small = stored.find((r) => r.kind === "bundle_rejected")!;
    expect(small.context).toEqual({
      attempt_id: "11111111-1111-1111-1111-111111111111",
      retries: 3,
    });
    const big = stored.find((r) => r.kind === "big")!;
    expect(big.context).toEqual({ dropped: "context_too_large" });
  });

  test("truncates a message to 2 000 characters", async () => {
    principal = studentPrincipal(STUDENT.email);
    await post({ errors: [entry({ message: "m".repeat(9000) })] });
    const stored = await rows();
    expect(stored[0]!.message).toHaveLength(2000);
  });

  test("more than 50 entries answers 413 and stores nothing", async () => {
    principal = studentPrincipal(STUDENT.email);
    const res = await post({ errors: Array.from({ length: 51 }, () => entry()) });
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ ok: false, error: "too_many_entries", max: 50 });
    expect(await rows()).toHaveLength(0);
  });

  test("exactly 50 is accepted", async () => {
    principal = studentPrincipal(STUDENT.email);
    const res = await post({ errors: Array.from({ length: 50 }, () => entry()) });
    expect(res.status).toBe(200);
    expect(await rows()).toHaveLength(50);
  });

  test.each([
    ["an empty batch", { errors: [] }],
    ["a missing kind", { errors: [{ ...entry(), kind: undefined }] }],
    ["a non-ISO occurred_at", { errors: [entry({ occurred_at: "yesterday" })] }],
    ["a missing app_commit", { errors: [{ ...entry(), app_commit: undefined }] }],
    ["no errors key at all", { entries: [entry()] }],
  ])("refuses %s with 400 and stores nothing", async (_name, body) => {
    principal = studentPrincipal(STUDENT.email);
    const res = await post(body);
    expect(res.status).toBe(400);
    expect(await rows()).toHaveLength(0);
  });

  test("a staff session answers 403 — this is the student plane", async () => {
    principal = staffPrincipal("some-teacher", TEACHER_EMAIL);
    const res = await post({ errors: [entry()] });
    expect(res.status).toBe(403);
    expect(await rows()).toHaveLength(0);
  });

  test("no session answers 401", async () => {
    principal = null;
    const res = await post({ errors: [entry()] });
    expect(res.status).toBe(401);
    expect(await rows()).toHaveLength(0);
  });
});
