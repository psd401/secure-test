// Class insights slice 2 (docs/class-insights-design.md): the report routes,
// end to end on the mock provider (the default) against the test DB —
// generate, store, regenerate (upsert), render with names swapped in, stale
// after a score change, a deleted attempt's wording, access, the guardrail
// and a malformed reply.
import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { closeDb, getDb } from "../db/client";
import {
  access_grants,
  assessments,
  attempts,
  class_insight_reports,
  guardrail_events,
  items,
  responses,
  scores,
  students,
} from "../db/schema";
import { SESSION_COOKIE_NAME } from "../lib/auth/session";
import * as sessionMod from "../lib/auth/session";
import { GONE_STUDENT } from "../lib/insights/reportView";
import { CLASS_INSIGHTS_PROMPT_VERSION } from "../lib/insights/reportPrompt";
import { OTHER_TEACHER_EMAIL, TEACHER_EMAIL, staffPrincipal } from "./helpers/roster";

const OWNER = "insights-route-teacher";
const OTHER = "insights-route-other";

type Principal = { sub: string; role: string; email?: string } | null;
let principal: Principal = staffPrincipal(OWNER);

mock.module("next/headers", () => ({
  headers: async () => new Headers(),
  cookies: async () => ({
    get: (name: string) => (principal && name === SESSION_COOKIE_NAME ? { value: "x" } : undefined),
  }),
}));

mock.module("../lib/auth/session", () => ({
  ...sessionMod,
  readSessionFromCookies: async () => principal,
}));

let originalSecret: string | undefined;

beforeAll(() => {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.includes("secure_test_design_tool_test")) {
    throw new Error(`insights route tests require the test DB DATABASE_URL; got: ${url}`);
  }
  originalSecret = process.env.DESIGN_TOOL_SESSION_SECRET;
  process.env.DESIGN_TOOL_SESSION_SECRET ||= "insights-test-secret-do-not-use";
});

afterEach(async () => {
  principal = staffPrincipal(OWNER);
  delete process.env.GUARDRAIL_PROVIDER;
  const db = getDb();
  await db.execute(sql`truncate table assessments, guardrail_events restart identity cascade`);
  await db.execute(sql`truncate table students restart identity cascade`);
  await db.execute(sql`truncate table access_grants restart identity cascade`);
});

afterAll(async () => {
  await closeDb();
  if (originalSecret === undefined) delete process.env.DESIGN_TOOL_SESSION_SECRET;
  else process.env.DESIGN_TOOL_SESSION_SECRET = originalSecret;
});

const NAMES = ["Student Alpha", "Student Bravo", "Student Charlie"];

/** Two items (MC Q1, short text Q2), three handed-in students, all final. */
async function scenario(title = "Insights route check") {
  const db = getDb();
  const [a] = await db
    .insert(assessments)
    .values({ owner_sub: OWNER, owner_email: TEACHER_EMAIL, name: title })
    .returning();
  const [mc, st] = await db
    .insert(items)
    .values([
      {
        assessment_id: a!.id,
        position: 0,
        type: "multiple_choice_single" as const,
        stem: "Pick the sunlit zone.",
        choices: [
          { id: "a", text: "Sunlit" },
          { id: "b", text: "Twilight" },
        ],
        correct_choice_ids: ["a"],
      },
      { assessment_id: a!.id, position: 1, type: "short_text" as const, stem: "Gas?", correct_answer: "oxygen" },
    ])
    .returning();
  const studentRows = await db
    .insert(students)
    .values(NAMES.map((name, i) => ({ owner_sub: OWNER, ssid: `SSID-FIX-${"ABC"[i]}`, name })))
    .returning();
  const t = new Date("2026-10-01T17:00:00Z");
  const attemptRows = await db
    .insert(attempts)
    .values(
      studentRows.map((s) => ({
        assessment_id: a!.id,
        student_id: s.id,
        status: "submitted" as const,
        started_at: new Date(t.getTime() - 600_000),
        submitted_at: t,
      })),
    )
    .returning();
  // Alpha: both right. Bravo: both wrong. Charlie: MC wrong, short right.
  const marks = [
    [1, 1],
    [0, 0],
    [0, 1],
  ];
  const scoreIds: string[] = [];
  for (const [i, at] of attemptRows.entries()) {
    const [r1, r2] = await db
      .insert(responses)
      .values([
        { attempt_id: at.id, item_id: mc!.id, response: { type: "multiple_choice_single" as const, choice_id: marks[i]![0] ? "a" : "b" } },
        { attempt_id: at.id, item_id: st!.id, response: { type: "short_text" as const, text: marks[i]![1] ? "oxygen" : "carbon" } },
      ])
      .returning();
    const s = await db
      .insert(scores)
      .values([
        { response_id: r1!.id, method: "auto", points: marks[i]![0]!, max_points: 1, scorer: "auto", status: "final" },
        { response_id: r2!.id, method: "auto", points: marks[i]![1]!, max_points: 1, scorer: "auto", status: "final" },
      ])
      .returning();
    scoreIds.push(...s.map((x) => x.id));
  }
  const byName = new Map(studentRows.map((s, i) => [s.name, attemptRows[i]!]));
  return { assessment: a!, mc: mc!, st: st!, attempts: attemptRows, byName, scoreIds };
}

async function post(id: string, body: unknown = { section: null }) {
  const { POST } = await import("../app/api/assessments/[id]/class-insights/route");
  return POST(
    new Request(`http://localhost/api/assessments/${id}/class-insights`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  );
}

async function get(id: string, section?: string) {
  const { GET } = await import("../app/api/assessments/[id]/class-insights/route");
  const q = section === undefined ? "" : `?section=${encodeURIComponent(section)}`;
  return GET(new Request(`http://localhost/api/assessments/${id}/class-insights${q}`), {
    params: Promise.resolve({ id }),
  });
}

interface RenderedClaim {
  text: string;
  citations: {
    items: { label: string; item_id: string | null }[];
    students: { pseudonym: string; attempt_id: string | null; name: string }[];
  };
}
interface Body {
  ok: boolean;
  error?: string;
  stage?: string;
  section_key: string;
  sections: Record<"strengths" | "growth" | "celebrations" | "next_steps", RenderedClaim[]>;
  stale: boolean;
  dropped_claims: number;
  model_id: string;
  prompt_version: string;
}

describe("POST /api/assessments/[id]/class-insights", () => {
  test("generates, stores pseudonyms only, renders names; regenerate overwrites", async () => {
    const s = await scenario();
    const res = await post(s.assessment.id);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Body;
    expect(body).toMatchObject({ ok: true, section_key: "__all__", stale: false, model_id: "mock", dropped_claims: 0 });
    expect(body.prompt_version).toBe(CLASS_INSIGHTS_PROMPT_VERSION);

    // The top student (Alpha) is celebrated BY NAME in the rendered text.
    const celebration = body.sections.celebrations[0]!;
    expect(celebration.text).toBe("Student Alpha earned 2 of 2 points.");
    expect(celebration.citations.students[0]!.attempt_id).toBe(s.byName.get("Student Alpha")!.id);
    // Q1 (MC) is the hardest; its link carries the item id.
    expect(body.sections.growth[0]!.citations.items[0]).toEqual({ label: "Q1", item_id: s.mc.id });
    expect(body.sections.next_steps.length).toBeGreaterThanOrEqual(2);

    const rows = await getDb().select().from(class_insight_reports);
    expect(rows.length).toBe(1);
    const row = rows[0]!;
    // S-numbers follow ascending attempt id.
    const sortedIds: string[] = s.attempts.map((a) => a.id).sort();
    expect(row.pseudonyms).toEqual({ S1: sortedIds[0]!, S2: sortedIds[1]!, S3: sortedIds[2]! });
    expect(row.item_ids).toEqual({ Q1: s.mc.id, Q2: s.st.id });
    const stored = JSON.stringify(row.report);
    for (const n of NAMES) expect(stored).not.toContain(n);
    expect(stored).toContain("[[S");

    const first = row.created_at;
    expect((await post(s.assessment.id)).status).toBe(200);
    const again = await getDb().select().from(class_insight_reports);
    expect(again.length).toBe(1);
    expect(again[0]!.id).toBe(row.id);
    expect(again[0]!.created_at.getTime()).toBeGreaterThanOrEqual(first.getTime());
  });

  test("409 nothing_to_report when no handed-in student has a final score", async () => {
    const s = await scenario();
    await getDb().delete(scores);
    const res = await post(s.assessment.id);
    expect(res.status).toBe(409);
    expect(((await res.json()) as Body).error).toBe("nothing_to_report");
    expect(await getDb().select().from(class_insight_reports)).toEqual([]);
  });

  test("a section filter is its own report", async () => {
    const s = await scenario();
    // Nobody is in "Period 9": nothing to report there.
    expect((await post(s.assessment.id, { section: "Period 9" })).status).toBe(409);
    // No section resolved for any of them: "__none__" holds everyone.
    expect((await post(s.assessment.id, { section: "__none__" })).status).toBe(200);
    expect((await get(s.assessment.id)).status).toBe(404);
    expect((await get(s.assessment.id, "__none__")).status).toBe(200);
  });

  test("400 on a bad body", async () => {
    const s = await scenario();
    expect((await post(s.assessment.id, { section: 7 })).status).toBe(400);
  });

  test("502 on a malformed reply; nothing stored", async () => {
    const s = await scenario("MOCK_MALFORMED check");
    const res = await post(s.assessment.id);
    expect(res.status).toBe(502);
    expect(((await res.json()) as Body).error).toBe("provider_failed");
    expect(await getDb().select().from(class_insight_reports)).toEqual([]);
  });

  test("invented claims are dropped and counted", async () => {
    const s = await scenario("MOCK_INVENTED check");
    const body = (await (await post(s.assessment.id)).json()) as Body;
    expect(body.dropped_claims).toBe(3);
  });

  test("guardrail: an output block → 422, nothing stored, one output event and no input event", async () => {
    process.env.GUARDRAIL_PROVIDER = "mock";
    const s = await scenario("BLOCKME check");
    const res = await post(s.assessment.id);
    expect(res.status).toBe(422);
    expect((await res.json()) as Body).toMatchObject({ error: "guardrail_blocked", stage: "output" });
    expect(await getDb().select().from(class_insight_reports)).toEqual([]);
    const events = await getDb().select().from(guardrail_events);
    expect(events.map((e) => [e.surface, e.stage, e.action])).toEqual([["class-insights", "output", "block"]]);
  });

  test("guardrail: an allowed run records the output check, pseudonyms only", async () => {
    process.env.GUARDRAIL_PROVIDER = "mock";
    const s = await scenario();
    expect((await post(s.assessment.id)).status).toBe(200);
    const events = await getDb().select().from(guardrail_events);
    expect(events.map((e) => [e.surface, e.stage, e.action])).toEqual([["class-insights", "output", "allow"]]);
    for (const n of NAMES) expect(events[0]!.text_snippet).not.toContain(n);
  });
});

describe("GET /api/assessments/[id]/class-insights", () => {
  test("404 none before generation; stale after a score change; a deleted attempt renders as gone", async () => {
    const s = await scenario();
    const none = await get(s.assessment.id);
    expect(none.status).toBe(404);
    expect(((await none.json()) as Body).error).toBe("none");

    await post(s.assessment.id);
    const fresh = (await (await get(s.assessment.id)).json()) as Body;
    expect(fresh.stale).toBe(false);
    expect(fresh.sections.celebrations[0]!.text).toBe("Student Alpha earned 2 of 2 points.");

    // Change score: Bravo's short answer now earns its point.
    const bravo = s.byName.get("Student Bravo")!;
    await getDb().execute(
      sql`update scores set points = 1 where response_id in (select id from responses where attempt_id = ${bravo.id} and item_id = ${s.st.id})`,
    );
    const changed = (await (await get(s.assessment.id)).json()) as Body;
    expect(changed.stale).toBe(true);
    // The stored text does not move with the scores.
    expect(changed.sections.celebrations[0]!.text).toBe("Student Alpha earned 2 of 2 points.");

    // Alpha's attempt is deleted: the name is gone, the claim stays.
    await getDb().delete(attempts).where(eq(attempts.id, s.byName.get("Student Alpha")!.id));
    const gone = (await (await get(s.assessment.id)).json()) as Body;
    expect(gone.sections.celebrations[0]!.text).toBe(`${GONE_STUDENT} earned 2 of 2 points.`);
    expect(gone.sections.celebrations[0]!.citations.students[0]!.attempt_id).toBeNull();
  });

  test("a deleted item keeps the label in the text and drops the link", async () => {
    const s = await scenario();
    await post(s.assessment.id);
    await getDb().delete(items).where(eq(items.id, s.mc.id));
    const body = (await (await get(s.assessment.id)).json()) as Body;
    expect(body.sections.growth[0]!.citations.items[0]).toEqual({ label: "Q1", item_id: null });
    expect(body.sections.growth[0]!.text).toContain("Q1");
  });

  test("deleted with the assessment (D-4 retention)", async () => {
    const s = await scenario();
    await post(s.assessment.id);
    await getDb().delete(assessments).where(eq(assessments.id, s.assessment.id));
    expect(await getDb().select().from(class_insight_reports)).toEqual([]);
  });
});

describe("class insights — access", () => {
  test("student 403; another teacher 404 on both", async () => {
    const s = await scenario();
    await post(s.assessment.id);
    principal = { sub: "student-sub", role: "student" };
    expect((await get(s.assessment.id)).status).toBe(403);
    expect((await post(s.assessment.id)).status).toBe(403);
    principal = staffPrincipal(OTHER, OTHER_TEACHER_EMAIL);
    expect((await get(s.assessment.id)).status).toBe(404);
    expect((await post(s.assessment.id)).status).toBe(404);
  });

  test("a view-level co-teacher reads the report but cannot generate; edit can", async () => {
    const s = await scenario();
    await post(s.assessment.id);
    const db = getDb();
    const grant = {
      grantee_email: OTHER_TEACHER_EMAIL,
      scope_kind: "assessment",
      scope_id: s.assessment.id,
      granted_by_sub: OWNER,
      granted_by_email: TEACHER_EMAIL,
    };
    await db.insert(access_grants).values({ ...grant, level: "view" });
    principal = staffPrincipal(OTHER, OTHER_TEACHER_EMAIL);
    const read = await get(s.assessment.id);
    expect(read.status).toBe(200);
    expect(((await read.json()) as Body).sections.celebrations[0]!.text).toContain("Student Alpha");
    expect((await post(s.assessment.id)).status).toBe(404);

    await db.update(access_grants).set({ level: "edit" }).where(eq(access_grants.scope_id, s.assessment.id));
    expect((await post(s.assessment.id)).status).toBe(200);
    const [row] = await db.select().from(class_insight_reports);
    expect(row!.created_by_sub).toBe(OTHER);
  });
});
