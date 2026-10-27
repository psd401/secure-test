// Graphing calculator D-9 (slice 7): the "graph it" item type in the design
// tool — writes and their validation, the publish lock's key door, scoring,
// points, the teacher's readback, the response gate, delivery (no key) and
// export / import. Pure functions are called directly; the API on the test DB.
import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { DeliveryBundleSchema, ItemBundleSchema, type ItemResponse } from "@secure-test/schema";
import { closeDb, getDb } from "../db/client";
import { assessments, items, type ItemRow } from "../db/schema";
import { SESSION_COOKIE_NAME } from "../lib/auth/session";
import * as headersMod from "next/headers";
import * as sessionMod from "../lib/auth/session";
import { buildExportBundle } from "../lib/api/exportBundle";
import { importBundleForOwner, isImportBundleError } from "../lib/api/importBundle";
import { unsealResponseIds } from "../lib/api/studentAttempt";
import { correctAnswerText, yourAnswerText } from "../lib/feedback/buildFeedback";
import { requiredClientUpgrade } from "../lib/items/clientSupport";
import { describeAnswer } from "../lib/reporting/answerView";
import { scoreResponse } from "../lib/scoring/auto";
import { itemMaxPoints } from "../lib/scoring/results";

const TEACHER = "graph-teacher";
const TEACHER_EMAIL = "graph-teacher@example.org";
type Principal = { sub: string; role: string; email?: string } | null;
let principal: Principal = null;

mock.module("next/headers", () => ({
  ...headersMod,
  headers: async () => new Headers(),
  cookies: async () => ({
    get: (name: string) => (principal && name === SESSION_COOKIE_NAME ? { value: "x" } : undefined),
  }),
}));
mock.module("../lib/auth/session", () => ({ ...sessionMod, readSessionFromCookies: async () => principal }));

beforeAll(() => {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.includes("secure_test_design_tool_test")) throw new Error(`graph tests require the test DB; got: ${url}`);
});
afterEach(async () => {
  principal = null;
  await getDb().execute(sql`truncate table assessments restart identity cascade`);
});
afterAll(async () => {
  await closeDb();
});

const BOARD = { x: [-10, 10] as [number, number], y: [-10, 10] as [number, number], grid: 1, snap: "1", tools: ["point" as const, "line" as const], max_objects: 2 };
const LINE = { tool: "line" as const, points: [[0, 1], [1, 3]] as [number, number][] };
const POINT = { tool: "point" as const, points: [[2, 2]] as [number, number][] };

function row(config: Record<string, unknown>): ItemRow {
  return {
    id: "item-1",
    assessment_id: "a",
    position: 0,
    type: "graph",
    stem: "Graph y = 2x + 1.",
    choices: [],
    correct_choice_ids: [],
    correct_answer: null,
    config,
    standards: [],
  } as unknown as ItemRow;
}
const response = (objects: unknown[]) => ({ type: "graph", objects }) as unknown as ItemResponse;

describe("scoring, points and readback (pure)", () => {
  test("all-or-nothing: 1 point for the line through any two of its points", () => {
    const item = row({ graph_board: BOARD, graph_key: { objects: [LINE], scoring: "all" } });
    expect(scoreResponse(item, response([{ tool: "line", points: [[2, 5], [-1, -1]] }]))).toEqual({ points: 1, max_points: 1 });
    expect(scoreResponse(item, response([LINE, POINT]))).toEqual({ points: 0, max_points: 1 });
    expect(itemMaxPoints(item)).toBe(1);
  });

  test("per object: a point per key shape", () => {
    const item = row({ graph_board: BOARD, graph_key: { objects: [LINE, POINT], scoring: "per_object" } });
    expect(scoreResponse(item, response([LINE]))).toEqual({ points: 1, max_points: 2 });
    expect(itemMaxPoints(item)).toBe(2);
  });

  test("no key: not auto-scored", () => {
    expect(scoreResponse(row({ graph_board: BOARD }), response([LINE]))).toBeNull();
    expect(itemMaxPoints(row({ graph_board: BOARD }))).toBe(1);
  });

  test("the teacher reads the answer in words, marked against the key", () => {
    const item = row({ graph_board: BOARD, graph_key: { objects: [LINE], scoring: "all" } });
    expect(describeAnswer(item as never, { type: "graph", objects: [LINE, POINT] })).toEqual({
      kind: "lines",
      lines: [
        { text: "y = 2x + 1", correct: true },
        { text: "point (2, 2)", correct: false },
      ],
    });
    expect(describeAnswer(item as never, { type: "graph", objects: [] })).toEqual({
      kind: "lines",
      lines: [{ text: "Nothing placed", correct: null }],
    });
    expect(yourAnswerText(item as never, { type: "graph", objects: [LINE] })).toBe("y = 2x + 1");
    expect(correctAnswerText(item as never)).toBe("y = 2x + 1");
    expect(correctAnswerText(row({ graph_board: BOARD }) as never)).toBeNull();
  });

  test("the response gate: tools, count and shapes must fit the board", () => {
    const item = row({ graph_board: BOARD });
    expect(unsealResponseIds("att", item, response([LINE, POINT]))).toEqual(response([LINE, POINT]));
    expect(unsealResponseIds("att", item, response([]))).toEqual(response([]));
    expect(unsealResponseIds("att", item, response([LINE, POINT, POINT]))).toBeNull();
    expect(unsealResponseIds("att", item, response([{ tool: "circle", points: [[0, 0], [1, 1]] }]))).toBeNull();
    expect(unsealResponseIds("att", item, response([{ tool: "point", points: [[0.5, 0]] }]))).toBeNull();
    expect(unsealResponseIds("att", item, response([{ tool: "line", points: [[1, 1], [1, 1]] }]))).toBeNull();
  });

  test("the type gate: 2.0.0", () => {
    expect(requiredClientUpgrade("1.6.3", ["graph"])).toBe("2.0.0");
    expect(requiredClientUpgrade("2.0.0", ["graph"])).toBeNull();
  });
});

describe("the item API", () => {
  async function seedAssessment(status: "draft" | "published" = "draft") {
    const [a] = await getDb()
      .insert(assessments)
      .values({ owner_sub: TEACHER, owner_email: TEACHER_EMAIL, name: "Graphs", status })
      .returning();
    return a!;
  }
  const asTeacher = () => {
    principal = { sub: TEACHER, role: "staff", email: TEACHER_EMAIL };
  };
  async function post(assessmentId: string, body: unknown) {
    const { POST } = await import("../app/api/assessments/[id]/items/route");
    return POST(
      new Request("http://localhost/x", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
      { params: Promise.resolve({ id: assessmentId }) },
    );
  }
  async function patch(assessmentId: string, itemId: string, body: unknown) {
    const { PATCH } = await import("../app/api/assessments/[id]/items/[itemId]/route");
    return PATCH(
      new Request("http://localhost/x", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
      { params: Promise.resolve({ id: assessmentId, itemId }) },
    );
  }
  const base = { type: "graph", stem: "Graph y = 2x + 1.", board: BOARD };

  test("create with and without a key; the stored config", async () => {
    const a = await seedAssessment();
    asTeacher();
    expect((await post(a.id, base)).status).toBe(201);
    const res = await post(a.id, { ...base, key: { objects: [LINE], scoring: "all" } });
    expect(res.status).toBe(201);
    const rows = await getDb().select().from(items).where(eq(items.assessment_id, a.id)).orderBy(items.position);
    expect(rows[0]!.config).toEqual({ graph_board: BOARD });
    expect(rows[1]!.config).toEqual({ graph_board: BOARD, graph_key: { objects: [LINE], scoring: "all" } });
  });

  test("a key that doesn't fit the board is a 400", async () => {
    const a = await seedAssessment();
    asTeacher();
    const bad = async (key: unknown, board: unknown = BOARD) => (await post(a.id, { ...base, board, key })).status;
    expect(await bad({ objects: [{ tool: "circle", points: [[0, 0], [1, 1]] }], scoring: "all" })).toBe(400);
    expect(await bad({ objects: [{ tool: "point", points: [[0.5, 0]] }], scoring: "all" })).toBe(400);
    expect(await bad({ objects: [{ tool: "point", points: [[20, 0]] }], scoring: "all" })).toBe(400);
    expect(await bad({ objects: [POINT, LINE, { tool: "point", points: [[1, 1]] }], scoring: "all" })).toBe(400);
    expect(await bad(null, { ...BOARD, snap: "zero" })).toBe(400);
    expect(await bad(null, { ...BOARD, x: [5, -5] })).toBe(400);
    expect(await bad(null, { ...BOARD, grid: 0.01 })).toBe(400);
  });

  test("published: the key may change, the board may not", async () => {
    const a = await seedAssessment();
    asTeacher();
    const created = await (await post(a.id, { ...base, key: { objects: [LINE], scoring: "all" } })).json();
    await getDb().update(assessments).set({ status: "published" }).where(eq(assessments.id, a.id));
    const id = created.item.id;
    expect((await patch(a.id, id, { ...base, key: { objects: [POINT], scoring: "per_object" } })).status).toBe(200);
    expect((await patch(a.id, id, { ...base, board: { ...BOARD, max_objects: 3 } })).status).toBe(409);
  });

  test("delivery has the board and never the key; export / import keep the key", async () => {
    const a = await seedAssessment();
    asTeacher();
    await post(a.id, { ...base, key: { objects: [LINE], scoring: "all" } });
    const built = await buildExportBundle(getDb(), a, TEACHER, true);
    if (!built.ok) throw new Error("export failed");
    expect(ItemBundleSchema.parse(built.bundle).items[0]).toMatchObject({ type: "graph", board: BOARD, key: { objects: [LINE], scoring: "all" } });
    const imported = await importBundleForOwner(built.bundle, TEACHER, TEACHER_EMAIL);
    if (isImportBundleError(imported)) throw new Error(imported.error);
    const [back] = await getDb().select().from(items).where(eq(items.assessment_id, imported.assessment_id));
    expect(back!.config).toEqual({ graph_board: BOARD, graph_key: { objects: [LINE], scoring: "all" } });
    // The delivery schema has no place for a key at all.
    const delivered = DeliveryBundleSchema.parse({
      test_id: "t",
      title: "t",
      items: [{ type: "graph", id: "g", stem: "s", board: BOARD, key: { objects: [LINE], scoring: "all" } }],
    });
    expect("key" in delivered.items[0]!).toBe(false);
  });
});
