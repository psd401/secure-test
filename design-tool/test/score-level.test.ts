// The `score` access level (docs/competency-assessment-design.md, D-11/D-12/D-15),
// CBA slice 5: `view < run < score < edit < own`.
//
// A scorer is delegated a time-boxed `assessment` grant at `score`. It reaches
// the review queue and every scoring action, and nothing that changes what the
// assessment IS — items, settings, publish, pass back (D-15 keeps that at
// `edit`), grants, deleting an attempt. Three halves:
//
//   - the ladder itself (pure);
//   - which routes ask for `score` and which stay at `edit` — structural, read
//     from source, so a later edit that quietly moves a route fails here;
//   - a scorer driven through the real routes against the test DB.
import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { eq, sql } from "drizzle-orm";
import { closeDb, getDb } from "../db/client";
import {
  ACCESS_GRANT_LEVELS,
  access_grants,
  assessments,
  attempts,
  items,
  responses,
  scores,
  students,
} from "../db/schema";
import { ACCESS_LEVELS, levelSatisfies, maxLevel } from "../lib/api/accessLevels";
import { GrantLevelSchema } from "../lib/api/grants";
import { SESSION_COOKIE_NAME } from "../lib/auth/session";
import * as headersMod from "next/headers";
import * as sessionMod from "../lib/auth/session";

const OWNER = { sub: "score-level-owner", email: "assessment-lead@psd401.net" };
const SCORER = { sub: "score-level-scorer", email: "scorer@psd401.net" };
const OTHER = { sub: "score-level-other", email: "other@psd401.net" };

let current: { sub: string; email: string } | null = null;

mock.module("next/headers", () => ({
  ...headersMod,
  headers: async () => new Headers(),
  cookies: async () => ({
    get: (name: string) =>
      current && name === SESSION_COOKIE_NAME ? { value: "x" } : undefined,
  }),
}));

mock.module("../lib/auth/session", () => ({
  ...sessionMod,
  readSessionFromCookies: async () =>
    current ? { sub: current.sub, role: "staff", email: current.email } : null,
}));

function asUser(user: { sub: string; email: string } | null) {
  current = user;
}

const HOUR = 3_600_000;

beforeAll(() => {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.includes("secure_test_design_tool_test")) {
    throw new Error(`score-level tests require the test DB; got: ${url}`);
  }
  process.env.DESIGN_TOOL_SESSION_SECRET ||= "score-level-test-secret-do-not-use";
});

afterEach(async () => {
  const db = getDb();
  await db.execute(sql`truncate table access_grants restart identity cascade`);
  await db.execute(sql`truncate table assessments restart identity cascade`);
  await db.execute(sql`truncate table students restart identity cascade`);
  asUser(null);
});

afterAll(async () => {
  await closeDb();
});

// ── The ladder ──────────────────────────────────────────────────────────────

describe("the ladder with score", () => {
  test("orders view < run < score < edit < own", () => {
    expect([...ACCESS_LEVELS]).toEqual(["view", "run", "score", "edit", "own"]);
    expect(levelSatisfies("score", "run")).toBe(true);
    expect(levelSatisfies("score", "view")).toBe(true);
    expect(levelSatisfies("score", "score")).toBe(true);
    expect(levelSatisfies("edit", "score")).toBe(true);
    expect(levelSatisfies("own", "score")).toBe(true);
    expect(levelSatisfies("run", "score")).toBe(false);
    expect(levelSatisfies("score", "edit")).toBe(false);
    expect(levelSatisfies("score", "own")).toBe(false);
    expect(maxLevel("run", "score")).toBe("score");
    expect(maxLevel("score", "edit")).toBe("edit");
  });

  test("the schema's CHECK list and the grants API both carry it, in ladder order", () => {
    expect([...ACCESS_GRANT_LEVELS]).toEqual([...ACCESS_LEVELS]);
    expect(GrantLevelSchema.options).toEqual([...ACCESS_LEVELS]);
  });
});

// ── Which routes ask for score, and which stay at edit ──────────────────────

const ROOT = resolve(import.meta.dir, "..");
function source(rel: string): string {
  return readFileSync(join(ROOT, rel), "utf8");
}
/** The levels a file passes to authorize*() or levelSatisfies(). */
function levelsAsked(rel: string): Set<string> {
  const src = source(rel);
  const found = new Set<string>();
  for (const call of src.matchAll(/authorize(?:Assessment|Attempt)\(([\s\S]*?)\);/g)) {
    for (const m of call[1]!.matchAll(/"(view|run|score|edit|own)"/g)) found.add(m[1]!);
  }
  for (const m of src.matchAll(/levelSatisfies\(access\.level, "(view|run|score|edit|own)"\)/g)) {
    found.add(m[1]!);
  }
  return found;
}

/** The scoring surface (D-11): moved from `edit` to `score`. */
const AT_SCORE = [
  "lib/api/reviewActions.ts", // manual score, approve, change score, per-response feedback, re-run AI
  "app/api/attempts/[attemptId]/score/route.ts",
  "app/api/attempts/[attemptId]/score-ai/route.ts",
  "app/api/attempts/[attemptId]/feedback/route.ts",
  "app/dashboard/[id]/scoring/page.tsx",
];

/** Deliberately NOT reachable from `score`: authoring, settings, pass back (D-15), release. */
const STAYS_AT_EDIT = [
  "app/api/assessments/[id]/route.ts",
  "app/api/assessments/[id]/items/route.ts",
  "app/api/assessments/[id]/items/[itemId]/route.ts",
  "app/api/assessments/[id]/items/reorder/route.ts",
  "app/api/assessments/[id]/items/import/route.ts",
  "app/api/assessments/[id]/item-sets/route.ts",
  "app/api/assessments/[id]/rubrics/extract/route.ts",
  "app/api/assessments/[id]/pass-back/route.ts",
  "app/api/attempts/[attemptId]/pass-back/route.ts",
  "app/api/assessments/[id]/release-answers/route.ts",
  "app/api/assessments/[id]/rescore/route.ts",
  "app/api/assessments/[id]/google-docs/route.ts",
  "app/api/response-revisions/[revisionId]/restore/route.ts",
  "lib/gradebook/authorizeSend.ts",
];

describe("route levels", () => {
  test("the scoring surface asks for score and never edit", () => {
    for (const file of AT_SCORE) {
      const asked = levelsAsked(file);
      expect({ file, score: asked.has("score") }).toEqual({ file, score: true });
      expect({ file, edit: asked.has("edit") }).toEqual({ file, edit: false });
    }
  });

  test("authoring, settings, pass back and release stay at edit", () => {
    for (const file of STAYS_AT_EDIT) {
      const asked = levelsAsked(file);
      expect({ file, edit: asked.has("edit") }).toEqual({ file, edit: true });
      expect({ file, score: asked.has("score") }).toEqual({ file, score: false });
    }
  });
});

// ── A scorer through the real routes ────────────────────────────────────────

async function scene(opts: { scorerLevel?: "run" | "score" | "edit"; endsAt?: Date } = {}) {
  const db = getDb();
  const [assessment] = await db
    .insert(assessments)
    .values({ owner_sub: OWNER.sub, owner_email: OWNER.email, name: "Score level fixture" })
    .returning();
  const [essay] = await db
    .insert(items)
    .values({
      assessment_id: assessment!.id,
      position: 0,
      type: "essay",
      stem: "Explain",
      config: { scoring_method: "human" },
    })
    .returning();
  const [student] = await db
    .insert(students)
    .values({ owner_sub: OWNER.sub, ssid: "SCORE-LEVEL-1", name: "Fixture Student" })
    .returning();
  const [attempt] = await db
    .insert(attempts)
    .values({
      assessment_id: assessment!.id,
      student_id: student!.id,
      status: "submitted",
      submitted_at: new Date(),
    })
    .returning();
  const [response] = await db
    .insert(responses)
    .values({
      attempt_id: attempt!.id,
      item_id: essay!.id,
      response: { type: "essay", text: "A typed response." },
    })
    .returning();
  await db.insert(access_grants).values({
    grantee_email: SCORER.email,
    scope_kind: "assessment",
    scope_id: assessment!.id,
    level: opts.scorerLevel ?? "score",
    starts_at: new Date(Date.now() - HOUR),
    ends_at: opts.endsAt ?? new Date(Date.now() + 24 * HOUR),
    granted_by_sub: OWNER.sub,
    granted_by_email: OWNER.email,
    note: "scorer",
  });
  return { assessment: assessment!, essay: essay!, attempt: attempt!, response: response! };
}

function ctx<T extends Record<string, string>>(params: T) {
  return { params: Promise.resolve(params) };
}
function json(method: string, url: string, body?: unknown) {
  return new Request(url, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function scoreResponse(responseId: string) {
  const { POST } = await import("../app/api/responses/[responseId]/score/route");
  return POST(
    // No rubric, so the item is worth 1 (checkManualScore).
    json("POST", `http://localhost/api/responses/${responseId}/score`, { points: 1, max_points: 1 }),
    ctx({ responseId }),
  );
}

describe("a score grantee", () => {
  test("reads the review queue and scores a response", async () => {
    const s = await scene();
    asUser(SCORER);

    const { GET } = await import("../app/api/assessments/[id]/review-queue/route");
    const queue = await GET(
      new Request(`http://localhost/api/assessments/${s.assessment.id}/review-queue`),
      ctx({ id: s.assessment.id }),
    );
    expect(queue.status).toBe(200);

    const res = await scoreResponse(s.response.id);
    expect(res.status).toBe(201);
    const [row] = await getDb().select().from(scores).where(eq(scores.response_id, s.response.id));
    expect(row).toMatchObject({ method: "human", points: 1, status: "final", scorer: SCORER.sub });
  });

  test("writes overall feedback on the attempt", async () => {
    const s = await scene();
    asUser(SCORER);
    const { PUT } = await import("../app/api/attempts/[attemptId]/feedback/route");
    const res = await PUT(
      json("PUT", `http://localhost/api/attempts/${s.attempt.id}/feedback`, { text: "Cite a source." }),
      ctx({ attemptId: s.attempt.id }),
    );
    expect(res.status).toBe(200);
  });

  test("is refused settings, item edit, pass back, grant creation and attempt delete — 404 each", async () => {
    const s = await scene();
    asUser(SCORER);

    const settings = await (await import("../app/api/assessments/[id]/route")).PATCH(
      json("PATCH", `http://localhost/api/assessments/${s.assessment.id}`, { name: "Renamed" }),
      ctx({ id: s.assessment.id }),
    );
    expect(settings.status).toBe(404);

    const addItem = await (await import("../app/api/assessments/[id]/items/route")).POST(
      json("POST", `http://localhost/api/assessments/${s.assessment.id}/items`, {
        type: "essay",
        stem: "A new question",
      }),
      ctx({ id: s.assessment.id }),
    );
    expect(addItem.status).toBe(404);

    const editItem = await (await import("../app/api/assessments/[id]/items/[itemId]/route")).PATCH(
      json("PATCH", `http://localhost/api/assessments/${s.assessment.id}/items/${s.essay.id}`, {
        type: "essay",
        stem: "Changed",
      }),
      ctx({ id: s.assessment.id, itemId: s.essay.id }),
    );
    expect(editItem.status).toBe(404);

    const passBack = await (await import("../app/api/attempts/[attemptId]/pass-back/route")).POST(
      json("POST", `http://localhost/api/attempts/${s.attempt.id}/pass-back`, {}),
      ctx({ attemptId: s.attempt.id }),
    );
    expect(passBack.status).toBe(404);

    const grant = await (await import("../app/api/assessments/[id]/grants/route")).POST(
      json("POST", `http://localhost/api/assessments/${s.assessment.id}/grants`, {
        grantee_email: OTHER.email,
        level: "score",
      }),
      ctx({ id: s.assessment.id }),
    );
    expect(grant.status).toBe(404);

    const del = await (await import("../app/api/attempts/[attemptId]/route")).DELETE(
      new Request(`http://localhost/api/attempts/${s.attempt.id}`, { method: "DELETE" }),
      ctx({ attemptId: s.attempt.id }),
    );
    expect(del.status).toBe(404);

    // Nothing moved underneath the refusals.
    const [after] = await getDb().select().from(attempts).where(eq(attempts.id, s.attempt.id));
    expect(after?.status).toBe("submitted");
    const [a] = await getDb().select().from(assessments).where(eq(assessments.id, s.assessment.id));
    expect(a?.name).toBe("Score level fixture");
  });

  test("a run grantee cannot score; an expired score grant confers nothing", async () => {
    const run = await scene({ scorerLevel: "run" });
    asUser(SCORER);
    expect((await scoreResponse(run.response.id)).status).toBe(404);

    await getDb().execute(sql`truncate table access_grants restart identity cascade`);
    await getDb().execute(sql`truncate table assessments restart identity cascade`);
    await getDb().execute(sql`truncate table students restart identity cascade`);

    const expired = await scene({ endsAt: new Date(Date.now() - 1000) });
    asUser(SCORER);
    expect((await scoreResponse(expired.response.id)).status).toBe(404);
  });
});

describe("granting score", () => {
  test("the owner grants score with an end date (D-12)", async () => {
    const [assessment] = await getDb()
      .insert(assessments)
      .values({ owner_sub: OWNER.sub, owner_email: OWNER.email, name: "Grant score" })
      .returning();
    asUser(OWNER);
    const endsAt = new Date(Date.now() + 7 * 24 * HOUR).toISOString();
    const { POST } = await import("../app/api/assessments/[id]/grants/route");
    const res = await POST(
      json("POST", `http://localhost/api/assessments/${assessment!.id}/grants`, {
        grantee_email: SCORER.email,
        level: "score",
        ends_at: endsAt,
        note: "scorer",
      }),
      ctx({ id: assessment!.id }),
    );
    expect(res.status).toBe(201);
    const [row] = await getDb().select().from(access_grants);
    expect(row).toMatchObject({ grantee_email: SCORER.email, level: "score", scope_kind: "assessment" });
    expect(row!.ends_at?.toISOString()).toBe(endsAt);
  });

  test("score without a future end is refused by the server, not only the form (PR #178 review)", async () => {
    const [assessment] = await getDb()
      .insert(assessments)
      .values({ owner_sub: OWNER.sub, owner_email: OWNER.email, name: "Grant score, no end" })
      .returning();
    asUser(OWNER);
    const { POST } = await import("../app/api/assessments/[id]/grants/route");
    const post = (extra: Record<string, unknown>) =>
      POST(
        json("POST", `http://localhost/api/assessments/${assessment!.id}/grants`, {
          grantee_email: SCORER.email,
          level: "score",
          ...extra,
        }),
        ctx({ id: assessment!.id }),
      );
    for (const extra of [{}, { ends_at: null }, { ends_at: new Date(Date.now() - HOUR).toISOString() }]) {
      const res = await post(extra);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe("ends_at_required");
    }
    expect(await getDb().select().from(access_grants)).toHaveLength(0);
  });

  test("the DB CHECK accepts score and still refuses an unknown level", async () => {
    const db = getDb();
    const base = {
      grantee_email: SCORER.email,
      scope_kind: "assessment",
      scope_id: "11111111-1111-4111-8111-111111111111",
      granted_by_sub: OWNER.sub,
      granted_by_email: OWNER.email,
    };
    await db.insert(access_grants).values({ ...base, level: "score" });
    let refused = false;
    try {
      await db.insert(access_grants).values({ ...base, grantee_email: OTHER.email, level: "grade" });
    } catch {
      refused = true;
    }
    expect(refused).toBe(true);
  });
});
