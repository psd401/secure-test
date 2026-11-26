// Working-time clock, slice 1 (docs/working-time-clock-design.md): the
// deadline rule, the tick, extend / pass-back compatibility, and the
// migration's backfill (D6, Q1). Pure tests first, then the DB.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import { closeDb, getDb } from "../db/client";
import { attempt_events, attempts, assessments, responses, students, items } from "../db/schema";
import {
  CLOCK_GAP_CAP_SECONDS,
  DEADLINE_GRACE_SECONDS,
  deadlineFor,
  extensionForEndTime,
  isPastDeadline,
  refuseIfPastDeadline,
  workingTimeLeft,
  type DeadlineAttempt,
} from "../lib/api/attemptDeadline";
import { tickWorkingClock } from "../lib/api/workingClock";
import { extendAttempt } from "../lib/api/extendAttempt";

const NOW = new Date("2026-11-26T17:00:00.000Z");
const ago = (s: number) => new Date(NOW.getTime() - s * 1000);
const after = (s: number) => new Date(NOW.getTime() + s * 1000);
const WORKING = { time_limit_seconds: 3600, time_limit_mode: "working" };
const attempt = (over: Partial<DeadlineAttempt> = {}): DeadlineAttempt => ({
  started_at: ago(86_400), // started yesterday: the wall clock would be long over
  deadline_override_at: null,
  time_limit_removed: false,
  working_seconds: 600,
  last_tick_at: null,
  extension_seconds: 0,
  ...over,
});

describe("deadlineFor on the working-time clock", () => {
  test("between sessions the clock is paused: now + time left", () => {
    expect(deadlineFor(attempt({ last_tick_at: ago(3600) }), WORKING, NOW)).toEqual(after(3000));
    expect(deadlineFor(attempt(), WORKING, NOW)).toEqual(after(3000));
  });

  test("live (ticked within 2 min): the time since the tick counts, so the deadline holds steady", () => {
    expect(deadlineFor(attempt({ last_tick_at: ago(5) }), WORKING, NOW)).toEqual(after(2995));
    expect(deadlineFor(attempt({ last_tick_at: ago(CLOCK_GAP_CAP_SECONDS) }), WORKING, NOW)).toEqual(
      after(3000 - CLOCK_GAP_CAP_SECONDS),
    );
  });

  test("extension seconds add to the limit; a wall-clock override is not read", () => {
    expect(deadlineFor(attempt({ extension_seconds: 900 }), WORKING, NOW)).toEqual(after(3900));
    expect(deadlineFor(attempt({ deadline_override_at: ago(10) }), WORKING, NOW)).toEqual(after(3000));
  });

  test("time used up and not live: certainly past, so a rejoin is refused even inside the grace", () => {
    const d = deadlineFor(attempt({ working_seconds: 3600 }), WORKING, NOW);
    expect(isPastDeadline(NOW, d)).toBe(true);
  });

  test("time used up while live: the shared 30 s grace still covers the in-flight save", () => {
    // 10 s over: inside the grace. 40 s over: past it.
    expect(isPastDeadline(NOW, deadlineFor(attempt({ working_seconds: 3605, last_tick_at: ago(5) }), WORKING, NOW))).toBe(false);
    expect(isPastDeadline(NOW, deadlineFor(attempt({ working_seconds: 3635, last_tick_at: ago(5) }), WORKING, NOW))).toBe(true);
    expect(DEADLINE_GRACE_SECONDS).toBe(30);
  });

  test("a removed limit beats the clock; the wall clock is unchanged", () => {
    expect(deadlineFor(attempt({ time_limit_removed: true }), WORKING, NOW)).toBeNull();
    const wall = { time_limit_seconds: 3600, time_limit_mode: "wall" };
    const a = attempt({ started_at: ago(600) });
    expect(deadlineFor(a, wall, NOW)).toEqual(after(3000));
    expect(deadlineFor({ ...a, deadline_override_at: after(10) }, wall, NOW)).toEqual(after(10));
  });

  test("workingTimeLeft reports used and left (D5); null off the working clock", () => {
    expect(workingTimeLeft(attempt({ last_tick_at: ago(5) }), WORKING, NOW)).toEqual({ used: 605, left: 2995 });
    expect(workingTimeLeft(attempt({ working_seconds: 4000 }), WORKING, NOW)).toEqual({ used: 4000, left: 0 });
    expect(workingTimeLeft(attempt(), { time_limit_seconds: 3600, time_limit_mode: "wall" }, NOW)).toBeNull();
  });

  test("extensionForEndTime: the extra seconds that end the clock at the chosen time", () => {
    // 50 of 60 min used; "until 20 min from now" = 10 extra minutes.
    const a = attempt({ working_seconds: 3000 });
    const ext = extensionForEndTime(a, WORKING, after(1200), NOW);
    expect(ext).toBe(600);
    expect(deadlineFor({ ...a, extension_seconds: ext }, WORKING, NOW)).toEqual(after(1200));
  });
});

// ---- DB --------------------------------------------------------------------

const expectTestDb = () => {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.includes("secure_test_design_tool_test")) {
    throw new Error(`working-time-clock tests require the test DB DATABASE_URL; got: ${url}`);
  }
};

beforeAll(() => expectTestDb());
afterEach(async () => {
  await getDb().execute(sql`truncate table assessments restart identity cascade`);
  await getDb().execute(sql`truncate table students restart identity cascade`);
});
afterAll(async () => {
  await closeDb();
});

async function seed(opts: { mode?: "working" | "wall"; limit?: number | null; status?: string } = {}) {
  const db = getDb();
  const [a] = await db
    .insert(assessments)
    .values({
      owner_sub: "clock-teacher",
      name: "Clocked",
      time_limit_seconds: opts.limit === undefined ? 3600 : opts.limit,
      time_limit_mode: opts.mode ?? "working",
    })
    .returning();
  const [s] = await db.insert(students).values({ owner_sub: "clock-teacher", ssid: "CLOCK-1", name: "Clock Student" }).returning();
  const [at] = await db
    .insert(attempts)
    .values({ assessment_id: a!.id, student_id: s!.id, status: opts.status ?? "in_progress", started_at: ago(86_400) })
    .returning();
  return { assessment: a!, attempt: at! };
}

const reload = async (id: string) => (await getDb().select().from(attempts).where(eq(attempts.id, id)))[0]!;
const gaps = async (id: string) =>
  getDb().select().from(attempt_events).where(eq(attempt_events.attempt_id, id));

describe("tickWorkingClock", () => {
  test("the first tick starts the clock; later ticks within 2 min add the gap", async () => {
    const { assessment, attempt: a } = await seed();
    let row = await tickWorkingClock(getDb(), a, assessment, { join: false }, NOW);
    expect(row.working_seconds).toBe(0);
    expect(row.last_tick_at).toEqual(NOW);
    row = await tickWorkingClock(getDb(), row, assessment, { join: false }, after(5));
    row = await tickWorkingClock(getDb(), row, assessment, { join: false }, after(10));
    expect(row.working_seconds).toBe(10);
    expect(await gaps(a.id)).toHaveLength(0);
  });

  test("a gap over 2 min inside a session is not counted and is logged; at a join it is neither", async () => {
    const { assessment, attempt: a } = await seed();
    let row = await tickWorkingClock(getDb(), a, assessment, { join: false }, NOW);
    row = await tickWorkingClock(getDb(), row, assessment, { join: false }, after(200));
    expect(row.working_seconds).toBe(0);
    const logged = await gaps(a.id);
    expect(logged.map((e) => [e.kind, e.detail])).toEqual([["clock_gap", { seconds: 200 }]]);
    // A join after a day away: reset, not counted, not logged.
    row = await tickWorkingClock(getDb(), row, assessment, { join: true }, after(86_400));
    expect(row.working_seconds).toBe(0);
    expect(await gaps(a.id)).toHaveLength(1);
  });

  test("a join never counts the time since the last tick, even under 2 min (a quit and relaunch)", async () => {
    const { assessment, attempt: a } = await seed();
    let row = await tickWorkingClock(getDb(), a, assessment, { join: false }, NOW);
    row = await tickWorkingClock(getDb(), row, assessment, { join: false }, after(5));
    expect(row.working_seconds).toBe(5);
    row = await tickWorkingClock(getDb(), row, assessment, { join: true }, after(65));
    expect(row.working_seconds).toBe(5);
    expect(row.last_tick_at).toEqual(after(65));
    row = await tickWorkingClock(getDb(), row, assessment, { join: false }, after(70));
    expect(row.working_seconds).toBe(10);
    expect(await gaps(a.id)).toHaveLength(0);
  });

  test("a stale caller copy cannot overwrite the stored total", async () => {
    const { assessment, attempt: a } = await seed();
    await tickWorkingClock(getDb(), a, assessment, { join: false }, NOW);
    await tickWorkingClock(getDb(), a, assessment, { join: false }, after(5)); // stale `a`
    const row = await tickWorkingClock(getDb(), a, assessment, { join: false }, after(10)); // stale again
    expect(row.working_seconds).toBe(10);
  });

  test("untimed, wall-clock and handed-in attempts are never written", async () => {
    for (const opts of [{ limit: null }, { mode: "wall" as const }, { status: "submitted" }]) {
      const { assessment, attempt: a } = await seed(opts);
      await tickWorkingClock(getDb(), a, assessment, { join: false }, NOW);
      expect((await reload(a.id)).last_tick_at).toBeNull();
      await getDb().execute(sql`truncate table assessments restart identity cascade`);
      await getDb().execute(sql`truncate table students restart identity cascade`);
    }
  });
});

describe("the join refusal agrees with the join rule (#250 re-review)", () => {
  test("a relaunch inside the last gap is let in on the time the join leaves; nothing left is refused", async () => {
    const { attempt: a } = await seed({ limit: 600 });
    // 595 s counted at the last poll; the student quits and relaunches 60 s later.
    await getDb()
      .update(attempts)
      .set({ working_seconds: 595, last_tick_at: ago(60) })
      .where(eq(attempts.id, a.id));
    const row = await reload(a.id);
    // A poll would count the 60 s (live), so 655 > 600: past.
    expect(await refuseIfPastDeadline(getDb(), row, NOW)).not.toBeNull();
    // A join does not count them: 5 s left, so it gets in.
    expect(await refuseIfPastDeadline(getDb(), row, NOW, { join: true })).toBeNull();
    // With the limit already used up, the join is refused even inside the grace.
    await getDb().update(attempts).set({ working_seconds: 605 }).where(eq(attempts.id, a.id));
    expect(await refuseIfPastDeadline(getDb(), await reload(a.id), NOW, { join: true })).not.toBeNull();
  });
});

describe("Extend time on a working-time test (slice 1 compatibility)", () => {
  test("an end time becomes extra seconds; the end time is kept on the row", async () => {
    const { attempt: a } = await seed();
    await getDb().update(attempts).set({ working_seconds: 3000 }).where(eq(attempts.id, a.id));
    const before = await reload(a.id);
    const { attempt: row } = await extendAttempt(getDb(), before, "clock-teacher", { endsAt: after(1200) }, NOW);
    expect(row.extension_seconds).toBe(600);
    expect(row.deadline_override_at).toEqual(after(1200));
    const [event] = await gaps(a.id);
    expect(event!.detail).toMatchObject({ extension_seconds: 600 });
  });

  test("on a wall-clock test nothing changes: the override is the deadline", async () => {
    const { attempt: a } = await seed({ mode: "wall" });
    const { attempt: row } = await extendAttempt(getDb(), a, "clock-teacher", { endsAt: after(1200) }, NOW);
    expect(row.extension_seconds).toBe(0);
    expect(row.deadline_override_at).toEqual(after(1200));
  });
});

describe("migration 0074 backfill (D6, Q1)", () => {
  // The two UPDATE statements appended to the generated migration, run again
  // against fixture rows (the migration itself ran on an empty database).
  const migration = readFileSync(join(import.meta.dir, "..", "db", "migrations", "0074_working_time_clock.sql"), "utf8");
  const statements = migration.split("--> statement-breakpoint").map((s) => s.trim());
  const backfill = statements.slice(-2);

  async function event(attemptId: string, kind: string, at: Date) {
    await getDb().insert(attempt_events).values({ attempt_id: attemptId, kind, at });
  }

  test("credit is time spent in each session; an override becomes extra seconds", async () => {
    const db = getDb();
    const { assessment, attempt: a } = await seed();
    const t0 = new Date(Date.now() - 2 * 86_400_000);
    // Session 1: 20 min, ended by lockdown_end.
    await event(a.id, "lockdown_begin", t0);
    await event(a.id, "lockdown_end", new Date(t0.getTime() + 20 * 60_000));
    // Session 2 the next day: no end event; the last save was 7 min in.
    const t1 = new Date(t0.getTime() + 86_400_000);
    await event(a.id, "lockdown_begin", t1);
    const [item] = await db.insert(items).values({ assessment_id: assessment.id, position: 0, type: "short_text", stem: "x" }).returning();
    await db.insert(responses).values({
      attempt_id: a.id,
      item_id: item!.id,
      response: { type: "short_text", text: "a" },
      updated_at: new Date(t1.getTime() + 7 * 60_000),
    });
    // A wall-clock extension 15 min past started_at + limit.
    await db
      .update(attempts)
      .set({ deadline_override_at: new Date(a.started_at.getTime() + (3600 + 900) * 1000) })
      .where(eq(attempts.id, a.id));
    for (const stmt of backfill) await db.execute(sql.raw(stmt));
    const row = await reload(a.id);
    expect(row.working_seconds).toBe(27 * 60);
    expect(row.extension_seconds).toBe(900);
  });

  test("no session events: clock time since the start, capped at the limit — nobody gains time", async () => {
    const { attempt: a } = await seed(); // started a day ago, limit 1 h
    for (const stmt of backfill) await getDb().execute(sql.raw(stmt));
    expect((await reload(a.id)).working_seconds).toBe(3600);
  });

  test("a handed-in attempt is credited too, and keeps its extension, so a pass back resumes the clock", async () => {
    const db = getDb();
    const { attempt: done } = await seed({ status: "submitted" });
    // Handed in 25 min after the start, no session events; extended 10 min.
    await db
      .update(attempts)
      .set({
        submitted_at: new Date(done.started_at.getTime() + 25 * 60_000),
        deadline_override_at: new Date(done.started_at.getTime() + (3600 + 600) * 1000),
      })
      .where(eq(attempts.id, done.id));
    for (const stmt of backfill) await db.execute(sql.raw(stmt));
    const row = await reload(done.id);
    expect(row.working_seconds).toBe(25 * 60);
    expect(row.extension_seconds).toBe(600);
  });

  test("untimed attempts are left alone", async () => {
    const { attempt: a } = await seed({ limit: null });
    await getDb().update(attempts).set({ deadline_override_at: new Date() }).where(eq(attempts.id, a.id));
    for (const stmt of backfill) await getDb().execute(sql.raw(stmt));
    const row = await reload(a.id);
    expect(row.working_seconds).toBe(0);
    expect(row.extension_seconds).toBe(0);
  });
});
