// Access slice 2 (docs/access-model-design.md, D-1/D-2/D-5/D-6/D-7): grant
// RESOLUTION, the grants API, list widening, and sitting creation under a grant.
//
// Slice 1's `test/access-enforcement.test.ts` is structural — it proves every
// route asks the helper. This file is behavioural: it proves what the helper
// now answers. The two halves worth stating up front, because both are the kind
// of rule that quietly stops holding:
//
//   - a grant that is expired, not yet started, or revoked confers NOTHING;
//   - a `school`-scoped grant confers nothing at all (D-7 deferred principals,
//     and the scope is stored so slice 6 lands without a migration). "Stored but
//     inert" is exactly the half-feature that becomes live by accident, so it
//     has its own test rather than a comment.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { closeDb, getDb } from "../db/client";
import { access_grants, assessments, students, test_sessions } from "../db/schema";
import {
  authorizeAssessment,
  authorizeRubric,
  authorizeSitting,
} from "../lib/api/access";
import {
  createGrant,
  effectiveLevel,
  grantedLevel,
  listGrantsFor,
  listGrantsOnScope,
  loadActiveGrants,
  revokeGrant,
  validateGrantRequest,
} from "../lib/api/grants";
import { visibleAssessments } from "../lib/api/visibleAssessments";
import { adminEmails, isAdmin } from "../lib/auth/admin";
import type { SessionPayload } from "../lib/auth/session";

const OWNER: SessionPayload = {
  sub: "grants-owner",
  role: "staff",
  email: "lead@psd401.net",
} as SessionPayload;
const CO: SessionPayload = {
  sub: "grants-co",
  role: "staff",
  email: "coteacher@psd401.net",
} as SessionPayload;
const SUB: SessionPayload = {
  sub: "grants-sub",
  role: "staff",
  email: "substitute@psd401.net",
} as SessionPayload;
const OUTSIDER: SessionPayload = {
  sub: "grants-outsider",
  role: "staff",
  email: "outsider@psd401.net",
} as SessionPayload;
const ADMIN: SessionPayload = {
  sub: "grants-admin",
  role: "staff",
  email: "sysadmin@psd401.net",
} as SessionPayload;

const HOUR = 3_600_000;

beforeAll(() => {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.includes("secure_test_design_tool_test")) {
    throw new Error(`access-grants tests require the test DB; got: ${url}`);
  }
});

afterEach(async () => {
  const db = getDb();
  await db.execute(sql`truncate table access_grants restart identity cascade`);
  await db.execute(sql`truncate table assessments restart identity cascade`);
  await db.execute(sql`truncate table students restart identity cascade`);
  await db.execute(sql`truncate table rubrics restart identity cascade`);
  delete process.env.ADMIN_EMAILS;
});

afterAll(async () => {
  await closeDb();
});

const db = getDb();

async function makeAssessment(
  owner: SessionPayload = OWNER,
  overrides: Record<string, unknown> = {},
) {
  const [row] = await db
    .insert(assessments)
    .values({
      owner_sub: owner.sub,
      owner_email: owner.email ?? null,
      name: "Grant fixture",
      ...overrides,
    })
    .returning();
  return row!;
}

async function grant(values: {
  grantee_email: string;
  scope_kind: "assessment" | "teacher" | "school";
  scope_id: string;
  level: "view" | "run" | "edit" | "own";
  starts_at?: Date;
  ends_at?: Date | null;
  revoked_at?: Date | null;
}) {
  const [row] = await db
    .insert(access_grants)
    .values({
      grantee_email: values.grantee_email,
      scope_kind: values.scope_kind,
      scope_id: values.scope_id,
      level: values.level,
      starts_at: values.starts_at ?? new Date(Date.now() - HOUR),
      ends_at: values.ends_at ?? null,
      revoked_at: values.revoked_at ?? null,
      granted_by_sub: OWNER.sub,
      granted_by_email: OWNER.email!,
    })
    .returning();
  return row!;
}

// ── Resolution ──────────────────────────────────────────────────────────────

describe("grant resolution inside authorize*", () => {
  test("the owner still resolves own/owner and an outsider still gets 404", async () => {
    const a = await makeAssessment();
    const mine = await authorizeAssessment(db, OWNER, a.id, "own");
    expect(mine.ok).toBe(true);
    if (mine.ok) {
      expect(mine.level).toBe("own");
      expect(mine.via).toBe("owner");
      expect(mine.scope).toBeNull();
    }
    const theirs = await authorizeAssessment(db, OUTSIDER, a.id, "view");
    expect(theirs.ok).toBe(false);
    if (!theirs.ok) expect(theirs.response.status).toBe(404);
  });

  test("an admin resolves own via admin, without any grant row", async () => {
    process.env.ADMIN_EMAILS = ` ${ADMIN.email!.toUpperCase()} , `;
    expect(adminEmails()).toEqual([ADMIN.email!]);
    expect(isAdmin(ADMIN)).toBe(true);
    expect(isAdmin(OUTSIDER)).toBe(false);

    const a = await makeAssessment();
    const asAdmin = await authorizeAssessment(db, ADMIN, a.id, "own");
    expect(asAdmin.ok).toBe(true);
    if (asAdmin.ok) {
      expect(asAdmin.level).toBe("own");
      expect(asAdmin.via).toBe("admin");
    }
    // D-6 covers the per-teacher tables too: an admin reads the rubric shelf.
    const [rubric] = await db
      .insert((await import("../db/schema")).rubrics)
      .values({
        owner_sub: OWNER.sub,
        title: "Admin-readable rubric",
        rubric: { style: "holistic", criteria: [] },
      })
      .returning();
    const asAdminRubric = await authorizeRubric(db, ADMIN, rubric!.id, "view");
    expect(asAdminRubric.ok).toBe(true);
    // …and a co-teacher's assessment grant does NOT reach it.
    await grant({
      grantee_email: CO.email!,
      scope_kind: "assessment",
      scope_id: a.id,
      level: "edit",
    });
    const coRubric = await authorizeRubric(db, CO, rubric!.id, "view");
    expect(coRubric.ok).toBe(false);
  });

  test("an assessment grant resolves at each level, and only up to it", async () => {
    const a = await makeAssessment();
    const ladder = [
      { level: "view", allowed: ["view"], refused: ["run", "edit", "own"] },
      { level: "run", allowed: ["view", "run"], refused: ["edit", "own"] },
      { level: "edit", allowed: ["view", "run", "edit"], refused: ["own"] },
      { level: "own", allowed: ["view", "run", "edit", "own"], refused: [] },
    ] as const;
    for (const step of ladder) {
      await db.delete(access_grants);
      await grant({
        grantee_email: CO.email!,
        scope_kind: "assessment",
        scope_id: a.id,
        level: step.level,
      });
      for (const need of step.allowed) {
        const access = await authorizeAssessment(db, CO, a.id, need);
        expect(access.ok).toBe(true);
        if (access.ok) {
          expect(access.level).toBe(step.level);
          expect(access.via).toBe("grant");
          expect(access.scope).toBe("assessment");
        }
      }
      for (const need of step.refused) {
        const access = await authorizeAssessment(db, CO, a.id, need);
        expect(access.ok).toBe(false);
        // The refusal is the SAME 404 as a missing row — a `view` grantee must
        // not learn from the status code that the assessment exists and they
        // are merely under-levelled (D-3).
        if (!access.ok) expect(access.response.status).toBe(404);
      }
    }
  });

  test("a view grantee gets 404 on an edit route's level and 200 on a view route's", async () => {
    // The ladder stated the way the routes use it: the review-queue GET asks
    // for `view`, the items routes ask for `edit`.
    const a = await makeAssessment();
    await grant({
      grantee_email: CO.email!,
      scope_kind: "assessment",
      scope_id: a.id,
      level: "view",
    });
    expect((await authorizeAssessment(db, CO, a.id, "view")).ok).toBe(true);
    const edit = await authorizeAssessment(db, CO, a.id, "edit");
    expect(edit.ok).toBe(false);
    if (!edit.ok) expect(edit.response.status).toBe(404);
  });

  test("expired, future-dated and revoked grants confer nothing", async () => {
    const a = await makeAssessment();
    const cases = [
      { label: "expired", ends_at: new Date(Date.now() - HOUR) },
      { label: "future", starts_at: new Date(Date.now() + HOUR) },
      { label: "revoked", revoked_at: new Date() },
    ];
    for (const c of cases) {
      await db.delete(access_grants);
      await grant({
        grantee_email: CO.email!,
        scope_kind: "assessment",
        scope_id: a.id,
        level: "edit",
        ...c,
      });
      const access = await authorizeAssessment(db, CO, a.id, "view");
      expect(access.ok).toBe(false);
      expect((await loadActiveGrants(db, CO.email)).empty).toBe(true);
    }
    // A grant whose window is open on both ends does resolve, so the three
    // above are failing for their own reason and not because the fixture is
    // broken.
    await db.delete(access_grants);
    await grant({
      grantee_email: CO.email!,
      scope_kind: "assessment",
      scope_id: a.id,
      level: "edit",
      ends_at: new Date(Date.now() + HOUR),
    });
    expect((await authorizeAssessment(db, CO, a.id, "edit")).ok).toBe(true);
  });

  test("a teacher-scope grant resolves through the assessment's owner_email", async () => {
    const a = await makeAssessment();
    await grant({
      grantee_email: SUB.email!,
      scope_kind: "teacher",
      scope_id: OWNER.email!,
      level: "run",
    });
    const access = await authorizeAssessment(db, SUB, a.id, "run");
    expect(access.ok).toBe(true);
    if (access.ok) {
      expect(access.level).toBe("run");
      expect(access.via).toBe("grant");
      expect(access.scope).toBe("teacher");
    }
    // `run` does not reach `edit`: a substitute runs the day, they do not author.
    expect((await authorizeAssessment(db, SUB, a.id, "edit")).ok).toBe(false);

    // The deviation the note records: an assessment whose owner_email is still
    // NULL (nothing has written it since the 0038 backfill) resolves no
    // teacher-scope grant at all.
    const legacy = await makeAssessment(OWNER, { owner_email: null });
    expect((await authorizeAssessment(db, SUB, legacy.id, "view")).ok).toBe(false);
  });

  test("a school-scope grant confers nothing (D-7 deferred)", async () => {
    const a = await makeAssessment();
    await grant({
      grantee_email: OUTSIDER.email!,
      scope_kind: "school",
      scope_id: "1000",
      level: "view",
      ends_at: new Date(Date.now() + HOUR),
    });
    // Stored…
    expect(await listGrantsFor(db, OUTSIDER.email!)).toHaveLength(1);
    // …and inert: neither the loaded set nor the helper sees it.
    const grants = await loadActiveGrants(db, OUTSIDER.email);
    expect(grants.empty).toBe(true);
    expect(grantedLevel(grants, a)).toBeNull();
    expect((await authorizeAssessment(db, OUTSIDER, a.id, "view")).ok).toBe(false);
    const rows = await visibleAssessments(db, OUTSIDER);
    expect(rows).toEqual([]);
  });

  test("the higher of two covering grants wins, and reports its scope", async () => {
    const a = await makeAssessment();
    await grant({
      grantee_email: CO.email!,
      scope_kind: "teacher",
      scope_id: OWNER.email!,
      level: "run",
    });
    await grant({
      grantee_email: CO.email!,
      scope_kind: "assessment",
      scope_id: a.id,
      level: "edit",
    });
    const resolved = await effectiveLevel(db, CO, a);
    expect(resolved).toEqual({ level: "edit", via: "grant", scope: "assessment" });
  });

  test("a sitting and its attempts resolve through the assessment's grant", async () => {
    const a = await makeAssessment();
    const [sitting] = await db
      .insert(test_sessions)
      .values({
        assessment_id: a.id,
        owner_sub: OWNER.sub,
        owner_email: OWNER.email,
        code: `G${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
        expires_at: new Date(Date.now() + HOUR),
      })
      .returning();
    // Before the grant: invisible, even though the sitting exists.
    expect((await authorizeSitting(db, CO, sitting!.id, "view")).ok).toBe(false);
    await grant({
      grantee_email: CO.email!,
      scope_kind: "assessment",
      scope_id: a.id,
      level: "edit",
    });
    const access = await authorizeSitting(db, CO, sitting!.id, "run");
    expect(access.ok).toBe(true);
    if (access.ok) expect(access.sitting.id).toBe(sitting!.id);
  });
});

// ── List widening ───────────────────────────────────────────────────────────

describe("assessments I can see = owned ∪ granted", () => {
  test("a grantee sees the row with via grant; an outsider does not", async () => {
    const mine = await makeAssessment();
    const theirs = await makeAssessment(OUTSIDER);
    await grant({
      grantee_email: CO.email!,
      scope_kind: "assessment",
      scope_id: mine.id,
      level: "edit",
    });

    const asOwner = await visibleAssessments(db, OWNER);
    expect(asOwner.map((r) => r.id)).toEqual([mine.id]);
    expect(asOwner[0]!.access).toEqual({ level: "own", via: "owner" });

    const asCo = await visibleAssessments(db, CO);
    expect(asCo.map((r) => r.id)).toEqual([mine.id]);
    expect(asCo[0]!.access).toEqual({
      level: "edit",
      via: "grant",
      owner_email: OWNER.email,
    });

    // The outsider sees only their own row, not the one they hold no grant on.
    const asOutsider = await visibleAssessments(db, OUTSIDER);
    expect(asOutsider.map((r) => r.id)).toEqual([theirs.id]);
  });

  test("a teacher-scope grant widens the list to every assessment that teacher owns", async () => {
    const first = await makeAssessment();
    const second = await makeAssessment();
    await grant({
      grantee_email: SUB.email!,
      scope_kind: "teacher",
      scope_id: OWNER.email!,
      level: "run",
    });
    const rows = await visibleAssessments(db, SUB);
    expect(new Set(rows.map((r) => r.id))).toEqual(new Set([first.id, second.id]));
    for (const row of rows) {
      expect(row.access.level).toBe("run");
      expect(row.access.via).toBe("grant");
    }
  });

  test("archived semantics are unchanged for a grantee", async () => {
    const live = await makeAssessment();
    const archived = await makeAssessment(OWNER, { archived_at: new Date() });
    for (const id of [live.id, archived.id]) {
      await grant({
        grantee_email: CO.email!,
        scope_kind: "assessment",
        scope_id: id,
        level: "edit",
      });
    }
    expect((await visibleAssessments(db, CO)).map((r) => r.id)).toEqual([live.id]);
    expect(
      (await visibleAssessments(db, CO, { archived: true })).map((r) => r.id),
    ).toEqual([archived.id]);
  });

  // Slice 5a (docs/access-model-design.md, D-6 clarified 2026-09-21): the
  // admin's default LIST is the same owned ∪ granted scope as anyone else —
  // "My assessments" — and `{ all: true }` is the explicit widening to
  // every teacher's rows. `authorizeAssessment`'s admin-always-`own`
  // resolution (tested above) is unchanged; this is the list only.
  test("by default an admin's list is just their own, like anyone else", async () => {
    process.env.ADMIN_EMAILS = ADMIN.email!;
    await makeAssessment();
    const adminOwn = await makeAssessment(ADMIN);
    const rows = await visibleAssessments(db, ADMIN);
    expect(rows.map((r) => r.id)).toEqual([adminOwn.id]);
    expect(rows[0]!.access).toEqual({ level: "own", via: "owner" });
  });

  test("with { all: true } an admin sees every assessment, own rows still marked owner", async () => {
    process.env.ADMIN_EMAILS = ADMIN.email!;
    await makeAssessment();
    const adminOwn = await makeAssessment(ADMIN);
    const rows = await visibleAssessments(db, ADMIN, { all: true });
    expect(rows).toHaveLength(2);
    const own = rows.find((r) => r.id === adminOwn.id)!;
    expect(own.access.via).toBe("owner");
    expect(rows.find((r) => r.id !== adminOwn.id)!.access.via).toBe("admin");
  });

  test("{ all: true } is ignored for a non-admin — the normal owned ∪ granted set", async () => {
    const mine = await makeAssessment();
    await makeAssessment(OUTSIDER);
    const rows = await visibleAssessments(db, OWNER, { all: true });
    expect(rows.map((r) => r.id)).toEqual([mine.id]);
  });
});

// ── The grants API's own rules ──────────────────────────────────────────────

describe("grant creation rules", () => {
  test("the grantee must be staff, and never yourself", async () => {
    const student = validateGrantRequest({
      granter: OWNER,
      grantee_email: "someone@edtools.psd401.net",
      level: "edit",
    });
    expect(student).toEqual({ ok: false, error: "grantee_not_staff" });

    const outside = validateGrantRequest({
      granter: OWNER,
      grantee_email: "someone@example.com",
      level: "edit",
    });
    expect(outside).toEqual({ ok: false, error: "grantee_not_staff" });

    const blank = validateGrantRequest({
      granter: OWNER,
      grantee_email: "   ",
      level: "edit",
    });
    expect(blank).toEqual({ ok: false, error: "invalid_email" });

    const self = validateGrantRequest({
      granter: OWNER,
      grantee_email: OWNER.email!.toUpperCase(),
      level: "edit",
    });
    expect(self).toEqual({ ok: false, error: "self_grant" });

    const ok = validateGrantRequest({
      granter: OWNER,
      grantee_email: ` ${CO.email!.toUpperCase()} `,
      level: "edit",
    });
    expect(ok).toEqual({ ok: true, grantee_email: CO.email! });
  });

  test("own is admin-only to grant", async () => {
    expect(
      validateGrantRequest({ granter: OWNER, grantee_email: CO.email!, level: "own" }),
    ).toEqual({ ok: false, error: "level_not_allowed" });

    process.env.ADMIN_EMAILS = ADMIN.email!;
    expect(
      validateGrantRequest({ granter: ADMIN, grantee_email: CO.email!, level: "own" }),
    ).toEqual({ ok: true, grantee_email: CO.email! });
  });

  test("a second live grant on the same scope is already_granted, and revoke frees it", async () => {
    const a = await makeAssessment();
    const first = await createGrant(db, {
      grantee_email: CO.email!,
      scope_kind: "assessment",
      scope_id: a.id,
      level: "edit",
      granted_by_sub: OWNER.sub,
      granted_by_email: OWNER.email!,
    });
    expect(first.ok).toBe(true);

    const second = await createGrant(db, {
      grantee_email: CO.email!,
      scope_kind: "assessment",
      scope_id: a.id,
      level: "view",
      granted_by_sub: OWNER.sub,
      granted_by_email: OWNER.email!,
    });
    expect(second).toEqual({ ok: false, error: "already_granted" });

    expect(await listGrantsOnScope(db, "assessment", a.id)).toHaveLength(1);

    // Revoking is soft: the row stays, the access goes, and the scope is free
    // for a new grant at a different level.
    const revoked = await revokeGrant(db, first.ok ? first.grant.id : "", {
      scope_kind: "assessment",
      scope_id: a.id,
    });
    expect(revoked?.revoked_at).not.toBeNull();
    expect((await authorizeAssessment(db, CO, a.id, "view")).ok).toBe(false);
    expect(await listGrantsOnScope(db, "assessment", a.id)).toHaveLength(0);
    expect(await listGrantsFor(db, CO.email!)).toHaveLength(1);

    const third = await createGrant(db, {
      grantee_email: CO.email!,
      scope_kind: "assessment",
      scope_id: a.id,
      level: "view",
      granted_by_sub: OWNER.sub,
      granted_by_email: OWNER.email!,
    });
    expect(third.ok).toBe(true);
  });

  test("revoke is scoped, so an id from another assessment does nothing", async () => {
    const mine = await makeAssessment();
    const other = await makeAssessment(OUTSIDER);
    const onOther = await grant({
      grantee_email: CO.email!,
      scope_kind: "assessment",
      scope_id: other.id,
      level: "edit",
    });
    expect(
      await revokeGrant(db, onOther.id, {
        scope_kind: "assessment",
        scope_id: mine.id,
      }),
    ).toBeNull();
    // Unscoped (the admin surface) it does revoke, and a second call is a no-op
    // rather than an error — the button is idempotent.
    expect(await revokeGrant(db, onOther.id)).not.toBeNull();
    expect(await revokeGrant(db, onOther.id)).toBeNull();
  });
});

// ── Sitting creation under a grant (D-5) ────────────────────────────────────

describe("a sitting created under a grant", () => {
  test("a co-teacher's sitting is THEIRS; a substitute's stays the teacher's", async () => {
    const a = await makeAssessment(OWNER, { status: "published" });

    // The two branches POST /api/test-sessions chooses between, asserted on the
    // resolved access rather than through the route, which needs a roster and a
    // signed session; the route's own rows are hand-run.
    await grant({
      grantee_email: CO.email!,
      scope_kind: "assessment",
      scope_id: a.id,
      level: "edit",
    });
    const asCo = await authorizeAssessment(db, CO, a.id, "run");
    expect(asCo.ok).toBe(true);
    if (asCo.ok) {
      const coveringForTeacher = asCo.via === "grant" && asCo.scope === "teacher";
      expect(coveringForTeacher).toBe(false);
    }

    await grant({
      grantee_email: SUB.email!,
      scope_kind: "teacher",
      scope_id: OWNER.email!,
      level: "run",
    });
    const asSub = await authorizeAssessment(db, SUB, a.id, "run");
    expect(asSub.ok).toBe(true);
    if (asSub.ok) {
      const coveringForTeacher = asSub.via === "grant" && asSub.scope === "teacher";
      expect(coveringForTeacher).toBe(true);
      // What the route writes in that branch.
      expect(asSub.assessment.owner_sub).toBe(OWNER.sub);
      expect(asSub.assessment.owner_email).toBe(OWNER.email!);
    }
  });

  test("created_by_sub records the caller beside the sitting's owner", async () => {
    const a = await makeAssessment();
    const [sitting] = await db
      .insert(test_sessions)
      .values({
        assessment_id: a.id,
        owner_sub: OWNER.sub,
        owner_email: OWNER.email,
        created_by_sub: SUB.sub,
        code: `C${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
        expires_at: new Date(Date.now() + HOUR),
      })
      .returning();
    expect(sitting!.owner_sub).toBe(OWNER.sub);
    expect(sitting!.created_by_sub).toBe(SUB.sub);
    // Audit only: the column does not authorize. The sub reaches the sitting
    // through their teacher-scope grant, and without one they do not.
    expect((await authorizeSitting(db, SUB, sitting!.id, "run")).ok).toBe(false);
    await grant({
      grantee_email: SUB.email!,
      scope_kind: "teacher",
      scope_id: OWNER.email!,
      level: "run",
    });
    expect((await authorizeSitting(db, SUB, sitting!.id, "run")).ok).toBe(true);
    await db.delete(test_sessions).where(eq(test_sessions.id, sitting!.id));
    await db.delete(students);
  });
});
