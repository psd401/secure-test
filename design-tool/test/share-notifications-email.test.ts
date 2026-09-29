// Share notifications (docs/share-notifications-design.md), slice 2: the email
// sent on a share offer and on a co-teach grant — mock provider, same route
// harness as shares-api.test.ts / grants-api.test.ts.
import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { sql } from "drizzle-orm";
import { closeDb, getDb } from "../db/client";
import { assessments } from "../db/schema";
import { SESSION_COOKIE_NAME } from "../lib/auth/session";
import * as sessionMod from "../lib/auth/session";
import { mockEmailProvider, resetMockEmails, sentEmails } from "../lib/email/mockProvider";
import { buildShareEmail, sendShareEmail } from "../lib/email/shareNotifications";
import { setLogSink } from "../lib/log";

const OWNER = { sub: "sn-mail-owner", email: "lead@psd401.net" };
const PEER = "peer@psd401.net";

let current: { sub: string; email: string } | null = null;

mock.module("next/headers", () => ({
  headers: async () => new Headers(),
  cookies: async () => ({
    get: (name: string) => (current && name === SESSION_COOKIE_NAME ? { value: "x" } : undefined),
  }),
}));

mock.module("../lib/auth/session", () => ({
  ...sessionMod,
  readSessionFromCookies: async () =>
    current ? { sub: current.sub, role: "staff", email: current.email } : null,
}));

beforeAll(() => {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.includes("secure_test_design_tool_test")) {
    throw new Error(`share-notifications-email tests require the test DB; got: ${url}`);
  }
  process.env.DESIGN_TOOL_SESSION_SECRET ??= "test-session-secret-do-not-use";
});

afterEach(async () => {
  const db = getDb();
  await db.execute(sql`truncate table access_grants restart identity cascade`);
  await db.execute(sql`truncate table assessments restart identity cascade`);
  resetMockEmails();
  current = null;
  delete process.env.EMAIL_PROVIDER;
});

afterAll(async () => {
  await closeDb();
});

async function makeAssessment(name = "Unit 3 essay") {
  const [row] = await getDb()
    .insert(assessments)
    .values({ owner_sub: OWNER.sub, owner_email: OWNER.email, name })
    .returning();
  return row!;
}

function post(url: string, body: unknown) {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function share(id: string, email: string) {
  const { POST } = await import("../app/api/assessments/[id]/shares/route");
  return POST(post(`http://localhost/api/assessments/${id}/shares`, { email }), {
    params: Promise.resolve({ id }),
  });
}

async function coTeach(id: string, grantee_email: string) {
  const { POST } = await import("../app/api/assessments/[id]/grants/route");
  return POST(
    post(`http://localhost/api/assessments/${id}/grants`, { grantee_email, level: "edit", note: "co-teacher" }),
    { params: Promise.resolve({ id }) },
  );
}

describe("buildShareEmail", () => {
  test("share: reply goes to the sharer; name and link in the body", () => {
    const m = buildShareEmail({
      kind: "share",
      to: PEER,
      sharerEmail: OWNER.email,
      assessmentName: "Unit 3\r\nessay",
      link: "https://example.test/dashboard",
    });
    expect(m.to).toBe(PEER);
    expect(m.replyTo).toBe(OWNER.email);
    expect(m.subject).toBe(`${OWNER.email} shared "Unit 3 essay" with you`);
    expect(m.text).toContain("https://example.test/dashboard");
    expect(m.text).toContain("your own copy");
  });

  test("co-teach: its own subject", () => {
    const m = buildShareEmail({
      kind: "co_teach",
      to: PEER,
      sharerEmail: OWNER.email,
      assessmentName: "Unit 3 essay",
      link: "https://example.test/dashboard/x",
    });
    expect(m.subject).toBe(`${OWNER.email} added you as a co-teacher on "Unit 3 essay"`);
    expect(m.replyTo).toBe(OWNER.email);
  });
});

describe("routes send one email per new share or grant", () => {
  test("share → one email to the recipient; duplicate sends nothing", async () => {
    current = OWNER;
    const a = await makeAssessment();
    expect((await share(a.id, " Peer@PSD401.net ")).status).toBe(201);
    expect(sentEmails).toHaveLength(1);
    expect(sentEmails[0]!.to).toBe(PEER);
    expect(sentEmails[0]!.replyTo).toBe(OWNER.email);
    expect(sentEmails[0]!.text).toMatch(/\/dashboard$/m);

    expect((await share(a.id, PEER)).status).toBe(409);
    expect(sentEmails).toHaveLength(1);
  });

  test("a refused share (not staff) sends nothing", async () => {
    current = OWNER;
    const a = await makeAssessment();
    expect((await share(a.id, "kid@edtools.psd401.net")).status).toBe(400);
    expect(sentEmails).toHaveLength(0);
  });

  test("co-teach → one email linking to the editor; duplicate sends nothing", async () => {
    current = OWNER;
    const a = await makeAssessment();
    expect((await coTeach(a.id, PEER)).status).toBe(201);
    expect(sentEmails).toHaveLength(1);
    expect(sentEmails[0]!.subject).toContain("co-teacher");
    expect(sentEmails[0]!.text).toContain(`/dashboard/${a.id}`);

    expect((await coTeach(a.id, PEER)).status).toBe(409);
    expect(sentEmails).toHaveLength(1);
  });

  test("a send failure is logged and the share still succeeds", async () => {
    current = OWNER;
    const a = await makeAssessment();
    const original = mockEmailProvider.send;
    const lines: string[] = [];
    const previousSink = setLogSink((line) => lines.push(line));
    (mockEmailProvider as { send: typeof original }).send = async () => {
      throw new Error("ses down");
    };
    try {
      expect((await share(a.id, PEER)).status).toBe(201);
    } finally {
      (mockEmailProvider as { send: typeof original }).send = original;
      setLogSink(previousSink);
    }
    expect(lines.some((l) => l.includes("share_email_failed") && l.includes("ses down"))).toBe(true);
  });

  test("an unknown provider is logged, never thrown", async () => {
    process.env.EMAIL_PROVIDER = "nope";
    const lines: string[] = [];
    const previousSink = setLogSink((line) => lines.push(line));
    try {
      await sendShareEmail({ kind: "share", to: PEER, sharerEmail: OWNER.email, assessmentName: "x", link: "l" });
    } finally {
      setLogSink(previousSink);
    }
    expect(lines.some((l) => l.includes("share_email_failed"))).toBe(true);
  });
});
