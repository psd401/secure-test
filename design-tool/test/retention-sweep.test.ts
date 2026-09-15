// D-11 (James, 2026-09-15; docs/observability-design.md end): the retention
// sweep over the three observability event tables. `feedback` is explicitly
// out of scope and must be untouched by every case here.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { closeDb, getDb } from "../db/client";
import { client_error_events, feedback, guardrail_events, server_error_events } from "../db/schema";
import { RETENTION_DAYS_DEFAULT, sweepEventTables } from "../lib/retention/sweep";

const expectTestDb = () => {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.includes("secure_test_design_tool_test")) {
    throw new Error(`retention-sweep tests require the test DB; got: ${url}`);
  }
};

const DAY_MS = 24 * 60 * 60 * 1000;
const daysAgo = (now: Date, days: number) => new Date(now.getTime() - days * DAY_MS);

async function seed(now: Date, days: number) {
  const at = daysAgo(now, days);
  const [se] = await getDb()
    .insert(server_error_events)
    .values({
      route: "/api/x",
      method: "GET",
      status: 500,
      message: `server error at ${days}d`,
      created_at: at,
    })
    .returning({ id: server_error_events.id });

  const [ce] = await getDb()
    .insert(client_error_events)
    .values({
      sub: "sub-1",
      app_version: "1.3.1",
      app_commit: "abc123",
      kind: "signin_failed",
      message: `client error at ${days}d`,
      occurred_at: at,
      received_at: at,
    })
    .returning({ id: client_error_events.id });

  const [ge] = await getDb()
    .insert(guardrail_events)
    .values({
      owner_sub: "sub-1",
      surface: "item-gen",
      stage: "input",
      action: "allow",
      provider_id: "mock",
      created_at: at,
    })
    .returning({ id: guardrail_events.id });

  const [fb] = await getDb()
    .insert(feedback)
    .values({
      sub: "sub-1",
      email: "teacher@psd401.net",
      role: "staff",
      path: "/dashboard",
      message: `feedback at ${days}d`,
      created_at: at,
    })
    .returning({ id: feedback.id });

  return { serverErrorId: se!.id, clientErrorId: ce!.id, guardrailEventId: ge!.id, feedbackId: fb!.id };
}

describe("sweepEventTables (D-11)", () => {
  beforeAll(() => expectTestDb());

  afterEach(async () => {
    await getDb().execute(
      sql`truncate table server_error_events, client_error_events, guardrail_events, feedback`,
    );
  });

  afterAll(async () => await closeDb());

  test("deletes rows past the retention window, keeps rows inside it, and never touches feedback", async () => {
    const now = new Date("2026-09-15T12:00:00Z");
    const old = await seed(now, 91);
    const recent = await seed(now, 89);

    const counts = await sweepEventTables(getDb(), now, RETENTION_DAYS_DEFAULT);
    expect(counts).toEqual({ server_error_events: 1, client_error_events: 1, guardrail_events: 1 });

    const remainingServer = await getDb().select().from(server_error_events);
    expect(remainingServer.map((r) => r.id)).toEqual([recent.serverErrorId]);
    expect(remainingServer.map((r) => r.id)).not.toContain(old.serverErrorId);

    const remainingClient = await getDb().select().from(client_error_events);
    expect(remainingClient.map((r) => r.id)).toEqual([recent.clientErrorId]);
    expect(remainingClient.map((r) => r.id)).not.toContain(old.clientErrorId);

    const remainingGuardrail = await getDb().select().from(guardrail_events);
    expect(remainingGuardrail.map((r) => r.id)).toEqual([recent.guardrailEventId]);
    expect(remainingGuardrail.map((r) => r.id)).not.toContain(old.guardrailEventId);

    // feedback is untouched regardless of age — row count unchanged, both
    // the 91-day and the 89-day row survive.
    const remainingFeedback = await getDb().select().from(feedback);
    expect(remainingFeedback.length).toBe(2);
    expect(remainingFeedback.map((r) => r.id).sort()).toEqual(
      [old.feedbackId, recent.feedbackId].sort(),
    );
  });

  test("an empty table sweeps to a zero count, not an error", async () => {
    const counts = await sweepEventTables(getDb(), new Date());
    expect(counts).toEqual({ server_error_events: 0, client_error_events: 0, guardrail_events: 0 });
  });

  test("client_error_events ages off received_at, not the client-stamped occurred_at", async () => {
    const now = new Date("2026-09-15T12:00:00Z");
    // occurred_at (client clock) is old enough to sweep on its own, but
    // received_at (server clock, the trustworthy one) is recent — must
    // survive.
    const [row] = await getDb()
      .insert(client_error_events)
      .values({
        sub: "sub-1",
        app_version: "1.3.1",
        app_commit: "abc123",
        kind: "signin_failed",
        message: "clock skew case",
        occurred_at: daysAgo(now, 200),
        received_at: daysAgo(now, 1),
      })
      .returning({ id: client_error_events.id });

    const counts = await sweepEventTables(getDb(), now, RETENTION_DAYS_DEFAULT);
    expect(counts.client_error_events).toBe(0);
    const remaining = await getDb().select().from(client_error_events);
    expect(remaining.map((r) => r.id)).toEqual([row!.id]);
  });
});
