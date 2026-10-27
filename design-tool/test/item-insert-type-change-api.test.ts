// R-6 (docs/editor-redesign-design.md, Phase 4 slice B): the server side of the
// new editor's insertion and in-place type change, both behind the R-12 flag.
// - An empty stem is accepted on create and update only with the flag on.
// - A new question goes where the "+" was via the EXISTING reorder route.
// - A type change is accepted only with the flag on, only in draft, and not
//   once students have answered; it starts the config afresh and history
//   keeps the version it replaced (so History can restore across types).
// Same harness as item-history-api.test.ts.
import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { asc, eq, sql } from "drizzle-orm";
import { assessments, attempts, item_snapshots, items, responses, students } from "../db/schema";
import { closeDb, getDb } from "../db/client";
import { SESSION_COOKIE_NAME, type SessionPayload } from "../lib/auth/session";
import * as sessionMod from "../lib/auth/session";
import { setNewAuthoring } from "../lib/authoring/flag";

const expectTestDb = () => {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.includes("secure_test_design_tool_test")) {
    throw new Error(`insert / type-change tests require the test DB DATABASE_URL; got: ${url}`);
  }
};

let originalSessionSecret: string | undefined;
let mockSub: string | null = null;

mock.module("next/headers", () => ({
  headers: async () => new Headers(),
  cookies: async () => ({
    get: (name: string) => (mockSub && name === SESSION_COOKIE_NAME ? { value: "x" } : undefined),
  }),
}));

mock.module("../lib/auth/session", () => ({
  ...sessionMod,
  readSessionFromCookies: async () => (mockSub ? { sub: mockSub, role: "staff" } : null),
}));

const OLD = "teacher-old-editor";
const NEW = "teacher-new-editor";

beforeAll(() => {
  expectTestDb();
  originalSessionSecret = process.env.DESIGN_TOOL_SESSION_SECRET;
  process.env.DESIGN_TOOL_SESSION_SECRET = "test-session-secret-do-not-use";
});

afterEach(async () => {
  mockSub = null;
  await getDb().execute(sql`truncate table assessments restart identity cascade`);
  await getDb().execute(sql`truncate table staff_preferences`);
  await getDb().delete(students).where(eq(students.owner_sub, NEW));
});

afterAll(async () => {
  await closeDb();
  if (originalSessionSecret === undefined) delete process.env.DESIGN_TOOL_SESSION_SECRET;
  else process.env.DESIGN_TOOL_SESSION_SECRET = originalSessionSecret;
});

async function asTeacher(sub: string, newAuthoring: boolean) {
  mockSub = sub;
  if (newAuthoring) await setNewAuthoring(getDb(), { sub, role: "staff" } as SessionPayload, true);
}

async function createAssessment(): Promise<string> {
  const { POST } = await import("../app/api/assessments/route");
  const res = await POST(
    new Request("http://localhost/api/assessments", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Insert and type change" }),
    }),
  );
  expect(res.status).toBe(201);
  return ((await res.json()) as { assessment: { id: string } }).assessment.id;
}

async function postItem(assessmentId: string, body: unknown) {
  const { POST } = await import("../app/api/assessments/[id]/items/route");
  return POST(
    new Request(`http://localhost/api/assessments/${assessmentId}/items`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: assessmentId }) },
  );
}

async function createItem(assessmentId: string, body: unknown): Promise<string> {
  const res = await postItem(assessmentId, body);
  expect(res.status).toBe(201);
  return ((await res.json()) as { item: { id: string } }).item.id;
}

async function patchItem(assessmentId: string, itemId: string, body: unknown, query = "") {
  const { PATCH } = await import("../app/api/assessments/[id]/items/[itemId]/route");
  return PATCH(
    new Request(`http://localhost/api/assessments/${assessmentId}/items/${itemId}${query}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: assessmentId, itemId }) },
  );
}

async function reorder(assessmentId: string, orderedIds: string[]) {
  const { POST } = await import("../app/api/assessments/[id]/items/reorder/route");
  return POST(
    new Request(`http://localhost/api/assessments/${assessmentId}/items/reorder`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ordered_ids: orderedIds }),
    }),
    { params: Promise.resolve({ id: assessmentId }) },
  );
}

async function errorOf(res: Response) {
  return ((await res.json()) as { error: string }).error;
}

const EMPTY_MC = {
  type: "multiple_choice_single",
  stem: "",
  choices: [
    { id: "a", text: "" },
    { id: "b", text: "" },
  ],
  correct_choice_ids: [],
};

const MC = {
  type: "multiple_choice_single",
  stem: "Which is a prime?",
  choices: [
    { id: "a", text: "4" },
    { id: "b", text: "7" },
  ],
  correct_choice_ids: ["b"],
  scoring_method: "human",
  standards: ["Unit 2"],
};

describe("empty new questions (UX3-1)", () => {
  test("flag off: an empty stem is refused on create and update, as today", async () => {
    await asTeacher(OLD, false);
    const a = await createAssessment();
    const res = await postItem(a, EMPTY_MC);
    expect(res.status).toBe(400);
    const id = await createItem(a, MC);
    expect((await patchItem(a, id, { ...MC, stem: "" })).status).toBe(400);
  });

  test("flag on: an empty question saves, and only the stem rule is relaxed", async () => {
    await asTeacher(NEW, true);
    const a = await createAssessment();
    const id = await createItem(a, EMPTY_MC);
    const [row] = await getDb().select().from(items).where(eq(items.id, id));
    expect(row!.stem).toBe("");
    expect(row!.choices).toEqual(EMPTY_MC.choices);
    // Typing then clearing the stem autosaves too.
    expect((await patchItem(a, id, { ...EMPTY_MC, stem: "Draft" })).status).toBe(200);
    expect((await patchItem(a, id, EMPTY_MC)).status).toBe(200);
    // Every other rule still applies.
    expect((await postItem(a, { ...EMPTY_MC, choices: [{ id: "a", text: "" }] })).status).toBe(400);
  });

  test("a new question lands where the '+' was through the existing reorder route", async () => {
    await asTeacher(NEW, true);
    const a = await createAssessment();
    const q1 = await createItem(a, MC);
    const q2 = await createItem(a, MC);
    const inserted = await createItem(a, EMPTY_MC);
    expect((await reorder(a, [q1, inserted, q2])).status).toBe(200);
    const rows = await getDb().select().from(items).where(eq(items.assessment_id, a)).orderBy(asc(items.position));
    expect(rows.map((r) => r.id)).toEqual([q1, inserted, q2]);
  });
});

describe("in-place type change (R-6)", () => {
  const ESSAY = { type: "essay", stem: "Which is a prime?", choices: [], correct_choice_ids: [], scoring_method: null, standards: ["Unit 2"] };

  test("flag off: still type_change_not_supported", async () => {
    await asTeacher(OLD, false);
    const a = await createAssessment();
    const id = await createItem(a, MC);
    const res = await patchItem(a, id, ESSAY);
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toBe("type_change_not_supported");
  });

  test("flag on: the type changes, the config starts afresh, and history keeps the old type", async () => {
    await asTeacher(NEW, true);
    const a = await createAssessment();
    const id = await createItem(a, MC);
    // The editor sends a type change with ?restore=1 so the old version is always kept.
    const res = await patchItem(a, id, { ...ESSAY, scoring_method: undefined }, "?restore=1");
    expect(res.status).toBe(200);
    const [row] = await getDb().select().from(items).where(eq(items.id, id));
    expect(row!.type).toBe("essay");
    expect(row!.stem).toBe(MC.stem);
    expect(row!.choices).toEqual([]);
    // "human" was the MC's pick; an omitted method on a type change is not carried over.
    expect(row!.config).toEqual({});
    expect(row!.standards).toEqual(["Unit 2"]);
    const snaps = await getDb().select().from(item_snapshots).where(eq(item_snapshots.item_id, id));
    expect(snaps).toHaveLength(1);
    expect((snaps[0]!.content as { type: string }).type).toBe("multiple_choice_single");
    // Restoring that version is itself a type change back.
    expect((await patchItem(a, id, MC, "?restore=1")).status).toBe(200);
    const [back] = await getDb().select().from(items).where(eq(items.id, id));
    expect(back!.type).toBe("multiple_choice_single");
    expect(back!.correct_choice_ids).toEqual(["b"]);
    expect(back!.config).toEqual({ scoring_method: "human" });
  });

  test("published: the publish lock refuses a type change", async () => {
    await asTeacher(NEW, true);
    const a = await createAssessment();
    const id = await createItem(a, MC);
    await getDb().update(assessments).set({ status: "published" }).where(eq(assessments.id, a));
    const res = await patchItem(a, id, ESSAY);
    expect(res.status).toBe(409);
    expect(await errorOf(res)).toBe("assessment_published_editing_locked");
  });

  test("answered: refused, so students' answers keep their shape", async () => {
    await asTeacher(NEW, true);
    const a = await createAssessment();
    const id = await createItem(a, MC);
    const db = getDb();
    const [student] = await db.insert(students).values({ owner_sub: NEW, ssid: "fixture-1", name: "Fixture" }).returning();
    const [attempt] = await db
      .insert(attempts)
      .values({ assessment_id: a, student_id: student!.id, status: "submitted", submitted_at: new Date() })
      .returning();
    await db
      .insert(responses)
      .values({ attempt_id: attempt!.id, item_id: id, response: { type: "multiple_choice_single", choice_id: "b" } });
    const res = await patchItem(a, id, ESSAY);
    expect(res.status).toBe(409);
    expect(await errorOf(res)).toBe("type_change_has_responses");
    const [row] = await db.select().from(items).where(eq(items.id, id));
    expect(row!.type).toBe("multiple_choice_single");
    // An ordinary edit of the same question still saves.
    expect((await patchItem(a, id, { ...MC, stem: "Edited" })).status).toBe(200);
  });
});
