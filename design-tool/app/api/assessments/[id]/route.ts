import { NextResponse } from "next/server";
import { and, asc, count, eq, gt, notInArray } from "drizzle-orm";
import { getDb } from "@/db/client";
import {
  assessments,
  assessment_student_overrides,
  attempts,
  items,
  test_sessions,
} from "@/db/schema";
import { requireStaff } from "@/lib/api/requireSession";
import {
  UpdateAssessmentBody,
  findConstructAlteringSubsetViolation,
} from "@/lib/api/assessments";
import { isUnlockOnlyPatch, requireDraft } from "@/lib/api/requireDraft";
import { UUID_RE } from "@/lib/uuid";
import { loadOwnedAssessment } from "@/lib/api/loadOwned";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(_req: Request, ctx: RouteContext) {
  const auth = await requireStaff();
  if (!auth.ok) return auth.response;
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ ok: false, error: "invalid_id" }, { status: 400 });
  }
  const owned = await loadOwnedAssessment(id, auth.session.sub);
  if (owned.status === 404) {
    return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  }
  if (owned.status === 403) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }
  const db = getDb();
  const itemRows = await db
    .select()
    .from(items)
    .where(eq(items.assessment_id, id))
    .orderBy(asc(items.position));
  return NextResponse.json({ assessment: owned.row, items: itemRows });
}

export async function PATCH(req: Request, ctx: RouteContext) {
  const auth = await requireStaff();
  if (!auth.ok) return auth.response;
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ ok: false, error: "invalid_id" }, { status: 400 });
  }
  let body;
  let rawKeys: string[] = [];
  try {
    const raw = await req.json();
    body = UpdateAssessmentBody.parse(raw);
    rawKeys =
      raw && typeof raw === "object" && !Array.isArray(raw)
        ? Object.keys(raw as Record<string, unknown>)
        : [];
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_body" }, { status: 400 });
  }

  // Archive (docs/archive-and-delete-design.md, D-3) is the SECOND status-only
  // PATCH beside the unlock, and stays status-only: a body carrying `archived`
  // alongside any other key is refused outright rather than half-applied.
  const isArchivePatch = body.archived !== undefined;
  if (isArchivePatch && rawKeys.length !== 1) {
    return NextResponse.json({ ok: false, error: "invalid_body" }, { status: 400 });
  }

  const owned = await loadOwnedAssessment(id, auth.session.sub);
  if (owned.status === 404) {
    return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  }
  if (owned.status === 403) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }

  // Archive runs BEFORE the publish lock and is accepted on a published row:
  // the lock exists so a delivered bundle cannot change under a student, and
  // archiving changes no content. A published assessment stays published while
  // archived, so unarchiving restores it exactly.
  if (isArchivePatch) {
    const db = getDb();
    const archived = body.archived === true;
    // Idempotent, and deliberately not a re-stamp: archiving an already
    // archived row keeps its original date (the list shows it) and skips the
    // open-sitting guard, since the state asked for is already the state.
    if (archived === (owned.row.archived_at !== null)) {
      return NextResponse.json({ assessment: owned.row });
    }
    if (archived) {
      // The same rule the delete-attempt route applies: close the sittings
      // first. An expired-but-unclosed sitting counts as closed, as everywhere
      // else — nothing flips status the moment a sitting expires.
      const [openSitting] = await db
        .select({ id: test_sessions.id })
        .from(test_sessions)
        .where(
          and(
            eq(test_sessions.assessment_id, id),
            eq(test_sessions.status, "open"),
            gt(test_sessions.expires_at, new Date()),
          ),
        )
        .limit(1);
      if (openSitting) {
        return NextResponse.json(
          { ok: false, error: "session_open" },
          { status: 409 },
        );
      }
    }
    const [updated] = await db
      .update(assessments)
      .set({ archived_at: archived ? new Date() : null, updated_at: new Date() })
      .where(
        and(eq(assessments.id, id), eq(assessments.owner_sub, auth.session.sub)),
      )
      .returning();
    return NextResponse.json({ assessment: updated });
  }

  // Slice 19 publish lock: while published, accept ONLY the unlock —
  // a PATCH that flips status back to draft and CHANGES nothing else.
  // This is the unlock chokepoint.
  //
  // C9: the check used to require a body with exactly one key. The editor's
  // saveMetadata always sends all six metadata fields, so the unlock the lock
  // banner told the teacher to perform 409'd every single time. It now keys on
  // changed fields rather than present fields — see isUnlockOnlyPatch.
  if (owned.row.status === "published") {
    if (!isUnlockOnlyPatch(body, owned.row)) {
      return NextResponse.json(
        {
          ok: false,
          error: "assessment_published_editing_locked",
          hint: "Set status: 'draft' (leaving other fields unchanged) to re-enable edits.",
        },
        { status: 409 },
      );
    }
  }

  // Cross-row subset invariant for construct_altering.
  // Three patch shapes to handle:
  //   1. Both arrays present  → Zod superRefine already enforced subset.
  //   2. Only construct_altering present → compare against current row.
  //   3. Only allowed_accommodations present (shrinking) → auto-clamp
  //      the current construct_altering down to the new subset.
  const patch: Record<string, unknown> = { ...body };
  if (
    body.construct_altering !== undefined &&
    body.allowed_accommodations === undefined
  ) {
    const currentAllowed = (owned.row.allowed_accommodations ?? []) as string[];
    const violation = findConstructAlteringSubsetViolation(
      currentAllowed,
      body.construct_altering,
    );
    if (violation !== null) {
      return NextResponse.json(
        {
          ok: false,
          error: "construct_altering_must_be_subset",
          orphan_id: violation,
        },
        { status: 400 },
      );
    }
  } else if (
    body.allowed_accommodations !== undefined &&
    body.construct_altering === undefined
  ) {
    const currentCA = (owned.row.construct_altering ?? []) as string[];
    if (currentCA.length > 0) {
      const newAllowed = new Set(body.allowed_accommodations);
      patch.construct_altering = currentCA.filter((id) => newAllowed.has(id));
    }
  }

  const db = getDb();

  // D15: when allowed_accommodations shrinks, construct_altering is clamped
  // above — but per-student overrides were left untouched, so an override for
  // a now-disallowed tool survived and was still served. That is the exact
  // invariant the overrides POST route enforces on write
  // ("tool_not_in_allowed_accommodations"), broken after the fact by an edit
  // to the parent. Delete the orphans in the same transaction as the update so
  // the two can't diverge.
  const nextAllowed =
    body.allowed_accommodations !== undefined
      ? body.allowed_accommodations
      : null;

  const [updated] = await db.transaction(async (tx) => {
    const rows = await tx
      .update(assessments)
      .set({ ...patch, updated_at: new Date() })
      .where(
        and(eq(assessments.id, id), eq(assessments.owner_sub, auth.session.sub)),
      )
      .returning();
    if (nextAllowed !== null) {
      const keep = nextAllowed;
      await tx
        .delete(assessment_student_overrides)
        .where(
          and(
            eq(assessment_student_overrides.assessment_id, id),
            keep.length > 0
              ? notInArray(assessment_student_overrides.tool_id, keep)
              : undefined,
          ),
        );
    }
    return rows;
  });
  return NextResponse.json({ assessment: updated });
}

export async function DELETE(_req: Request, ctx: RouteContext) {
  const auth = await requireStaff();
  if (!auth.ok) return auth.response;
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ ok: false, error: "invalid_id" }, { status: 400 });
  }
  const owned = await loadOwnedAssessment(id, auth.session.sub);
  if (owned.status === 404) {
    return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  }
  if (owned.status === 403) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }

  // C10: every edit path on a published assessment 409s, but DELETE had no
  // publish guard at all — the published assessment and all its items
  // hard-deleted with a 204. Deleting is a bigger change than editing, so it
  // gets the same lock. With C9 fixed, "unlock to draft, then delete" is a
  // reachable path.
  const draftGuard = requireDraft(owned.row);
  if (draftGuard) return draftGuard;

  const db = getDb();

  // D-1 (docs/archive-and-delete-design.md): deleting a draft with attempts
  // on it would hard-delete every response/upload with no audit trail — the
  // delete-attempt route (docs/reporting-design.md) is the only sanctioned
  // way to remove student work, one attempt at a time. Refuse instead of
  // deleting quietly; the dialog reads this as "archive instead".
  const [attemptCountRow] = await db
    .select({ n: count() })
    .from(attempts)
    .where(eq(attempts.assessment_id, id));
  const n = attemptCountRow?.n ?? 0;
  if (n > 0) {
    return NextResponse.json(
      { ok: false, error: "has_attempts", attempts: n },
      { status: 409 },
    );
  }

  await db.delete(assessments).where(eq(assessments.id, id));
  return new NextResponse(null, { status: 204 });
}
