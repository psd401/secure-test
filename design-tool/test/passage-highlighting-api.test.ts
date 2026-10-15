// Passage highlighting (docs/passage-highlighting-design.md, slice 1): the
// server half on the test DB — the setting passes the publish lock, and the
// teacher bundle (export / import / Duplicate) carries it. The delivery gate
// (2.0+ only, never refused) is in delivery-api.test.ts.
import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { closeDb, getDb } from "../db/client";
import { assessments, items } from "../db/schema";
import { SESSION_COOKIE_NAME } from "../lib/auth/session";
import * as sessionMod from "../lib/auth/session";
import { duplicateAssessment } from "../lib/api/duplicateAssessment";
import { buildExportBundle } from "../lib/api/exportBundle";
import { importBundleForOwner, isImportBundleError } from "../lib/api/importBundle";
import {
  MIN_CLIENT_VERSION_FOR_HIGHLIGHTING,
  clientSupportsHighlighting,
} from "../lib/items/clientSupport";

const expectTestDb = () => {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.includes("secure_test_design_tool_test")) {
    throw new Error(`passage-highlighting tests require the test DB; got: ${url}`);
  }
};

const TEACHER = "highlight-teacher";
const TEACHER_EMAIL = "highlight-teacher@example.org";

type Principal = { sub: string; role: string; email?: string } | null;
let principal: Principal = null;

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

async function seed(opts: { status?: "draft" | "published"; allowHighlighting?: boolean } = {}) {
  const db = getDb();
  const [a] = await db
    .insert(assessments)
    .values({
      owner_sub: TEACHER,
      owner_email: TEACHER_EMAIL,
      name: "Highlighting",
      status: opts.status ?? "draft",
      allow_highlighting: opts.allowHighlighting ?? false,
    })
    .returning();
  await db.insert(items).values({
    assessment_id: a!.id,
    position: 0,
    type: "multiple_choice_single",
    stem: "Pick one",
    choices: [
      { id: "c1", text: "one" },
      { id: "c2", text: "two" },
    ],
    correct_choice_ids: ["c1"],
  });
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

describe("clientSupportsHighlighting (H-1 gate)", () => {
  test("2.0.0 and later yes; older, absent or unreadable no", () => {
    expect(MIN_CLIENT_VERSION_FOR_HIGHLIGHTING).toBe("2.0.0");
    expect(clientSupportsHighlighting("2.0.0")).toBe(true);
    expect(clientSupportsHighlighting("2.1")).toBe(true);
    expect(clientSupportsHighlighting("10.0.0")).toBe(true);
    expect(clientSupportsHighlighting("1.6.3")).toBe(false);
    expect(clientSupportsHighlighting(null)).toBe(false);
    expect(clientSupportsHighlighting("garbage")).toBe(false);
  });
});

describe("create / PATCH", () => {
  test("POST accepts the setting; absent is off", async () => {
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
    const on = await (await post({ name: "On", allow_highlighting: true })).json();
    expect(on.assessment.allow_highlighting).toBe(true);
    const off = await (await post({ name: "Off" })).json();
    expect(off.assessment.allow_highlighting).toBe(false);
  });

  test("editable while Published; other settings stay locked", async () => {
    const a = await seed({ status: "published" });
    asTeacher();
    const ok = await patch(a.id, { allow_highlighting: true });
    expect(ok.status).toBe(200);
    const body = await ok.json();
    expect(body.assessment.allow_highlighting).toBe(true);
    expect(body.assessment.status).toBe("published");

    expect((await patch(a.id, { allow_highlighting: false, name: "Renamed" })).status).toBe(409);
    // No change is not a way through the lock.
    expect((await patch(a.id, { allow_highlighting: true })).status).toBe(409);
  });

  test("a non-boolean is a 400", async () => {
    const a = await seed();
    asTeacher();
    expect((await patch(a.id, { allow_highlighting: "yes" })).status).toBe(400);
  });
});

describe("export / import / duplicate", () => {
  test("on: export carries it, import and Duplicate keep it", async () => {
    const source = await seed({ allowHighlighting: true });
    const built = await buildExportBundle(getDb(), source, TEACHER, true);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.bundle.allow_highlighting).toBe(true);

    const imported = await importBundleForOwner(built.bundle, TEACHER, TEACHER_EMAIL);
    expect(isImportBundleError(imported)).toBe(false);
    if (isImportBundleError(imported)) return;
    const [importedRow] = await getDb()
      .select()
      .from(assessments)
      .where(eq(assessments.id, imported.assessment_id));
    expect(importedRow!.allow_highlighting).toBe(true);

    const copy = await duplicateAssessment(getDb(), source, TEACHER, TEACHER_EMAIL);
    expect(copy.ok).toBe(true);
    if (!copy.ok) return;
    const [copyRow] = await getDb().select().from(assessments).where(eq(assessments.id, copy.assessment_id));
    expect(copyRow!.allow_highlighting).toBe(true);
  });

  test("off: not emitted; a bundle without the field imports as off", async () => {
    const source = await seed();
    const built = await buildExportBundle(getDb(), source, TEACHER, true);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect("allow_highlighting" in built.bundle).toBe(false);

    const imported = await importBundleForOwner(built.bundle, TEACHER, TEACHER_EMAIL);
    if (isImportBundleError(imported)) throw new Error(imported.error);
    const [row] = await getDb().select().from(assessments).where(eq(assessments.id, imported.assessment_id));
    expect(row!.allow_highlighting).toBe(false);
  });
});
