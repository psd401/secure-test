import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  SignJWT,
  exportJWK,
  generateKeyPair,
  type JSONWebKeySet,
  type KeyLike,
} from "jose";
import {
  resolveExpectedAudience,
  verifyIdToken,
} from "../lib/auth/verifyIdToken";
import { mintSessionJWT, verifySessionJWT } from "../lib/auth/session";

const TEST_ISSUER = "https://test.example.com";
const TEST_AUDIENCE = "design-tool-test-client";

let privateKey: KeyLike;
let jwks: JSONWebKeySet;
let originalSecret: string | undefined;

beforeAll(async () => {
  const keys = await generateKeyPair("RS256");
  privateKey = keys.privateKey;
  const publicJwk = await exportJWK(keys.publicKey);
  publicJwk.kid = "test-kid-1";
  publicJwk.alg = "RS256";
  publicJwk.use = "sig";
  jwks = { keys: [publicJwk] };
  originalSecret = process.env.DESIGN_TOOL_SESSION_SECRET;
  process.env.DESIGN_TOOL_SESSION_SECRET = "test-secret-do-not-use-in-prod";
});

afterAll(() => {
  if (originalSecret === undefined) {
    delete process.env.DESIGN_TOOL_SESSION_SECRET;
  } else {
    process.env.DESIGN_TOOL_SESSION_SECRET = originalSecret;
  }
});

async function signTestIdToken(claims: Record<string, unknown>) {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: "test-kid-1" })
    .setIssuer(TEST_ISSUER)
    .setAudience(TEST_AUDIENCE)
    .setSubject((claims.sub as string) ?? "user-123")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);
}

describe("verifyIdToken (local JWKS)", () => {
  test("accepts a well-formed token", async () => {
    const token = await signTestIdToken({
      sub: "teacher-001",
      email: "teacher.one@psd401.net",
      email_verified: true,
    });
    const claims = await verifyIdToken(token, {
      issuer: TEST_ISSUER,
      audience: TEST_AUDIENCE,
      jwks,
    });
    expect(claims.sub).toBe("teacher-001");
    expect(claims.email).toBe("teacher.one@psd401.net");
  });

  test("rejects a tampered signature", async () => {
    const token = await signTestIdToken({ sub: "teacher-002" });
    const tampered = token.slice(0, -2) + "AA";
    await expect(
      verifyIdToken(tampered, {
        issuer: TEST_ISSUER,
        audience: TEST_AUDIENCE,
        jwks,
      }),
    ).rejects.toThrow();
  });

  test("rejects wrong issuer", async () => {
    const token = await signTestIdToken({ sub: "teacher-003" });
    await expect(
      verifyIdToken(token, {
        issuer: "https://attacker.example.com",
        audience: TEST_AUDIENCE,
        jwks,
      }),
    ).rejects.toThrow();
  });

  test("rejects a token minted for a different client at the same issuer", async () => {
    const token = await signTestIdToken({ sub: "teacher-004" });
    await expect(
      verifyIdToken(token, {
        issuer: TEST_ISSUER,
        audience: "some-other-clients-audience",
        jwks,
      }),
    ).rejects.toThrow();
  });

  // A2: jose skips the aud check when `audience` is undefined, which let a
  // token issued to any other client at the same issuer mint a session.
  test("refuses to verify without an expected audience", async () => {
    const token = await signTestIdToken({ sub: "teacher-005" });
    await expect(
      verifyIdToken(token, {
        issuer: TEST_ISSUER,
        audience: undefined as unknown as string,
        jwks,
      }),
    ).rejects.toThrow(/audience/i);
    await expect(
      verifyIdToken(token, { issuer: TEST_ISSUER, audience: [], jwks }),
    ).rejects.toThrow(/audience/i);
  });

  // Slice 77: the web app and the native client are two Google OAuth clients.
  test("accepts a token for any client in an audience list", async () => {
    const token = await signTestIdToken({ sub: "teacher-006" });
    const claims = await verifyIdToken(token, {
      issuer: TEST_ISSUER,
      audience: ["another-client", TEST_AUDIENCE],
      jwks,
    });
    expect(claims.sub).toBe("teacher-006");
    await expect(
      verifyIdToken(token, {
        issuer: TEST_ISSUER,
        audience: ["another-client", "yet-another"],
        jwks,
      }),
    ).rejects.toThrow();
  });

  // Slice 77: Google documents `iss` as either form.
  test("accepts Google's schemeless issuer form only when the issuer is Google", async () => {
    const schemeless = await new SignJWT({ sub: "g-1" })
      .setProtectedHeader({ alg: "RS256", kid: "test-kid-1" })
      .setIssuer("accounts.google.com")
      .setAudience(TEST_AUDIENCE)
      .setSubject("g-1")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);
    const claims = await verifyIdToken(schemeless, {
      issuer: "https://accounts.google.com",
      audience: TEST_AUDIENCE,
      jwks,
    });
    expect(claims.iss).toBe("accounts.google.com");

    // The same leniency must not apply to any other issuer.
    const other = await new SignJWT({ sub: "g-1" })
      .setProtectedHeader({ alg: "RS256", kid: "test-kid-1" })
      .setIssuer("test.example.com")
      .setAudience(TEST_AUDIENCE)
      .setSubject("g-1")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);
    await expect(
      verifyIdToken(other, { issuer: TEST_ISSUER, audience: TEST_AUDIENCE, jwks }),
    ).rejects.toThrow();
  });
});

describe("resolveExpectedAudience", () => {
  function withEnv(
    vars: Record<string, string | undefined>,
    fn: () => void,
  ) {
    const prior: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(vars)) {
      prior[k] = process.env[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    try {
      fn();
    } finally {
      for (const [k, v] of Object.entries(prior)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  }

  test("prefers OIDC_AUDIENCE, falls back to OIDC_CLIENT_ID", () => {
    withEnv({ OIDC_AUDIENCE: "aud-1", OIDC_CLIENT_ID: "client-1" }, () => {
      expect(resolveExpectedAudience()).toBe("aud-1");
    });
    withEnv({ OIDC_AUDIENCE: undefined, OIDC_CLIENT_ID: "client-1" }, () => {
      expect(resolveExpectedAudience()).toBe("client-1");
    });
  });

  test("a comma-separated OIDC_AUDIENCE becomes a list (slice 77)", () => {
    withEnv({ OIDC_AUDIENCE: " web-client , native-client,, ", OIDC_CLIENT_ID: undefined }, () => {
      expect(resolveExpectedAudience()).toEqual(["web-client", "native-client"]);
    });
    withEnv({ OIDC_AUDIENCE: " , ", OIDC_CLIENT_ID: undefined }, () => {
      expect(resolveExpectedAudience()).toBeUndefined();
    });
  });

  test("returns undefined when neither is set so callers fail closed", () => {
    withEnv({ OIDC_AUDIENCE: undefined, OIDC_CLIENT_ID: undefined }, () => {
      expect(resolveExpectedAudience()).toBeUndefined();
    });
  });
});

describe("session JWT round-trip", () => {
  test("mint then verify yields the same payload", async () => {
    const jwt = await mintSessionJWT({
      sub: "teacher-001",
      role: "staff",
      email: "teacher.one@psd401.net",
      hd: "psd401.net",
    });
    const claims = await verifySessionJWT(jwt);
    expect(claims.sub).toBe("teacher-001");
    expect(claims.role).toBe("staff");
    expect(claims.email).toBe("teacher.one@psd401.net");
    expect(claims.hd).toBe("psd401.net");
  });

  test("rejects a session signed with the wrong secret", async () => {
    const jwt = await mintSessionJWT({ sub: "teacher-001" });
    process.env.DESIGN_TOOL_SESSION_SECRET = "different-secret";
    try {
      await expect(verifySessionJWT(jwt)).rejects.toThrow();
    } finally {
      process.env.DESIGN_TOOL_SESSION_SECRET = "test-secret-do-not-use-in-prod";
    }
  });
});
