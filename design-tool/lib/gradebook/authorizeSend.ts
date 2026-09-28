// Gradebook push authorization, in one place
// (docs/gradebook-push-design.md, "Authorization, in one place").
//
// PowerSchool does not restrict the plugin by user — every call carries the
// acting teacher's `users_dcid`, and whatever we pass, it acts as. So the
// tool decides, twice:
//
//   1. `authorizeAssessment(id, "edit")` — the owner, an edit-level
//      co-teacher (8.4), or an admin; a `run`-level substitute is refused.
//   2. The SENDER's own address must currently teach the section on the
//      roster (active row, today inside its dates, any role). An owner
//      sending to a section they do not teach, or a plain admin, is refused.
//
// Both refusals are the access model's 404 (D-3 there). Under act-as the
// session IS the target teacher (sub, email) — they are the one who could do
// this themselves — and `actor_sub` is carried out for the audit row.
//
// The users_dcid comes from the roster row found in step 2, never from the
// request.
import type { AssessmentRow } from "@/db/schema";
import type { getDb } from "@/db/client";
import { authorizeAssessment, notFoundResponse, type AccessLevel, type AccessVia } from "@/lib/api/access";
import type { SessionPayload } from "@/lib/auth/session";
import { normalizeEmail } from "@/lib/roster/queries";
import { loadSectionIds, loadSenderAssignment, type SectionIds } from "./mapping";
import type { NextResponse } from "next/server";

type Db = ReturnType<typeof getDb>;

export type SendAccess =
  | {
      ok: true;
      assessment: AssessmentRow;
      level: AccessLevel;
      via: AccessVia;
      teacher: { sub: string; email: string; users_dcid: string | null };
      /** The admin behind an act-as session, else null. */
      actor_sub: string | null;
      section: SectionIds;
    }
  | { ok: false; response: NextResponse };

export async function authorizeSend(
  db: Db,
  session: SessionPayload,
  assessmentId: string,
  sectionPsId: string,
): Promise<SendAccess> {
  const access = await authorizeAssessment(db, session, assessmentId, "edit");
  if (!access.ok) return access;

  const email = normalizeEmail(session.email);
  if (!email) return { ok: false, response: notFoundResponse() };
  const assignment = await loadSenderAssignment(db, email, sectionPsId);
  if (!assignment) return { ok: false, response: notFoundResponse() };
  const section = await loadSectionIds(db, sectionPsId);
  if (!section) return { ok: false, response: notFoundResponse() };

  return {
    ok: true,
    assessment: access.assessment,
    level: access.level,
    via: access.via,
    teacher: { sub: session.sub, email, users_dcid: assignment.users_dcid },
    actor_sub: session.actor_sub ?? null,
    section,
  };
}
