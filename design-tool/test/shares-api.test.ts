// Slice C (2026-09-01): staff-to-staff sharing with copy semantics.
// Same harness as items-api.test.ts — direct route imports against the
// local test DB with the session helper mocked; here the mock also carries
// the verified email, which is what an offer is addressed to.
import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { closeDb, getDb } from "../db/client";
import { assessment_shares, assessments, items } from "../db/schema";
import { SESSION_COOKIE_NAME } from "../lib/auth/session";
import * as sessionMod from "../lib/auth/session";

const expectTestDb = () => {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.includes("secure_test_design_tool_test")) {
    throw new Error(`shares-api tests require the test DB DATABASE_URL; got: ${url}`);
  }
};

let mockSub: string | null = null;
let mockEmail: string | undefined;

mock.module("next/headers", () => ({
  headers: async () => new Headers(),
  cookies: async () => ({
    get: (name: string) => (mockSub && name === SESSION_COOKIE_NAME ? { value: "x" } : undefined),
  }),
}));

mock.module("../lib/auth/session", () => ({
  ...sessionMod,
  readSessionFromCookies: async () =>
    mockSub ? { sub: mockSub, role: "staff", email: mockEmail } : null,
}));

function asUser(sub: string | null, email?: string) {
  mockSub = sub;
  mockEmail = email;
}

beforeAll(() => {
  expectTestDb();
  process.env.DESIGN_TOOL_SESSION_SECRET ??= "shares-test-secret-shares-test-secret";
});

afterEach(async () => {
  await getDb().execute(sql`TRUNCATE TABLE assessments CASCADE`);
});

afterAll(async () => {
  await closeDb();
});

const OWNER = { sub: "owner-1", email: "owner.one@psd401.net" };
const PEER = { sub: "peer-1", email: "Peer.Two@psd401.net" };

async function createAssessment(name: string) {
  const { POST } = await import("../app/api/assessments/route");
  const res = await POST(
    new Request("http://localhost/api/assessments", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    }),
  );
  expect(res.status).toBe(201);
  return ((await res.json()) as { assessment: { id: string } }).assessment.id;
}

async function createItem(aid: string, body: unknown) {
  const { POST } = await import("../app/api/assessments/[id]/items/route");
  const res = await POST(
    new Request(`http://localhost/api/assessments/${aid}/items`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: aid }) },
  );
  expect(res.status).toBe(201);
}

async function share(aid: string, email: string) {
  const { POST } = await import("../app/api/assessments/[id]/shares/route");
  return POST(
    new Request(`http://localhost/api/assessments/${aid}/shares`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email }),
    }),
    { params: Promise.resolve({ id: aid }) },
  );
}

async function listOwnerShares(aid: string) {
  const { GET } = await import("../app/api/assessments/[id]/shares/route");
  return GET(new Request(`http://localhost/api/assessments/${aid}/shares`), {
    params: Promise.resolve({ id: aid }),
  });
}

async function revoke(aid: string, shareId: string) {
  const { DELETE } = await import("../app/api/assessments/[id]/shares/[shareId]/route");
  return DELETE(new Request(`http://localhost/api/assessments/${aid}/shares/${shareId}`, { method: "DELETE" }), {
    params: Promise.resolve({ id: aid, shareId }),
  });
}

async function myShares() {
  const { GET } = await import("../app/api/shares/route");
  return GET();
}

async function accept(shareId: string) {
  const { POST } = await import("../app/api/shares/[shareId]/accept/route");
  return POST(new Request(`http://localhost/api/shares/${shareId}/accept`, { method: "POST" }), {
    params: Promise.resolve({ shareId }),
  });
}

const MC = {
  type: "multiple_choice_single",
  stem: "What is 2 + 2?",
  choices: [
    { id: "a", text: "3" },
    { id: "b", text: "4" },
  ],
  correct_choice_ids: ["b"],
};

describe("POST /api/assessments/[id]/shares (owner offers)", () => {
  test("staff email → 201, stored lowercased with the sharer's email", async () => {
    asUser(OWNER.sub, OWNER.email);
    const aid = await createAssessment("Unit 1");
    const res = await share(aid, "  Peer.Two@PSD401.net ");
    expect(res.status).toBe(201);
    const body = (await res.json()) as { share: { recipient_email: string; shared_by_email: string } };
    expect(body.share.recipient_email).toBe("peer.two@psd401.net");
    expect(body.share.shared_by_email).toBe(OWNER.email);
  });

  test("non-staff domain → 400 recipient_not_staff", async () => {
    asUser(OWNER.sub, OWNER.email);
    const aid = await createAssessment("x");
    const res = await share(aid, "kid@edtools.psd401.net");
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("recipient_not_staff");
    const res2 = await share(aid, "someone@gmail.com");
    expect(res2.status).toBe(400);
  });

  test("own address → 400; malformed → 400; duplicate → 409", async () => {
    asUser(OWNER.sub, OWNER.email);
    const aid = await createAssessment("x");
    expect((await share(aid, OWNER.email)).status).toBe(400);
    expect((await share(aid, "not-an-email")).status).toBe(400);
    expect((await share(aid, PEER.email)).status).toBe(201);
    const dup = await share(aid, PEER.email.toLowerCase());
    expect(dup.status).toBe(409);
    expect(((await dup.json()) as { error: string }).error).toBe("already_shared");
  });

  test("session without an email cannot share (400 session_missing_email)", async () => {
    asUser(OWNER.sub, undefined);
    const aid = await createAssessment("x");
    const res = await share(aid, PEER.email);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("session_missing_email");
  });

  test("a non-owner cannot share or list someone else's assessment", async () => {
    asUser(OWNER.sub, OWNER.email);
    const aid = await createAssessment("x");
    asUser(PEER.sub, PEER.email);
    expect((await share(aid, "third@psd401.net")).status).toBe(403);
    expect((await listOwnerShares(aid)).status).toBe(403);
  });
});

describe("recipient flow: list, accept (copy), idempotency, revoke", () => {
  test("the offer shows on the recipient's list and accept makes an independent copy", async () => {
    asUser(OWNER.sub, OWNER.email);
    const aid = await createAssessment("Shared quiz");
    await createItem(aid, MC);
    await createItem(aid, { type: "short_text", stem: "Capital of WA?", correct_answer: "Olympia" });
    await createItem(aid, { ...MC, stem: "Keyless one", correct_choice_ids: [] });
    const created = await share(aid, PEER.email);
    const shareId = ((await created.json()) as { share: { id: string } }).share.id;

    asUser(PEER.sub, PEER.email);
    const listed = (await (await myShares()).json()) as {
      shares: { id: string; assessment_name: string; shared_by_email: string; copied_assessment_id: string | null }[];
    };
    expect(listed.shares).toHaveLength(1);
    expect(listed.shares[0]!.id).toBe(shareId);
    expect(listed.shares[0]!.assessment_name).toBe("Shared quiz");
    expect(listed.shares[0]!.shared_by_email).toBe(OWNER.email);
    expect(listed.shares[0]!.copied_assessment_id).toBeNull();

    const acc = await accept(shareId);
    expect(acc.status).toBe(200);
    const body = (await acc.json()) as { ok: boolean; assessment_id: string; already_added: boolean };
    expect(body.ok).toBe(true);
    expect(body.already_added).toBe(false);
    expect(body.assessment_id).not.toBe(aid);

    const db = getDb();
    const [copy] = await db.select().from(assessments).where(eq(assessments.id, body.assessment_id));
    expect(copy!.owner_sub).toBe(PEER.sub);
    expect(copy!.name).toBe("Shared quiz");
    expect(copy!.status).toBe("draft");
    const copiedItems = await db.select().from(items).where(eq(items.assessment_id, body.assessment_id));
    expect(copiedItems).toHaveLength(3);
    expect(copiedItems.map((i) => i.stem).sort()).toEqual(["Capital of WA?", "Keyless one", "What is 2 + 2?"]);
    const [source] = await db.select().from(assessments).where(eq(assessments.id, aid));
    expect(source!.owner_sub).toBe(OWNER.sub);

    const [row] = await db.select().from(assessment_shares).where(eq(assessment_shares.id, shareId));
    expect(row!.accepted_at).not.toBeNull();
    expect(row!.copied_assessment_id).toBe(body.assessment_id);

    // Second accept returns the same copy instead of making another.
    const again = (await (await accept(shareId)).json()) as { assessment_id: string; already_added: boolean };
    expect(again.already_added).toBe(true);
    expect(again.assessment_id).toBe(body.assessment_id);
    const peerAssessments = await db.select().from(assessments).where(eq(assessments.owner_sub, PEER.sub));
    expect(peerAssessments).toHaveLength(1);
  });

  test("only the addressed recipient can accept", async () => {
    asUser(OWNER.sub, OWNER.email);
    const aid = await createAssessment("x");
    const shareId = ((await (await share(aid, PEER.email)).json()) as { share: { id: string } }).share.id;
    asUser("stranger", "stranger@psd401.net");
    expect((await accept(shareId)).status).toBe(403);
    asUser(OWNER.sub, OWNER.email);
    expect((await accept(shareId)).status).toBe(403);
    expect((await myShares()).status).toBe(200);
    expect(((await (await myShares()).json()) as { shares: unknown[] }).shares).toHaveLength(0);
  });

  test("owner can withdraw an offer; the recipient's existing copy survives", async () => {
    asUser(OWNER.sub, OWNER.email);
    const aid = await createAssessment("x");
    await createItem(aid, MC);
    const shareId = ((await (await share(aid, PEER.email)).json()) as { share: { id: string } }).share.id;
    asUser(PEER.sub, PEER.email);
    const copyId = ((await (await accept(shareId)).json()) as { assessment_id: string }).assessment_id;
    asUser(OWNER.sub, OWNER.email);
    expect((await revoke(aid, shareId)).status).toBe(200);
    expect((await revoke(aid, shareId)).status).toBe(404);
    const db = getDb();
    const [copy] = await db.select().from(assessments).where(eq(assessments.id, copyId));
    expect(copy!.owner_sub).toBe(PEER.sub);
    asUser(PEER.sub, PEER.email);
    expect(((await (await myShares()).json()) as { shares: unknown[] }).shares).toHaveLength(0);
  });

  test("deleting the source removes the offer (cascade) but not an accepted copy", async () => {
    asUser(OWNER.sub, OWNER.email);
    const aid = await createAssessment("x");
    const shareId = ((await (await share(aid, PEER.email)).json()) as { share: { id: string } }).share.id;
    asUser(PEER.sub, PEER.email);
    const copyId = ((await (await accept(shareId)).json()) as { assessment_id: string }).assessment_id;
    const db = getDb();
    await db.delete(assessments).where(eq(assessments.id, aid));
    expect(await db.select().from(assessment_shares).where(eq(assessment_shares.id, shareId))).toHaveLength(0);
    expect(await db.select().from(assessments).where(eq(assessments.id, copyId))).toHaveLength(1);
  });
});
