// Practice-sitting sweep (docs/practice-sitting-design.md, D-7 "known gap"):
// end-to-end proof that `handleS3Event` → `sweepPracticeSittings` calls a
// wired-in `deleteStored` for a swept practice attempt's upload, with the
// exact `StoredUploadRef` the row carries — and that a THROWING deleteStored
// never fails the sync. Built with direct schema inserts (no app routes),
// so this file does not touch, or race, the resolver/attempts/delivery code
// another agent is editing in this checkout.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { closeDb, getDb } from "../db/client";
import {
  assessments,
  attempts,
  items,
  response_uploads,
  students,
  test_sessions,
} from "../db/schema";
import { MockSnapshotSource, handleS3Event } from "../lib/roster/syncHandler";
import type { StoredUploadRef } from "../lib/api/deleteAttempt";

const expectTestDb = () => {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.includes("secure_test_design_tool_test")) {
    throw new Error(`practice-sweep-asset-delete tests require the test DB; got: ${url}`);
  }
};

const OWNER = "practice-sweep-asset-delete-owner";

beforeAll(() => expectTestDb());

afterEach(async () => {
  const db = getDb();
  await db.execute(
    `truncate table assessments, students restart identity cascade`,
  );
});

afterAll(async () => await closeDb());

/** One overdue practice sitting, one practice attempt on it, one upload row —
 * everything `sweepPracticeSittings` needs to find and delete both the DB
 * rows and (via `deleteStored`) the stored bytes. */
async function seedOverdueSitting(): Promise<{ storageKey: string }> {
  const db = getDb();
  const [assessment] = await db
    .insert(assessments)
    .values({ owner_sub: OWNER, name: "Practice sweep fixture", status: "published" })
    .returning();
  const [item] = await db
    .insert(items)
    .values({
      assessment_id: assessment!.id,
      position: 1,
      type: "drawing",
      stem: "Draw something",
    })
    .returning();
  const [student] = await db
    .insert(students)
    .values({ owner_sub: OWNER, practice_for_sub: OWNER, name: "" })
    .returning();

  const longAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000); // 30 days ago
  const [sitting] = await db
    .insert(test_sessions)
    .values({
      assessment_id: assessment!.id,
      owner_sub: OWNER,
      kind: "practice",
      practice_for_sub: OWNER,
      code: "PRACT1",
      status: "closed",
      expires_at: longAgo,
      updated_at: longAgo,
    })
    .returning();
  const [attempt] = await db
    .insert(attempts)
    .values({
      assessment_id: assessment!.id,
      student_id: student!.id,
      test_session_id: sitting!.id,
      status: "submitted",
      practice: true,
    })
    .returning();

  const storageKey = `responses/${attempt!.id}/${item!.id}/fixture-upload`;
  await db.insert(response_uploads).values({
    attempt_id: attempt!.id,
    item_id: item!.id,
    storage_provider: "s3",
    storage_key: storageKey,
    content_type: "image/png",
    status: "complete",
  });

  return { storageKey };
}

describe("handleS3Event threads deleteStored into the practice sweep", () => {
  test("a wired deleteStored is called once with the swept upload's exact ref", async () => {
    const { storageKey } = await seedOverdueSitting();
    const calls: StoredUploadRef[] = [];
    const deleteStored = async (upload: StoredUploadRef) => {
      calls.push(upload);
    };

    const source = new MockSnapshotSource();
    const entries: unknown[] = [];
    const outcome = await handleS3Event(
      getDb(),
      source,
      { Records: [] }, // no manifest to import — only the sweeps run
      "roster/",
      (e) => void entries.push(e),
      deleteStored,
    );

    expect(outcome).toEqual({ imported: [], refused: [], ignored: 0 });
    expect(calls).toEqual([{ storage_provider: "s3", storage_key: storageKey }]);

    const practiceLine = entries.find(
      (e) => (e as { event: string }).event === "practice_sweep",
    ) as Record<string, unknown>;
    expect(practiceLine).toMatchObject({
      practice_attempts_deleted: 1,
      practice_uploads: 1,
      practice_uploads_deleted: 1,
    });

    // The row is gone; nothing left to double-delete on a later run.
    const remaining = await getDb()
      .select()
      .from(response_uploads)
      .where(eq(response_uploads.storage_key, storageKey));
    expect(remaining.length).toBe(0);
  });

  test("a throwing deleteStored is counted as not-deleted and never fails the sync", async () => {
    await seedOverdueSitting();
    const deleteStored = async () => {
      throw new Error("storage_s3_error_403: denied");
    };

    const entries: unknown[] = [];
    const outcome = await handleS3Event(
      getDb(),
      new MockSnapshotSource(),
      { Records: [] },
      "roster/",
      (e) => void entries.push(e),
      deleteStored,
    );

    expect(outcome).toEqual({ imported: [], refused: [], ignored: 0 });
    const practiceLine = entries.find(
      (e) => (e as { event: string }).event === "practice_sweep",
    ) as Record<string, unknown>;
    expect(practiceLine).toMatchObject({
      practice_attempts_deleted: 1,
      practice_uploads: 1,
      practice_uploads_deleted: 0,
    });
    // No practice_sweep_failed line — the throw stayed inside the sweep.
    expect(entries.some((e) => (e as { event: string }).event === "practice_sweep_failed")).toBe(
      false,
    );
  });
});
