// Access slice 1 (docs/access-model-design.md, D-3): proves that OWNERSHIP,
// like the role gate before it, is decided in one place for every teacher
// route — by enumerating the routes from disk rather than sampling them.
//
// `test/auth-role-enforcement.test.ts` answers "is this principal the right
// KIND". Nothing answered "may this principal touch THIS row": the survey
// behind the design note found the check written inline in 36 route files, in
// two styles that disagreed about the status code. This file is the guard that
// keeps it in `lib/api/access.ts` from here on, and it is deliberately
// structural rather than behavioural: it reads the source of every route and
// asserts what the route imports and what it does not contain, so the failure
// mode it catches — a new route that quietly writes its own owner comparison —
// fails on the day that route lands instead of the day someone audits.
//
// The behavioural half lives in the per-feature suites (another teacher gets
// 404, the owner gets through) plus the unit tests at the bottom of this file.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { eq, sql } from "drizzle-orm";
import type { NextResponse } from "next/server";
import { closeDb, getDb } from "../db/client";
import {
  assessments,
  assets,
  attempts,
  rubrics,
  students,
  test_sessions,
} from "../db/schema";
import {
  authorizeAssessment,
  authorizeAsset,
  authorizeAttempt,
  authorizeRubric,
  authorizeSitting,
  authorizeStudent,
  levelSatisfies,
} from "../lib/api/access";
import type { SessionPayload } from "../lib/auth/session";

const APP_ROOT = resolve(import.meta.dir, "../app");

/**
 * Where a route file can live. `app/api` is the bulk; `app/preview` is the one
 * teacher route outside it — and slice 1's sweep, which read `app/api` only,
 * consequently left that route's inline owner check and its 403 in place until
 * access slice 2. Sweeping both roots is what stops the next non-api route
 * repeating it. Paths are reported without the `api/` prefix, so the
 * classifications below read the same as the URL.
 */
const ROUTE_ROOTS = [
  { dir: join(APP_ROOT, "api"), prefix: "" },
  { dir: join(APP_ROOT, "preview"), prefix: "preview" },
];

/**
 * Student-plane routes. A student's access is the sitting's scope plus roster
 * membership and never consults ownership or grants, so these are exempt from
 * the whole file. The list mirrors STUDENT_ROUTES in the role-enforcement test
 * and is asserted against disk below; `attempts/[attemptId]/events` is here
 * even though its GET is the teacher's (it is the one split-role file), and it
 * DOES go through the helper for that method.
 */
const STUDENT_ROUTES = new Set([
  join("test-sessions", "redeem"),
  join("me", "sittings"),
  join("attempts"),
  join("attempts", "[attemptId]", "responses", "[itemId]"),
  join("attempts", "[attemptId]", "submit"),
  join("attempts", "[attemptId]", "events"),
  join("attempts", "[attemptId]", "peek", "pending"),
  join("attempts", "[attemptId]", "peek", "upload"),
  join("assessments", "[id]", "delivery"),
  join("attempts", "[attemptId]", "responses", "[itemId]", "upload-url"),
  join("attempts", "[attemptId]", "responses", "[itemId]", "upload"),
  join("client-errors"),
]);

/**
 * Teacher routes that address NO owned row, so there is nothing for
 * `authorize*` to decide. Each is here for a stated reason; the set is
 * asserted to match disk exactly, so a new route has to be classified rather
 * than silently inheriting an exemption.
 */
const NO_OWNED_ROW = new Map<string, string>([
  [join("auth", "start"), "login surface — no principal yet"],
  [join("auth", "callback"), "login surface — no principal yet"],
  [join("auth", "exchange"), "login surface — no principal yet"],
  [join("auth", "logout"), "login surface — no principal yet"],
  [join("health"), "ALB probe; reads nothing"],
  [join("debug", "throw"), "row 67's knob; reads nothing, writes nothing"],
  [join("feedback"), "writes a feedback row of the caller's own"],
  [
    join("assessments"),
    "LIST + CREATE: the WHERE clause is the scope, widened in access slice 2",
  ],
  [join("assets"), "LIST of the caller's own assets"],
  [join("rubrics"), "LIST + CREATE of the caller's own rubric library"],
  [join("students"), "LIST + CREATE of the caller's own overlay rows"],
  [join("uploads", "image"), "CREATE: dedup + insert under the caller's sub"],
  [
    join("test-sessions"),
    "LIST of the caller's sittings; the POST authorizes its assessment",
  ],
  [
    join("assessments", "import"),
    "CREATE: a bundle becomes a NEW assessment owned by the caller",
  ],
  [join("shares"), "offers addressed to the caller's own email"],
  [
    join("shares", "[shareId]", "accept"),
    "authorized by the RECIPIENT's email, not by ownership of the source",
  ],
  [join("roster", "sections"), "roster read, keyed on the caller's email"],
  [join("roster", "students"), "roster read, keyed on the caller's email"],
  [
    join("accommodations", "import"),
    "TIDE import into the caller's own overlay rows",
  ],
  // Access slice 2 (D-1 / D-6): the admin grant surface. It addresses a SCOPE
  // (a teacher's email, a school id) rather than an owned row, and its own gate
  // is `isAdmin` — which refuses with 404, not 403, for the same
  // no-existence-leak reason as the helper.
  [
    join("grants"),
    "admin surface: scope-addressed, gated by isAdmin with a 404 refusal",
  ],
]);

/**
 * Routes that authorize through a shared loader rather than importing
 * `authorize*` themselves. The loader is named, and the test proves the loader
 * itself goes through `lib/api/access` — so the chain is checked end to end
 * instead of being taken on trust.
 */
const VIA_HELPER = new Map<string, { symbol: string; module: string }>([
  [
    join("assessments", "[id]", "item-sets", "[setId]"),
    { symbol: "loadItemSetForSession", module: "lib/api/itemSets.ts" },
  ],
  [
    join("assessments", "[id]", "item-sets", "[setId]", "items"),
    { symbol: "loadItemSetForSession", module: "lib/api/itemSets.ts" },
  ],
  [
    join("assessments", "[id]", "item-sets", "[setId]", "items", "[itemId]"),
    { symbol: "loadItemSetForSession", module: "lib/api/itemSets.ts" },
  ],
  [
    join("responses", "[responseId]", "score"),
    { symbol: "loadResponseChain", module: "lib/api/reviewActions.ts" },
  ],
  [
    join("responses", "[responseId]", "rescore-ai"),
    { symbol: "loadResponseChain", module: "lib/api/reviewActions.ts" },
  ],
  [
    join("scores", "[scoreId]", "approve"),
    { symbol: "loadResponseChain", module: "lib/api/reviewActions.ts" },
  ],
]);

/**
 * Route files that may still mention `owner_sub` — every one a LIST scope or a
 * write of the column, never a per-row refusal. Anywhere else the literal is
 * the signature of the inline check this slice removed.
 */
const OWNER_SUB_ALLOWED = new Map<string, string>([
  [join("assessments"), "list WHERE + insert value"],
  [join("assets"), "list WHERE"],
  [join("rubrics"), "list WHERE + insert value"],
  [
    join("rubrics", "[id]"),
    "detach subquery scoped to the caller's own items on DELETE",
  ],
  [join("students"), "list WHERE + ssid dedup + insert value"],
  [join("test-sessions"), "list WHERE + insert value"],
  [join("uploads", "image"), "sha256 dedup WHERE + insert value"],
  [
    join("assessments", "[id]", "review-queue"),
    "asset and overlay-student lookups scoped to the caller (not the queue's own gate)",
  ],
  // Access slice 2: the preview's asset lookup is scoped to the ASSESSMENT's
  // owner, not the caller, so a co-teacher's preview shows the lead teacher's
  // images. A read scope, not a refusal.
  [
    join("preview", "[id]"),
    "asset lookup scoped to the assessment's owner so a grantee sees its images",
  ],
]);

function findRouteFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...findRouteFiles(full));
    else if (entry.name === "route.ts") out.push(full);
  }
  return out;
}

const allRoutes = ROUTE_ROOTS.flatMap(({ dir, prefix }) =>
  findRouteFiles(dir).map((file) => ({
    file,
    path: join(prefix, file.slice(dir.length + 1).replace(/\/route\.ts$/, "")),
    source: readFileSync(file, "utf8"),
  })),
).sort((a, b) => a.path.localeCompare(b.path));

const staffRoutes = allRoutes.filter((r) => !STUDENT_ROUTES.has(r.path));

const IMPORTS_ACCESS = /from\s+"@\/lib\/api\/access"/;

describe("ownership enforcement across every teacher route", () => {
  test("the sweep found the routes", () => {
    expect(allRoutes.length).toBeGreaterThanOrEqual(60);
    expect(staffRoutes.length).toBeGreaterThanOrEqual(45);
  });

  test("every classified student route exists on disk", () => {
    const onDisk = new Set(allRoutes.map((r) => r.path));
    const missing = [...STUDENT_ROUTES].filter((p) => !onDisk.has(p));
    expect(missing).toEqual([]);
  });

  test("every classification names a route that exists", () => {
    // A typo in any of the three sets would silently exempt a route from the
    // assertions below, which is the one way this test can pass for the wrong
    // reason.
    const onDisk = new Set(allRoutes.map((r) => r.path));
    const stale = [
      ...NO_OWNED_ROW.keys(),
      ...VIA_HELPER.keys(),
      ...OWNER_SUB_ALLOWED.keys(),
    ].filter((p) => !onDisk.has(p));
    expect(stale).toEqual([]);
  });

  test("every teacher route that addresses an owned row goes through the helper", () => {
    const wrong: string[] = [];
    for (const { path, source } of staffRoutes) {
      if (NO_OWNED_ROW.has(path)) continue;
      const via = VIA_HELPER.get(path);
      if (via) {
        if (!source.includes(via.symbol)) {
          wrong.push(`/${path} should authorize through ${via.symbol}`);
        }
        continue;
      }
      if (!IMPORTS_ACCESS.test(source)) {
        wrong.push(
          `/${path} imports nothing from @/lib/api/access — add the authorize* call, ` +
            "or classify it in NO_OWNED_ROW / VIA_HELPER with a reason",
        );
      }
    }
    expect(wrong).toEqual([]);
  });

  test("the shared loaders behind VIA_HELPER go through the helper themselves", () => {
    const wrong: string[] = [];
    for (const { symbol, module } of VIA_HELPER.values()) {
      const source = readFileSync(resolve(import.meta.dir, "..", module), "utf8");
      if (!IMPORTS_ACCESS.test(source)) wrong.push(`${module} (${symbol})`);
      if (!source.includes(`export async function ${symbol}`)) {
        wrong.push(`${module} no longer exports ${symbol}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  test("no teacher route contains an inline owner_sub comparison", () => {
    const wrong: string[] = [];
    for (const { path, source } of staffRoutes) {
      if (!source.includes("owner_sub")) continue;
      if (OWNER_SUB_ALLOWED.has(path)) continue;
      wrong.push(
        `/${path} mentions owner_sub — ownership belongs in lib/api/access.ts; ` +
          "if this is a list scope or an insert value, classify it in OWNER_SUB_ALLOWED",
      );
    }
    expect(wrong).toEqual([]);
  });

  test("an allowlisted owner_sub mention is a scope or a write, never a comparison", () => {
    // The shape the inline checks all had: `row.owner_sub !== session.sub` (or
    // the reverse). A list WHERE and an insert value never look like that, so
    // the allowlist cannot be used to smuggle a refusal back in.
    const comparison = /owner_sub\s*(?:!==|===|==|!=)|(?:!==|===|==|!=)\s*\w+\.owner_sub/;
    const wrong: string[] = [];
    for (const { path, source } of staffRoutes) {
      if (!OWNER_SUB_ALLOWED.has(path)) continue;
      if (comparison.test(source)) wrong.push(`/${path}`);
    }
    expect(wrong).toEqual([]);
  });

  test("no teacher route builds its own 403 for a row it cannot reach", () => {
    // D-3: an ACCESS refusal is 404 everywhere, and `forbidden` is the ROLE
    // gate's word alone (requireStaff owns it). The two 403s that remain are
    // not about access to a row, so they are named here rather than hidden by
    // a looser pattern.
    const nonAccess403 = new Map<string, string>([
      [join("auth", "exchange"), "the email's domain is not a district domain"],
      [join("ai", "generate-item"), "llm_authoring_disabled on the assessment"],
    ]);
    const wrong: string[] = [];
    for (const { path, source } of staffRoutes) {
      if (/error:\s*"forbidden"/.test(source)) wrong.push(`/${path} (forbidden body)`);
      if (/status:\s*403\s*\}/.test(source) && !nonAccess403.has(path)) {
        wrong.push(`/${path} (status 403)`);
      }
    }
    expect(wrong).toEqual([]);
  });
});

// ── The helper itself ────────────────────────────────────────────────────────
//
// One session per role, and rows inserted directly: the point is the decision
// `authorize*` makes, not the routes above it.

const OWNER: SessionPayload = {
  sub: "access-owner",
  role: "staff",
  email: "owner@psd401.net",
} as SessionPayload;
const OTHER: SessionPayload = {
  sub: "access-other",
  role: "staff",
  email: "other@psd401.net",
} as SessionPayload;

const MALFORMED = "not-a-uuid";

async function status(response: NextResponse): Promise<number> {
  return response.status;
}

const expectTestDb = () => {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.includes("secure_test_design_tool_test")) {
    throw new Error(
      `access-enforcement tests require the test DB DATABASE_URL; got: ${url}`,
    );
  }
};

beforeAll(() => {
  expectTestDb();
});

afterEach(async () => {
  const db = getDb();
  await db.execute(sql`truncate table assessments restart identity cascade`);
  await db.execute(sql`truncate table students restart identity cascade`);
  await db.execute(sql`truncate table rubrics restart identity cascade`);
  await db.execute(sql`truncate table assets restart identity cascade`);
});

afterAll(async () => {
  await closeDb();
});

describe("authorize* resolves the owner and refuses everyone else with 404", () => {
  const db = getDb();

  test("an assessment: owner → own/owner, another teacher → 404", async () => {
    const [row] = await db
      .insert(assessments)
      .values({ owner_sub: OWNER.sub, name: "Access helper fixture" })
      .returning();
    const id = row!.id;

    const mine = await authorizeAssessment(db, OWNER, id, "own");
    expect(mine.ok).toBe(true);
    if (mine.ok) {
      expect(mine.level).toBe("own");
      expect(mine.via).toBe("owner");
      expect(mine.assessment.id).toBe(id);
    }

    // Every level the ladder has, since `own` satisfies all of them.
    for (const need of ["view", "run", "edit", "own"] as const) {
      const at = await authorizeAssessment(db, OWNER, id, need);
      expect(at.ok).toBe(true);
    }

    const theirs = await authorizeAssessment(db, OTHER, id, "view");
    expect(theirs.ok).toBe(false);
    if (!theirs.ok) {
      expect(await status(theirs.response)).toBe(404);
      expect(await theirs.response.json()).toEqual({
        ok: false,
        error: "not_found",
      });
    }

    await db.delete(assessments).where(eq(assessments.id, id));
  });

  test("an unknown id is the same 404 as another teacher's row", async () => {
    const unknown = "11111111-1111-4111-8111-111111111111";
    const missing = await authorizeAssessment(db, OWNER, unknown, "view");
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(await status(missing.response)).toBe(404);
      expect(await missing.response.json()).toEqual({
        ok: false,
        error: "not_found",
      });
    }
  });

  test("a malformed id is 400 invalid_id on every entry point", async () => {
    const calls = [
      authorizeAssessment(db, OWNER, MALFORMED, "view"),
      authorizeSitting(db, OWNER, MALFORMED, "view"),
      authorizeAttempt(db, OWNER, MALFORMED, "view"),
      authorizeStudent(db, OWNER, MALFORMED, "view"),
      authorizeRubric(db, OWNER, MALFORMED, "view"),
      authorizeAsset(db, OWNER, MALFORMED, "view"),
    ];
    for (const result of await Promise.all(calls)) {
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(await status(result.response)).toBe(400);
        expect(await result.response.json()).toEqual({
          ok: false,
          error: "invalid_id",
        });
      }
    }
  });

  test("a sitting resolves through its assessment", async () => {
    const [assessment] = await db
      .insert(assessments)
      .values({ owner_sub: OWNER.sub, name: "Access sitting fixture" })
      .returning();
    const [sitting] = await db
      .insert(test_sessions)
      .values({
        assessment_id: assessment!.id,
        owner_sub: OWNER.sub,
        code: `AX${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
        expires_at: new Date(Date.now() + 3_600_000),
      })
      .returning();

    const mine = await authorizeSitting(db, OWNER, sitting!.id, "run");
    expect(mine.ok).toBe(true);
    if (mine.ok) {
      expect(mine.sitting.id).toBe(sitting!.id);
      expect(mine.assessment.id).toBe(assessment!.id);
      expect(mine.level).toBe("own");
    }

    const theirs = await authorizeSitting(db, OTHER, sitting!.id, "view");
    expect(theirs.ok).toBe(false);
    if (!theirs.ok) expect(await status(theirs.response)).toBe(404);

    await db.delete(assessments).where(eq(assessments.id, assessment!.id));
  });

  test("an attempt resolves through its assessment", async () => {
    const [assessment] = await db
      .insert(assessments)
      .values({ owner_sub: OWNER.sub, name: "Access attempt fixture" })
      .returning();
    const [student] = await db
      .insert(students)
      .values({ owner_sub: OWNER.sub, ssid: `AX${Date.now()}`, name: "" })
      .returning();
    const [attempt] = await db
      .insert(attempts)
      .values({ assessment_id: assessment!.id, student_id: student!.id })
      .returning();

    const mine = await authorizeAttempt(db, OWNER, attempt!.id, "edit");
    expect(mine.ok).toBe(true);
    if (mine.ok) {
      expect(mine.attempt.id).toBe(attempt!.id);
      expect(mine.assessment.id).toBe(assessment!.id);
    }

    const theirs = await authorizeAttempt(db, OTHER, attempt!.id, "view");
    expect(theirs.ok).toBe(false);
    if (!theirs.ok) expect(await status(theirs.response)).toBe(404);

    await db.delete(assessments).where(eq(assessments.id, assessment!.id));
    await db.delete(students).where(eq(students.id, student!.id));
  });

  test("the overlay student, a rubric and an asset resolve on their own owner_sub", async () => {
    const [student] = await db
      .insert(students)
      .values({ owner_sub: OWNER.sub, ssid: `AY${Date.now()}`, name: "" })
      .returning();
    const [rubric] = await db
      .insert(rubrics)
      .values({
        owner_sub: OWNER.sub,
        title: "Access fixture rubric",
        rubric: { style: "holistic", criteria: [] },
      })
      .returning();
    const [asset] = await db
      .insert(assets)
      .values({
        owner_sub: OWNER.sub,
        content_type: "image/png",
        size_bytes: 1,
        sha256: `ax${Date.now()}`,
        storage_provider: "local",
        storage_key: `access/${Date.now()}`,
      })
      .returning();

    expect((await authorizeStudent(db, OWNER, student!.id, "own")).ok).toBe(true);
    expect((await authorizeRubric(db, OWNER, rubric!.id, "own")).ok).toBe(true);
    expect((await authorizeAsset(db, OWNER, asset!.id, "own")).ok).toBe(true);

    for (const denied of [
      await authorizeStudent(db, OTHER, student!.id, "view"),
      await authorizeRubric(db, OTHER, rubric!.id, "view"),
      await authorizeAsset(db, OTHER, asset!.id, "view"),
    ]) {
      expect(denied.ok).toBe(false);
      if (!denied.ok) expect(await status(denied.response)).toBe(404);
    }

    await db.delete(students).where(eq(students.id, student!.id));
    await db.delete(rubrics).where(eq(rubrics.id, rubric!.id));
    await db.delete(assets).where(eq(assets.id, asset!.id));
  });

  test("the ladder orders view < run < edit < own", () => {
    expect(levelSatisfies("own", "view")).toBe(true);
    expect(levelSatisfies("edit", "run")).toBe(true);
    expect(levelSatisfies("run", "view")).toBe(true);
    expect(levelSatisfies("view", "view")).toBe(true);
    expect(levelSatisfies("view", "run")).toBe(false);
    expect(levelSatisfies("run", "edit")).toBe(false);
    expect(levelSatisfies("edit", "own")).toBe(false);
  });
});
