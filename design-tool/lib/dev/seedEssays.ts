// Pilot essay seeding: submitted attempts carrying the SAMPLE_ESSAYS text,
// written for named roster students without the macOS client.
//
// WHY, and why it is not seedAttempts.ts: the pilot sittings start
// 2026-09-17 on an essay assessment scored with AI plus a rubric, and the
// "Score with AI" path (finding R-4) has never run against Bedrock on the
// origin. Proving it needs several submitted essays of different quality on
// the real deployed database — which means this runs INSIDE the production
// image via infra/scripts/oneoff-aurora.sh, unlike seedAttempts, whose
// script refuses under NODE_ENV=production. The safety that replaces that
// refusal: nothing is discovered. Every student is named explicitly by
// number on the command line, the assessment must be published, the sitting
// must be open and named by its code, and any refusal aborts the whole run
// before a single row is written.
//
// It mirrors the real student plane rather than inventing its own path:
//
//   join      app/api/attempts/route.ts — findOrBindOverlay against the
//             assessment's owner_sub, then one attempt row per student with
//             the sitting on it.
//   answer    app/api/attempts/[attemptId]/responses/[itemId] — one
//             ItemResponseSchema-parsed { type: "essay", text } per essay
//             item.
//   hand in   app/api/attempts/[attemptId]/submit — status/submitted_at,
//             then the same idempotent runAutoScoringPass.
//
// What it deliberately does NOT do: check section admission. The teacher
// picks the students when starting the sitting (Start session → Picked
// students), so by the time this runs the decision about who belongs has
// already been made by a human; re-deriving it from enrollment dates would
// only fail on a roster day that has not flipped yet.
import { and, asc, eq } from "drizzle-orm";
import { ItemResponseSchema } from "@secure-test/schema";
import {
  assessments,
  attempt_events,
  attempts,
  items,
  responses,
  roster_students,
  test_sessions,
  type ItemRow,
  type RosterStudentRow,
  type StudentRow,
} from "@/db/schema";
import { findOrBindOverlay } from "@/lib/api/resolveStudent";
import { runAutoScoringPass } from "@/lib/scoring/runAutoScoring";
import type { getDb } from "@/db/client";
import { SAMPLE_ESSAYS, isEssayQuality, type EssayQuality } from "@/lib/dev/sampleEssays";

type Db = ReturnType<typeof getDb>;

/** A refusal the operator should read and act on — never a stack trace. */
export class SeedEssaysError extends Error {}

export type SeedEssaysStudent = {
  /** roster_students.ps_id — the student NUMBER, as the teacher knows it. */
  studentNumber: string;
  quality: EssayQuality;
};

export type SeedEssaysOptions = {
  assessmentId: string;
  sessionCode: string;
  students: SeedEssaysStudent[];
  dryRun?: boolean;
};

export type SeedEssaysPlanRow = {
  studentNumber: string;
  quality: EssayQuality;
  /** Null on a dry run when the overlay row does not exist yet. */
  studentId: string | null;
  overlayWillBeCreated: boolean;
  words: number;
};

export type SeedEssaysWriteRow = SeedEssaysPlanRow & {
  studentId: string;
  attemptId: string;
  responseCount: number;
  autoScored: number;
};

export type SeedEssaysResult = {
  assessmentName: string;
  sittingId: string;
  /** Essay items the text was written to, in position order. */
  essayItemIds: string[];
  /** Non-essay items on the assessment, skipped with a log line. */
  skippedItems: { id: string; type: string; position: number }[];
  dryRun: boolean;
  planned: SeedEssaysPlanRow[];
  written: SeedEssaysWriteRow[];
};

const PS_ID_RE = /^\d{5,8}$/;

export function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/**
 * Validate everything first, then write.
 *
 * The split is the point: five students where the fourth already has an
 * attempt must leave the database exactly as it was, not three-fifths seeded
 * and an error on the console. The only write the validation phase can leave
 * behind is none — overlay rows are looked up read-only here and created in
 * the write phase, the same rows a real join would have created.
 */
export async function seedEssays(
  db: Db,
  opts: SeedEssaysOptions,
): Promise<SeedEssaysResult> {
  const dryRun = opts.dryRun ?? false;

  if (opts.students.length === 0) {
    throw new SeedEssaysError("no --student given — name every student explicitly");
  }
  const seenNumbers = new Set<string>();
  for (const s of opts.students) {
    if (!PS_ID_RE.test(s.studentNumber)) {
      throw new SeedEssaysError(
        `"${s.studentNumber}" is not a student number (5-8 digits)`,
      );
    }
    if (seenNumbers.has(s.studentNumber)) {
      throw new SeedEssaysError(`student ${s.studentNumber} given twice`);
    }
    seenNumbers.add(s.studentNumber);
    if (!isEssayQuality(s.quality)) {
      throw new SeedEssaysError(
        `unknown quality "${s.quality}" for student ${s.studentNumber}`,
      );
    }
  }

  const [assessment] = await db
    .select()
    .from(assessments)
    .where(eq(assessments.id, opts.assessmentId))
    .limit(1);
  if (!assessment) {
    throw new SeedEssaysError(`assessment ${opts.assessmentId} not found`);
  }
  if (assessment.status !== "published") {
    throw new SeedEssaysError(
      `assessment ${assessment.id} is "${assessment.status}" — publish it first ` +
        "(a sitting only exists on a published assessment)",
    );
  }

  const [sitting] = await db
    .select()
    .from(test_sessions)
    .where(
      and(
        eq(test_sessions.assessment_id, assessment.id),
        eq(test_sessions.code, opts.sessionCode),
        eq(test_sessions.status, "open"),
      ),
    )
    .limit(1);
  if (!sitting) {
    throw new SeedEssaysError(
      `no OPEN sitting with code "${opts.sessionCode}" on assessment ${assessment.id} ` +
        "— start the session and copy the code off the Test sessions tab",
    );
  }
  if (sitting.expires_at.getTime() <= Date.now()) {
    throw new SeedEssaysError(
      `the sitting with code "${opts.sessionCode}" expired at ${sitting.expires_at.toISOString()} ` +
        "— start a new one",
    );
  }

  const allItems = await db
    .select()
    .from(items)
    .where(eq(items.assessment_id, assessment.id))
    .orderBy(asc(items.position));
  const essayItems = allItems.filter((i) => i.type === "essay");
  if (essayItems.length === 0) {
    throw new SeedEssaysError(
      `assessment ${assessment.id} has no essay items — this seeder writes essay text only`,
    );
  }
  const skippedItems = allItems
    .filter((i) => i.type !== "essay")
    .map((i) => ({ id: i.id, type: i.type, position: i.position }));

  // Phase 1, read-only: resolve every student, and refuse on the first thing
  // a human has to decide about.
  type Resolved = {
    input: SeedEssaysStudent;
    roster: RosterStudentRow;
    overlay: StudentRow | null;
    words: number;
  };
  const resolved: Resolved[] = [];
  for (const input of opts.students) {
    const [roster] = await db
      .select()
      .from(roster_students)
      .where(eq(roster_students.ps_id, input.studentNumber))
      .limit(1);
    if (!roster) {
      throw new SeedEssaysError(
        `student number ${input.studentNumber} is not on the roster ` +
          "(roster_students) — check the number, or wait for the 06:00 import",
      );
    }

    // createIfMissing false: a missing overlay is not a refusal, it is the
    // row the write phase will create. identity_conflict IS a refusal — the
    // same one the join route makes, and for the same reason.
    const bound = await findOrBindOverlay(db, assessment.owner_sub, roster, false);
    if (!bound.ok && bound.reason === "identity_conflict") {
      throw new SeedEssaysError(
        `student ${input.studentNumber} cannot be bound to this teacher's student row ` +
          "(identity_conflict) — a human has to resolve that before seeding",
      );
    }
    const overlay = bound.ok ? bound.student : null;

    if (overlay) {
      const [existing] = await db
        .select({ id: attempts.id, status: attempts.status })
        .from(attempts)
        .where(
          and(
            eq(attempts.assessment_id, assessment.id),
            eq(attempts.student_id, overlay.id),
          ),
        )
        .limit(1);
      if (existing) {
        throw new SeedEssaysError(
          `student ${input.studentNumber} already has an attempt on this assessment ` +
            `(attempt ${existing.id}, ${existing.status}) — there is one attempt per ` +
            "student per assessment, so delete it on the results page and re-run",
        );
      }
    }

    resolved.push({
      input,
      roster,
      overlay,
      words: countWords(SAMPLE_ESSAYS[input.quality].text),
    });
  }

  const planned: SeedEssaysPlanRow[] = resolved.map((r) => ({
    studentNumber: r.input.studentNumber,
    quality: r.input.quality,
    studentId: r.overlay?.id ?? null,
    overlayWillBeCreated: r.overlay === null,
    words: r.words,
  }));

  if (dryRun) {
    return {
      assessmentName: assessment.name,
      sittingId: sitting.id,
      essayItemIds: essayItems.map((i) => i.id),
      skippedItems,
      dryRun: true,
      planned,
      written: [],
    };
  }

  // Phase 2, write. The overlay rows first (findOrBindOverlay is the join
  // route's own function and wants the base connection), then attempts,
  // responses and events for every student in ONE transaction, so a unique
  // violation from a join that raced this script rolls the whole batch back
  // rather than leaving half a class seeded.
  const overlays: StudentRow[] = [];
  for (const r of resolved) {
    if (r.overlay) {
      overlays.push(r.overlay);
      continue;
    }
    const bound = await findOrBindOverlay(db, assessment.owner_sub, r.roster, true);
    if (!bound.ok) {
      throw new SeedEssaysError(
        `student ${r.input.studentNumber} could not be bound (${bound.reason})`,
      );
    }
    overlays.push(bound.student);
  }

  const now = new Date();
  const written = await db.transaction(async (tx) => {
    const rows: SeedEssaysWriteRow[] = [];
    for (const [i, r] of resolved.entries()) {
      const student = overlays[i]!;
      // The join route's insert, then the submit route's flip — two steps on
      // purpose, so started_at and submitted_at are both real and the row
      // looks like every other handed-in attempt.
      const [created] = await tx
        .insert(attempts)
        .values({
          assessment_id: assessment.id,
          student_id: student.id,
          test_session_id: sitting.id,
          status: "in_progress",
        })
        .returning();
      const attempt = created!;

      await tx.insert(responses).values(
        essayItems.map((item) => ({
          attempt_id: attempt.id,
          item_id: item.id,
          response: essayResponse(item, r.input.quality),
        })),
      );

      // The two lifecycle events the client posts around a real sitting, so
      // the integrity timeline on the results page is not blank. The client
      // posts no "submit" event — the attempt row is that record.
      await tx.insert(attempt_events).values([
        { attempt_id: attempt.id, kind: "lockdown_begin", at: now },
        { attempt_id: attempt.id, kind: "lockdown_end", at: now },
      ]);

      const [submitted] = await tx
        .update(attempts)
        .set({ status: "submitted", submitted_at: now, updated_at: now })
        .where(eq(attempts.id, attempt.id))
        .returning();

      rows.push({
        studentNumber: r.input.studentNumber,
        quality: r.input.quality,
        studentId: student.id,
        overlayWillBeCreated: r.overlay === null,
        words: r.words,
        attemptId: submitted!.id,
        responseCount: essayItems.length,
        autoScored: 0,
      });
    }
    return rows;
  });

  // Parity with both hand-in paths: the same idempotent pass runs here. An
  // essay is hand- or AI-scored, so this normally scores nothing; it matters
  // if the assessment also carries an auto item, and a failure must never
  // undo a seeded attempt.
  for (const row of written) {
    try {
      const summary = await runAutoScoringPass(db, {
        id: row.attemptId,
        assessment_id: assessment.id,
      });
      row.autoScored = summary.scored;
    } catch (err) {
      console.error(`seed-essays: auto-scoring failed for ${row.attemptId}`, err);
    }
  }

  return {
    assessmentName: assessment.name,
    sittingId: sitting.id,
    essayItemIds: essayItems.map((i) => i.id),
    skippedItems,
    dryRun: false,
    planned,
    written,
  };
}

/**
 * The exact payload the client PUTs for an essay, parsed through the wire
 * schema for the same reason seedAttempts does it: a drift between this
 * seeder and the schema should throw here, not plant a row the scoring code
 * chokes on later.
 */
function essayResponse(item: ItemRow, quality: EssayQuality) {
  const sample = SAMPLE_ESSAYS[quality];
  const cap = item.config.max_word_count;
  const words = countWords(sample.text);
  if (cap && words > cap) {
    console.warn(
      `seed-essays: the "${quality}" essay is ${words} words and item ${item.id} ` +
        `caps at ${cap} — seeding it anyway (the cap is a client-side guide)`,
    );
  }
  return ItemResponseSchema.parse({ type: "essay", text: sample.text });
}
