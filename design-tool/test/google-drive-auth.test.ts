// Row GD slice 2 (docs/google-docs-release-design.md, R-1 + GD-P1): the
// teacher's Drive authorization — drive.file only, no stored token, the
// one-hour token in an encrypted cookie bound to the staff session.
import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import type { NextResponse } from "next/server";
import { SESSION_COOKIE_NAME } from "../lib/auth/session";
import * as sessionMod from "../lib/auth/session";
import { setLogSink } from "../lib/log";
import {
  DRIVE_FILE_SCOPE,
  DRIVE_STATE_COOKIE_NAME,
  DRIVE_TOKEN_COOKIE_NAME,
  buildDriveAuthorizeUrl,
  driveTokenLifetimeSeconds,
  grantedScopeIsExactlyDriveFile,
  mintDriveStateCookie,
  mintDriveTokenCookie,
  readDriveToken,
  returnUrl,
  verifyDriveStateCookie,
} from "../lib/googleDocs/driveAuth";

type Principal = {
  sub: string;
  role: string;
  email?: string;
  actor_sub?: string;
} | null;
let principal: Principal = null;

mock.module("next/headers", () => ({
  headers: async () => new Headers(),
  cookies: async () => ({
    get: (name: string) =>
      principal && name === SESSION_COOKIE_NAME ? { value: "x" } : undefined,
  }),
}));

mock.module("../lib/auth/session", () => ({
  ...sessionMod,
  readSessionFromCookies: async () => principal,
}));

const TEACHER = { sub: "staff-sub-1", role: "staff", email: "teacher@example.org" };
const ORIGIN = "http://localhost:3000";
const ENV_KEYS = [
  "DESIGN_TOOL_SESSION_SECRET",
  "OIDC_CLIENT_ID",
  "OIDC_CLIENT_SECRET",
  "OIDC_REDIRECT_URI",
] as const;
const savedEnv: Record<string, string | undefined> = {};
const realFetch = globalThis.fetch;
const restoreSink = setLogSink(() => {});

beforeAll(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  process.env.DESIGN_TOOL_SESSION_SECRET = "session-secret-test-only";
  process.env.OIDC_CLIENT_ID = "client-id-test";
  process.env.OIDC_CLIENT_SECRET = "client-secret-test";
  process.env.OIDC_REDIRECT_URI = `${ORIGIN}/api/auth/callback`;
});

afterEach(() => {
  principal = null;
  globalThis.fetch = realFetch;
});

afterAll(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  setLogSink(restoreSink);
});

describe("helpers", () => {
  test("the authorize URL asks for drive.file alone, without include_granted_scopes (GD-P1)", () => {
    const u = new URL(
      buildDriveAuthorizeUrl({
        clientId: "cid",
        redirectUri: `${ORIGIN}/api/google/drive/callback`,
        state: "st",
        challenge: "ch",
        loginHint: TEACHER.email,
      }),
    );
    expect(u.searchParams.get("scope")).toBe(DRIVE_FILE_SCOPE);
    expect(u.searchParams.has("include_granted_scopes")).toBe(false);
    expect(u.searchParams.get("access_type")).toBe("online");
    expect(u.searchParams.get("login_hint")).toBe(TEACHER.email);
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
  });

  test("granted scope must be exactly drive.file", () => {
    expect(grantedScopeIsExactlyDriveFile(DRIVE_FILE_SCOPE)).toBe(true);
    expect(
      grantedScopeIsExactlyDriveFile(
        `${DRIVE_FILE_SCOPE} https://www.googleapis.com/auth/gmail.send`,
      ),
    ).toBe(false);
    expect(grantedScopeIsExactlyDriveFile("")).toBe(false);
  });

  test("token cookie is encrypted and bound to the session's sub", async () => {
    const cookie = await mintDriveTokenCookie("ya29.secret-token", TEACHER.sub, 600);
    expect(cookie).not.toContain("ya29");
    expect(await readDriveToken(cookie, TEACHER.sub)).toBe("ya29.secret-token");
    expect(await readDriveToken(cookie, "someone-else")).toBeNull();
    expect(await readDriveToken(`${cookie}x`, TEACHER.sub)).toBeNull();
    expect(await readDriveToken(undefined, TEACHER.sub)).toBeNull();
  });

  test("token lifetime is capped at an hour, a minute early", () => {
    expect(driveTokenLifetimeSeconds(3599)).toBe(3539);
    expect(driveTokenLifetimeSeconds(7200)).toBe(3540);
    expect(driveTokenLifetimeSeconds(30)).toBe(0);
  });

  test("returnUrl keeps next's own query", () => {
    expect(returnUrl("/dashboard/a/results?section=7", ORIGIN, "ok")).toBe(
      `${ORIGIN}/dashboard/a/results?section=7&gdrive=ok`,
    );
  });
});

async function start(query = "") {
  const { GET } = await import("../app/api/google/drive/start/route");
  return (await GET(
    new Request(`${ORIGIN}/api/google/drive/start${query}`),
  )) as NextResponse;
}

describe("GET /api/google/drive/start", () => {
  test("401 without a session, 403 for a student or an act-as session", async () => {
    expect((await start()).status).toBe(401);
    principal = { sub: "stu", role: "student", email: "s@example.org" };
    expect((await start()).status).toBe(403);
    principal = { ...TEACHER, actor_sub: "admin-sub" };
    const res = await start();
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "not_while_acting_as" });
  });

  test("redirects to Google with the callback URI and sets the state cookie", async () => {
    principal = TEACHER;
    const res = await start("?next=%2Fdashboard%2Fa%2Fresults");
    expect(res.status).toBe(302);
    const u = new URL(res.headers.get("location")!);
    expect(u.origin).toBe("https://accounts.google.com");
    expect(u.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/api/google/drive/callback`);
    const cookie = res.cookies.get(DRIVE_STATE_COOKIE_NAME)!;
    expect(cookie.httpOnly).toBe(true);
    const state = await verifyDriveStateCookie(cookie.value);
    expect(state.sub).toBe(TEACHER.sub);
    expect(state.next).toBe("/dashboard/a/results");
    expect(state.state).toBe(u.searchParams.get("state")!);
  });

  test("an unsafe next falls back to /dashboard", async () => {
    principal = TEACHER;
    const res = await start("?next=%2F%5Cevil.example");
    const state = await verifyDriveStateCookie(res.cookies.get(DRIVE_STATE_COOKIE_NAME)!.value);
    expect(state.next).toBe("/dashboard");
  });
});

async function callback(query: string, stateCookie?: string) {
  const { GET } = await import("../app/api/google/drive/callback/route");
  const headers = new Headers();
  if (stateCookie) headers.set("cookie", `${DRIVE_STATE_COOKIE_NAME}=${encodeURIComponent(stateCookie)}`);
  return (await GET(
    new Request(`${ORIGIN}/api/google/drive/callback${query}`, { headers }),
  )) as NextResponse;
}

function stateFor(sub = TEACHER.sub) {
  return mintDriveStateCookie({ verifier: "v", state: "st", sub, next: "/dashboard/a/results" });
}

function stubGoogle(options: { scope?: string; tokenStatus?: number; account?: string }) {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith("https://oauth2.googleapis.com/token")) {
      if (options.tokenStatus && options.tokenStatus !== 200) {
        return new Response("{}", { status: options.tokenStatus });
      }
      return Response.json({
        access_token: "ya29.from-google",
        expires_in: 3599,
        scope: options.scope ?? DRIVE_FILE_SCOPE,
      });
    }
    if (url.startsWith("https://www.googleapis.com/drive/v3/about")) {
      return Response.json({ user: { emailAddress: options.account ?? TEACHER.email } });
    }
    return new Response("unexpected", { status: 500 });
  }) as typeof fetch;
}

function outcome(res: NextResponse) {
  return new URL(res.headers.get("location")!).searchParams.get("gdrive");
}

describe("GET /api/google/drive/callback", () => {
  test("401 without a session", async () => {
    expect((await callback("?code=c&state=st")).status).toBe(401);
  });

  test("no state cookie → expired", async () => {
    principal = TEACHER;
    expect(outcome(await callback("?code=c&state=st"))).toBe("expired");
  });

  test("state mismatch, or a cookie from another session → state_mismatch", async () => {
    principal = TEACHER;
    expect(outcome(await callback("?code=c&state=other", await stateFor()))).toBe("state_mismatch");
    expect(outcome(await callback("?code=c&state=st", await stateFor("other-sub")))).toBe(
      "state_mismatch",
    );
  });

  test("Google's error → denied, back to next", async () => {
    principal = TEACHER;
    const res = await callback("?error=access_denied&state=st", await stateFor());
    expect(res.headers.get("location")).toBe(`${ORIGIN}/dashboard/a/results?gdrive=denied`);
    expect(res.cookies.get(DRIVE_TOKEN_COOKIE_NAME)).toBeUndefined();
  });

  test("success sets the encrypted token cookie on the send path and clears the state", async () => {
    principal = TEACHER;
    stubGoogle({});
    const res = await callback("?code=c&state=st", await stateFor());
    expect(outcome(res)).toBe("ok");
    const tok = res.cookies.get(DRIVE_TOKEN_COOKIE_NAME)!;
    expect(tok.path).toBe("/api/assessments");
    expect(tok.httpOnly).toBe(true);
    expect(tok.maxAge).toBe(3539);
    expect(await readDriveToken(tok.value, TEACHER.sub)).toBe("ya29.from-google");
    expect(res.cookies.get(DRIVE_STATE_COOKIE_NAME)!.maxAge).toBe(0);
  });

  test("an extra granted scope is refused (GD-P1)", async () => {
    principal = TEACHER;
    stubGoogle({ scope: `${DRIVE_FILE_SCOPE} https://www.googleapis.com/auth/gmail.send` });
    const res = await callback("?code=c&state=st", await stateFor());
    expect(outcome(res)).toBe("scope_mismatch");
    expect(res.cookies.get(DRIVE_TOKEN_COOKIE_NAME)).toBeUndefined();
  });

  test("another Google account at the consent screen → wrong_account", async () => {
    principal = TEACHER;
    stubGoogle({ account: "someone.else@example.org" });
    const res = await callback("?code=c&state=st", await stateFor());
    expect(outcome(res)).toBe("wrong_account");
    expect(res.cookies.get(DRIVE_TOKEN_COOKIE_NAME)).toBeUndefined();
  });

  test("a refused exchange → exchange_failed", async () => {
    principal = TEACHER;
    stubGoogle({ tokenStatus: 400 });
    expect(outcome(await callback("?code=c&state=st", await stateFor()))).toBe("exchange_failed");
  });

  test("an act-as session is refused", async () => {
    principal = { ...TEACHER, actor_sub: "admin-sub" };
    expect((await callback("?code=c&state=st", await stateFor())).status).toBe(403);
  });
});
