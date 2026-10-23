// Finding OE-1 (2026-10-22): the New assessment form never wrote
// `assessments.owner_email`, so roster co-teacher suggestions and
// teacher-scope grants found nothing for those assessments. The form now
// writes it, and the owner opening an older one fills it.
import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { closeDb, getDb } from "../db/client";
import { assessments } from "../db/schema";
import * as sessionMod from "../lib/auth/session";
import { healAssessmentOwnerEmail } from "../lib/api/grants";

const expectTestDb = () => {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.includes("secure_test_design_tool_test")) {
    throw new Error(`owner-email-heal tests require the test DB DATABASE_URL; got: ${url}`);
  }
};

let mockSession: { sub: string; role: "staff"; email: string } | null = null;

mock.module("../lib/auth/session", () => ({
  ...sessionMod,
  readStaffSessionFromCookies: async () => mockSession,
}));

class Redirected extends Error {
  constructor(public url: string) {
    super(`redirect ${url}`);
  }
}
mock.module("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Redirected(url);
  },
}));

beforeAll(() => {
  expectTestDb();
});

afterEach(async () => {
  await getDb().execute(sql`TRUNCATE TABLE assessments CASCADE`);
});

afterAll(async () => {
  await closeDb();
});

const OWNER = { sub: "owner-oe1", email: "Owner.One@psd401.net" };

async function insertAssessment(ownerEmail: string | null) {
  const [row] = await getDb()
    .insert(assessments)
    .values({ owner_sub: OWNER.sub, owner_email: ownerEmail, name: "OE-1" })
    .returning({ id: assessments.id });
  return row!.id;
}

async function ownerEmailOf(id: string) {
  const [row] = await getDb()
    .select({ owner_email: assessments.owner_email })
    .from(assessments)
    .where(eq(assessments.id, id));
  return row!.owner_email;
}

describe("New assessment form (OE-1)", () => {
  test("writes the creator's normalized email as owner_email", async () => {
    mockSession = { sub: OWNER.sub, role: "staff", email: OWNER.email };
    const { createAssessment } = await import("../app/dashboard/new/actions");
    const form = new FormData();
    form.set("name", "Made from the form");
    let target = "";
    try {
      await createAssessment({ fieldErrors: {}, values: { name: "", description: "" } } as never, form);
    } catch (err) {
      if (!(err instanceof Redirected)) throw err;
      target = err.url;
    }
    const id = target.replace("/dashboard/", "");
    expect(target).toStartWith("/dashboard/");
    expect(await ownerEmailOf(id)).toBe("owner.one@psd401.net");
  });
});

describe("healAssessmentOwnerEmail (OE-1)", () => {
  test("the owner opening a null-owner_email assessment fills it", async () => {
    const id = await insertAssessment(null);
    await healAssessmentOwnerEmail(getDb(), OWNER, id);
    expect(await ownerEmailOf(id)).toBe("owner.one@psd401.net");
  });

  test("anyone but the owner leaves it null", async () => {
    const id = await insertAssessment(null);
    await healAssessmentOwnerEmail(getDb(), { sub: "someone-else", email: "other@psd401.net" }, id);
    expect(await ownerEmailOf(id)).toBeNull();
  });

  test("an act-as session leaves it null", async () => {
    const id = await insertAssessment(null);
    await healAssessmentOwnerEmail(getDb(), { ...OWNER, actor_sub: "admin-1" }, id);
    expect(await ownerEmailOf(id)).toBeNull();
  });

  test("never overwrites an existing value", async () => {
    const id = await insertAssessment("kept@psd401.net");
    await healAssessmentOwnerEmail(getDb(), OWNER, id);
    expect(await ownerEmailOf(id)).toBe("kept@psd401.net");
  });
});
