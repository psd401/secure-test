// Graphing calculator (docs/graphing-calculator-design.md D-7, slice 5): the
// server half on the test DB — the setting is validated, locked once
// Published (it is part of what the test measures, unlike highlighting),
// and carried by the teacher bundle (export / import / Duplicate) together
// with the per-question "no calculator" mark. The delivery side (the field,
// the per-item mark and the 2.0 refusal) is in delivery-api.test.ts.
import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { closeDb, getDb } from "../db/client";
import { assessments, items } from "../db/schema";
import { SESSION_COOKIE_NAME } from "../lib/auth/session";
import * as headersMod from "next/headers";
import * as sessionMod from "../lib/auth/session";
import { duplicateAssessment } from "../lib/api/duplicateAssessment";
import { buildExportBundle } from "../lib/api/exportBundle";
import { importBundleForOwner, isImportBundleError } from "../lib/api/importBundle";
import { MIN_CLIENT_VERSION_FOR_FEATURE, requiredClientUpgrade } from "../lib/items/clientSupport";

const expectTestDb = () => {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.includes("secure_test_design_tool_test")) {
    throw new Error(`calculator tests require the test DB; got: ${url}`);
  }
};

const TEACHER = "calculator-teacher";
const TEACHER_EMAIL = "calculator-teacher@example.org";

type Principal = { sub: string; role: string; email?: string } | null;
let principal: Principal = null;

mock.module("next/headers", () => ({
  ...headersMod,
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

const asTeacher = () => {
  principal = { sub: TEACHER, role: "staff", email: TEACHER_EMAIL };
};

beforeAll(() => {
  expectTestDb();
});

afterEach(async () => {
  principal = null;
  await getDb().execute(sql`truncate table assessments restart identity cascade`);
});

afterAll(async () => {
  await closeDb();
});

async function seed(
  opts: {
    status?: "draft" | "published";
    mode?: "none" | "four_function" | "scientific" | "graphing";
    preset?: "full" | "state_wa";
    noCalcOnFirst?: boolean;
  } = {},
) {
  const db = getDb();
  const [a] = await db
    .insert(assessments)
    .values({
      owner_sub: TEACHER,
      owner_email: TEACHER_EMAIL,
      name: "Calculator",
      status: opts.status ?? "draft",
      calculator_mode: opts.mode ?? "none",
      calculator_preset: opts.preset ?? "full",
    })
    .returning();
  await db.insert(items).values([
    {
      assessment_id: a!.id,
      position: 0,
      type: "short_text",
      stem: "What is 12 × 13?",
      correct_answer: "156",
      config: opts.noCalcOnFirst ? { no_calculator: true } : {},
    },
    {
      assessment_id: a!.id,
      position: 1,
      type: "multiple_choice_single",
      stem: "Pick one",
      choices: [
        { id: "c1", text: "one" },
        { id: "c2", text: "two" },
      ],
      correct_choice_ids: ["c1"],
    },
  ]);
  return a!;
}

async function patch(assessmentId: string, body: unknown) {
  const { PATCH } = await import("../app/api/assessments/[id]/route");
  return PATCH(
    new Request("http://localhost/x", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: assessmentId }) },
  );
}

describe("the version gate", () => {
  test("a calculator needs 2.0.0; an item type and a feature combine", () => {
    expect(MIN_CLIENT_VERSION_FOR_FEATURE.calculator).toBe("2.0.0");
    expect(requiredClientUpgrade("1.6.3", ["short_text"], ["calculator"])).toBe("2.0.0");
    expect(requiredClientUpgrade(null, [], ["calculator"])).toBe("2.0.0");
    expect(requiredClientUpgrade("2.0.0", ["fill_blank"], ["calculator"])).toBeNull();
    expect(requiredClientUpgrade("1.5.0", ["fill_blank"], ["calculator"])).toBe("2.0.0");
    expect(requiredClientUpgrade("1.5.0", ["fill_blank"], [])).toBe("1.6.0");
    expect(requiredClientUpgrade("1.6.3", ["short_text"])).toBeNull();
  });
});

describe("create / PATCH", () => {
  test("POST accepts the setting; absent is no calculator", async () => {
    asTeacher();
    const { POST } = await import("../app/api/assessments/route");
    const post = (body: unknown) =>
      POST(
        new Request("http://localhost/x", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      );
    const on = await (await post({ name: "On", calculator_mode: "graphing", calculator_preset: "state_wa" })).json();
    expect(on.assessment.calculator_mode).toBe("graphing");
    expect(on.assessment.calculator_preset).toBe("state_wa");
    const off = await (await post({ name: "Off" })).json();
    expect(off.assessment.calculator_mode).toBe("none");
    expect(off.assessment.calculator_preset).toBe("full");
  });

  test("a draft takes any mode and preset", async () => {
    const a = await seed();
    asTeacher();
    const res = await patch(a.id, { calculator_mode: "scientific", calculator_preset: "state_wa" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.assessment.calculator_mode).toBe("scientific");
    expect(body.assessment.calculator_preset).toBe("state_wa");
  });

  test("unknown values are a 400", async () => {
    const a = await seed();
    asTeacher();
    expect((await patch(a.id, { calculator_mode: "abacus" })).status).toBe(400);
    expect((await patch(a.id, { calculator_preset: "texas" })).status).toBe(400);
  });

  test("locked once Published — unlike highlighting, it changes what is measured", async () => {
    const a = await seed({ status: "published", mode: "graphing" });
    asTeacher();
    expect((await patch(a.id, { calculator_mode: "none" })).status).toBe(409);
    expect((await patch(a.id, { calculator_preset: "state_wa" })).status).toBe(409);
    // Sending the unchanged value alongside a setting that IS allowed while
    // Published is fine (the editor sends every field).
    const ok = await patch(a.id, { calculator_mode: "graphing", allow_highlighting: true });
    expect(ok.status).toBe(200);
  });

  test("the database refuses an unknown mode even past the API", async () => {
    const a = await seed();
    let failed = false;
    try {
      await getDb()
        .update(assessments)
        .set({ calculator_mode: "abacus" })
        .where(eq(assessments.id, a.id));
    } catch {
      failed = true;
    }
    expect(failed).toBe(true);
  });
});

describe("the per-question mark", () => {
  test("PATCHing an item sets and clears no_calculator; omitted keeps it", async () => {
    const a = await seed({ mode: "graphing" });
    asTeacher();
    const [first] = await getDb().select().from(items).where(eq(items.assessment_id, a.id)).orderBy(items.position);
    const { PATCH } = await import("../app/api/assessments/[id]/items/[itemId]/route");
    const send = (body: unknown) =>
      PATCH(
        new Request("http://localhost/x", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
        { params: Promise.resolve({ id: a.id, itemId: first!.id }) },
      );
    const base = { type: "short_text", stem: first!.stem, correct_answer: "156" };
    expect((await send({ ...base, no_calculator: true })).status).toBe(200);
    let [row] = await getDb().select().from(items).where(eq(items.id, first!.id));
    expect(row!.config?.no_calculator).toBe(true);
    expect((await send(base)).status).toBe(200);
    [row] = await getDb().select().from(items).where(eq(items.id, first!.id));
    expect(row!.config?.no_calculator).toBe(true);
    expect((await send({ ...base, no_calculator: false })).status).toBe(200);
    [row] = await getDb().select().from(items).where(eq(items.id, first!.id));
    expect(row!.config?.no_calculator).toBeUndefined();
  });
});

describe("export / import / duplicate", () => {
  test("on: export carries the setting and the mark; import and Duplicate keep both", async () => {
    const source = await seed({ mode: "scientific", preset: "state_wa", noCalcOnFirst: true });
    const built = await buildExportBundle(getDb(), source, TEACHER, true);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.bundle.calculator).toEqual({ mode: "scientific", preset: "state_wa" });
    expect(built.bundle.items[0]!.no_calculator).toBe(true);
    expect("no_calculator" in built.bundle.items[1]!).toBe(false);

    const imported = await importBundleForOwner(built.bundle, TEACHER, TEACHER_EMAIL);
    if (isImportBundleError(imported)) throw new Error(imported.error);
    const [row] = await getDb().select().from(assessments).where(eq(assessments.id, imported.assessment_id));
    expect(row!.calculator_mode).toBe("scientific");
    expect(row!.calculator_preset).toBe("state_wa");
    const importedItems = await getDb()
      .select()
      .from(items)
      .where(eq(items.assessment_id, imported.assessment_id))
      .orderBy(items.position);
    expect(importedItems[0]!.config?.no_calculator).toBe(true);
    expect(importedItems[1]!.config?.no_calculator).toBeUndefined();

    const copy = await duplicateAssessment(getDb(), source, TEACHER, TEACHER_EMAIL);
    if (!copy.ok) throw new Error("duplicate failed");
    const [copyRow] = await getDb().select().from(assessments).where(eq(assessments.id, copy.assessment_id));
    expect(copyRow!.calculator_mode).toBe("scientific");
    expect(copyRow!.calculator_preset).toBe("state_wa");
    const copyItems = await getDb()
      .select()
      .from(items)
      .where(eq(items.assessment_id, copy.assessment_id))
      .orderBy(items.position);
    expect(copyItems[0]!.config?.no_calculator).toBe(true);
  });

  test("none: not emitted; a bundle without the field imports as none", async () => {
    const source = await seed();
    const built = await buildExportBundle(getDb(), source, TEACHER, true);
    if (!built.ok) throw new Error("export failed");
    expect("calculator" in built.bundle).toBe(false);
    const imported = await importBundleForOwner(built.bundle, TEACHER, TEACHER_EMAIL);
    if (isImportBundleError(imported)) throw new Error(imported.error);
    const [row] = await getDb().select().from(assessments).where(eq(assessments.id, imported.assessment_id));
    expect(row!.calculator_mode).toBe("none");
  });
});

// Stimulus graphs (D-8): content on any item, carried like the mark.
describe("stimulus graphs", () => {
  const GRAPH = {
    rows: [{ latex: "y=x^{2}-4", color: "#1f5fa8" }],
    view: { xmin: -10, xmax: 10, ymin: -7.5, ymax: 7.5 },
    alt: "A graph of y = x² − 4.",
  };

  async function itemPatch(assessmentId: string, itemId: string, body: unknown) {
    const { PATCH } = await import("../app/api/assessments/[id]/items/[itemId]/route");
    return PATCH(
      new Request("http://localhost/x", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ id: assessmentId, itemId }) },
    );
  }

  test("an item takes a graph, keeps it when omitted, drops it on null; bad graphs are 400", async () => {
    const a = await seed();
    asTeacher();
    const [first] = await getDb().select().from(items).where(eq(items.assessment_id, a.id)).orderBy(items.position);
    const base = { type: "short_text", stem: first!.stem, correct_answer: "156" };
    expect((await itemPatch(a.id, first!.id, { ...base, graph: GRAPH })).status).toBe(200);
    let [row] = await getDb().select().from(items).where(eq(items.id, first!.id));
    expect(row!.config?.graph).toEqual(GRAPH);
    expect((await itemPatch(a.id, first!.id, base)).status).toBe(200);
    [row] = await getDb().select().from(items).where(eq(items.id, first!.id));
    expect(row!.config?.graph).toEqual(GRAPH);
    expect((await itemPatch(a.id, first!.id, { ...base, graph: null })).status).toBe(200);
    [row] = await getDb().select().from(items).where(eq(items.id, first!.id));
    expect(row!.config?.graph).toBeUndefined();
    // No alt text, an inverted view, too many rows: refused.
    expect((await itemPatch(a.id, first!.id, { ...base, graph: { ...GRAPH, alt: " " } })).status).toBe(400);
    expect(
      (await itemPatch(a.id, first!.id, { ...base, graph: { ...GRAPH, view: { xmin: 5, xmax: -5, ymin: 0, ymax: 1 } } })).status,
    ).toBe(400);
    const rows = Array.from({ length: 21 }, () => ({ latex: "y=x" }));
    expect((await itemPatch(a.id, first!.id, { ...base, graph: { ...GRAPH, rows } })).status).toBe(400);
  });

  test("export carries it; import keeps it", async () => {
    const source = await seed();
    const [first] = await getDb().select().from(items).where(eq(items.assessment_id, source.id)).orderBy(items.position);
    await getDb().update(items).set({ config: { graph: GRAPH } }).where(eq(items.id, first!.id));
    const built = await buildExportBundle(getDb(), source, TEACHER, true);
    if (!built.ok) throw new Error("export failed");
    expect(built.bundle.items[0]!.graph).toEqual(GRAPH);
    const imported = await importBundleForOwner(built.bundle, TEACHER, TEACHER_EMAIL);
    if (isImportBundleError(imported)) throw new Error(imported.error);
    const back = await getDb().select().from(items).where(eq(items.assessment_id, imported.assessment_id)).orderBy(items.position);
    expect(back[0]!.config?.graph).toEqual(GRAPH);
  });
});
