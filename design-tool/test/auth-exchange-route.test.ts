// Slice 77: POST /api/auth/exchange end to end through the ALLOW_TEST_ISSUER
// path — the route the macOS client will call with a Google id_token (slice
// 80), exercised here with tokens we sign ourselves.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  SignJWT,
  exportJWK,
  generateKeyPair,
  type JSONWebKeySet,
  type KeyLike,
} from "jose";
import { POST } from "../app/api/auth/exchange/route";
import { SESSION_COOKIE_NAME, verifySessionJWT } from "../lib/auth/session";

const ISSUER = "https://test-issuer.example";
const WEB_CLIENT = "web-client-id.apps.googleusercontent.com";
const NATIVE_CLIENT = "native-client-id.apps.googleusercontent.com";

let privateKey: KeyLike;
let jwks: JSONWebKeySet;
const savedEnv: Record<string, string | undefined> = {};

function setEnv(vars: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(vars)) {
    if (!(k in savedEnv)) savedEnv[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

beforeAll(async () => {
  const keys = await generateKeyPair("RS256");
  privateKey = keys.privateKey;
  const jwk = await exportJWK(keys.publicKey);
  jwk.kid = "exchange-kid";
  jwk.alg = "RS256";
  jwk.use = "sig";
  jwks = { keys: [jwk] };
  setEnv({
    ALLOW_TEST_ISSUER: "1",
    OIDC_ISSUER: "https://accounts.google.com",
    OIDC_CLIENT_ID: WEB_CLIENT,
    // Both clients, comma-separated — the shape a Google deployment needs.
    OIDC_AUDIENCE: `${WEB_CLIENT}, ${NATIVE_CLIENT}`,
    DESIGN_TOOL_SESSION_SECRET: "exchange-test-secret",
  });
});

afterAll(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

async function idToken(claims: Record<string, unknown>, audience = NATIVE_CLIENT) {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: "exchange-kid" })
    .setIssuer(ISSUER)
    .setAudience(audience)
    .setSubject((claims.sub as string) ?? "google-sub-1")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);
}

async function exchange(token: string) {
  const res = await POST(
    new Request("http://localhost/api/auth/exchange", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id_token: token, test_issuer: ISSUER, test_jwks: jwks }),
    }),
  );
  return { res, body: (await res.json()) as Record<string, unknown> };
}

function sessionCookie(res: Response): string | null {
  const header = res.headers.get("set-cookie") ?? "";
  const m = new RegExp(`${SESSION_COOKIE_NAME}=([^;]+)`).exec(header);
  return m?.[1] ?? null;
}

describe("POST /api/auth/exchange (slice 77)", () => {
  test("a verified staff address mints a staff session, as cookie and as token", async () => {
    const { res, body } = await exchange(
      await idToken({ email: "Teacher.One@psd401.net", email_verified: true, hd: "psd401.net" }),
    );
    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      sub: "google-sub-1",
      role: "staff",
      email: "teacher.one@psd401.net",
    });
    expect(typeof body.session_token).toBe("string");

    const cookie = sessionCookie(res);
    expect(cookie).not.toBeNull();
    const session = await verifySessionJWT(cookie!);
    expect(session.role).toBe("staff");
    expect(session.email).toBe("teacher.one@psd401.net");
    expect(session.hd).toBe("psd401.net");
    expect("classLink_sourcedId" in session).toBe(false);

    const fromBody = await verifySessionJWT(body.session_token as string);
    expect(fromBody.sub).toBe(session.sub);
  });

  test("a verified student address mints a student session", async () => {
    const { res, body } = await exchange(
      await idToken({
        sub: "google-sub-2",
        email: "ada.fixture@edtools.psd401.net",
        email_verified: true,
        hd: "edtools.psd401.net",
      }),
    );
    expect(res.status).toBe(200);
    expect(body.role).toBe("student");
  });

  test("a token for the web client id is accepted too (audience list)", async () => {
    const { res } = await exchange(
      await idToken({ email: "teacher.one@psd401.net", email_verified: true }, WEB_CLIENT),
    );
    expect(res.status).toBe(200);
  });

  test("a token for an unlisted client id is refused with 401", async () => {
    const { res } = await exchange(
      await idToken(
        { email: "teacher.one@psd401.net", email_verified: true },
        "somebody-elses-client.apps.googleusercontent.com",
      ),
    );
    expect(res.status).toBe(401);
    expect(sessionCookie(res)).toBeNull();
  });

  test("a domain outside the allowlist is refused with 403 account_not_allowed", async () => {
    const original = console.warn;
    console.warn = () => {};
    try {
      const { res, body } = await exchange(
        await idToken({ email: "somebody@gmail.com", email_verified: true }),
      );
      expect(res.status).toBe(403);
      expect(body).toEqual({ ok: false, error: "account_not_allowed" });
      expect(sessionCookie(res)).toBeNull();
    } finally {
      console.warn = original;
    }
  });

  test("email_verified=false is refused with 403 even on a staff domain", async () => {
    const original = console.warn;
    console.warn = () => {};
    try {
      const { res, body } = await exchange(
        await idToken({ email: "teacher.one@psd401.net", email_verified: false }),
      );
      expect(res.status).toBe(403);
      expect(body).toEqual({ ok: false, error: "account_not_allowed" });
    } finally {
      console.warn = original;
    }
  });

  test("a token with no email is refused with 403", async () => {
    const original = console.warn;
    console.warn = () => {};
    try {
      const { res } = await exchange(await idToken({}));
      expect(res.status).toBe(403);
    } finally {
      console.warn = original;
    }
  });

  test("a ClassLink role claim on the token changes nothing", async () => {
    const { res, body } = await exchange(
      await idToken({
        email: "ada.fixture@edtools.psd401.net",
        email_verified: true,
        classLink_role: "administrator",
      }),
    );
    expect(res.status).toBe(200);
    expect(body.role).toBe("student");
  });

  test("a bad signature is refused with 401", async () => {
    const token = await idToken({ email: "teacher.one@psd401.net", email_verified: true });
    const { res } = await exchange(token.slice(0, -3) + "xyz");
    expect(res.status).toBe(401);
  });
});
