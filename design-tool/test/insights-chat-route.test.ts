// Class insights slice 4 (docs/class-insights-design.md): the chat routes,
// end to end on the mock provider against the test DB — a turn stored with
// names out and rendered with names in, nothing named in the provider's
// input, the answer pull, refusals, the cap, per-teacher threads, the
// guardrail, staleness, the thread's stable numbering, DELETE and access.
import { afterAll, afterEach, beforeAll, describe, expect, mock, spyOn, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { closeDb, getDb } from "../db/client";
import {
  access_grants,
  assessments,
  attempts,
  class_insight_threads,
  class_insight_turns,
  guardrail_events,
  items,
  responses,
  safeguarding_alerts,
  scores,
  students,
} from "../db/schema";
import { SESSION_COOKIE_NAME } from "../lib/auth/session";
import * as sessionMod from "../lib/auth/session";
import { mockProvider } from "../lib/ai/mockProvider";
import { MAX_THREAD_TURNS, type ClassInsightsChatInput } from "../lib/insights/chat";
import {
  CLASS_INSIGHTS_CHAT_PROMPT_VERSION,
  buildClassInsightsChatUserText,
} from "../lib/insights/chatPrompt";
import { GONE_STUDENT } from "../lib/insights/reportView";
import { OTHER_TEACHER_EMAIL, TEACHER_EMAIL, staffPrincipal } from "./helpers/roster";

const OWNER = "insights-chat-teacher";
const OTHER = "insights-chat-other";

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
    throw new Error(`insights chat tests require the test DB DATABASE_URL; got: ${url}`);
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

const NAMES = ["Alpha Tester", "Bravo Tester", "Charlie Tester"];
const FIRST_NAMES = ["Alpha", "Bravo", "Charlie"];

/** Q1 MC, Q2 short text, Q3 essay; three handed-in students, all final. */
async function scenario(title = "Insights chat check") {
  const db = getDb();
  const [a] = await db
    .insert(assessments)
    .values({ owner_sub: OWNER, owner_email: TEACHER_EMAIL, name: title })
    .returning();
  const [mc, st, essay] = await db
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
      { assessment_id: a!.id, position: 2, type: "essay" as const, stem: "Explain the zones." },
    ])
    .returning();
  const studentRows = await db
    .insert(students)
    .values(NAMES.map((name, i) => ({ owner_sub: OWNER, ssid: `SSID-CHAT-${"ABC"[i]}`, name })))
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
  // Each essay mentions the NEXT student by name — it must come out.
  const essayText = (i: number) =>
    `My essay about the zones. I studied with ${NAMES[(i + 1) % 3]} and ${FIRST_NAMES[(i + 2) % 3]}.`;
  const responseIds: Record<string, { mc: string; st: string; essay: string }> = {};
  for (const [i, at] of attemptRows.entries()) {
    const [r1, r2, r3] = await db
      .insert(responses)
      .values([
        { attempt_id: at.id, item_id: mc!.id, response: { type: "multiple_choice_single" as const, choice_id: i === 0 ? "a" : "b" } },
        { attempt_id: at.id, item_id: st!.id, response: { type: "short_text" as const, text: i === 1 ? "carbon" : "oxygen" } },
        { attempt_id: at.id, item_id: essay!.id, response: { type: "essay" as const, text: essayText(i) } },
      ])
      .returning();
    await db.insert(scores).values([
      { response_id: r1!.id, method: "auto", points: i === 0 ? 1 : 0, max_points: 1, scorer: "auto", status: "final" },
      { response_id: r2!.id, method: "auto", points: i === 1 ? 0 : 1, max_points: 1, scorer: "auto", status: "final" },
      { response_id: r3!.id, method: "human", points: i === 0 ? 1 : 0, max_points: 1, scorer: "teacher", status: "final" },
    ]);
    responseIds[NAMES[i]!] = { mc: r1!.id, st: r2!.id, essay: r3!.id };
  }
  const byName = new Map(studentRows.map((s, i) => [s.name, { attempt: attemptRows[i]!, student: s }]));
  return { assessment: a!, mc: mc!, st: st!, essay: essay!, byName, responseIds };
}

const URL_BASE = "http://localhost/api/assessments";

async function post(id: string, message: string, section: string | null = null) {
  const { POST } = await import("../app/api/assessments/[id]/class-insights/chat/route");
  return POST(
    new Request(`${URL_BASE}/${id}/class-insights/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ section, message }),
    }),
    { params: Promise.resolve({ id }) },
  );
}

async function get(id: string, section?: string) {
  const { GET } = await import("../app/api/assessments/[id]/class-insights/chat/route");
  const q = section === undefined ? "" : `?section=${encodeURIComponent(section)}`;
  return GET(new Request(`${URL_BASE}/${id}/class-insights/chat${q}`), { params: Promise.resolve({ id }) });
}

async function del(id: string) {
  const { DELETE } = await import("../app/api/assessments/[id]/class-insights/chat/route");
  return DELETE(new Request(`${URL_BASE}/${id}/class-insights/chat`, { method: "DELETE" }), {
    params: Promise.resolve({ id }),
  });
}

interface Turn {
  position: number;
  role: "teacher" | "assistant";
  text: string;
  citations: { students: { pseudonym: string; attempt_id: string | null; name: string }[] };
  stale_turn: boolean;
  read_answers: number;
}
interface Body {
  ok: boolean;
  error?: string;
  stage?: string;
  section_key: string;
  turns: Turn[];
  turns_left: number;
}

/** The thread label the route gave a student. */
async function labelOf(attemptId: string): Promise<string> {
  const [thread] = await getDb().select().from(class_insight_threads);
  return Object.entries(thread!.pseudonyms).find(([, a]) => a === attemptId)![0];
}

describe("POST /api/assessments/[id]/class-insights/chat", () => {
  test("stores the turn pair with names out, renders names in", async () => {
    const s = await scenario();
    const alpha = s.byName.get("Alpha Tester")!.attempt;
    const res = await post(s.assessment.id, "How did alpha tester do on Q1?");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Body;
    expect(body.turns.map((t) => t.role)).toEqual(["teacher", "assistant"]);
    expect(body.turns_left).toBe(MAX_THREAD_TURNS - 2);
    // Rendered: the teacher's own words come back with the name swapped in.
    expect(body.turns[0]!.text).toBe("How did Alpha Tester do on Q1?");
    expect(body.turns[1]!.text).toContain("Alpha Tester earned 3 of 3 points.");
    expect(body.turns[1]!.citations.students[0]!.attempt_id).toBe(alpha.id);

    const label = await labelOf(alpha.id);
    const stored = await getDb().select().from(class_insight_turns).orderBy(class_insight_turns.position);
    expect(stored[0]!.text).toBe(`How did [[${label}]] do on Q1?`);
    expect(stored[1]!.prompt_version).toBe(CLASS_INSIGHTS_CHAT_PROMPT_VERSION);
    expect(stored[1]!.model_id).toBe("mock");
    expect(stored[0]!.pack_hash).toBe(stored[1]!.pack_hash);
    const all = JSON.stringify(stored) + JSON.stringify(await getDb().select().from(class_insight_threads));
    for (const n of [...NAMES, ...FIRST_NAMES]) expect(all).not.toContain(n);

    const read = (await (await get(s.assessment.id)).json()) as Body;
    expect(read.turns.map((t) => t.text)).toEqual(body.turns.map((t) => t.text));
    expect(read.turns.every((t) => !t.stale_turn)).toBe(true);
  });

  test("no display name reaches the provider — message, answers or history", async () => {
    const s = await scenario();
    const spy = spyOn(mockProvider, "classInsightsChat");
    try {
      expect((await post(s.assessment.id, "Tell me about Bravo and Q1")).status).toBe(200);
      expect((await post(s.assessment.id, "What did Charlie Tester write on Q3?")).status).toBe(200);
      const input = spy.mock.calls.at(-1)![0] as ClassInsightsChatInput;
      expect(input.history.length).toBe(2);
      expect(input.answers.length).toBe(1);
      const everything = JSON.stringify(input) + buildClassInsightsChatUserText(input);
      for (const n of [...NAMES, ...FIRST_NAMES]) expect(everything).not.toContain(n);
      // The essay named two other students; both came out as pseudonyms.
      expect(input.answers[0]!.text).toMatch(/I studied with S\d+ and S\d+\./);
    } finally {
      spy.mockRestore();
    }
  });

  test("answer pull: only on an essay / short-text question, narrowed, alerts out, ids recorded", async () => {
    const s = await scenario();
    const spy = spyOn(mockProvider, "classInsightsChat");
    try {
      // MC only → no pull.
      await post(s.assessment.id, "Why did Q1 go badly?");
      expect((spy.mock.calls.at(-1)![0] as ClassInsightsChatInput).answers).toEqual([]);

      // An open alert on Bravo's essay keeps it out.
      const bravo = s.byName.get("Bravo Tester")!;
      await getDb().insert(safeguarding_alerts).values({
        response_id: s.responseIds["Bravo Tester"]!.essay,
        attempt_id: bravo.attempt.id,
        assessment_id: s.assessment.id,
        student_id: bravo.student.id,
        item_id: s.essay.id,
        kind: "wellbeing",
        category: "self_harm",
        detector: "mock",
      });
      await post(s.assessment.id, "Read question 3 for me");
      const all = spy.mock.calls.at(-1)![0] as ClassInsightsChatInput;
      expect(all.answers.length).toBe(2);
      const [last] = await getDb()
        .select()
        .from(class_insight_turns)
        .where(eq(class_insight_turns.position, 3));
      expect(new Set(last!.read_response_ids)).toEqual(
        new Set([s.responseIds["Alpha Tester"]!.essay, s.responseIds["Charlie Tester"]!.essay]),
      );
      // Rendered turns carry the count for the UI's "Read N answers".
      const reread = await (await get(s.assessment.id)).json();
      expect(reread.turns.at(-1).read_answers).toBe(2);

      // Naming one student narrows the pull to them.
      await post(s.assessment.id, "What did alpha write on Q3?");
      const narrowed = spy.mock.calls.at(-1)![0] as ClassInsightsChatInput;
      const alphaLabel = await labelOf(s.byName.get("Alpha Tester")!.attempt.id);
      expect(narrowed.answers.map((a) => a.student)).toEqual([alphaLabel]);
      // Short text pulls too.
      await post(s.assessment.id, "What did people write on Q2?");
      expect((spy.mock.calls.at(-1)![0] as ClassInsightsChatInput).answers.length).toBe(3);
    } finally {
      spy.mockRestore();
    }
  });

  test("a refused or malformed reply → 502 and nothing stored", async () => {
    const s = await scenario();
    const invented = await post(s.assessment.id, "MOCK_INVENTED please");
    expect(invented.status).toBe(502);
    expect(((await invented.json()) as Body).error).toBe("provider_failed");
    expect((await post(s.assessment.id, "MOCK_MALFORMED please")).status).toBe(502);
    expect(await getDb().select().from(class_insight_turns)).toEqual([]);
    expect(await getDb().select().from(class_insight_threads)).toEqual([]);
  });

  test("400 on a bad body; 409 nothing_to_report", async () => {
    const s = await scenario();
    expect((await post(s.assessment.id, "")).status).toBe(400);
    expect((await post(s.assessment.id, "x".repeat(1001))).status).toBe(400);
    await getDb().delete(scores);
    const res = await post(s.assessment.id, "Hello");
    expect(res.status).toBe(409);
    expect(((await res.json()) as Body).error).toBe("nothing_to_report");
  });

  test("40 turns is the cap → 409 thread_full", async () => {
    const s = await scenario();
    expect((await post(s.assessment.id, "Hello")).status).toBe(200);
    const [thread] = await getDb().select().from(class_insight_threads);
    await getDb()
      .insert(class_insight_turns)
      .values(
        Array.from({ length: MAX_THREAD_TURNS - 2 }, (_, i) => ({
          thread_id: thread!.id,
          position: i + 2,
          role: i % 2 === 0 ? "teacher" : "assistant",
          text: "filler",
          pack_hash: "h",
        })),
      );
    const res = await post(s.assessment.id, "One more");
    expect(res.status).toBe(409);
    expect(((await res.json()) as Body).error).toBe("thread_full");
    expect(((await (await get(s.assessment.id)).json()) as Body).turns_left).toBe(0);
  });

  test("guardrail: an input block stores nothing and never calls the model", async () => {
    process.env.GUARDRAIL_PROVIDER = "mock";
    const s = await scenario();
    const spy = spyOn(mockProvider, "classInsightsChat");
    try {
      const res = await post(s.assessment.id, "BLOCKME about Q1");
      expect(res.status).toBe(422);
      expect((await res.json()) as Body).toMatchObject({ error: "guardrail_blocked", stage: "input" });
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
    expect(await getDb().select().from(class_insight_turns)).toEqual([]);
    const events = await getDb().select().from(guardrail_events);
    expect(events.map((e) => [e.surface, e.stage, e.action])).toEqual([["class-insights", "input", "block"]]);
  });

  test("guardrail: an output block → 422, nothing stored; the input check ran on the pseudonymized message", async () => {
    process.env.GUARDRAIL_PROVIDER = "mock";
    const s = await scenario();
    const res = await post(s.assessment.id, "Charlie Tester MOCK_BLOCK_REPLY");
    expect(res.status).toBe(422);
    expect((await res.json()) as Body).toMatchObject({ error: "guardrail_blocked", stage: "output" });
    expect(await getDb().select().from(class_insight_turns)).toEqual([]);
    const events = await getDb().select().from(guardrail_events).orderBy(guardrail_events.created_at);
    expect(events.map((e) => [e.stage, e.action])).toEqual([
      ["input", "allow"],
      ["output", "block"],
    ]);
    for (const e of events) for (const n of NAMES) expect(e.text_snippet).not.toContain(n);
  });
});

describe("GET / DELETE and the thread over time", () => {
  test("an empty thread before the first message", async () => {
    const s = await scenario();
    const body = (await (await get(s.assessment.id)).json()) as Body;
    expect(body).toMatchObject({ ok: true, section_key: "__all__", turns: [], turns_left: MAX_THREAD_TURNS });
  });

  test("turns from an older pack are stale_turn after a score change; a gone attempt reads as gone", async () => {
    const s = await scenario();
    await post(s.assessment.id, "How did Alpha do on Q1?");
    await getDb()
      .update(scores)
      .set({ points: 1 })
      .where(eq(scores.response_id, s.responseIds["Bravo Tester"]!.mc));
    const changed = (await (await get(s.assessment.id)).json()) as Body;
    expect(changed.turns.every((t) => t.stale_turn)).toBe(true);
    await post(s.assessment.id, "And now?");
    const mixed = (await (await get(s.assessment.id)).json()) as Body;
    expect(mixed.turns.map((t) => t.stale_turn)).toEqual([true, true, false, false]);

    await getDb().delete(attempts).where(eq(attempts.id, s.byName.get("Alpha Tester")!.attempt.id));
    const gone = (await (await get(s.assessment.id)).json()) as Body;
    expect(gone.turns[0]!.text).toBe(`How did ${GONE_STUDENT} do on Q1?`);
  });

  test("a new student keeps everyone's thread label and takes the next one", async () => {
    const s = await scenario();
    await post(s.assessment.id, "Hello");
    const [before] = await getDb().select().from(class_insight_threads);
    const db = getDb();
    const [newcomer] = await db
      .insert(students)
      .values({ owner_sub: OWNER, ssid: "SSID-CHAT-D", name: "Delta Tester" })
      .returning();
    // The smallest possible attempt id: it would be S1 in a fresh pack.
    const [early] = await db
      .insert(attempts)
      .values({
        id: "00000000-0000-4000-8000-000000000000",
        assessment_id: s.assessment.id,
        student_id: newcomer!.id,
        status: "submitted" as const,
        started_at: new Date("2026-10-01T16:50:00Z"),
        submitted_at: new Date("2026-10-01T17:00:00Z"),
      })
      .returning();
    const [r] = await db
      .insert(responses)
      .values({ attempt_id: early!.id, item_id: s.mc.id, response: { type: "multiple_choice_single" as const, choice_id: "a" } })
      .returning();
    await db.insert(scores).values({ response_id: r!.id, method: "auto", points: 1, max_points: 1, scorer: "auto", status: "final" });

    const res = (await (await post(s.assessment.id, "How did delta do?")).json()) as Body;
    const [after] = await getDb().select().from(class_insight_threads);
    expect(after!.pseudonyms).toEqual({ ...before!.pseudonyms, S4: early!.id });
    expect(res.turns[0]!.text).toBe("How did Delta Tester do?");
    expect(res.turns[1]!.text).toContain("Delta Tester earned 1 of 3 points.");
  });

  test("DELETE removes the caller's thread; cascades with the assessment", async () => {
    const s = await scenario();
    await post(s.assessment.id, "Hello");
    const res = await del(s.assessment.id);
    expect((await res.json()) as { deleted: boolean }).toMatchObject({ ok: true, deleted: true });
    expect(await getDb().select().from(class_insight_turns)).toEqual([]);
    await post(s.assessment.id, "Hello again");
    await getDb().delete(assessments).where(eq(assessments.id, s.assessment.id));
    expect(await getDb().select().from(class_insight_threads)).toEqual([]);
    expect(await getDb().select().from(class_insight_turns)).toEqual([]);
  });
});

describe("class insights chat — access", () => {
  test("student 403; another teacher 404 on all three", async () => {
    const s = await scenario();
    principal = { sub: "student-sub", role: "student" };
    expect((await get(s.assessment.id)).status).toBe(403);
    expect((await post(s.assessment.id, "Hi")).status).toBe(403);
    expect((await del(s.assessment.id)).status).toBe(403);
    principal = staffPrincipal(OTHER, OTHER_TEACHER_EMAIL);
    expect((await get(s.assessment.id)).status).toBe(404);
    expect((await post(s.assessment.id, "Hi")).status).toBe(404);
    expect((await del(s.assessment.id)).status).toBe(404);
  });

  test("view-level co-teacher 404; edit-level co-teacher gets their own thread (D-5)", async () => {
    const s = await scenario();
    await post(s.assessment.id, "Owner's question about Q1");
    const db = getDb();
    await db.insert(access_grants).values({
      grantee_email: OTHER_TEACHER_EMAIL,
      scope_kind: "assessment",
      scope_id: s.assessment.id,
      granted_by_sub: OWNER,
      granted_by_email: TEACHER_EMAIL,
      level: "view",
    });
    principal = staffPrincipal(OTHER, OTHER_TEACHER_EMAIL);
    expect((await get(s.assessment.id)).status).toBe(404);
    expect((await post(s.assessment.id, "Hi")).status).toBe(404);

    await db.update(access_grants).set({ level: "edit" }).where(eq(access_grants.scope_id, s.assessment.id));
    expect(((await (await get(s.assessment.id)).json()) as Body).turns).toEqual([]);
    expect((await post(s.assessment.id, "Co-teacher's question")).status).toBe(200);
    const own = (await (await get(s.assessment.id)).json()) as Body;
    expect(own.turns[0]!.text).toBe("Co-teacher's question");
    // Deleting the co-teacher's thread leaves the owner's.
    await del(s.assessment.id);
    principal = staffPrincipal(OWNER);
    const owners = (await (await get(s.assessment.id)).json()) as Body;
    expect(owners.turns[0]!.text).toBe("Owner's question about Q1");
    expect((await getDb().select().from(class_insight_threads)).length).toBe(1);
  });
});
