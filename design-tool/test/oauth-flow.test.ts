import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { generatePkcePair, generateRandomToken } from "../lib/auth/pkce";
import {
  mintPkceCookie,
  verifyPkceCookie,
} from "../lib/auth/pkceCookie";
import { exchangeCode, type FetchLike } from "../lib/auth/oauth";

let originalSessionSecret: string | undefined;
let originalPkceSecret: string | undefined;

beforeAll(() => {
  originalSessionSecret = process.env.DESIGN_TOOL_SESSION_SECRET;
  originalPkceSecret = process.env.DESIGN_TOOL_PKCE_SECRET;
  process.env.DESIGN_TOOL_SESSION_SECRET = "session-secret-test-only";
  process.env.DESIGN_TOOL_PKCE_SECRET = "pkce-secret-test-only";
});

afterAll(() => {
  function restore(key: string, value: string | undefined) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  restore("DESIGN_TOOL_SESSION_SECRET", originalSessionSecret);
  restore("DESIGN_TOOL_PKCE_SECRET", originalPkceSecret);
});

function base64url(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

describe("PKCE helpers", () => {
  test("verifier is URL-safe and 43+ chars (>= 256 bits of entropy)", () => {
    const { verifier } = generatePkcePair();
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  test("challenge is the base64url-encoded SHA-256 of the verifier", () => {
    const { verifier, challenge } = generatePkcePair();
    const expected = base64url(createHash("sha256").update(verifier).digest());
    expect(challenge).toBe(expected);
  });

  test("each call returns a fresh pair", () => {
    const a = generatePkcePair();
    const b = generatePkcePair();
    expect(a.verifier).not.toBe(b.verifier);
    expect(a.challenge).not.toBe(b.challenge);
  });

  test("generateRandomToken is URL-safe and high-entropy", () => {
    const tok = generateRandomToken();
    expect(tok.length).toBeGreaterThanOrEqual(43);
    expect(tok).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe("PKCE cookie round-trip", () => {
  test("mint then verify yields the same payload", async () => {
    const cookie = await mintPkceCookie({
      verifier: "test-verifier",
      state: "test-state",
      nonce: "test-nonce",
      next: "/dashboard/items",
    });
    const payload = await verifyPkceCookie(cookie);
    expect(payload.verifier).toBe("test-verifier");
    expect(payload.state).toBe("test-state");
    expect(payload.nonce).toBe("test-nonce");
    expect(payload.next).toBe("/dashboard/items");
  });

  test("rejects a cookie signed with the wrong secret", async () => {
    const cookie = await mintPkceCookie({
      verifier: "v",
      state: "s",
      nonce: "n",
    });
    process.env.DESIGN_TOOL_PKCE_SECRET = "different-secret";
    try {
      await expect(verifyPkceCookie(cookie)).rejects.toThrow();
    } finally {
      process.env.DESIGN_TOOL_PKCE_SECRET = "pkce-secret-test-only";
    }
  });
});

describe("exchangeCode", () => {
  test("POSTs application/x-www-form-urlencoded with all required params", async () => {
    let captured: { url: string; init: Parameters<FetchLike>[1] } | null = null;
    const fakeFetch: FetchLike = async (input, init) => {
      captured = { url: input, init };
      return {
        ok: true,
        status: 200,
        text: async () => "",
        json: async () => ({
          id_token: "fake.id.token",
          access_token: "fake-access",
          token_type: "Bearer",
        }),
      };
    };
    const res = await exchangeCode({
      tokenEndpoint: "https://idp.example.com/token",
      code: "abc",
      verifier: "v",
      redirectUri: "http://localhost:3000/api/auth/callback",
      clientId: "client-1",
      fetchImpl: fakeFetch,
    });
    expect(res.id_token).toBe("fake.id.token");
    expect(captured).not.toBeNull();
    expect(captured!.url).toBe("https://idp.example.com/token");
    expect(captured!.init.headers["content-type"]).toBe(
      "application/x-www-form-urlencoded",
    );
    const body = new URLSearchParams(captured!.init.body);
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code")).toBe("abc");
    expect(body.get("code_verifier")).toBe("v");
    expect(body.get("client_id")).toBe("client-1");
    expect(body.get("redirect_uri")).toBe(
      "http://localhost:3000/api/auth/callback",
    );
    expect(body.has("client_secret")).toBe(false);
  });

  test("includes client_secret when provided", async () => {
    let body = "";
    const fakeFetch: FetchLike = async (_url, init) => {
      body = init.body;
      return {
        ok: true,
        status: 200,
        text: async () => "",
        json: async () => ({ id_token: "x" }),
      };
    };
    await exchangeCode({
      tokenEndpoint: "https://idp.example.com/token",
      code: "abc",
      verifier: "v",
      redirectUri: "http://localhost:3000/api/auth/callback",
      clientId: "client-1",
      clientSecret: "secret-1",
      fetchImpl: fakeFetch,
    });
    const parsed = new URLSearchParams(body);
    expect(parsed.get("client_secret")).toBe("secret-1");
  });

  test("throws on non-200", async () => {
    const fakeFetch: FetchLike = async () => ({
      ok: false,
      status: 400,
      text: async () => "invalid_grant",
      json: async () => ({}),
    });
    await expect(
      exchangeCode({
        tokenEndpoint: "https://idp.example.com/token",
        code: "abc",
        verifier: "v",
        redirectUri: "http://localhost:3000/api/auth/callback",
        clientId: "client-1",
        fetchImpl: fakeFetch,
      }),
    ).rejects.toThrow(/400/);
  });

  test("throws when response is missing id_token", async () => {
    const fakeFetch: FetchLike = async () => ({
      ok: true,
      status: 200,
      text: async () => "",
      json: async () => ({ access_token: "x" }),
    });
    await expect(
      exchangeCode({
        tokenEndpoint: "https://idp.example.com/token",
        code: "abc",
        verifier: "v",
        redirectUri: "http://localhost:3000/api/auth/callback",
        clientId: "client-1",
        fetchImpl: fakeFetch,
      }),
    ).rejects.toThrow(/id_token/);
  });
});
