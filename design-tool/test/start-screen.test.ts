// Editor redesign Phase 8 (D-5): the start screen. The district templates
// (they parse as ItemBundles, create through the import, save back through
// the item PATCH validator unchanged and are publish-ready), the New
// assessment form's start choices (blank with an example, import, AI draft),
// and the AI draft's gate: today's `allow_llm_authoring`, set only by the
// teacher's own tick. With the R-12 flag off, `start` is ignored.
import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { asc, eq, sql } from "drizzle-orm";
import { ItemBundleSchema } from "@secure-test/schema";
import { closeDb, getDb } from "../db/client";
import { assessments, item_sets, items } from "../db/schema";
import * as sessionMod from "../lib/auth/session";
import { setNewAuthoring } from "../lib/authoring/flag";
import {
  ASSESSMENT_TEMPLATES,
  EXAMPLE_QUESTION_BUNDLE,
  startTemplates,
  templateById,
  templateContents,
  templateTypeCounts,
} from "../lib/authoring/templates";
import {
  aiDraftAllowed,
  editorStartAction,
  parseStartChoice,
  startRedirect,
} from "../lib/authoring/startScreen";
import { exampleQuestionRows } from "../lib/authoring/exampleQuestion";
import { UpdateItemBody } from "../lib/api/items";
import { itemPatchBody, rowToView } from "../app/dashboard/[id]/editorModel";
import { beforePublishing } from "../app/dashboard/[id]/readiness";

const expectTestDb = () => {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.includes("secure_test_design_tool_test")) {
    throw new Error(`start-screen tests require the test DB DATABASE_URL; got: ${url}`);
  }
};

const TEACHER = { sub: "start-screen-teacher", role: "staff" as const, email: "teacher@example.test" };
let mockSession: typeof TEACHER | null = TEACHER;

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
  mockSession = TEACHER;
  const db = getDb();
  await db.execute(sql`truncate table assessments restart identity cascade`);
  await db.execute(sql`truncate table staff_preferences`);
});

afterAll(async () => {
  await closeDb();
});

async function flagOn() {
  await setNewAuthoring(getDb(), TEACHER as never, true);
}

/** Run a server action and return where it redirected (or its returned state). */
async function run<T>(fn: () => Promise<T>): Promise<{ redirect: string } | { state: T }> {
  try {
    return { state: await fn() };
  } catch (err) {
    if (err instanceof Redirected) return { redirect: err.url };
    throw err;
  }
}

async function actions() {
  return import("../app/dashboard/new/actions");
}

function form(fields: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}

const EMPTY = { fieldErrors: {}, values: { name: "", description: "", time_limit_minutes: "" } };

async function allAssessments() {
  return getDb().select().from(assessments);
}

async function itemsOf(id: string) {
  return getDb().select().from(items).where(eq(items.assessment_id, id)).orderBy(asc(items.position));
}

describe("templates (pure)", () => {
  test("there are a few, with unique ids, and every one parses as an ItemBundle", () => {
    expect(ASSESSMENT_TEMPLATES.length).toBeGreaterThanOrEqual(3);
    expect(new Set(ASSESSMENT_TEMPLATES.map((t) => t.id)).size).toBe(ASSESSMENT_TEMPLATES.length);
    for (const t of ASSESSMENT_TEMPLATES) {
      const parsed = ItemBundleSchema.safeParse(t.bundle);
      if (!parsed.success) throw new Error(`${t.id}: ${parsed.error.issues[0]?.message}`);
      expect(parsed.data.items.length).toBeGreaterThan(0);
      expect(t.bundle.title).toBe(t.title);
    }
  });

  test("no template carries pictures (nothing to upload) or a source link", () => {
    for (const t of ASSESSMENT_TEMPLATES) {
      expect(t.bundle.assets).toBeUndefined();
      for (const s of t.bundle.item_sets ?? []) expect("source" in s && s.source).toBeFalsy();
    }
  });

  test("templateById, contents and the list the client gets (no bundle)", () => {
    expect(templateById("exit-ticket")?.title).toBe("Exit ticket");
    expect(templateById("nope")).toBeNull();
    const exit = templateById("exit-ticket")!;
    expect(templateTypeCounts(exit)).toEqual([
      { type: "multiple_choice_single", count: 1 },
      { type: "short_text", count: 1 },
      { type: "essay", count: 1 },
    ]);
    expect(templateContents(exit)).toBe("1 Multiple choice · 1 Short answer · 1 Essay");
    expect(templateContents(templateById("reading-check")!)).toContain("1 passage");
    const listed = startTemplates();
    expect(listed.map((t) => t.id)).toEqual(ASSESSMENT_TEMPLATES.map((t) => t.id));
    for (const t of listed) expect(Object.keys(t).sort()).toEqual(["contents", "id", "summary", "title"]);
  });

  test("the example question parses and builds one keyed row", () => {
    expect(ItemBundleSchema.safeParse(EXAMPLE_QUESTION_BUNDLE).success).toBe(true);
    const rows = exampleQuestionRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.type).toBe("multiple_choice_single");
    expect(rows[0]!.stem).toStartWith("Example question:");
    expect(rows[0]!.correct_choice_ids).toEqual(["a"]);
  });
});

describe("start choices (pure)", () => {
  test("parseStartChoice accepts the three choices only", () => {
    expect(parseStartChoice("blank")).toBe("blank");
    expect(parseStartChoice("import")).toBe("import");
    expect(parseStartChoice("ai")).toBe("ai");
    expect(parseStartChoice(null)).toBeNull();
    expect(parseStartChoice("template")).toBeNull();
  });

  test("startRedirect opens the editor with ?start= for import and AI only", () => {
    expect(startRedirect("x", null)).toBe("/dashboard/x");
    expect(startRedirect("x", "blank")).toBe("/dashboard/x");
    expect(startRedirect("x", "import")).toBe("/dashboard/x?start=import");
    expect(startRedirect("x", "ai")).toBe("/dashboard/x?start=ai");
  });

  test("aiDraftAllowed needs the AI choice AND the teacher's tick", () => {
    expect(aiDraftAllowed("ai", form({ allow_llm_authoring: "on" }))).toBe(true);
    expect(aiDraftAllowed("ai", form({}))).toBe(false);
    expect(aiDraftAllowed("blank", form({ allow_llm_authoring: "on" }))).toBe(false);
    expect(aiDraftAllowed(null, form({ allow_llm_authoring: "on" }))).toBe(false);
  });

  test("editorStartAction: flag on, not locked, and AI only while the assessment allows it", () => {
    const on = { newAuthoring: true, allowLlm: true, locked: false };
    expect(editorStartAction("import", on)).toBe("import");
    expect(editorStartAction("ai", on)).toBe("ai");
    expect(editorStartAction("ai", { ...on, allowLlm: false })).toBeNull();
    expect(editorStartAction("import", { ...on, newAuthoring: false })).toBeNull();
    expect(editorStartAction("ai", { ...on, locked: true })).toBeNull();
    expect(editorStartAction("other", on)).toBeNull();
    expect(editorStartAction(null, on)).toBeNull();
  });
});

describe("createFromTemplate (DB)", () => {
  for (const t of ASSESSMENT_TEMPLATES) {
    test(`${t.id}: creates the teacher's own draft, savable and publish-ready`, async () => {
      await flagOn();
      const { createFromTemplate } = await actions();
      const out = await run(() => createFromTemplate(form({ template: t.id })));
      expect("redirect" in out).toBe(true);
      const id = (out as { redirect: string }).redirect.replace("/dashboard/", "");
      const [a] = await getDb().select().from(assessments).where(eq(assessments.id, id));
      expect(a!.owner_sub).toBe(TEACHER.sub);
      expect(a!.owner_email).toBe(TEACHER.email);
      expect(a!.name).toBe(t.title);
      expect(a!.status).toBe("draft");
      // A template never turns AI help on.
      expect(a!.allow_llm_authoring).toBe(false);
      expect(a!.allow_highlighting).toBe(t.bundle.allow_highlighting ?? false);

      const rows = await itemsOf(id);
      expect(rows.map((r) => r.type)).toEqual(ItemBundleSchema.parse(t.bundle).items.map((i) => i.type));
      const sets = await getDb().select().from(item_sets).where(eq(item_sets.assessment_id, id));
      expect(sets).toHaveLength(t.bundle.item_sets?.length ?? 0);
      for (const s of sets) {
        expect(rows.filter((r) => r.item_set_id === s.id).length).toBeGreaterThan(0);
      }

      // Each question is something the editor can save unchanged.
      const views = rows.map((r) => rowToView(r as never));
      for (const v of views) {
        const parsed = UpdateItemBody.safeParse(itemPatchBody(v));
        if (!parsed.success) throw new Error(`${t.id} ${v.type}: ${parsed.error.issues[0]?.message}`);
      }
      // And nothing on the "Before publishing" list: every question is keyed and complete.
      expect(beforePublishing(views, sets.map((s) => ({ id: s.id, stimulus_text: s.stimulus_text })))).toEqual([]);
    });
  }

  test("a second use of the same template gets the import's copy name", async () => {
    await flagOn();
    const { createFromTemplate } = await actions();
    await run(() => createFromTemplate(form({ template: "exit-ticket" })));
    await run(() => createFromTemplate(form({ template: "exit-ticket" })));
    expect((await allAssessments()).map((a) => a.name).sort()).toEqual(["Exit ticket", "Exit ticket (copy)"]);
  });

  test("flag off, or an unknown template: back to /dashboard/new, nothing created", async () => {
    const { createFromTemplate } = await actions();
    expect(await run(() => createFromTemplate(form({ template: "exit-ticket" })))).toEqual({
      redirect: "/dashboard/new",
    });
    await flagOn();
    expect(await run(() => createFromTemplate(form({ template: "nope" })))).toEqual({
      redirect: "/dashboard/new",
    });
    expect(await allAssessments()).toHaveLength(0);
  });

  test("signed out: to the login page", async () => {
    mockSession = null;
    const { createFromTemplate } = await actions();
    expect(await run(() => createFromTemplate(form({ template: "exit-ticket" })))).toEqual({
      redirect: "/login?next=/dashboard/new",
    });
  });
});

describe("createAssessment with a start choice (DB)", () => {
  test("flag off: start, the example and the AI tick are all ignored (today's form)", async () => {
    const { createAssessment } = await actions();
    const out = await run(() =>
      createAssessment(
        EMPTY,
        form({ name: "Plain", start: "ai", allow_llm_authoring: "on", with_example: "on" }),
      ),
    );
    const [a] = await allAssessments();
    expect(out).toEqual({ redirect: `/dashboard/${a!.id}` });
    expect(a!.allow_llm_authoring).toBe(false);
    expect(await itemsOf(a!.id)).toHaveLength(0);
  });

  test("blank with the example: one example question; without it: none", async () => {
    await flagOn();
    const { createAssessment } = await actions();
    const withEx = await run(() => createAssessment(EMPTY, form({ name: "With", start: "blank", with_example: "on" })));
    const without = await run(() => createAssessment(EMPTY, form({ name: "Without", start: "blank" })));
    const byName = new Map((await allAssessments()).map((a) => [a.name, a]));
    expect(withEx).toEqual({ redirect: `/dashboard/${byName.get("With")!.id}` });
    expect(without).toEqual({ redirect: `/dashboard/${byName.get("Without")!.id}` });
    const ex = await itemsOf(byName.get("With")!.id);
    expect(ex).toHaveLength(1);
    expect(ex[0]!.stem).toStartWith("Example question:");
    expect(UpdateItemBody.safeParse(itemPatchBody(rowToView(ex[0] as never))).success).toBe(true);
    expect(await itemsOf(byName.get("Without")!.id)).toHaveLength(0);
  });

  test("import: an empty draft that opens with the import panel", async () => {
    await flagOn();
    const { createAssessment } = await actions();
    const out = await run(() => createAssessment(EMPTY, form({ name: "From a PDF", start: "import" })));
    const [a] = await allAssessments();
    expect(out).toEqual({ redirect: `/dashboard/${a!.id}?start=import` });
    expect(a!.allow_llm_authoring).toBe(false);
  });

  test("AI draft without the tick: refused with the field named, nothing created", async () => {
    await flagOn();
    const { createAssessment } = await actions();
    const out = await run(() => createAssessment(EMPTY, form({ name: "AI please", start: "ai" })));
    expect("state" in out).toBe(true);
    const state = (out as { state: { fieldErrors: Record<string, string>; values: { name: string } } }).state;
    expect(state.fieldErrors.allow_llm_authoring).toContain("Allow AI help");
    expect(state.values.name).toBe("AI please");
    expect(await allAssessments()).toHaveLength(0);
  });

  test("AI draft with the tick: AI help on for this assessment, editor opens the AI dialog", async () => {
    await flagOn();
    const { createAssessment } = await actions();
    const out = await run(() =>
      createAssessment(EMPTY, form({ name: "AI draft", start: "ai", allow_llm_authoring: "on" })),
    );
    const [a] = await allAssessments();
    expect(out).toEqual({ redirect: `/dashboard/${a!.id}?start=ai` });
    expect(a!.allow_llm_authoring).toBe(true);
  });

  test("the AI tick on any other choice does not turn AI help on", async () => {
    await flagOn();
    const { createAssessment } = await actions();
    await run(() => createAssessment(EMPTY, form({ name: "Sneaky", start: "blank", allow_llm_authoring: "on" })));
    const [a] = await allAssessments();
    expect(a!.allow_llm_authoring).toBe(false);
  });

  test("name errors still come back with a start choice", async () => {
    await flagOn();
    const { createAssessment } = await actions();
    const out = await run(() => createAssessment(EMPTY, form({ name: "", start: "ai", allow_llm_authoring: "on" })));
    const state = (out as { state: { fieldErrors: Record<string, string> } }).state;
    expect(state.fieldErrors.name).toBeDefined();
    expect(state.fieldErrors.allow_llm_authoring).toBeUndefined();
    expect(await allAssessments()).toHaveLength(0);
  });
});
