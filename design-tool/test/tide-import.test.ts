// Integration tests for the TIDE xlsx import route (slice 23a). Same
// harness as assessments-api.test.ts — direct route imports against the
// local test DB with the session helper mocked.
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import { and, eq, isNull, sql } from "drizzle-orm";
import { closeDb, getDb } from "../db/client";
import { students, student_accommodations } from "../db/schema";
import { SESSION_COOKIE_NAME } from "../lib/auth/session";
import * as sessionMod from "../lib/auth/session";
import { buildTideXlsxBuffer, type TideFixtureRow } from "./fixtures/build-tide-fixture";
import { tideValueForCode } from "../lib/accommodations/tideCatalog";
import { pendingTideDiffs } from "../lib/accommodations/pendingDiffs";
import type { ImportTideResult } from "../lib/api/students";

const expectTestDb = () => {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.includes("secure_test_design_tool_test")) {
    throw new Error(
      `tide-import tests require the test DB DATABASE_URL; got: ${url}`,
    );
  }
};

let originalSessionSecret: string | undefined;
let mockSub: string | null = null;

mock.module("next/headers", () => ({
  // Slice 58: requireSession now reads an Authorization bearer header as
  // well as the cookie, so the mocked module has to provide headers().
  headers: async () => new Headers(),
  cookies: async () => ({
    get: (name: string) =>
      mockSub && name === SESSION_COOKIE_NAME ? { value: "x" } : undefined,
  }),
}));

mock.module("../lib/auth/session", () => ({
  ...sessionMod,
  readSessionFromCookies: async () =>
    mockSub ? { sub: mockSub, role: "staff" } : null,
}));

function asUser(sub: string | null) {
  mockSub = sub;
}

beforeAll(() => {
  expectTestDb();
  originalSessionSecret = process.env.DESIGN_TOOL_SESSION_SECRET;
  process.env.DESIGN_TOOL_SESSION_SECRET = "test-session-secret-do-not-use";
});

afterEach(async () => {
  const db = getDb();
  await db.execute(sql`truncate table students restart identity cascade`);
});

afterAll(async () => {
  await closeDb();
  if (originalSessionSecret === undefined) {
    delete process.env.DESIGN_TOOL_SESSION_SECRET;
  } else {
    process.env.DESIGN_TOOL_SESSION_SECRET = originalSessionSecret;
  }
});

async function postImport(rows: readonly TideFixtureRow[]) {
  const { POST } = await import("../app/api/accommodations/import/route");
  const buf = await buildTideXlsxBuffer(rows);
  const form = new FormData();
  form.append(
    "file",
    new Blob(
      [buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer],
      {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      },
    ),
    "fixture.xlsx",
  );
  const req = new Request("http://localhost/api/accommodations/import", {
    method: "POST",
    body: form,
  });
  return POST(req);
}

describe("POST /api/accommodations/import (slice 23a)", () => {
  test("requires a session", async () => {
    asUser(null);
    const res = await postImport([]);
    expect(res.status).toBe(401);
  });

  test("creates students + tide_import rows on first import", async () => {
    asUser("teacher-1");
    const res = await postImport([
      { ssid: "T001", subject: "Mathematics", tool: "Color Contrast", value: "Black on Rose" },
      { ssid: "T001", subject: "Mathematics", tool: "Highlighter", value: "On" },
      { ssid: "T002", subject: "ELA-CAT", tool: "Mark for Review", value: "On" },
    ]);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ImportTideResult;
    expect(body.students_added).toBe(2);
    expect(body.students_updated).toBe(0);
    expect(body.rows_inserted).toBe(3);
    expect(body.rows_overwritten).toBe(0);
    expect(body.rows_dropped).toBe(0);
    expect(body.diffs).toEqual([]);

    const db = getDb();
    const stu = await db.select().from(students);
    expect(stu.length).toBe(2);
    const accs = await db.select().from(student_accommodations);
    expect(accs.length).toBe(3);
    expect(accs.every((a) => a.source === "tide_import")).toBe(true);
    expect(accs.every((a) => a.last_imported_at !== null)).toBe(true);
  });

  test("idempotent re-import: same payload → no changes (only last_imported_at bumps)", async () => {
    asUser("teacher-1");
    const rows: TideFixtureRow[] = [
      { ssid: "T001", subject: "Mathematics", tool: "Color Contrast", value: "Black on Rose" },
    ];
    await postImport(rows);
    const second = await postImport(rows);
    const body = (await second.json()) as ImportTideResult;
    expect(body.students_added).toBe(0);
    expect(body.students_updated).toBe(1);
    expect(body.rows_inserted).toBe(0);
    expect(body.rows_overwritten).toBe(0);
    expect(body.rows_preserved_with_diff).toBe(0);
    expect(body.rows_soft_removed).toBe(0);
  });

  test("re-import with new TIDE value overwrites tide_import rows", async () => {
    asUser("teacher-1");
    await postImport([
      { ssid: "T001", subject: "Mathematics", tool: "Color Contrast", value: "Black on Rose" },
    ]);
    const res = await postImport([
      { ssid: "T001", subject: "Mathematics", tool: "Color Contrast", value: "Yellow on Black" },
    ]);
    const body = (await res.json()) as ImportTideResult;
    expect(body.rows_overwritten).toBe(1);
    expect(body.rows_inserted).toBe(0);
    expect(body.rows_preserved_with_diff).toBe(0);

    const db = getDb();
    const [acc] = await db.select().from(student_accommodations);
    expect(acc!.value).toBe("Yellow on Black");
    expect(acc!.source).toBe("tide_import");
  });

  test("edited row preserved on re-import; diff surfaced", async () => {
    asUser("teacher-1");
    // First import: TIDE says "Black on Rose".
    await postImport([
      { ssid: "T001", subject: "Mathematics", tool: "Color Contrast", value: "Black on Rose" },
    ]);

    // Teacher edits the value → row transitions to tide_then_edited.
    const db = getDb();
    const [acc] = await db.select().from(student_accommodations);
    const [stu] = await db.select().from(students);
    const { PATCH } = await import(
      "../app/api/students/[id]/accommodations/[accId]/route"
    );
    const patchRes = await PATCH(
      new Request(
        `http://localhost/api/students/${stu!.id}/accommodations/${acc!.id}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ value: "Yellow on Black" }),
        },
      ),
      { params: Promise.resolve({ id: stu!.id, accId: acc!.id }) },
    );
    expect(patchRes.status).toBe(200);
    const [post] = await db.select().from(student_accommodations);
    expect(post!.source).toBe("tide_then_edited");
    expect(post!.value).toBe("Yellow on Black");

    // Re-import: TIDE now says "Red on White" — should preserve teacher's
    // "Yellow on Black" and surface a diff.
    const res = await postImport([
      { ssid: "T001", subject: "Mathematics", tool: "Color Contrast", value: "Red on White" },
    ]);
    const body = (await res.json()) as ImportTideResult;
    expect(body.rows_preserved_with_diff).toBe(1);
    expect(body.rows_overwritten).toBe(0);
    expect(body.diffs.length).toBe(1);
    expect(body.diffs[0]!.kept_value).toBe("Yellow on Black");
    expect(body.diffs[0]!.tide_value).toBe("Red on White");
    expect(body.diffs[0]!.ssid).toBe("T001");
    expect(body.diffs[0]!.subject).toBe("Mathematics");
    expect(body.diffs[0]!.tool_id).toBe("color_contrast");

    const [final] = await db.select().from(student_accommodations);
    expect(final!.value).toBe("Yellow on Black");
    expect(final!.source).toBe("tide_then_edited");
  });

  test("manual rows are untouched by import", async () => {
    asUser("teacher-1");
    // Seed a roster via import.
    await postImport([
      { ssid: "T001", subject: "Mathematics", tool: "Highlighter", value: "On" },
    ]);
    const db = getDb();
    const [stu] = await db.select().from(students);

    // Add a manual row on a different (subject, tool).
    const { POST } = await import(
      "../app/api/students/[id]/accommodations/route"
    );
    const createRes = await POST(
      new Request(
        `http://localhost/api/students/${stu!.id}/accommodations`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            subject: "Mathematics",
            tool_id: "english_glossary",
            value: "On",
          }),
        },
      ),
      { params: Promise.resolve({ id: stu!.id }) },
    );
    expect(createRes.status).toBe(201);

    // Re-import without english_glossary → soft-remove should NOT touch
    // the manual row.
    const res = await postImport([
      { ssid: "T001", subject: "Mathematics", tool: "Highlighter", value: "On" },
    ]);
    const body = (await res.json()) as ImportTideResult;
    expect(body.rows_soft_removed).toBe(0);
    const live = await db
      .select()
      .from(student_accommodations)
      .where(isNull(student_accommodations.removed_at));
    expect(live.length).toBe(2);
    const manual = live.find((r) => r.source === "manual");
    expect(manual).toBeDefined();
    expect(manual!.tool_id).toBe("english_glossary");
  });

  test("baseline rows absent from re-import are soft-removed", async () => {
    asUser("teacher-1");
    await postImport([
      { ssid: "T001", subject: "Mathematics", tool: "Highlighter", value: "On" },
      { ssid: "T001", subject: "Mathematics", tool: "Mark for Review", value: "On" },
    ]);
    // Re-import drops Mark for Review.
    const res = await postImport([
      { ssid: "T001", subject: "Mathematics", tool: "Highlighter", value: "On" },
    ]);
    const body = (await res.json()) as ImportTideResult;
    expect(body.rows_soft_removed).toBe(1);

    const db = getDb();
    const liveRows = await db
      .select()
      .from(student_accommodations)
      .where(isNull(student_accommodations.removed_at));
    expect(liveRows.length).toBe(1);
    expect(liveRows[0]!.tool_id).toBe("highlighter");

    const removed = await db
      .select()
      .from(student_accommodations)
      .where(sql`removed_at is not null`);
    expect(removed.length).toBe(1);
    expect(removed[0]!.tool_id).toBe("mark_for_review");
  });

  test("unknown TIDE triples are dropped with a counter", async () => {
    asUser("teacher-1");
    const res = await postImport([
      { ssid: "T001", subject: "Mathematics", tool: "Color Contrast", value: "Black on Rose" }, // known
      { ssid: "T001", subject: "Mathematics", tool: "Color Contrast", value: "Black on Mauve" }, // unknown value
      { ssid: "T001", subject: "ELA-CAT", tool: "Made Up Tool", value: "On" }, // unknown tool
    ]);
    const body = (await res.json()) as ImportTideResult;
    expect(body.rows_inserted).toBe(1);
    expect(body.rows_dropped).toBe(2);
  });

  // D12 — DATA LOSS. An incoming row that failed catalog mapping never entered
  // incomingIndex, so the soft-remove sweep treated the student's EXISTING
  // live row for that tool as absent from the import and revoked it. A
  // legally-entitled student silently lost a tool because TIDE re-cased a
  // dropdown value.
  test("an unmappable VALUE does not revoke the student's existing row (D12)", async () => {
    asUser("teacher-1");
    await postImport([
      { ssid: "T001", subject: "Mathematics", tool: "Color Contrast", value: "Black on Rose" },
      { ssid: "T001", subject: "Mathematics", tool: "Highlighter", value: "On" },
    ]);

    // TIDE still asserts Color Contrast for this student, but with a value
    // that isn't in the catalog (drift / re-casing).
    const res = await postImport([
      { ssid: "T001", subject: "Mathematics", tool: "Color Contrast", value: "Black on Mauve" },
      { ssid: "T001", subject: "Mathematics", tool: "Highlighter", value: "On" },
    ]);
    const body = (await res.json()) as ImportTideResult;
    expect(body.rows_dropped).toBe(1);
    expect(body.rows_soft_removed).toBe(0);
    expect(body.rows_removal_suppressed).toBe(1);

    const db = getDb();
    const live = await db
      .select()
      .from(student_accommodations)
      .where(isNull(student_accommodations.removed_at));
    expect(live.length).toBe(2);
    const cc = live.find((r) => r.tool_id === "color_contrast");
    expect(cc).toBeDefined();
    // Untouched — the previously-imported value survives as-is.
    expect(cc!.value).toBe("Black on Rose");
  });

  test("an unmappable TOOL NAME suppresses the sweep for that student (D12)", async () => {
    asUser("teacher-1");
    await postImport([
      { ssid: "T001", subject: "Mathematics", tool: "Highlighter", value: "On" },
      { ssid: "T001", subject: "Mathematics", tool: "Mark for Review", value: "On" },
    ]);

    // TIDE sends a tool we cannot correlate at all AND omits Mark for Review.
    // We cannot distinguish "withdrawn" from "renamed", so nothing is removed.
    const res = await postImport([
      { ssid: "T001", subject: "Mathematics", tool: "Highlighter", value: "On" },
      { ssid: "T001", subject: "Mathematics", tool: "Brand New Tool", value: "On" },
    ]);
    const body = (await res.json()) as ImportTideResult;
    expect(body.rows_dropped).toBe(1);
    expect(body.rows_soft_removed).toBe(0);
    expect(body.students_sweep_skipped).toBe(1);

    const db = getDb();
    const live = await db
      .select()
      .from(student_accommodations)
      .where(isNull(student_accommodations.removed_at));
    expect(live.length).toBe(2);
  });

  test("a fully-mappable import still soft-removes genuinely absent rows (D12 regression guard)", async () => {
    asUser("teacher-1");
    await postImport([
      { ssid: "T001", subject: "Mathematics", tool: "Highlighter", value: "On" },
      { ssid: "T001", subject: "Mathematics", tool: "Mark for Review", value: "On" },
    ]);
    const res = await postImport([
      { ssid: "T001", subject: "Mathematics", tool: "Highlighter", value: "On" },
    ]);
    const body = (await res.json()) as ImportTideResult;
    expect(body.rows_soft_removed).toBe(1);
    expect(body.rows_removal_suppressed).toBe(0);
    expect(body.students_sweep_skipped).toBe(0);
  });

  // D14: applyTideImport refreshes last_imported_at on every tide_then_edited
  // row it touches, and the review predicate was purely timestamp-based — so
  // an edited row showed as a pending diff after EVERY import, forever, even
  // when TIDE's value matched the kept value. tide_code now tracks what TIDE
  // currently asserts, which is what makes the value comparison possible.
  test("re-importing the SAME value as the kept edit refreshes tide_code to match (D14)", async () => {
    asUser("teacher-1");
    await postImport([
      { ssid: "T001", subject: "Mathematics", tool: "Color Contrast", value: "Black on Rose" },
    ]);
    const db = getDb();
    const [acc] = await db.select().from(student_accommodations);
    const [stu] = await db.select().from(students);
    const { PATCH } = await import(
      "../app/api/students/[id]/accommodations/[accId]/route"
    );
    await PATCH(
      new Request(
        `http://localhost/api/students/${stu!.id}/accommodations/${acc!.id}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ value: "Yellow on Black" }),
        },
      ),
      { params: Promise.resolve({ id: stu!.id, accId: acc!.id }) },
    );

    // TIDE now agrees with the teacher's edit.
    const res = await postImport([
      { ssid: "T001", subject: "Mathematics", tool: "Color Contrast", value: "Yellow on Black" },
    ]);
    const body = (await res.json()) as ImportTideResult;
    expect(body.rows_preserved_with_diff).toBe(0);
    expect(body.diffs).toEqual([]);

    // tide_code now resolves to the SAME value the teacher kept, which is what
    // lets the review screen stop listing this row.
    const [row] = await db.select().from(student_accommodations);
    expect(row!.source).toBe("tide_then_edited");
    expect(row!.value).toBe("Yellow on Black");
    expect(
      tideValueForCode(row!.subject, row!.tool_id, row!.tide_code!),
    ).toBe("Yellow on Black");
  });

  test("re-importing a DIFFERENT value leaves tide_code pointing at TIDE's value (D14)", async () => {
    asUser("teacher-1");
    await postImport([
      { ssid: "T001", subject: "Mathematics", tool: "Color Contrast", value: "Black on Rose" },
    ]);
    const db = getDb();
    const [acc] = await db.select().from(student_accommodations);
    const [stu] = await db.select().from(students);
    const { PATCH } = await import(
      "../app/api/students/[id]/accommodations/[accId]/route"
    );
    await PATCH(
      new Request(
        `http://localhost/api/students/${stu!.id}/accommodations/${acc!.id}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ value: "Yellow on Black" }),
        },
      ),
      { params: Promise.resolve({ id: stu!.id, accId: acc!.id }) },
    );
    await postImport([
      { ssid: "T001", subject: "Mathematics", tool: "Color Contrast", value: "Red on White" },
    ]);
    const [row] = await db.select().from(student_accommodations);
    expect(row!.value).toBe("Yellow on Black");
    expect(
      tideValueForCode(row!.subject, row!.tool_id, row!.tide_code!),
    ).toBe("Red on White");
  });

  // D13: mapTideToCatalogId was called with an EMPTY tool name (so it always
  // returned null) and the result discarded with `void mapped`. Any client
  // string was then stored with source flipped to the canonical `tide_import`
  // and tide_code left stale — a typo became "TIDE truth" in the audit ledger.
  describe("keep-mine persists the decision (UX pass 2 slice 5, P2-5)", () => {
    async function seedDiff() {
      asUser("teacher-1");
      await postImport([
        { ssid: "T001", subject: "Mathematics", tool: "Color Contrast", value: "Black on Rose" },
      ]);
      const db = getDb();
      const [acc] = await db.select().from(student_accommodations);
      const [stu] = await db.select().from(students);
      const { PATCH } = await import("../app/api/students/[id]/accommodations/[accId]/route");
      await PATCH(
        new Request(`http://localhost/api/students/${stu!.id}/accommodations/${acc!.id}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ value: "Yellow on Black" }),
        }),
        { params: Promise.resolve({ id: stu!.id, accId: acc!.id }) },
      );
      await postImport([
        { ssid: "T001", subject: "Mathematics", tool: "Color Contrast", value: "Black on Rose" },
      ]);
      return { accId: acc!.id, studentId: stu!.id };
    }

    async function keepMine(accId: string) {
      const { POST } = await import("../app/api/accommodations/import/diff/[accId]/keep-mine/route");
      return POST(
        new Request(`http://localhost/api/accommodations/import/diff/${accId}/keep-mine`, { method: "POST" }),
        { params: Promise.resolve({ accId }) },
      );
    }

    test("an identical re-import raises nothing after Keep mine", async () => {
      const { accId } = await seedDiff();
      const db = getDb();
      expect((await pendingTideDiffs(db, "teacher-1")).length).toBe(1);

      const res = await keepMine(accId);
      expect(res.status).toBe(200);
      expect((await pendingTideDiffs(db, "teacher-1")).length).toBe(0);

      const res2 = await postImport([
        { ssid: "T001", subject: "Mathematics", tool: "Color Contrast", value: "Black on Rose" },
      ]);
      const result = (await res2.json()) as ImportTideResult;
      expect(result.rows_preserved_with_diff).toBe(0);
      expect(result.diffs.length).toBe(0);
      expect((await pendingTideDiffs(db, "teacher-1")).length).toBe(0);
      // The kept value is still in effect.
      const [row] = await db.select().from(student_accommodations);
      expect(row!.value).toBe("Yellow on Black");
      expect(row!.source).toBe("tide_then_edited");
    });

    test("a NEW TIDE value raises the diff again", async () => {
      const { accId } = await seedDiff();
      await keepMine(accId);
      const res2 = await postImport([
        { ssid: "T001", subject: "Mathematics", tool: "Color Contrast", value: "Red on White" },
      ]);
      const result = (await res2.json()) as ImportTideResult;
      expect(result.rows_preserved_with_diff).toBe(1);
      const db = getDb();
      const diffs = await pendingTideDiffs(db, "teacher-1");
      expect(diffs.length).toBe(1);
      expect(diffs[0]!.tide_value).toBe("Red on White");
    });

    test("a teacher edit clears the decision", async () => {
      const { accId, studentId } = await seedDiff();
      await keepMine(accId);
      const { PATCH } = await import("../app/api/students/[id]/accommodations/[accId]/route");
      await PATCH(
        new Request(`http://localhost/api/students/${studentId}/accommodations/${accId}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ value: "Red on White" }),
        }),
        { params: Promise.resolve({ id: studentId, accId } ) },
      );
      const db = getDb();
      const [row] = await db.select().from(student_accommodations);
      expect(row!.kept_against_tide_code).toBeNull();
    });

    test("409 on a row that is not a pending diff", async () => {
      asUser("teacher-1");
      await postImport([
        { ssid: "T001", subject: "Mathematics", tool: "Color Contrast", value: "Black on Rose" },
      ]);
      const db = getDb();
      const [acc] = await db.select().from(student_accommodations);
      const res = await keepMine(acc!.id);
      expect(res.status).toBe(409);
    });
  });

  describe("accept-tide re-validates against the catalog (D13)", () => {
    async function seedEditedRow() {
      asUser("teacher-1");
      await postImport([
        { ssid: "T001", subject: "Mathematics", tool: "Color Contrast", value: "Black on Rose" },
      ]);
      const db = getDb();
      const [acc] = await db.select().from(student_accommodations);
      const [stu] = await db.select().from(students);
      const { PATCH } = await import(
        "../app/api/students/[id]/accommodations/[accId]/route"
      );
      await PATCH(
        new Request(
          `http://localhost/api/students/${stu!.id}/accommodations/${acc!.id}`,
          {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ value: "Yellow on Black" }),
          },
        ),
        { params: Promise.resolve({ id: stu!.id, accId: acc!.id }) },
      );
      await postImport([
        { ssid: "T001", subject: "Mathematics", tool: "Color Contrast", value: "Red on White" },
      ]);
      return acc!.id;
    }

    async function acceptTide(accId: string, tide_value: unknown) {
      const { POST } = await import(
        "../app/api/accommodations/import/diff/[accId]/accept-tide/route"
      );
      return POST(
        new Request(
          `http://localhost/api/accommodations/import/diff/${accId}/accept-tide`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ tide_value }),
          },
        ),
        { params: Promise.resolve({ accId }) },
      );
    }

    test("rejects a value that isn't in the catalog for this (subject, tool)", async () => {
      const accId = await seedEditedRow();
      const res = await acceptTide(accId, "Chartreuse on Puce");
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("tide_value_not_in_catalog");

      // Nothing was written — provenance and value are unchanged.
      const db = getDb();
      const [row] = await db.select().from(student_accommodations);
      expect(row!.source).toBe("tide_then_edited");
      expect(row!.value).toBe("Yellow on Black");
      expect(row!.edited_at).not.toBeNull();
    });

    test("rejects a catalog value that belongs to a DIFFERENT tool", async () => {
      const accId = await seedEditedRow();
      // "On" is a real TIDE value, but not for Color Contrast.
      const res = await acceptTide(accId, "On");
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("tide_value_not_in_catalog");
    });

    test("accepts a valid value and refreshes tide_code alongside it", async () => {
      const accId = await seedEditedRow();
      const res = await acceptTide(accId, "Red on White");
      expect(res.status).toBe(200);

      const db = getDb();
      const [row] = await db.select().from(student_accommodations);
      expect(row!.value).toBe("Red on White");
      expect(row!.source).toBe("tide_import");
      expect(row!.edited_at).toBeNull();
      // tide_code now agrees with the stored value — it used to stay stale.
      expect(
        tideValueForCode(row!.subject, row!.tool_id, row!.tide_code!),
      ).toBe("Red on White");
    });
  });

  // Cleanup #5: the merge was batched from ~2 queries per row to a handful of
  // bulk statements. Bulk writes hit Postgres's 65535 bind-parameter cap, which
  // an unchunked insert would blow at exactly the district scale the batching
  // exists to serve — so exercise a row count past the 1000-row chunk boundary.
  test("imports a multi-chunk batch without hitting the PG parameter cap", async () => {
    asUser("teacher-1");
    const tools: [string, string][] = [
      ["Color Contrast", "Black on Rose"],
      ["Highlighter", "On"],
      ["Mark for Review", "On"],
    ];
    const rows: TideFixtureRow[] = [];
    for (let i = 0; i < 500; i += 1) {
      const ssid = `S${String(i).padStart(5, "0")}`;
      for (const [tool, value] of tools) {
        rows.push({ ssid, subject: "Mathematics", tool, value });
      }
    }
    expect(rows.length).toBe(1500); // > PG_BATCH_SIZE, so chunking must engage

    const res = await postImport(rows);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ImportTideResult;
    expect(body.students_added).toBe(500);
    expect(body.rows_inserted).toBe(1500);
    expect(body.rows_dropped).toBe(0);

    const db = getDb();
    const live = await db
      .select()
      .from(student_accommodations)
      .where(isNull(student_accommodations.removed_at));
    expect(live.length).toBe(1500);

    // Re-import the same payload: every student is now an update, and every
    // accommodation an overwrite-with-no-change. Exercises the batched
    // student-update path across chunks too.
    const second = await postImport(rows);
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as ImportTideResult;
    expect(secondBody.students_added).toBe(0);
    expect(secondBody.students_updated).toBe(500);
    expect(secondBody.rows_inserted).toBe(0);
    expect(secondBody.rows_overwritten).toBe(0);
    expect(secondBody.rows_soft_removed).toBe(0);
  }, 60_000);

  test("rejects requests without multipart content-type", async () => {
    asUser("teacher-1");
    const { POST } = await import("../app/api/accommodations/import/route");
    const res = await POST(
      new Request("http://localhost/api/accommodations/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("expected_multipart");
  });

  test("scoping: teacher A's import doesn't surface to teacher B", async () => {
    asUser("teacher-A");
    await postImport([
      { ssid: "TA-001", subject: "Mathematics", tool: "Highlighter", value: "On" },
    ]);
    asUser("teacher-B");
    await postImport([
      { ssid: "TB-001", subject: "Mathematics", tool: "Highlighter", value: "On" },
    ]);
    const db = getDb();
    const accA = await db
      .select()
      .from(students)
      .where(eq(students.owner_sub, "teacher-A"));
    expect(accA.length).toBe(1);
    expect(accA[0]!.ssid).toBe("TA-001");
    const accB = await db
      .select()
      .from(students)
      .where(eq(students.owner_sub, "teacher-B"));
    expect(accB.length).toBe(1);
    expect(accB[0]!.ssid).toBe("TB-001");
  });
});
