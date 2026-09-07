import { NextResponse, type NextRequest } from "next/server";
import { jwtVerify } from "jose";
import { SESSION_COOKIE_NAME } from "@/lib/auth/session";
import { isStaff } from "@/lib/auth/roles";
import { REQUEST_ID_HEADER, resolveRequestId } from "@/lib/observability/requestId";

const PROTECTED_PREFIXES = ["/dashboard"];

function isProtected(pathname: string): boolean {
  return PROTECTED_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

/**
 * Batch 3 slice 2: every request gets an id here — on the request, so
 * `onRequestError` can read it out of the headers and stamp it on the
 * `server_error_events` row, and on the response as `x-request-id`, so a
 * teacher who screenshots an error screen hands over something that finds the
 * row. Behind the ALB the id IS the trace id (see lib/observability/requestId).
 *
 * The matcher therefore had to widen from `/dashboard` to everything except
 * the static asset paths; `isProtected` still decides who gets the auth
 * treatment, so nothing else about the auth behaviour moved.
 */
function withRequestId(res: NextResponse, id: string): NextResponse {
  res.headers.set(REQUEST_ID_HEADER, id);
  return res;
}

export async function proxy(req: NextRequest) {
  const requestId = resolveRequestId(req.headers);
  const requestHeaders = new Headers(req.headers);
  requestHeaders.set(REQUEST_ID_HEADER, requestId);
  const pass = () =>
    NextResponse.next({ request: { headers: requestHeaders } });

  if (!isProtected(req.nextUrl.pathname)) {
    return withRequestId(pass(), requestId);
  }

  const cookie = req.cookies.get(SESSION_COOKIE_NAME)?.value;
  if (!cookie) {
    return withRequestId(redirectToLogin(req), requestId);
  }

  const secret = process.env.DESIGN_TOOL_SESSION_SECRET;
  if (!secret) {
    return withRequestId(misconfiguredResponse(requestId), requestId);
  }

  try {
    // Slice 58: verifying the signature only ever answered "is this a real
    // session". It never asked whose — so a valid STUDENT session reached the
    // teacher dashboard. The role check closes that at the edge, before any
    // page runs a query.
    const { payload } = await jwtVerify(cookie, new TextEncoder().encode(secret), {
      issuer: "secure-test/design-tool",
    });
    const role = typeof payload.role === "string" ? payload.role : null;
    if (!isStaff(role)) {
      // A student here is authenticated correctly to the wrong kind of
      // account. /login is outside the matcher, so no loop: the page reads
      // `error=student_account` and offers Sign out (which clears the cookie)
      // instead of the text/plain 403 this used to be (UX pass 1, slice 2).
      const url = req.nextUrl.clone();
      url.pathname = "/login";
      url.search = "?error=student_account";
      return withRequestId(NextResponse.redirect(url), requestId);
    }
  } catch {
    return withRequestId(redirectToLogin(req), requestId);
  }

  return withRequestId(pass(), requestId);
}

function redirectToLogin(req: NextRequest) {
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.search = `?next=${encodeURIComponent(req.nextUrl.pathname)}`;
  return NextResponse.redirect(url);
}

/**
 * `DESIGN_TOOL_SESSION_SECRET` unset means the deploy is broken, not the
 * teacher. This used to be a `text/plain` line; it is now the same shape as
 * the error boundaries — a sentence, and the ref to hand IT.
 *
 * Hand-written HTML rather than a rendered page on purpose: proxy runs before
 * any route does, cannot import a React tree, and must not itself depend on
 * the thing that is misconfigured.
 */
export function misconfiguredPage(requestId: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Secure-Test is not available</title>
<style>
  body { margin:0; font: 16px/1.5 system-ui, sans-serif; color:#1c2b33; background:#f4f6f7; }
  main { max-width: 34rem; margin: 4rem auto; padding: 0 1.5rem; }
  .alert { border:1px solid #c0392b; border-left-width:4px; border-radius:6px;
           background:#fff; padding:1rem 1.25rem; }
  h1 { font-size:1.15rem; margin:0 0 .5rem; }
  code { font-size:.8rem; color:#5a6b75; }
</style></head>
<body><main><div class="alert">
<h1>Secure-Test can&rsquo;t start.</h1>
<p>The server is missing part of its configuration. Nothing you did caused
this, and trying again will not help until IT has looked at it.</p>
<p><code>ref ${requestId}</code></p>
</div></main></body></html>`;
}

function misconfiguredResponse(requestId: string): NextResponse {
  return new NextResponse(misconfiguredPage(requestId), {
    status: 500,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

export const config = {
  // Everything except Next's own static output and the public folder: the
  // request id has to be minted for API routes and the student plane too, not
  // only the dashboard.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|icon.png|.*\\.woff2$).*)"],
};
