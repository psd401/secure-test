import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/db/client";
import { authorizeAssessment } from "@/lib/api/access";
import { requireStaff } from "@/lib/api/requireSession";
import { DRIVE_TOKEN_COOKIE_NAME, cookieFromHeader, readDriveToken } from "@/lib/googleDocs/driveAuth";
import { createDriveClient } from "@/lib/googleDocs/drive";
import { releaseToGoogleDocs } from "@/lib/googleDocs/release";
import { log } from "@/lib/log";

interface RouteContext {
  params: Promise<{ id: string }>;
}

const Body = z
  .object({
    section: z.string().trim().min(1).max(200).optional(),
    attempt_id: z.string().uuid().optional(),
    // D-2: the essay itself is always in the Doc; these are the extras.
    contents: z.object({
      prompt: z.boolean(),
      sources: z.boolean(),
      score: z.boolean(),
      teacher_feedback: z.boolean(),
      ai_feedback: z.boolean(),
    }),
    mode: z.enum(["skip", "new"]),
    include_drafts: z.boolean(),
    // Slice 5: optional so a dialog from before it still posts.
    transfer_ownership: z.boolean().optional(),
  })
  .refine((b) => (b.section === undefined) !== (b.attempt_id === undefined), {
    message: "exactly one of section or attempt_id",
  });

/**
 * Release essays to Google Docs (docs/google-docs-release-design.md, row GD
 * slice 3). `edit` on the assessment (D-9: co-teachers with edit can send;
 * their Docs land in their own Drive). The Drive token is the slice 2 cookie;
 * without one — or when Drive refuses it mid-send — the answer carries
 * `drive_auth_needed` and the page runs the authorization again.
 *
 * Answers `{ ok, outcomes: [{ attempt_id, name, status: sent | skipped |
 * failed, reason?, url? }], drive_auth_needed }`. Names are for the teacher's
 * own screen; nothing about a student is logged.
 */
export async function POST(req: Request, ctx: RouteContext) {
  const auth = await requireStaff();
  if (!auth.ok) return auth.response;
  const { session } = auth;
  // The Drive behind the token is the signed-in person's own; an admin
  // acting as a teacher would put Docs in the admin's Drive.
  if (session.actor_sub) {
    return NextResponse.json({ ok: false, error: "not_while_acting_as" }, { status: 403 });
  }
  const { id } = await ctx.params;

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_body" }, { status: 400 });
  }
  const parsed = Body.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: "invalid_body" }, { status: 400 });
  }
  const body = parsed.data;

  const db = getDb();
  const access = await authorizeAssessment(db, session, id, "edit");
  if (!access.ok) return access.response;

  const token = await readDriveToken(
    cookieFromHeader(req.headers.get("cookie"), DRIVE_TOKEN_COOKIE_NAME),
    session.sub,
  );
  if (!token) {
    return NextResponse.json({ ok: false, error: "drive_auth_needed" }, { status: 401 });
  }

  const result = await releaseToGoogleDocs(db, {
    assessment: access.assessment,
    senderSub: session.sub,
    scope: body.attempt_id ? { attemptId: body.attempt_id } : { section: body.section! },
    options: {
      contents: body.contents,
      mode: body.mode,
      includeDrafts: body.include_drafts,
      transferOwnership: body.transfer_ownership ?? false,
    },
    drive: createDriveClient(token),
  });
  if (!result.ok) {
    const status = result.error === "attempt_not_found" ? 404 : 409;
    return NextResponse.json({ ok: false, error: result.error }, { status });
  }

  const count = (s: string) => result.outcomes.filter((o) => o.status === s).length;
  log.info("google_docs_released", {
    assessment_id: id,
    sent: count("sent"),
    skipped: count("skipped"),
    failed: count("failed"),
    drive_auth_needed: result.drive_auth_needed,
  });
  return NextResponse.json({
    ok: true,
    outcomes: result.outcomes,
    drive_auth_needed: result.drive_auth_needed,
  });
}
