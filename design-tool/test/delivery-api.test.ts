// Slice 51: the student delivery bundle. The load-bearing assertion in this
// file is negative — no answer key may appear anywhere in the response body for
// any item type. /export keeps its keys because teacher-to-teacher share
// round-trips through /api/assessments/import; this route is the other
// audience.
import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { eq, inArray, sql } from "drizzle-orm";
import { DeliveryBundleSchema, type ItemResponse, type Rubric } from "@secure-test/schema";
import { closeDb, getDb } from "../db/client";
import {
  assessments,
  attempts,
  item_sets,
  items,
  response_uploads,
  responses,
  students,
} from "../db/schema";
import { MATCH_LEFT, MATCH_RIGHT, opaqueId } from "../lib/api/opaqueIds";
import { SESSION_COOKIE_NAME } from "../lib/auth/session";
import * as sessionMod from "../lib/auth/session";
import {
  OTHER_STUDENT,
  STUDENT,
  TEACHER_EMAIL,
  OTHER_TEACHER_EMAIL,
  clearRoster,
  seedRoster,
  studentPrincipal,
} from "./helpers/roster";

const expectTestDb = () => {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.includes("secure_test_design_tool_test")) {
    throw new Error(`delivery-api tests require the test DB DATABASE_URL; got: ${url}`);
  }
};

const OWNER = "delivery-teacher";

type Principal = { sub: string; role: string; email?: string } | null;
let principal: Principal = studentPrincipal();

mock.module("next/headers", () => ({
  headers: async () => new Headers(),
  cookies: async () => ({
    get: (name: string) =>
      principal && name === SESSION_COOKIE_NAME ? { value: "x" } : undefined,
  }),
}));

mock.module("../lib/auth/session", () => ({
  ...sessionMod,
  readSessionFromCookies: async () => principal,
}));

let originalDeliverySecret: string | undefined;
let originalStorageRoot: string | undefined;

beforeAll(async () => {
  expectTestDb();
  await seedRoster();
  // Slice 64 seals match/order option ids per attempt, which needs a secret.
  originalDeliverySecret = process.env.DESIGN_TOOL_SESSION_SECRET;
  process.env.DESIGN_TOOL_SESSION_SECRET ||= "delivery-test-secret-do-not-use";
  // P-1: the drawing cases store real bytes through the real provider.
  originalStorageRoot = process.env.STORAGE_LOCAL_ROOT;
  process.env.STORAGE_LOCAL_ROOT = "./storage-test";
});

afterEach(async () => {
  principal = studentPrincipal();
  const db = getDb();
  await db.execute(sql`truncate table assessments restart identity cascade`);
  await db.execute(sql`truncate table students restart identity cascade`);
});

afterAll(async () => {
  await clearRoster();
  await closeDb();
  if (originalDeliverySecret === undefined) delete process.env.DESIGN_TOOL_SESSION_SECRET;
  else process.env.DESIGN_TOOL_SESSION_SECRET = originalDeliverySecret;
  if (originalStorageRoot === undefined) delete process.env.STORAGE_LOCAL_ROOT;
  else process.env.STORAGE_LOCAL_ROOT = originalStorageRoot;
});

async function getDelivery(id: string) {
  const { GET } = await import("../app/api/assessments/[id]/delivery/route");
  const req = new Request(`http://localhost/api/assessments/${id}/delivery`);
  return GET(req, { params: Promise.resolve({ id }) });
}

/** Slice 62: the bundle is authorised by an EXISTING attempt, so seeding one is
 * part of setting the scene rather than an extra. */
async function admitStudent(assessmentId: string, owner = OWNER) {
  const db = getDb();
  const [student] = await db
    .insert(students)
    .values({
      owner_sub: owner,
      ssid: STUDENT.ssid,
      roster_ps_id: STUDENT.ps_id,
      name: STUDENT.name,
    })
    .returning();
  const [attempt] = await db
    .insert(attempts)
    .values({ assessment_id: assessmentId, student_id: student!.id, status: "in_progress" })
    .returning();
  return { student: student!, attempt: attempt! };
}

const VISIBLE_RUBRIC: Rubric = {
  style: "holistic",
  criteria: [
    {
      id: "c1",
      name: "Overall",
      levels: [
        { id: "l1", label: "Low", points: 0, descriptor: "misses the claim" },
        { id: "l2", label: "High", points: 2, descriptor: "cites the evidence" },
      ],
    },
  ],
  student_visibility: { during_test: true },
};

const HIDDEN_RUBRIC: Rubric = {
  ...VISIBLE_RUBRIC,
  student_visibility: { during_test: false },
};

async function seedAllTypes(rubric: Rubric = HIDDEN_RUBRIC) {
  const db = getDb();
  const [a] = await db
    .insert(assessments)
    .values({ owner_sub: OWNER, name: "Delivery", allowed_accommodations: ["spell_check"] })
    .returning();
  if (!a) throw new Error("no assessment");
  await db.insert(items).values([
    {
      assessment_id: a.id,
      position: 1,
      type: "multiple_choice_single",
      stem: "MC single",
      choices: [{ id: "c1", text: "one" }, { id: "c2", text: "two" }],
      correct_choice_ids: ["c1"],
    },
    {
      assessment_id: a.id,
      position: 2,
      type: "multiple_choice_multi",
      stem: "MC multi",
      choices: [{ id: "c1", text: "one" }, { id: "c2", text: "two" }],
      correct_choice_ids: ["c1", "c2"],
    },
    {
      assessment_id: a.id,
      position: 3,
      type: "short_text",
      stem: "Short",
      correct_answer: "mitochondria",
    },
    {
      assessment_id: a.id,
      position: 4,
      type: "essay",
      stem: "Essay",
      config: { max_word_count: 300, placeholder: "Write here", rubric, scoring_method: "ai" },
    },
    {
      assessment_id: a.id,
      position: 5,
      type: "match",
      stem: "Match",
      config: {
        pairs: [
          { id: "p1", left: "Dog", right: "Puppy" },
          { id: "p2", left: "Cat", right: "Kitten" },
          { id: "p3", left: "Cow", right: "Calf" },
        ],
      },
    },
    {
      assessment_id: a.id,
      position: 6,
      type: "order",
      stem: "Order",
      config: {
        sequence: [
          { id: "e1", label: "First" },
          { id: "e2", label: "Second" },
          { id: "e3", label: "Third" },
        ],
      },
    },
    {
      assessment_id: a.id,
      position: 7,
      type: "hotspot",
      stem: "Hotspot",
      config: {
        regions: [
          { id: "r1", x: 0, y: 0, w: 0.5, h: 0.5 },
          { id: "r2", x: 0.5, y: 0.5, w: 0.4, h: 0.4 },
        ],
        correct_region_ids: ["r2"],
      },
    },
    {
      assessment_id: a.id,
      position: 8,
      type: "drawing_upload",
      stem: "Draw",
      // Drawing background: rides inside canvas, so the student bundle must
      // carry it (the client paints the paper under the strokes).
      config: { canvas: { width: 800, height: 600, background: "grid" } },
    },
    {
      assessment_id: a.id,
      position: 9,
      type: "table",
      stem: "Table",
      config: {
        columns: [{ id: "c1", label: "Observed" }, { id: "c2", label: "Expected" }],
        rows: [{ id: "r1", label: "Middle" }, { id: "r2", label: "Total" }],
        corner: "Chamber",
        cell_keys: { r1: { c1: "chisquarekeyvalue" } },
      },
    },
  ]);
  return a.id;
}

describe("GET /api/assessments/:id/delivery — who may read it", () => {
  test("refuses an unauthenticated caller", async () => {
    const id = await seedAllTypes();
    await admitStudent(id);
    principal = null;
    expect((await getDelivery(id)).status).toBe(401);
  });

  test("refuses a teacher — this is the student's copy", async () => {
    const id = await seedAllTypes();
    await admitStudent(id);
    principal = { sub: OWNER, role: "staff" };
    expect((await getDelivery(id)).status).toBe(403);
  });

  // Authorisation is an existing attempt, not merely being on the roster. The
  // code and roster checks that gated attempt creation therefore also gate the
  // content — a student cannot read an assessment they were never admitted to.
  test("refuses a rostered student with no attempt", async () => {
    const id = await seedAllTypes();
    await getDb()
      .insert(students)
      .values({
        owner_sub: OWNER,
        ssid: STUDENT.ssid,
        roster_ps_id: STUDENT.ps_id,
        name: "Not Admitted",
      });
    const res = await getDelivery(id);
    expect(res.status).toBe(404);
  });

  test("refuses a student who has never been admitted by that teacher", async () => {
    // On the warehouse roster, but no overlay row under this teacher and no
    // sitting in hand: the delivery route creates nothing and answers 404.
    const id = await seedAllTypes();
    const res = await getDelivery(id);
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("not_on_roster");
    expect((await getDb().select().from(students)).length).toBe(0);
  });

  test("refuses a student who is not on the roster at all", async () => {
    const id = await seedAllTypes();
    principal = studentPrincipal("nobody@edtools.psd401.net");
    const res = await getDelivery(id);
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("not_on_roster");
  });

  test("400s on a non-uuid id", async () => {
    const res = await getDelivery("not-a-uuid");
    expect(res.status).toBe(400);
  });

  test("404s on an assessment that does not exist", async () => {
    const res = await getDelivery("11111111-1111-4111-8111-111111111111");
    expect(res.status).toBe(404);
  });
});

describe("GET /api/assessments/:id/delivery — no answer key survives", () => {
  test("emits all 9 items with no key field anywhere in the body", async () => {
    const id = await seedAllTypes();
    await admitStudent(id);
    const res = await getDelivery(id);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items.length).toBe(9);

    // Whole-body scan: catches a key smuggled through any branch, including
    // one added by a future item type.
    const raw = JSON.stringify(body);
    for (const forbidden of [
      "correct_choice_id",
      "correct_choice_ids",
      "correct_answer",
      "correct_region_ids",
      "scoring_method",
      "pairs",
      "sequence",
      "cell_keys",
    ]) {
      expect(raw).not.toContain(forbidden);
    }
    // The short_text answer value itself must be gone, not just its key.
    expect(raw).not.toContain("mitochondria");
    // E3: the table's expected cell text likewise.
    expect(raw).not.toContain("chisquarekeyvalue");
  });

  test("E3: a table ships its grid — columns, rows, corner — and nothing else", async () => {
    const id = await seedAllTypes();
    await admitStudent(id);
    const body = await (await getDelivery(id)).json();
    const table = body.items.find((i: { type: string }) => i.type === "table");
    expect(table.columns).toEqual([
      { id: "c1", label: "Observed" },
      { id: "c2", label: "Expected" },
    ]);
    expect(table.rows).toEqual([
      { id: "r1", label: "Middle" },
      { id: "r2", label: "Total" },
    ]);
    expect(table.corner).toBe("Chamber");
    expect(Object.keys(table).sort()).toEqual(["columns", "corner", "id", "rows", "stem", "type"]);
  });

  // docs/drawing-background-design.md: the field has no schema of its own on
  // the delivery side — it rides DrawingCanvasSchema — so this proves the
  // shared schema admits it rather than stripping it silently.
  test("a drawing item ships its canvas background", async () => {
    const id = await seedAllTypes();
    await admitStudent(id);
    const body = await (await getDelivery(id)).json();
    const drawing = body.items.find((i: { type: string }) => i.type === "drawing_upload");
    expect(drawing.canvas).toEqual({ width: 800, height: 600, background: "grid" });
  });

  test("match splits pairs into independent lefts and rights", async () => {
    const id = await seedAllTypes();
    await admitStudent(id);
    const body = await (await getDelivery(id)).json();
    const match = body.items.find((i: { type: string }) => i.type === "match");
    expect(match.lefts.map((l: { text: string }) => l.text)).toEqual([
      "Dog",
      "Cat",
      "Cow",
    ]);
    // Shuffled, so assert membership rather than order.
    expect(match.rights.map((r: { text: string }) => r.text).sort()).toEqual([
      "Calf",
      "Kitten",
      "Puppy",
    ]);
    expect(match).not.toHaveProperty("pairs");

    // Slice 64: the two sides must share no identifier. Without the side
    // scope, a pair's left and right derive from the same authoring id and the
    // bundle re-pairs itself for anyone who reads it.
    const leftIds = new Set(match.lefts.map((l: { id: string }) => l.id));
    const rightIds = new Set(match.rights.map((r: { id: string }) => r.id));
    for (const rightId of rightIds) expect(leftIds.has(rightId)).toBe(false);
    for (const anyId of [...leftIds, ...rightIds]) {
      expect(anyId).toMatch(/^[0-9a-f]{24}$/);
    }
  });

  // Slice 64: entry ids are sealed per attempt, so the authoring ids must not
  // appear — e1/e2/e3 are assigned in authored sequence, which would hand a
  // student the answer without their solving anything.
  test("order emits entries with sealed ids and no authored sequence", async () => {
    const id = await seedAllTypes();
    await admitStudent(id);
    const body = await (await getDelivery(id)).json();
    const order = body.items.find((i: { type: string }) => i.type === "order");
    const ids = order.entries.map((e: { id: string }) => e.id);
    expect(ids.length).toBe(3);
    expect(new Set(ids).size).toBe(3);
    for (const entryId of ids) {
      expect(entryId).toMatch(/^[0-9a-f]{24}$/);
    }
    expect(order.entries.map((e: { label: string }) => e.label).sort()).toEqual([
      "First",
      "Second",
      "Third",
    ]);
    expect(order).not.toHaveProperty("sequence");
  });

  test("hotspot keeps regions but drops the key", async () => {
    const id = await seedAllTypes();
    await admitStudent(id);
    const body = await (await getDelivery(id)).json();
    const hotspot = body.items.find((i: { type: string }) => i.type === "hotspot");
    expect(hotspot.regions.length).toBe(2);
    expect(hotspot).not.toHaveProperty("correct_region_ids");
  });

  test("hidden rubrics are omitted; visible ones ride along", async () => {
    const hiddenId = await seedAllTypes(HIDDEN_RUBRIC);
    await admitStudent(hiddenId);
    const hiddenBody = await (await getDelivery(hiddenId)).json();
    const hiddenEssay = hiddenBody.items.find((i: { type: string }) => i.type === "essay");
    expect(hiddenEssay).not.toHaveProperty("rubric");
    // Authoring metadata the client needs is still there.
    expect(hiddenEssay.max_word_count).toBe(300);
    expect(hiddenEssay.placeholder).toBe("Write here");

    const db = getDb();
    await db.execute(sql`truncate table assessments restart identity cascade`);
    await db.execute(sql`truncate table students restart identity cascade`);

    const visibleId = await seedAllTypes(VISIBLE_RUBRIC);
    await admitStudent(visibleId);
    const visibleBody = await (await getDelivery(visibleId)).json();
    const visibleEssay = visibleBody.items.find((i: { type: string }) => i.type === "essay");
    expect(visibleEssay.rubric.style).toBe("holistic");
  });

  // Slice 62: the bundle carries the EFFECTIVE set for this student, not the
  // assessment's allowed list. A student with no entitlements gets no
  // accommodations key at all, even though the assessment permits one.
  test("carries no accommodations for a student entitled to none", async () => {
    const id = await seedAllTypes();
    await admitStudent(id);
    const body = await (await getDelivery(id)).json();
    expect(body).not.toHaveProperty("allowed_accommodations");
    expect(body).not.toHaveProperty("accommodations");
  });

  test("500s loudly on an item type the mapper does not know", async () => {
    const db = getDb();
    const [a] = await db
      .insert(assessments)
      .values({ owner_sub: OWNER, name: "Forged" })
      .returning();
    if (!a) throw new Error("no assessment");
    await db.insert(items).values({
      assessment_id: a.id,
      position: 1,
      type: "essay_v2",
      stem: "forged",
    });
    await admitStudent(a.id);
    const res = await getDelivery(a.id);
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe("unknown_item_type");
  });
});

// Slice 69: the per-assessment clipboard policy.
describe("clipboard policy on the wire", () => {
  test("is omitted when locked, so absence means locked", async () => {
    const id = await seedAllTypes();
    await admitStudent(id);
    const body = await (await getDelivery(id)).json();
    // A client that has not heard of this flag stays closed rather than open,
    // which is the correct direction for a secure-testing browser.
    expect(body).not.toHaveProperty("allow_clipboard");
  });

  test("rides the bundle when the assessment permits it", async () => {
    const id = await seedAllTypes();
    await getDb()
      .update(assessments)
      .set({ allow_clipboard: true })
      .where(eq(assessments.id, id));
    await admitStudent(id);
    const body = await (await getDelivery(id)).json();
    expect(body.allow_clipboard).toBe(true);
  });
});

// E5 slice 1: stimuli are student-facing — the delivery bundle carries the
// sets with the same item ids the items use, and nothing key-shaped.
describe("item sets on the delivery bundle (E5 slice 1)", () => {
  // E12 slice 2: a set backed by a source question shows this student's own
  // saved answer; no answer → source_missing; an outline written inline on
  // this attempt (keyed by the source item) counts; the link never rides.
  test("a source-backed set resolves per student: saved answer, inline answer, or source_missing", async () => {
    const db = getDb();
    const [outline] = await db.insert(assessments).values({ owner_sub: OWNER, name: "Outline" }).returning();
    const [outlineQ] = await db
      .insert(items)
      .values({ assessment_id: outline!.id, position: 0, type: "essay", stem: "Outline your argument" })
      .returning();
    const [essay] = await db.insert(assessments).values({ owner_sub: OWNER, name: "Essay" }).returning();
    const [essayQ] = await db
      .insert(items)
      .values({ assessment_id: essay!.id, position: 0, type: "essay", stem: "Write the essay" })
      .returning();
    const [set] = await db
      .insert(item_sets)
      .values({ assessment_id: essay!.id, stimulus_text: "Your outline:", source_item_id: outlineQ!.id })
      .returning();
    await db.update(items).set({ item_set_id: set!.id }).where(eq(items.id, essayQ!.id));
    const { student, attempt } = await admitStudent(essay!.id);

    // 1. Nothing saved anywhere → lead-in only, source_missing, no link.
    let body = (await (await getDelivery(essay!.id)).json()) as {
      item_sets: { id: string; stimulus: string; source_missing?: boolean; inline_item_id?: string; inline_text?: string; source?: unknown }[];
    };
    expect(DeliveryBundleSchema.safeParse(body).success).toBe(true);
    expect(body.item_sets[0]).toMatchObject({ stimulus: "Your outline:", source_missing: true, inline_item_id: outlineQ!.id });
    expect(body.item_sets[0]!.inline_text).toBeUndefined();
    expect(body.item_sets[0]!.source).toBeUndefined();

    // 2. The student writes the outline inline on THIS attempt (D-4) → used.
    await db.insert(responses).values({
      attempt_id: attempt.id,
      item_id: outlineQ!.id,
      response: { type: "essay", text: "Inline: cars should yield" },
    });
    body = (await (await getDelivery(essay!.id)).json()) as typeof body;
    // Slice 3: an inline outline stays editable — the lead-in alone as the
    // stimulus, the text in inline_text, the id to post under.
    expect(body.item_sets[0]).toMatchObject({ stimulus: "Your outline:", inline_item_id: outlineQ!.id, inline_text: "Inline: cars should yield" });
    expect(body.item_sets[0]!.source_missing).toBeUndefined();

    // 3. A saved answer on the source assessment (any status, D-1) wins.
    const [outlineAttempt] = await db
      .insert(attempts)
      .values({ assessment_id: outline!.id, student_id: student.id, status: "in_progress" })
      .returning();
    await db.insert(responses).values({
      attempt_id: outlineAttempt!.id,
      item_id: outlineQ!.id,
      response: { type: "essay", text: "Real outline: three reasons" },
    });
    body = (await (await getDelivery(essay!.id)).json()) as typeof body;
    expect(body.item_sets[0]!.stimulus).toBe("Your outline:\n\nReal outline: three reasons");
    expect(body.item_sets[0]!.inline_item_id).toBeUndefined();
    expect(DeliveryBundleSchema.safeParse(body).success).toBe(true);
  });

  test("emits item_sets in order with the set's item ids; none → key omitted", async () => {
    const db = getDb();
    const [a] = await db
      .insert(assessments)
      .values({ owner_sub: OWNER, name: "Sets" })
      .returning();
    const rows = await db
      .insert(items)
      .values([
        { assessment_id: a!.id, position: 0, type: "essay", stem: "Q1" },
        { assessment_id: a!.id, position: 1, type: "essay", stem: "Q2" },
        { assessment_id: a!.id, position: 2, type: "essay", stem: "Q3" },
      ])
      .returning();
    await admitStudent(a!.id);
    const before = (await (await getDelivery(a!.id)).json()) as { item_sets?: unknown };
    expect(before.item_sets).toBeUndefined();

    const [set] = await db
      .insert(item_sets)
      .values({ assessment_id: a!.id, stimulus_text: "Use the graph above.", layout: "own_page" })
      .returning();
    await db.update(items).set({ item_set_id: set!.id }).where(inArray(items.id, [rows[1]!.id, rows[2]!.id]));

    const res = await getDelivery(a!.id);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: { id: string }[];
      item_sets: { id: string; stimulus: string; layout: string; item_ids: string[] }[];
    };
    expect(DeliveryBundleSchema.safeParse(body).success).toBe(true);
    expect(body.item_sets).toHaveLength(1);
    expect(body.item_sets[0]).toMatchObject({
      id: set!.id,
      stimulus: "Use the graph above.",
      layout: "own_page",
      item_ids: [rows[1]!.id, rows[2]!.id],
    });
    expect(body.items.map((i) => i.id)).toEqual(rows.map((r) => r.id));
  });

  // Multi-source stimulus slice 2 (docs/multi-source-stimulus-design.md): a
  // source is student-facing by definition, so the student bundle carries the
  // same {label, text} list the teacher bundle does.
  test("carries the set's sources and side_by_side to the student", async () => {
    const db = getDb();
    const [a] = await db.insert(assessments).values({ owner_sub: OWNER, name: "Sourced" }).returning();
    const [row] = await db
      .insert(items)
      .values({ assessment_id: a!.id, position: 0, type: "essay", stem: "Synthesise." })
      .returning();
    const [set] = await db
      .insert(item_sets)
      .values({
        assessment_id: a!.id,
        stimulus_text: "Use all the sources.",
        layout: "side_by_side",
        sources: [
          { label: "Source A", text: "Two roads diverged\nin a yellow wood" },
          { label: "Source B", text: "Ridership fell." },
        ],
      })
      .returning();
    await db.update(items).set({ item_set_id: set!.id }).where(eq(items.id, row!.id));
    await admitStudent(a!.id);

    const body = (await (await getDelivery(a!.id)).json()) as {
      item_sets: { layout: string; sources: { label: string; text: string }[] }[];
    };
    expect(DeliveryBundleSchema.safeParse(body).success).toBe(true);
    expect(body.item_sets[0]!.layout).toBe("side_by_side");
    expect(body.item_sets[0]!.sources.map((s) => s.label)).toEqual(["Source A", "Source B"]);
    expect(body.item_sets[0]!.sources[0]!.text).toContain("\n");
  });
});

// Client paging: the bundle says "paged" only when the teacher chose it;
// absence is one scrolling page, which is what every older client does.
describe("GET /api/assessments/:id/delivery — layout (client paging)", () => {
  test("absent by default, \"paged\" once the assessment says so", async () => {
    const id = await seedAllTypes();
    await admitStudent(id);
    let body = await (await getDelivery(id)).json();
    expect(body).not.toHaveProperty("layout");

    await getDb().update(assessments).set({ student_layout: "paged" }).where(eq(assessments.id, id));
    body = await (await getDelivery(id)).json();
    expect(body.layout).toBe("paged");
    expect(DeliveryBundleSchema.parse(body).layout).toBe("paged");
  });
});

// Time limit (docs/time-limit-and-unfinished-attempts-design.md, D-2/D-3):
// the deadline rides the bundle only when the assessment HAS a limit, so
// every bundle that existed before this field is byte-identical to what it
// was. `server_now` never travels alone.
describe("GET /api/assessments/:id/delivery — time_limit_ends_at / server_now", () => {
  test("both keys absent when the assessment has no limit; the body is byte-identical", async () => {
    const id = await seedAllTypes();
    await admitStudent(id);
    const body = await (await getDelivery(id)).json();
    expect(body).not.toHaveProperty("time_limit_ends_at");
    expect(body).not.toHaveProperty("server_now");

    // Byte-stability: the only fields that vary between two builds of the
    // same bundle are the shuffles, so compare the serialisation with those
    // two items dropped.
    const stable = (b: Record<string, unknown>) =>
      JSON.stringify({
        ...b,
        items: (b.items as Array<{ type: string }>).filter(
          (i) => i.type !== "match" && i.type !== "order",
        ),
      });
    const again = await (await getDelivery(id)).json();
    expect(stable(again)).toBe(stable(body));
  });

  test("with a limit, the deadline is started_at + time_limit_seconds and server_now rides along", async () => {
    const id = await seedAllTypes();
    const { attempt } = await admitStudent(id);
    await getDb()
      .update(assessments)
      .set({ time_limit_seconds: 1800 })
      .where(eq(assessments.id, id));

    const body = await (await getDelivery(id)).json();
    const parsed = DeliveryBundleSchema.parse(body);
    expect(parsed.time_limit_ends_at).toBe(
      new Date(attempt.started_at.getTime() + 1800 * 1000).toISOString(),
    );
    expect(parsed.server_now).toBeDefined();
    // The server's clock, not the client's, and near enough to now that a
    // countdown built from the pair is right.
    const skew = Math.abs(Date.now() - new Date(parsed.server_now!).getTime());
    expect(skew).toBeLessThan(60_000);
  });

  test("the deadline is per ATTEMPT, so it does not move when the bundle is refetched", async () => {
    const id = await seedAllTypes();
    await admitStudent(id);
    await getDb()
      .update(assessments)
      .set({ time_limit_seconds: 600 })
      .where(eq(assessments.id, id));
    const first = await (await getDelivery(id)).json();
    const second = await (await getDelivery(id)).json();
    expect(second.time_limit_ends_at).toBe(first.time_limit_ends_at);
  });

  test("a zero or negative limit is treated as no limit", async () => {
    const id = await seedAllTypes();
    await admitStudent(id);
    await getDb()
      .update(assessments)
      .set({ time_limit_seconds: 0 })
      .where(eq(assessments.id, id));
    const body = await (await getDelivery(id)).json();
    expect(body).not.toHaveProperty("time_limit_ends_at");
  });
});

// Client paging follow-up (D-4): the bundle names the questions this attempt
// has already answered — this attempt's rows only, this assessment's items
// only — so the client's marks are honest after a relaunch.
describe("GET /api/assessments/:id/delivery — answered_item_ids", () => {
  test("absent on a fresh attempt; lists exactly this attempt's answered questions in item order", async () => {
    const id = await seedAllTypes();
    const { attempt } = await admitStudent(id);
    let body = await (await getDelivery(id)).json();
    expect(body).not.toHaveProperty("answered_item_ids");

    const db = getDb();
    const rows = await db.select().from(items).where(eq(items.assessment_id, id)).orderBy(items.position);
    const short = rows.find((r) => r.type === "short_text")!;
    const essay = rows.find((r) => r.type === "essay")!;
    await db.insert(responses).values([
      { attempt_id: attempt.id, item_id: essay.id, response: { type: "essay", text: "words" } },
      { attempt_id: attempt.id, item_id: short.id, response: { type: "short_text", text: "x" } },
    ]);
    // Another attempt's answer (the other student, same assessment) must not leak in.
    const [other] = await db
      .insert(students)
      .values({ owner_sub: OWNER, ssid: OTHER_STUDENT.ssid, roster_ps_id: OTHER_STUDENT.ps_id, name: OTHER_STUDENT.name })
      .returning();
    const [otherAttempt] = await db
      .insert(attempts)
      .values({ assessment_id: id, student_id: other!.id, status: "in_progress" })
      .returning();
    const mc = rows.find((r) => r.type === "multiple_choice_single")!;
    await db.insert(responses).values({ attempt_id: otherAttempt!.id, item_id: mc.id, response: { type: "multiple_choice_single", choice_id: "c1" } });

    body = await (await getDelivery(id)).json();
    // Item order (short_text is position 3, essay position 4), not insert order.
    expect(body.answered_item_ids).toEqual([short.id, essay.id]);
    expect(DeliveryBundleSchema.parse(body).answered_item_ids).toEqual([short.id, essay.id]);
  });
});

// P-1 (docs/resume-prefill-design.md): the marks were honest and the fields
// under them were empty, so a student read a green check over an empty box as a
// lost answer and typed it again. The bundle now carries the answers
// themselves — this attempt's rows only, re-sealed where the ids are sealed,
// with the drawing bytes inline — derived from the same one query as the marks
// (D-4), so a mark can never arrive without its value.
describe("GET /api/assessments/:id/delivery — saved_responses / saved_uploads (P-1)", () => {
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  async function putResponse(attemptId: string, itemId: string, response: unknown) {
    const { PUT } = await import("../app/api/attempts/[attemptId]/responses/[itemId]/route");
    return PUT(
      new Request("http://localhost/x", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ response }),
      }),
      { params: Promise.resolve({ attemptId, itemId }) },
    );
  }

  /** A slot the server minted for this (attempt, item), with no bytes yet. */
  async function registerUpload(
    attemptId: string,
    itemId: string,
    contentType = "image/png",
  ): Promise<string> {
    const { POST } = await import(
      "../app/api/attempts/[attemptId]/responses/[itemId]/upload-url/route"
    );
    const res = await POST(
      new Request("http://localhost/x", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content_type: contentType, content_length: PNG.byteLength }),
      }),
      { params: Promise.resolve({ attemptId, itemId }) },
    );
    expect(res.status).toBe(201);
    return (await res.json()).upload_id as string;
  }

  /** The whole student flow: slot, bytes, response — all through the real routes. */
  async function saveDrawing(attemptId: string, itemId: string, contentType = "image/png") {
    const uploadId = await registerUpload(attemptId, itemId, contentType);
    const { PUT } = await import(
      "../app/api/attempts/[attemptId]/responses/[itemId]/upload/route"
    );
    const stored = await PUT(
      new Request(`http://localhost/x?upload_id=${uploadId}`, {
        method: "PUT",
        body: PNG as unknown as BodyInit,
      }),
      { params: Promise.resolve({ attemptId, itemId }) },
    );
    expect(stored.status).toBe(200);
    const saved = await putResponse(attemptId, itemId, {
      type: "drawing_upload",
      upload_id: uploadId,
    });
    expect(saved.status).toBe(200);
    return uploadId;
  }

  async function itemOf(assessmentId: string) {
    const rows = await getDb()
      .select()
      .from(items)
      .where(eq(items.assessment_id, assessmentId))
      .orderBy(items.position);
    return (type: string) => rows.find((r) => r.type === type)!;
  }

  test("a fresh attempt carries none of the three keys", async () => {
    const id = await seedAllTypes();
    await admitStudent(id);
    const body = await (await getDelivery(id)).json();
    expect(body).not.toHaveProperty("answered_item_ids");
    expect(body).not.toHaveProperty("saved_responses");
    expect(body).not.toHaveProperty("saved_uploads");
  });

  test("choice, text and table answers come back verbatim, keyed exactly as the marks", async () => {
    const id = await seedAllTypes();
    const { attempt } = await admitStudent(id);
    const item = await itemOf(id);
    const answers: Record<string, ItemResponse> = {
      [item("multiple_choice_single").id]: { type: "multiple_choice_single", choice_id: "c2" },
      [item("multiple_choice_multi").id]: {
        type: "multiple_choice_multi",
        choice_ids: ["c1", "c2"],
      },
      [item("short_text").id]: { type: "short_text", text: "photosynthesis" },
      [item("essay").id]: { type: "essay", text: "The author builds the case slowly." },
      [item("table").id]: { type: "table", cells: { r1: { c1: "12", c2: "9" } } },
    };
    for (const [itemId, response] of Object.entries(answers)) {
      expect((await putResponse(attempt.id, itemId, response)).status).toBe(200);
    }

    const body = await (await getDelivery(id)).json();
    expect(body.saved_responses).toEqual(answers);
    // The mark and the value are two views of one query: neither may be a
    // superset of the other.
    expect(new Set(Object.keys(body.saved_responses))).toEqual(new Set(body.answered_item_ids));
    expect(body).not.toHaveProperty("saved_uploads");
    expect(DeliveryBundleSchema.parse(body).saved_responses).toEqual(answers);
  });

  test("a saved match answer is sealed back into the ids this bundle shows", async () => {
    const id = await seedAllTypes();
    const { attempt } = await admitStudent(id);
    const match = (await itemOf(id))("match");
    const seal = (real: string, scope: string) => opaqueId(attempt.id, match.id, real, scope);
    // Dog→Kitten, Cat→Puppy: deliberately wrong, so a value that came back as
    // the authored pairing would be the key rather than the student's answer.
    const submitted = {
      [seal("p1", MATCH_LEFT)]: seal("p2", MATCH_RIGHT),
      [seal("p2", MATCH_LEFT)]: seal("p1", MATCH_RIGHT),
    };
    expect(
      (await putResponse(attempt.id, match.id, { type: "match", matches: submitted })).status,
    ).toBe(200);
    // Stored as the authoring ids; the sealing is a delivery concern only.
    const [row] = await getDb().select().from(responses).where(eq(responses.item_id, match.id));
    expect(row!.response).toEqual({ type: "match", matches: { p1: "p2", p2: "p1" } });

    const body = await (await getDelivery(id)).json();
    const saved = body.saved_responses[match.id];
    expect(saved).toEqual({ type: "match", matches: submitted });
    const bundled = body.items.find((i: { id: string }) => i.id === match.id);
    const leftIds = new Set(bundled.lefts.map((l: { id: string }) => l.id));
    const rightIds = new Set(bundled.rights.map((r: { id: string }) => r.id));
    for (const [left, right] of Object.entries(saved.matches as Record<string, string>)) {
      expect(leftIds.has(left)).toBe(true);
      expect(rightIds.has(right)).toBe(true);
    }
  });

  test("a saved order answer is sealed back into the ids this bundle shows", async () => {
    const id = await seedAllTypes();
    const { attempt } = await admitStudent(id);
    const order = (await itemOf(id))("order");
    const seal = (real: string) => opaqueId(attempt.id, order.id, real);
    const submitted = [seal("e3"), seal("e1"), seal("e2")];
    expect(
      (await putResponse(attempt.id, order.id, { type: "order", ordered_ids: submitted })).status,
    ).toBe(200);
    const [row] = await getDb().select().from(responses).where(eq(responses.item_id, order.id));
    expect(row!.response).toEqual({ type: "order", ordered_ids: ["e3", "e1", "e2"] });

    const body = await (await getDelivery(id)).json();
    const saved = body.saved_responses[order.id];
    expect(saved).toEqual({ type: "order", ordered_ids: submitted });
    const bundled = body.items.find((i: { id: string }) => i.id === order.id);
    const entryIds = new Set(bundled.entries.map((e: { id: string }) => e.id));
    for (const entryId of saved.ordered_ids as string[]) {
      expect(entryIds.has(entryId)).toBe(true);
    }
  });

  // D-1: the picture comes back, not a badge. The bytes ride the bundle the way
  // authored images do — no second route, no host→page channel.
  test("a drawing answer carries its stored bytes", async () => {
    const id = await seedAllTypes();
    const { attempt } = await admitStudent(id);
    const drawing = (await itemOf(id))("drawing_upload");
    const uploadId = await saveDrawing(attempt.id, drawing.id);

    const body = await (await getDelivery(id)).json();
    expect(body.saved_responses[drawing.id]).toEqual({
      type: "drawing_upload",
      upload_id: uploadId,
    });
    expect(body.saved_uploads[uploadId]).toEqual({
      content_type: "image/png",
      base64: Buffer.from(PNG).toString("base64"),
    });
    expect(DeliveryBundleSchema.safeParse(body).success).toBe(true);
  });

  test("a slot that never received bytes lists the answer without a picture", async () => {
    const id = await seedAllTypes();
    const { attempt } = await admitStudent(id);
    const drawing = (await itemOf(id))("drawing_upload");
    const uploadId = await registerUpload(attempt.id, drawing.id);
    // The ingest route refuses a pending slot, so the row is written directly:
    // this is the finding-10.10 shape — a response naming a slot nothing can
    // vouch for. The answer still counts; there is simply nothing to draw.
    await getDb().insert(responses).values({
      attempt_id: attempt.id,
      item_id: drawing.id,
      response: { type: "drawing_upload", upload_id: uploadId },
    });
    const [slot] = await getDb()
      .select()
      .from(response_uploads)
      .where(eq(response_uploads.id, uploadId));
    expect(slot!.status).toBe("pending");

    const body = await (await getDelivery(id)).json();
    expect(body.answered_item_ids).toEqual([drawing.id]);
    expect(body.saved_responses[drawing.id]).toEqual({
      type: "drawing_upload",
      upload_id: uploadId,
    });
    expect(body).not.toHaveProperty("saved_uploads");
  });

  test("a non-image upload lists the answer without a picture", async () => {
    const id = await seedAllTypes();
    const { attempt } = await admitStudent(id);
    const drawing = (await itemOf(id))("drawing_upload");
    // A PDF is a legitimate hand-in (a scan of paper work), but it is not
    // something the canvas can draw back, so it is listed and not inlined.
    const uploadId = await saveDrawing(attempt.id, drawing.id, "application/pdf");

    const body = await (await getDelivery(id)).json();
    expect(body.saved_responses[drawing.id]).toEqual({
      type: "drawing_upload",
      upload_id: uploadId,
    });
    expect(body).not.toHaveProperty("saved_uploads");
  });

  test("another student's attempt on the same assessment does not leak in", async () => {
    const id = await seedAllTypes();
    const { attempt } = await admitStudent(id);
    const item = await itemOf(id);
    const essay = item("essay");

    const db = getDb();
    const [other] = await db
      .insert(students)
      .values({
        owner_sub: OWNER,
        ssid: OTHER_STUDENT.ssid,
        roster_ps_id: OTHER_STUDENT.ps_id,
        name: OTHER_STUDENT.name,
      })
      .returning();
    const [otherAttempt] = await db
      .insert(attempts)
      .values({ assessment_id: id, student_id: other!.id, status: "in_progress" })
      .returning();
    principal = studentPrincipal(OTHER_STUDENT.email);
    expect(
      (await putResponse(otherAttempt!.id, essay.id, {
        type: "essay",
        text: "classmates-private-sentence",
      })).status,
    ).toBe(200);
    // Each student draws on the same item, so the upload map is scoped too.
    const otherUpload = await saveDrawing(otherAttempt!.id, item("drawing_upload").id);
    principal = studentPrincipal();
    await saveDrawing(attempt.id, item("drawing_upload").id);

    const body = await (await getDelivery(id)).json();
    expect(Object.keys(body.saved_responses)).toEqual([item("drawing_upload").id]);
    expect(Object.keys(body.saved_uploads)).not.toContain(otherUpload);
    expect(JSON.stringify(body)).not.toContain("classmates-private-sentence");
  });

  // The load-bearing negative, extended: saving answers must not open a second
  // road for a key, and the new field can only express a student's own answer.
  test("with answers saved, no key field appears and saved_responses cannot hold one", async () => {
    const id = await seedAllTypes();
    const { attempt } = await admitStudent(id);
    const item = await itemOf(id);
    const table = item("table");
    await putResponse(attempt.id, table.id, { type: "table", cells: { r1: { c1: "12" } } });
    await putResponse(attempt.id, item("short_text").id, { type: "short_text", text: "x" });

    const body = await (await getDelivery(id)).json();
    const raw = JSON.stringify(body);
    for (const forbidden of [
      "correct_choice_id",
      "correct_choice_ids",
      "correct_answer",
      "correct_region_ids",
      "scoring_method",
      "cell_keys",
    ]) {
      expect(raw).not.toContain(forbidden);
    }
    expect(raw).not.toContain("mitochondria");
    expect(raw).not.toContain("chisquarekeyvalue");

    // A key smuggled onto a saved value is stripped by the response union, the
    // same way an item-level one is stripped by the item union.
    const smuggled = DeliveryBundleSchema.parse({
      ...body,
      items: body.items.map((i: { type: string }) =>
        i.type === "multiple_choice_single" ? { ...i, correct_choice_id: "c1" } : i,
      ),
      saved_responses: {
        ...body.saved_responses,
        [table.id]: {
          type: "table",
          cells: { r1: { c1: "12" } },
          cell_keys: { r1: { c1: "chisquarekeyvalue" } },
        },
      },
    });
    expect(JSON.stringify(smuggled)).not.toContain("correct_choice_id");
    expect(JSON.stringify(smuggled)).not.toContain("cell_keys");

    // And a value that is not a student response at all is refused outright.
    expect(
      DeliveryBundleSchema.safeParse({
        ...body,
        saved_responses: { [table.id]: { type: "answer_key", cells: { r1: { c1: "12" } } } },
      }).success,
    ).toBe(false);
  });
});
