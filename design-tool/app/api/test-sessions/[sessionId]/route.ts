import { NextResponse } from "next/server";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { test_sessions } from "@/db/schema";
import { requireStaff } from "@/lib/api/requireSession";
import { UUID_RE } from "@/lib/uuid";
import { authorizeSitting } from "@/lib/api/access";

interface RouteContext {
  params: Promise<{ sessionId: string }>;
}

const PatchBody = z.object({ archived: z.boolean() }).strict();

/**
 * Archive / unarchive one sitting (docs/archive-and-delete-design.md, D-2).
 *
 * Nothing is deleted: an archived sitting drops out of the Test sessions tab's
 * default list, and attendance, the monitor's history and every attempt it
 * carries keep working. Owner-only, and 409 `session_open` while the sitting is
 * open and unexpired — close it first, the same rule the assessment archive
 * and the delete-attempt route apply. An expired-but-unclosed sitting counts
 * as closed here, as everywhere else.
 *
 * Idempotent, and deliberately not a re-stamp: archiving an already archived
 * sitting keeps its original date.
 */
export async function PATCH(req: Request, ctx: RouteContext) {
  const auth = await requireStaff();
  if (!auth.ok) return auth.response;

  const { sessionId } = await ctx.params;
  if (!UUID_RE.test(sessionId)) {
    return NextResponse.json({ ok: false, error: "invalid_id" }, { status: 400 });
  }

  let body;
  try {
    body = PatchBody.parse(await req.json());
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_body" }, { status: 400 });
  }

  const db = getDb();
  const access = await authorizeSitting(db, auth.session, sessionId, "own");
  if (!access.ok) return access.response;
  const row = access.sitting;

  if (body.archived === (row.archived_at !== null)) {
    return NextResponse.json({ test_session: row });
  }

  if (body.archived) {
    const isLive = row.status === "open" && row.expires_at.getTime() > Date.now();
    if (isLive) {
      return NextResponse.json(
        { ok: false, error: "session_open" },
        { status: 409 },
      );
    }
  }

  const [updated] = await db
    .update(test_sessions)
    .set({
      archived_at: body.archived ? new Date() : null,
      updated_at: new Date(),
    })
    .where(eq(test_sessions.id, row.id))
    .returning();
  return NextResponse.json({ test_session: updated });
}
