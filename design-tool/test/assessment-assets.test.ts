// G-1 (docs/coteacher-gaps-2026-10-design.md, D-1): co-teaching staff load the
// owner's images through the assessment. Covers the access decision
// (authorizeAssessmentAsset, behind GET /api/assessments/[id]/assets/[assetId]),
// the "referenced" set, the owner-scoped resolver and the URL the renderers
// emit.

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { closeDb, getDb } from "../db/client";
import { access_grants, assessments, assets, item_sets, items } from "../db/schema";
import { authorizeAssessmentAsset } from "../lib/api/access";
import {
  assessmentAssetUrl,
  assetRefsInContent,
  referencedAssetIds,
  resolveAssessmentAssets,
} from "../lib/assets/assessmentAssets";
import { assetSrc, renderItemContent } from "../lib/items/renderItemContent";
import type { SessionPayload } from "../lib/auth/session";

const OWNER = { sub: "g1-owner", role: "staff", email: "g1-lead@psd401.net" } as SessionPayload;
const CO = { sub: "g1-co", role: "staff", email: "g1-co@psd401.net" } as SessionPayload;
const OUTSIDER = { sub: "g1-out", role: "staff", email: "g1-out@psd401.net" } as SessionPayload;

const HOUR = 3_600_000;

beforeAll(() => {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.includes("secure_test_design_tool_test")) {
    throw new Error(`assessment-assets tests require the test DB; got: ${url}`);
  }
});

afterEach(async () => {
  const db = getDb();
  await db.execute(sql`truncate table access_grants restart identity cascade`);
  await db.execute(sql`truncate table assessments restart identity cascade`);
  await db.execute(sql`truncate table assets restart identity cascade`);
});

afterAll(async () => {
  await closeDb();
});

const db = getDb();
let seq = 0;

async function makeAsset(ownerSub: string) {
  seq += 1;
  const [row] = await db
    .insert(assets)
    .values({
      owner_sub: ownerSub,
      content_type: "image/png",
      size_bytes: 1,
      sha256: `g1-${Date.now()}-${seq}`,
      storage_provider: "local-fs",
      storage_key: `g1/${Date.now()}-${seq}`,
    })
    .returning();
  return row!;
}

async function makeAssessment() {
  const [row] = await db
    .insert(assessments)
    .values({ owner_sub: OWNER.sub, owner_email: OWNER.email!, name: "G-1 fixture" })
    .returning();
  return row!;
}

async function grantView(assessmentId: string, email: string) {
  await db.insert(access_grants).values({
    grantee_email: email,
    scope_kind: "assessment",
    scope_id: assessmentId,
    level: "view",
    starts_at: new Date(Date.now() - HOUR),
    granted_by_sub: OWNER.sub,
    granted_by_email: OWNER.email!,
  });
}

async function stemWith(assessmentId: string, assetId: string) {
  await db.insert(items).values({
    assessment_id: assessmentId,
    position: 0,
    type: "essay",
    stem: `Look at ![chart](asset:${assetId}) and explain.`,
  });
}

async function statusOf(r: Awaited<ReturnType<typeof authorizeAssessmentAsset>>) {
  return r.ok ? 200 : r.response.status;
}

describe("authorizeAssessmentAsset", () => {
  test("a co-teacher with view loads the owner's referenced image", async () => {
    const a = await makeAssessment();
    const pic = await makeAsset(OWNER.sub);
    await stemWith(a.id, pic.id);
    await grantView(a.id, CO.email!);

    const r = await authorizeAssessmentAsset(db, CO, a.id, pic.id);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.asset.id).toBe(pic.id);
  });

  test("an owner image the assessment does not reference is refused to the co-teacher", async () => {
    const a = await makeAssessment();
    const used = await makeAsset(OWNER.sub);
    const unused = await makeAsset(OWNER.sub);
    await stemWith(a.id, used.id);
    await grantView(a.id, CO.email!);

    expect(await statusOf(await authorizeAssessmentAsset(db, CO, a.id, unused.id))).toBe(404);
  });

  test("a referenced image that is not the owner's is refused", async () => {
    const a = await makeAssessment();
    const foreign = await makeAsset(OUTSIDER.sub);
    await stemWith(a.id, foreign.id);
    await grantView(a.id, CO.email!);

    expect(await statusOf(await authorizeAssessmentAsset(db, CO, a.id, foreign.id))).toBe(404);
  });

  test("no grant on the assessment → 404", async () => {
    const a = await makeAssessment();
    const pic = await makeAsset(OWNER.sub);
    await stemWith(a.id, pic.id);

    expect(await statusOf(await authorizeAssessmentAsset(db, OUTSIDER, a.id, pic.id))).toBe(404);
  });

  test("the owner loads an image inserted but not yet saved (decision 2.2)", async () => {
    const a = await makeAssessment();
    const pic = await makeAsset(OWNER.sub);

    expect((await authorizeAssessmentAsset(db, OWNER, a.id, pic.id)).ok).toBe(true);
  });

  test("a co-teacher's own unreferenced image still loads for them", async () => {
    const a = await makeAssessment();
    const theirs = await makeAsset(CO.sub);
    await grantView(a.id, CO.email!);

    expect((await authorizeAssessmentAsset(db, CO, a.id, theirs.id)).ok).toBe(true);
  });

  test("malformed ids → 400", async () => {
    const a = await makeAssessment();
    expect(await statusOf(await authorizeAssessmentAsset(db, OWNER, a.id, "nope"))).toBe(400);
    expect(await statusOf(await authorizeAssessmentAsset(db, OWNER, "nope", a.id))).toBe(400);
  });
});

describe("the referenced set (decision 2.3: the preview's fields)", () => {
  test("stems, choices, set introductions, sources and item-config images count", async () => {
    const a = await makeAssessment();
    const [inStem, inChoice, inIntro, inSource, hotspot, drawing] = await Promise.all(
      Array.from({ length: 6 }, () => makeAsset(OWNER.sub)),
    );
    const [set] = await db
      .insert(item_sets)
      .values({
        assessment_id: a.id,
        stimulus_text: `![](asset:${inIntro!.id})`,
        sources: [{ label: "A", text: `![](asset:${inSource!.id})` }],
      })
      .returning();
    await db.insert(items).values([
      {
        assessment_id: a.id,
        item_set_id: set!.id,
        position: 0,
        type: "multiple_choice_single",
        stem: `![](asset:${inStem!.id})`,
        choices: [{ id: "a", text: `![](asset:${inChoice!.id})` }],
        correct_choice_ids: ["a"],
      },
      {
        assessment_id: a.id,
        position: 1,
        type: "hotspot",
        stem: "Click",
        config: { image_asset_id: hotspot!.id, regions: [], correct_region_ids: [] },
      },
      {
        assessment_id: a.id,
        position: 2,
        type: "drawing_upload",
        stem: "Draw",
        config: { prompt_asset_id: drawing!.id },
      },
    ]);

    const refs = await referencedAssetIds(db, a.id);
    for (const asset of [inStem, inChoice, inIntro, inSource, hotspot, drawing]) {
      expect(refs.has(asset!.id.toLowerCase())).toBe(true);
    }
  });

  test("a non-uuid config value is dropped, not queried", () => {
    expect(
      assetRefsInContent(
        [{ stem: "", choices: [], config: { image_asset_id: "not-a-uuid" } }],
        [],
      ),
    ).toEqual([]);
  });
});

describe("resolution and the URL the renderers emit", () => {
  test("resolves under the owner, whoever reads, with the scoped URL", async () => {
    const a = await makeAssessment();
    const mine = await makeAsset(OWNER.sub);
    const other = await makeAsset(OUTSIDER.sub);

    const resolved = await resolveAssessmentAssets(db, a, [mine.id, other.id]);
    expect([...resolved.keys()]).toEqual([mine.id.toLowerCase()]);
    expect(resolved.get(mine.id.toLowerCase())!.url).toBe(assessmentAssetUrl(a.id, mine.id));

    const html = renderItemContent(`![chart](asset:${mine.id})`, resolved);
    expect(html).toContain(`src="/api/assessments/${a.id}/assets/${mine.id}"`);
    expect(html).not.toContain("/api/assets/");
  });

  test("an asset with no url keeps the owner's /api/assets path", () => {
    expect(assetSrc({ id: "ABC", content_type: "image/png" })).toBe("/api/assets/abc");
  });
});
