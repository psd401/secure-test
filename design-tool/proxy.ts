import { NextResponse, type NextRequest } from "next/server";
import { jwtVerify } from "jose";
import { SESSION_COOKIE_NAME } from "@/lib/auth/session";
import { isStaff } from "@/lib/auth/roles";

const PROTECTED_PREFIXES = ["/dashboard"];

function isProtected(pathname: string): boolean {
  return PROTECTED_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

export async function proxy(req: NextRequest) {
  if (!isProtected(req.nextUrl.pathname)) {
    return NextResponse.next();
  }

  const cookie = req.cookies.get(SESSION_COOKIE_NAME)?.value;
  if (!cookie) {
    return redirectToLogin(req);
  }

  const secret = process.env.DESIGN_TOOL_SESSION_SECRET;
  if (!secret) {
    return new NextResponse("server misconfigured", { status: 500 });
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
      return NextResponse.redirect(url);
    }
  } catch {
    return redirectToLogin(req);
  }

  return NextResponse.next();
}

function redirectToLogin(req: NextRequest) {
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.search = `?next=${encodeURIComponent(req.nextUrl.pathname)}`;
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/dashboard/:path*", "/dashboard"],
};
