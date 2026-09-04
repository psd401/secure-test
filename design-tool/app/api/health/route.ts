import { NextResponse } from "next/server";

/**
 * ALB target-group health check (ECS deploy follow-up, 2026-08-31). No
 * auth, no DB, no session read — a health probe must not recycle the task
 * over an Aurora hiccup, and the ALB sends no cookies anyway. The previous
 * target (/login) worked but cost an SSR render every 30s and read
 * ambiguously in CloudWatch.
 */
export function GET() {
  return NextResponse.json({ ok: true });
}
