import { NextResponse } from "next/server";
import { appOrigin } from "@/lib/auth/appOrigin";
import { SESSION_COOKIE_NAME } from "@/lib/auth/session";

function redirectToLogin(req: Request) {
  const url = new URL("/login", appOrigin(req));
  const res = NextResponse.redirect(url.toString(), { status: 302 });
  res.cookies.set({
    name: SESSION_COOKIE_NAME,
    value: "",
    path: "/",
    maxAge: 0,
  });
  return res;
}

export async function GET(req: Request) {
  return redirectToLogin(req);
}

export async function POST(req: Request) {
  return redirectToLogin(req);
}
