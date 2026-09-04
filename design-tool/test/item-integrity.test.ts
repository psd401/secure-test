// Slice 70: an item whose stored shape cannot produce a valid bundle.
//
// Flagged during slice 51 and left. The failure was not a wrong answer but an
// unhandled ZodError thrown out of the route, so a teacher pressing Export got
// a bare 500 naming nothing and had no way to find which item was at fault.
import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { sql } from "drizzle-orm";
import { closeDb, getDb } from "../db/client";
import { assessments, attempts, items, students } from "../db/schema";
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
import { IncompleteItemError, assertItemsAreBundleable } from "../lib/api/itemIntegrity";
import type { ItemRow } from "../db/schema";

const expectTestDb = () => {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.includes("secure_test_design_tool_test")) {
    throw new Error(`item-integrity tests require the test DB; got: ${url}`);
  }
};

const TEACHER = "integrity-teacher";

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

let originalSecret: string | undefined;

beforeAll(async () => {
  expectTestDb();
  await seedRoster();
  originalSecret = process.env.DESIGN_TOOL_SESSION_SECRET;
  process.env.DESIGN_TOOL_SESSION_SECRET ||= "integrity-test-secret";
});

afterEach(async () => {
  principal = null;
  const db = getDb();
  await db.execute(sql`truncate table assessments restart identity cascade`);
  await db.execute(sql`truncate table students restart identity cascade`);
});

afterAll(async () => {
  await clearRoster();
  await closeDb();
  if (originalSecret === undefined) delete process.env.DESIGN_TOOL_SESSION_SECRET;
  else process.env.DESIGN_TOOL_SESSION_SECRET = originalSecret;
});

function row(overrides: Partial<ItemRow>): ItemRow {
  return {
    id: "i1",
    assessment_id: "a1",
    position: 1,
    type: "match",
    stem: "s",
    choices: [],
    correct_choice_ids: [],
    correct_answer: null,
    config: {},
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  } as ItemRow;
}

describe("assertItemsAreBundleable", () => {
  test("accepts a complete match and order item", () => {
    expect(() =>
      assertItemsAreBundleable([
        row({
          type: "match",
          config: { pairs: [
            { id: "p1", left: "a", right: "b" },
            { id: "p2", left: "c", right: "d" },
          ] },
        }),
        row({
          id: "i2",
          type: "order",
          config: { sequence: [{ id: "e1", label: "a" }, { id: "e2", label: "b" }] },
        }),
      ]),
    ).not.toThrow();
  });

  test("names the offending item rather than failing anonymously", () => {
    try {
      assertItemsAreBundleable([row({ id: "broken", type: "match", config: { pairs: [] } })]);
      throw new Error("expected a throw");
    } catch (err) {
      expect(err).toBeInstanceOf(IncompleteItemError);
      expect((err as IncompleteItemError).itemId).toBe("broken");
      expect((err as IncompleteItemError).detail).toContain("two pairs");
    }
  });

  test("one pair is as unbundleable as none", () => {
    expect(() =>
      assertItemsAreBundleable([
        row({ type: "match", config: { pairs: [{ id: "p1", left: "a", right: "b" }] } }),
      ]),
    ).toThrow(IncompleteItemError);
  });

  test("an order item with fewer than two entries is refused", () => {
    expect(() =>
      assertItemsAreBundleable([
        row({ type: "order", config: { sequence: [{ id: "e1", label: "a" }] } }),
      ]),
    ).toThrow(IncompleteItemError);
  });

  // Hotspot is deliberately draft-friendly — the teacher creates the item and
  // draws the regions afterwards — and the client already says an unconfigured
  // one cannot be answered. Checking it here would break a legitimate state.
  test("a draft hotspot is left alone", () => {
    expect(() =>
      assertItemsAreBundleable([
        row({ type: "hotspot", config: { regions: [], correct_region_ids: [] } }),
      ]),
    ).not.toThrow();
  });

  test("a drawing item with no canvas is left alone", () => {
    expect(() =>
      assertItemsAreBundleable([row({ type: "drawing_upload", config: {} })]),
    ).not.toThrow();
  });

  // E3 slice 1: a table needs a grid to be drawn; a keyless one is fine.
  test("a table with no columns or no rows is refused; a keyless grid is left alone", () => {
    expect(() =>
      assertItemsAreBundleable([row({ type: "table", config: { columns: [], rows: [{ id: "r1", label: "" }] } })]),
    ).toThrow(IncompleteItemError);
    expect(() =>
      assertItemsAreBundleable([row({ type: "table", config: { columns: [{ id: "c1", label: "A" }], rows: [] } })]),
    ).toThrow(IncompleteItemError);
    expect(() =>
      assertItemsAreBundleable([
        row({ type: "table", config: { columns: [{ id: "c1", label: "A" }], rows: [{ id: "r1", label: "" }] } }),
      ]),
    ).not.toThrow();
  });
});

describe("the routes report it instead of throwing", () => {
  async function seedBroken() {
    const db = getDb();
    const [a] = await db
      .insert(assessments)
      .values({ owner_sub: TEACHER, name: "Draft" })
      .returning();
    const [item] = await db
      .insert(items)
      .values({
        assessment_id: a!.id,
        position: 1,
        type: "match",
        stem: "incomplete",
        config: { pairs: [] },
      })
      .returning();
    return { assessment: a!, item: item! };
  }

  test("export answers 409 and names the item", async () => {
    const { assessment, item } = await seedBroken();
    principal = { sub: TEACHER, role: "staff" };

    const { GET } = await import("../app/api/assessments/[id]/export/route");
    const res = await GET(new Request("http://localhost/x"), {
      params: Promise.resolve({ id: assessment.id }),
    });

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("incomplete_item");
    // The whole point: the teacher can find the item.
    expect(body.item_id).toBe(item.id);
    expect(body.detail).toContain("two pairs");
  });

  test("delivery answers 409 rather than throwing at a student", async () => {
    const { assessment, item } = await seedBroken();
    const db = getDb();
    const [student] = await db
      .insert(students)
      .values({
        owner_sub: TEACHER,
        ssid: STUDENT.ssid,
        roster_ps_id: STUDENT.ps_id,
        name: STUDENT.name,
      })
      .returning();
    await db
      .insert(attempts)
      .values({ assessment_id: assessment.id, student_id: student!.id, status: "in_progress" });

    principal = studentPrincipal();
    const { GET } = await import("../app/api/assessments/[id]/delivery/route");
    const res = await GET(new Request("http://localhost/x"), {
      params: Promise.resolve({ id: assessment.id }),
    });

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("incomplete_item");
    expect(body.item_id).toBe(item.id);
  });

  test("a complete assessment still exports", async () => {
    const db = getDb();
    const [a] = await db
      .insert(assessments)
      .values({ owner_sub: TEACHER, name: "Fine" })
      .returning();
    await db.insert(items).values({
      assessment_id: a!.id,
      position: 1,
      type: "match",
      stem: "ok",
      config: {
        pairs: [
          { id: "p1", left: "a", right: "b" },
          { id: "p2", left: "c", right: "d" },
        ],
      },
    });
    principal = { sub: TEACHER, role: "staff" };
    const { GET } = await import("../app/api/assessments/[id]/export/route");
    const res = await GET(new Request("http://localhost/x"), {
      params: Promise.resolve({ id: a!.id }),
    });
    expect(res.status).toBe(200);
  });
});
