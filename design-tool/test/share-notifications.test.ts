// Share notifications (docs/share-notifications-design.md), slice 1: the "New"
// badge on a co-teach row until the grantee opens the assessment.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { closeDb, getDb } from "../db/client";
import { assessments } from "../db/schema";
import {
  createGrant,
  markAssessmentGrantSeen,
  revokeGrant,
  unseenAssessmentGrantIds,
} from "../lib/api/grants";

const OWNER = { sub: "sn-owner", email: "lead@psd401.net" };
const CO = "coteacher@psd401.net";

beforeAll(() => {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.includes("secure_test_design_tool_test")) {
    throw new Error(`share-notifications tests require the test DB; got: ${url}`);
  }
});

afterEach(async () => {
  const db = getDb();
  await db.execute(sql`truncate table access_grants restart identity cascade`);
  await db.execute(sql`truncate table assessments restart identity cascade`);
});

afterAll(async () => {
  await closeDb();
});

async function assessment(name: string) {
  const [row] = await getDb()
    .insert(assessments)
    .values({ owner_sub: OWNER.sub, owner_email: OWNER.email, name })
    .returning();
  return row;
}

async function grant(assessmentId: string, grantee = CO) {
  const created = await createGrant(getDb(), {
    grantee_email: grantee,
    scope_kind: "assessment",
    scope_id: assessmentId,
    level: "edit",
    granted_by_sub: OWNER.sub,
    granted_by_email: OWNER.email,
  });
  if (!created.ok) throw new Error(created.error);
  return created.grant;
}

describe("co-teach grants: New until opened", () => {
  test("a new grant is unseen; opening it clears only that one", async () => {
    const db = getDb();
    const a = await assessment("A");
    const b = await assessment("B");
    await grant(a.id);
    await grant(b.id);

    expect(await unseenAssessmentGrantIds(db, CO)).toEqual(new Set([a.id, b.id]));
    // Case in the session email does not matter.
    await markAssessmentGrantSeen(db, "CoTeacher@PSD401.net", a.id);
    expect(await unseenAssessmentGrantIds(db, CO)).toEqual(new Set([b.id]));
  });

  test("marking seen is per grantee", async () => {
    const db = getDb();
    const a = await assessment("A");
    await grant(a.id);
    await grant(a.id, "other@psd401.net");

    await markAssessmentGrantSeen(db, CO, a.id);
    expect(await unseenAssessmentGrantIds(db, CO)).toEqual(new Set());
    expect(await unseenAssessmentGrantIds(db, "other@psd401.net")).toEqual(new Set([a.id]));
  });

  test("a revoked grant is not New; a re-grant is New again", async () => {
    const db = getDb();
    const a = await assessment("A");
    const first = await grant(a.id);
    await markAssessmentGrantSeen(db, CO, a.id);
    await revokeGrant(db, first.id);
    expect(await unseenAssessmentGrantIds(db, CO)).toEqual(new Set());

    await grant(a.id);
    expect(await unseenAssessmentGrantIds(db, CO)).toEqual(new Set([a.id]));
  });

  test("no email → nothing", async () => {
    expect(await unseenAssessmentGrantIds(getDb(), null)).toEqual(new Set());
    await markAssessmentGrantSeen(getDb(), undefined, "00000000-0000-0000-0000-000000000000");
  });
});
