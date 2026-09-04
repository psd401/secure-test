import { asc, eq } from "drizzle-orm";
import {
  assessments,
  attempts,
  items,
  responses,
  students,
  type ItemRow,
} from "@/db/schema";
import {
  ItemResponseSchema,
  type Choice,
  type ItemResponse,
} from "@secure-test/schema";
import type { getDb } from "@/db/client";

// Slice 35: dev-only seeding — the stand-in for the missing student app.
// Fabricates submitted attempts with plausible per-type responses so the
// scoring slices (37-39) have data to run against. Every generated response
// is ItemResponseSchema.parse'd before insert, so if the seed logic drifts
// from the wire schema this throws instead of planting invalid rows.
//
// Not wired into any route: production ingest is the student plane
// (app/api/attempts, slice 61); this seeder predates it and stays for local
// results-page work. The CLI wrapper is scripts/seed-attempts.ts.

type Db = ReturnType<typeof getDb>;

export type SeedAttemptsOptions = {
  assessmentId: string;
  // How many attempts (one per student) to fabricate. Existing roster
  // students of the assessment's owner are used first; seed students
  // (ssid "SEED-###") are created only to cover the shortfall.
  count?: number;
};

export type SeedAttemptsResult = {
  attemptIds: string[];
  studentIds: string[];
  responseCount: number;
};

const FILLER_WORDS = [
  "evidence", "the", "author", "supports", "a", "claim", "with", "data",
  "because", "structure", "context", "however", "pattern", "result",
  "therefore", "example", "detail", "contrast", "idea", "summary",
];

function pick<T>(arr: readonly T[]): T {
  const v = arr[Math.floor(Math.random() * arr.length)];
  if (v === undefined) throw new Error("pick() from an empty array");
  return v;
}

function fillerText(wordCount: number): string {
  const words: string[] = [];
  for (let i = 0; i < wordCount; i++) {
    words.push(pick(FILLER_WORDS));
  }
  return words.join(" ");
}

function one<T>(rows: T[]): T {
  const row = rows[0];
  if (row === undefined) throw new Error("expected at least one row");
  return row;
}

// Build a plausible response for one item. Exported for tests.
export function buildResponseFor(item: ItemRow): ItemResponse {
  const choices = item.choices as Choice[];
  switch (item.type) {
    case "multiple_choice_single": {
      if (choices.length === 0) {
        throw new Error(`item ${item.id} is ${item.type} but has no choices`);
      }
      return ItemResponseSchema.parse({
        type: "multiple_choice_single",
        choice_id: pick(choices).id,
      });
    }
    case "multiple_choice_multi": {
      if (choices.length === 0) {
        throw new Error(`item ${item.id} is ${item.type} but has no choices`);
      }
      // Random non-empty subset.
      const selected = choices.filter(() => Math.random() < 0.5);
      if (selected.length === 0) selected.push(pick(choices));
      return ItemResponseSchema.parse({
        type: "multiple_choice_multi",
        choice_ids: selected.map((c) => c.id),
      });
    }
    case "short_text": {
      // Half the time answer "correctly" (when a key exists) so slice 37's
      // auto-scoring has both outcomes to chew on.
      const text =
        item.correct_answer && Math.random() < 0.5
          ? item.correct_answer
          : fillerText(3);
      return ItemResponseSchema.parse({ type: "short_text", text });
    }
    case "essay": {
      const cap = item.config.max_word_count;
      const words = 40 + Math.floor(Math.random() * 80);
      return ItemResponseSchema.parse({
        type: "essay",
        text: fillerText(cap ? Math.min(cap, words) : words),
      });
    }
    case "match": {
      // Half the time fully correct (every pair id maps to itself), else a
      // rotated mapping so slice 37's auto-scoring sees both outcomes.
      const pairs = item.config.pairs ?? [];
      if (pairs.length === 0) {
        throw new Error(`item ${item.id} is match but has no pairs`);
      }
      const correct = Math.random() < 0.5;
      const matches = Object.fromEntries(
        pairs.map((p, i) => [
          p.id,
          correct ? p.id : pairs[(i + 1) % pairs.length]!.id,
        ]),
      );
      return ItemResponseSchema.parse({ type: "match", matches });
    }
    case "order": {
      // Half the time the authored (correct) order, else rotated by one.
      const sequence = item.config.sequence ?? [];
      if (sequence.length === 0) {
        throw new Error(`item ${item.id} is order but has no sequence`);
      }
      const ids = sequence.map((e) => e.id);
      const correct = Math.random() < 0.5;
      const ordered_ids = correct ? ids : [...ids.slice(1), ids[0]!];
      return ItemResponseSchema.parse({ type: "order", ordered_ids });
    }
    case "hotspot": {
      // Half the time the exact key; else a wrong region when one exists
      // (a 1-region item with a 1-region key can only be answered right).
      const regions = item.config.regions ?? [];
      const key = item.config.correct_region_ids ?? [];
      if (regions.length === 0 || key.length === 0) {
        throw new Error(`item ${item.id} is hotspot but has no regions/key`);
      }
      const keySet = new Set(key);
      const wrong = regions.map((r) => r.id).filter((id) => !keySet.has(id));
      const correct = Math.random() < 0.5 || wrong.length === 0;
      return ItemResponseSchema.parse({
        type: "hotspot",
        region_ids: correct ? key : [wrong[0]!],
      });
    }
    case "drawing_upload":
      // No response variant exists (slice 50, authoring-only) — callers
      // must filter these out, as seedAttempts does.
      throw new Error(
        `item ${item.id} is drawing_upload — no response format exists yet`,
      );
    case "table": {
      // E3: every cell filled; a keyed cell gets its key half the time so
      // per-cell auto-scoring sees both outcomes, the rest a small number.
      const columns = item.config.columns ?? [];
      const rows = item.config.rows ?? [];
      if (columns.length === 0 || rows.length === 0) {
        throw new Error(`item ${item.id} is table but has no columns/rows`);
      }
      const keys = item.config.cell_keys ?? {};
      const cells: Record<string, Record<string, string>> = {};
      for (const r of rows) {
        cells[r.id] = {};
        for (const c of columns) {
          const key = keys[r.id]?.[c.id];
          cells[r.id]![c.id] =
            key && Math.random() < 0.5 ? key : String(Math.floor(Math.random() * 100));
        }
      }
      return ItemResponseSchema.parse({ type: "table", cells });
    }
    default:
      throw new Error(`unknown item type "${item.type}" (item ${item.id})`);
  }
}

export async function seedAttempts(
  db: Db,
  opts: SeedAttemptsOptions,
): Promise<SeedAttemptsResult> {
  const count = opts.count ?? 5;
  if (count < 1) throw new Error("count must be >= 1");

  const [assessment] = await db
    .select()
    .from(assessments)
    .where(eq(assessments.id, opts.assessmentId));
  if (!assessment) throw new Error(`assessment ${opts.assessmentId} not found`);

  const allItemRows = await db
    .select()
    .from(items)
    .where(eq(items.assessment_id, assessment.id))
    .orderBy(asc(items.position));
  // Slice 50: drawing_upload has NO response format yet (authoring-only —
  // student ingest is deferred to the student-app plan), so seeding skips
  // those items rather than fabricating an impossible response.
  const itemRows = allItemRows.filter((r) => r.type !== "drawing_upload");
  if (allItemRows.length === 0) {
    throw new Error(`assessment ${assessment.id} has no items to respond to`);
  }
  if (itemRows.length === 0) {
    throw new Error(
      `assessment ${assessment.id} has only authoring-only items ` +
        `(drawing_upload) — nothing can be responded to yet`,
    );
  }

  // Roster first, seed students only for the shortfall.
  const roster = await db
    .select()
    .from(students)
    .where(eq(students.owner_sub, assessment.owner_sub))
    .orderBy(asc(students.created_at));
  const chosen = roster.slice(0, count);
  if (chosen.length < count) {
    const taken = new Set(roster.map((s) => s.ssid));
    const inserts = [];
    let n = 1;
    while (inserts.length < count - chosen.length) {
      const ssid = `SEED-${String(n).padStart(3, "0")}`;
      n++;
      if (taken.has(ssid)) continue;
      inserts.push({
        owner_sub: assessment.owner_sub,
        ssid,
        name: `Seed Student ${ssid.slice(-3)}`,
      });
    }
    const created = await db.insert(students).values(inserts).returning();
    chosen.push(...created);
  }

  const attemptIds: string[] = [];
  let responseCount = 0;
  for (const student of chosen) {
    const attempt = one(
      await db
        .insert(attempts)
        .values({
          assessment_id: assessment.id,
          student_id: student.id,
          status: "submitted",
          submitted_at: new Date(),
        })
        .returning(),
    );
    attemptIds.push(attempt.id);

    await db.insert(responses).values(
      itemRows.map((item) => ({
        attempt_id: attempt.id,
        item_id: item.id,
        response: buildResponseFor(item),
      })),
    );
    responseCount += itemRows.length;
  }

  return {
    attemptIds,
    studentIds: chosen.map((s) => s.id),
    responseCount,
  };
}
