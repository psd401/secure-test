import { NextResponse } from "next/server";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { ItemResponseSchema } from "@secure-test/schema";
import { getDb } from "@/db/client";
import { responses } from "@/db/schema";
import { requireStudent } from "@/lib/api/requireSession";
import {
  alreadySubmitted,
  attemptAcceptsWrites,
  loadItemForAttempt,
  loadOwnAttempt,
  notFound,
  unsealResponseIds,
} from "@/lib/api/studentAttempt";
import {
  loadUploadForItem,
  pruneSupersededUploads,
  settlePendingUpload,
} from "@/lib/api/responseUploads";
import { UUID_RE } from "@/lib/uuid";

interface RouteContext {
  params: Promise<{ attemptId: string; itemId: string }>;
}

const WriteBody = z.object({ response: ItemResponseSchema });

/**
 * Slice 61: the student response ingest.
 *
 * Until now `attempts`/`responses` were populated only by lib/dev/seedAttempts,
 * whose header says it is "the stand-in for the missing student app". These
 * routes are that app's half, and they carry the seeder's invariants across
 * rather than reinventing them:
 *
 *   - the payload is ItemResponseSchema.parse'd before insert, so a drifting
 *     client cannot plant a row the scoring code will later choke on;
 *   - `response.type` must EQUAL the answered item's type. The column is jsonb
 *     and enforces nothing, and a mismatch is silently unscoreable — an essay
 *     response on a multiple-choice item scores zero forever with no error
 *     anywhere.
 *
 * PUT rather than POST: answering the same item twice is the normal case, not a
 * conflict. The (attempt_id, item_id) unique constraint makes the upsert the
 * natural idempotency key, which is what `docs/plan.md` asks of the offline
 * retry path.
 */
export async function PUT(req: Request, ctx: RouteContext) {
  const auth = await requireStudent();
  if (!auth.ok) return auth.response;

  const { attemptId, itemId } = await ctx.params;
  if (!UUID_RE.test(attemptId) || !UUID_RE.test(itemId)) {
    return NextResponse.json({ ok: false, error: "invalid_id" }, { status: 400 });
  }

  let body;
  try {
    body = WriteBody.parse(await req.json());
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_body" }, { status: 400 });
  }

  const db = getDb();
  const access = await loadOwnAttempt(db, attemptId, auth.session);
  if (!access.ok) return access.response;
  if (!attemptAcceptsWrites(access.attempt)) return alreadySubmitted();

  const item = await loadItemForAttempt(db, access.attempt, itemId);
  if (!item) return notFound();

  if (item.type !== body.response.type) {
    return NextResponse.json(
      { ok: false, error: "response_type_mismatch", item_type: item.type },
      { status: 400 },
    );
  }

  // Slice 65: a drawing response names an upload SLOT, and the slot must be one
  // the server minted for this exact (attempt, item) and actually received
  // bytes for. Without the scoped lookup a student could reference another
  // student's file; without the status check they could hand in an id for an
  // upload that never happened and have it look like an answer.
  if (body.response.type === "drawing_upload") {
    const registered = await loadUploadForItem(
      db,
      access.attempt,
      item,
      body.response.upload_id,
    );
    if (!registered) return notFound();
    // Finding 10.10: a direct (presigned) upload lands without telling this
    // app; ask the backend before calling the slot incomplete.
    const upload = await settlePendingUpload(db, registered);
    if (upload.status !== "complete") {
      return NextResponse.json(
        { ok: false, error: "upload_incomplete" },
        { status: 409 },
      );
    }
  }

  // Slice 64: match and order arrive carrying per-attempt opaque ids. Translate
  // before storing, so what lands in the column is the authoring ids the scoring
  // code compares against — the sealing is a delivery concern and must not leak
  // into the data model.
  const stored = unsealResponseIds(access.attempt.id, item, body.response);
  if (stored === null) {
    return NextResponse.json(
      { ok: false, error: "unknown_option_id" },
      { status: 400 },
    );
  }

  // Slice 73: a student who redraws leaves the previous file referenced by
  // nothing. Pruned here rather than by a sweep, because this is the only moment
  // anything knows which upload just stopped being the answer.
  if (stored.type === "drawing_upload") {
    await pruneSupersededUploads(db, access.attempt.id, item.id, stored.upload_id);
  }

  const [row] = await db
    .insert(responses)
    .values({ attempt_id: access.attempt.id, item_id: item.id, response: stored })
    .onConflictDoUpdate({
      target: [responses.attempt_id, responses.item_id],
      set: { response: stored, updated_at: new Date() },
    })
    .returning();

  return NextResponse.json({ response: row });
}

/**
 * Withdraw an answer.
 *
 * The client needs this: for multi-select, matching and hotspot items an
 * unanswered item is the ABSENCE of a response, and the wire schema requires at
 * least one id — so clearing every checkbox has nothing valid to send and the
 * renderer currently stays silent, leaving the previous answer standing. This
 * is the operation that actually clears it.
 *
 * Idempotent: deleting an answer that is not there returns 204, because the
 * caller's intent — no answer for this item — is satisfied either way.
 */
export async function DELETE(_req: Request, ctx: RouteContext) {
  const auth = await requireStudent();
  if (!auth.ok) return auth.response;

  const { attemptId, itemId } = await ctx.params;
  if (!UUID_RE.test(attemptId) || !UUID_RE.test(itemId)) {
    return NextResponse.json({ ok: false, error: "invalid_id" }, { status: 400 });
  }

  const db = getDb();
  const access = await loadOwnAttempt(db, attemptId, auth.session);
  if (!access.ok) return access.response;
  if (!attemptAcceptsWrites(access.attempt)) return alreadySubmitted();

  const item = await loadItemForAttempt(db, access.attempt, itemId);
  if (!item) return notFound();

  await db
    .delete(responses)
    .where(
      and(eq(responses.attempt_id, access.attempt.id), eq(responses.item_id, item.id)),
    );
  // Withdrawing a drawing takes its file with it. Keeping the bytes for an
  // answer the student explicitly retracted is the version of this nobody would
  // defend if asked.
  if (item.type === "drawing_upload") {
    await pruneSupersededUploads(db, access.attempt.id, item.id, null);
  }
  return new NextResponse(null, { status: 204 });
}
