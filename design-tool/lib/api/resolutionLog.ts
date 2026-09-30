/**
 * The server-side record of a student refused at the door (roadmap U-11's
 * operator half, 2026-09-30). The client puts the reason into words on the
 * student's screen and in its own stderr, which nobody can read on a Finder
 * launch; this line is what an operator finds in CloudWatch afterwards.
 *
 * lib/log.ts's redaction contract: never the address. `email_ref` is a keyed
 * hash of the normalized address — `student-lookup <email>` prints the same
 * ref, so a lookup can be matched to its refusals without the address ever
 * reaching the log. `email_domain` shows a personal or staff account at a
 * glance.
 */
import { createHmac } from "node:crypto";
import { log } from "@/lib/log";
import { normalizeEmail } from "@/lib/roster/queries";

/** 16 hex characters of HMAC-SHA256 over the normalized address, keyed by the
 * session secret. Null without an address or without the secret. */
export function emailRef(email: string | null | undefined): string | null {
  const normalized = normalizeEmail(email);
  const key = process.env.DESIGN_TOOL_SESSION_SECRET;
  if (!normalized || !key) return null;
  return createHmac("sha256", key).update(`email-ref:v1:${normalized}`).digest("hex").slice(0, 16);
}

export function emailDomainOf(email: string | null | undefined): string | null {
  const normalized = normalizeEmail(email);
  if (!normalized) return null;
  const at = normalized.lastIndexOf("@");
  return at >= 0 ? normalized.slice(at + 1) : null;
}

export interface ResolutionFailureContext {
  /** The route that refused, e.g. "GET /api/me/sittings". */
  route: string;
  reason: string;
  session: { sub: string; email?: string | null };
  sittingId?: string;
}

/** `not_in_sitting` is routine (a wrong or foreign code) and logs at info;
 * every account-level refusal logs at warn. Neither alarms (the alarm
 * matches level error only). */
export function logResolutionFailure(ctx: ResolutionFailureContext): void {
  const fields = {
    route: ctx.route,
    reason: ctx.reason,
    sub: ctx.session.sub,
    email_ref: emailRef(ctx.session.email) ?? undefined,
    email_domain: emailDomainOf(ctx.session.email) ?? undefined,
    sitting_id: ctx.sittingId,
  };
  if (ctx.reason === "not_in_sitting") log.info("student_resolution_failed", fields);
  else log.warn("student_resolution_failed", fields);
}
