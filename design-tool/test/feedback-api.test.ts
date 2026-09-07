// Batch 3 slice 3: "Send feedback" from the teacher header
// (docs/observability-design.md). Staff session required, the row is the
// record, the SNS publish is best-effort and never fails the request.
import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { desc, sql } from "drizzle-orm";
import { closeDb, getDb } from "../db/client";
import { feedback } from "../db/schema";
import { SESSION_COOKIE_NAME } from "../lib/auth/session";
import * as sessionMod from "../lib/auth/session";
import { setLogSink } from "../lib/log";
import { mockNotifyProvider, notifications, resetMockNotifications } from "../lib/notify/mockProvider";
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
    throw new Error(`feedback tests require the test DB; got: ${url}`);
  }
};

type Principal = { sub: string; role: string; email?: string } | null;
let principal: Principal = null;
let userAgent: string | null = "TestAgent/1.0";

mock.module("next/headers", () => ({
  headers: async () =>
    new Headers(userAgent ? { "user-agent": userAgent } : {}),
  cookies: async () => ({
    get: (name: string) =>
      principal && name === SESSION_COOKIE_NAME ? { value: "x" } : undefined,
  }),
}));

mock.module("../lib/auth/session", () => ({
  ...sessionMod,
  readSessionFromCookies: async () => principal,
}));

// The route publishes and may log a warning on a stubbed failure; capture the
// lines instead of letting them hit stdout, and restore the real sink after.
const restoreSink = setLogSink(() => {});
const logged: Array<Record<string, unknown>> = [];
setLogSink((line) => logged.push(JSON.parse(line)));

beforeAll(async () => {
  expectTestDb();
  await seedRoster();
});

afterEach(async () => {
  principal = null;
  userAgent = "TestAgent/1.0";
  logged.length = 0;
  resetMockNotifications();
  await getDb().execute(sql`truncate table feedback`);
});

afterAll(async () => {
  setLogSink(restoreSink);
  await clearRoster();
  await closeDb();
});

function body(over: Record<string, unknown> = {}) {
  return { message: "The publish button did nothing.", path: "/dashboard/abc", ...over };
}

async function post(payload: unknown) {
  const { POST } = await import("../app/api/feedback/route");
  return POST(
    new Request("http://localhost/api/feedback", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    }),
  );
}

const rows = () => getDb().select().from(feedback).orderBy(desc(feedback.created_at));

describe("POST /api/feedback", () => {
  test("stores a row from the session's sub/email/role and publishes", async () => {
    principal = staffPrincipal("teacher-sub-1", TEACHER_EMAIL);
    const res = await post(body());
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; id: string };
    expect(json.ok).toBe(true);
    expect(json.id).toBeTruthy();

    const stored = await rows();
    expect(stored).toHaveLength(1);
    expect(stored[0]!.sub).toBe("teacher-sub-1");
    expect(stored[0]!.email).toBe(TEACHER_EMAIL);
    expect(stored[0]!.role).toBe("staff");
    expect(stored[0]!.path).toBe("/dashboard/abc");
    expect(stored[0]!.message).toBe("The publish button did nothing.");
    expect(stored[0]!.user_agent).toBe("TestAgent/1.0");

    expect(notifications).toHaveLength(1);
    expect(notifications[0]!.subject).toBe("[secure-test] Feedback from staff");
    expect(notifications[0]!.body).toContain(TEACHER_EMAIL);
    expect(notifications[0]!.body).toContain("/dashboard/abc");
    expect(notifications[0]!.body).toContain("The publish button did nothing.");
    // Nothing else sensitive: no cookie/token/header value, no other student's
    // identifier, and the redaction contract's forbidden fields are absent.
    expect(notifications[0]!.body).not.toContain("Bearer");
    expect(notifications[0]!.body).not.toContain(SESSION_COOKIE_NAME);
  });

  test("empty message is rejected", async () => {
    principal = staffPrincipal("teacher-sub-1", TEACHER_EMAIL);
    const res = await post(body({ message: "   " }));
    expect(res.status).toBe(400);
    expect(await rows()).toHaveLength(0);
    expect(notifications).toHaveLength(0);
  });

  test("a message over 2000 characters is rejected", async () => {
    principal = staffPrincipal("teacher-sub-1", TEACHER_EMAIL);
    const res = await post(body({ message: "m".repeat(2001) }));
    expect(res.status).toBe(400);
    expect(await rows()).toHaveLength(0);
  });

  test("a missing path is rejected", async () => {
    principal = staffPrincipal("teacher-sub-1", TEACHER_EMAIL);
    const res = await post({ message: "hello" });
    expect(res.status).toBe(400);
    expect(await rows()).toHaveLength(0);
  });

  test("a student session gets 403 and nothing is stored", async () => {
    principal = studentPrincipal(STUDENT.email);
    const res = await post(body());
    expect(res.status).toBe(403);
    expect(await rows()).toHaveLength(0);
    expect(notifications).toHaveLength(0);
  });

  test("no session answers 401", async () => {
    principal = null;
    const res = await post(body());
    expect(res.status).toBe(401);
    expect(await rows()).toHaveLength(0);
  });

  test("a throwing publisher still yields 200 and logs feedback_publish_failed", async () => {
    principal = staffPrincipal("teacher-sub-1", TEACHER_EMAIL);
    const originalPublish = mockNotifyProvider.publish;
    mockNotifyProvider.publish = async () => {
      throw new Error("sns down");
    };
    try {
      const res = await post(body());
      expect(res.status).toBe(200);
      const json = (await res.json()) as { ok: boolean; id: string };
      expect(json.ok).toBe(true);

      const stored = await rows();
      expect(stored).toHaveLength(1);

      const failure = logged.find((l) => l.event === "feedback_publish_failed");
      expect(failure).toBeTruthy();
      expect(failure!.sub).toBe("teacher-sub-1");
    } finally {
      mockNotifyProvider.publish = originalPublish;
    }
  });

  test("mock publisher records calls", async () => {
    resetMockNotifications();
    await mockNotifyProvider.publish("subject", "body text");
    expect(notifications).toEqual([{ subject: "subject", body: "body text" }]);
  });
});
