// Tiny OIDC issuer for local end-to-end smoke testing of the design-tool's
// /api/auth/start -> /api/auth/callback flow. NOT for production use.
//
//   bun design-tool/scripts/mock-issuer.mjs
//
// Spawns on :4444 (override with MOCK_ISSUER_PORT). Emits a single
// authorization code per /authorize hit, then signs an id_token at /token.
// The CLIENT_ID is fixed at "design-tool-mock-client".
//
// Sample design-tool env to talk to it:
//   OIDC_ISSUER=http://localhost:4444
//   OIDC_CLIENT_ID=design-tool-mock-client
//   OIDC_REDIRECT_URI=http://localhost:3000/api/auth/callback
//   DESIGN_TOOL_SESSION_SECRET=dev-secret
//   DESIGN_TOOL_PKCE_SECRET=dev-pkce-secret
//   NEXT_PUBLIC_ALLOW_TEST_ISSUER=0     # full real-looking flow

import { createServer } from "node:http";
import { SignJWT, exportJWK, generateKeyPair } from "jose";

const PORT = Number(process.env.MOCK_ISSUER_PORT ?? 4444);
const ISSUER = process.env.MOCK_ISSUER_URL ?? `http://localhost:${PORT}`;
const CLIENT_ID = "design-tool-mock-client";

const { privateKey, publicKey } = await generateKeyPair("RS256");
const publicJwk = await exportJWK(publicKey);
publicJwk.kid = "mock-issuer-kid-1";
publicJwk.alg = "RS256";
publicJwk.use = "sig";

const codes = new Map();

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    "content-type": typeof body === "string" ? "text/html" : "application/json",
    ...headers,
  });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, ISSUER);
  if (req.method === "GET" && url.pathname === "/.well-known/openid-configuration") {
    return send(res, 200, {
      issuer: ISSUER,
      authorization_endpoint: `${ISSUER}/authorize`,
      token_endpoint: `${ISSUER}/token`,
      jwks_uri: `${ISSUER}/jwks`,
      response_types_supported: ["code"],
      id_token_signing_alg_values_supported: ["RS256"],
      code_challenge_methods_supported: ["S256"],
      subject_types_supported: ["public"],
    });
  }
  if (req.method === "GET" && url.pathname === "/jwks") {
    return send(res, 200, { keys: [publicJwk] });
  }
  if (req.method === "GET" && url.pathname === "/authorize") {
    const params = url.searchParams;
    const redirectUri = params.get("redirect_uri");
    const state = params.get("state");
    const challenge = params.get("code_challenge");
    const challengeMethod = params.get("code_challenge_method");
    const nonce = params.get("nonce");
    if (!redirectUri || !state || !challenge || challengeMethod !== "S256") {
      return send(res, 400, { error: "invalid_request" });
    }
    const code = Math.random().toString(36).slice(2);
    codes.set(code, { challenge, nonce, redirectUri });
    const redirect = new URL(redirectUri);
    redirect.searchParams.set("code", code);
    redirect.searchParams.set("state", state);
    res.writeHead(302, { location: redirect.toString() });
    return res.end();
  }
  if (req.method === "POST" && url.pathname === "/token") {
    const body = new URLSearchParams(await readBody(req));
    const code = body.get("code");
    const verifier = body.get("code_verifier");
    const grantType = body.get("grant_type");
    const clientId = body.get("client_id");
    if (grantType !== "authorization_code" || clientId !== CLIENT_ID) {
      return send(res, 400, { error: "unsupported_grant_type_or_client" });
    }
    const stored = codes.get(code ?? "");
    if (!stored || !verifier) {
      return send(res, 400, { error: "invalid_grant" });
    }
    const { createHash } = await import("node:crypto");
    const computed = createHash("sha256")
      .update(verifier)
      .digest("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    if (computed !== stored.challenge) {
      return send(res, 400, { error: "pkce_mismatch" });
    }
    codes.delete(code);

    // Slice 77: Google-shaped claims. The role comes from the email domain
    // (lib/auth/roles.ts), so this signs in as staff.
    const idToken = await new SignJWT({
      email: "mock.teacher@psd401.net",
      email_verified: true,
      hd: "psd401.net",
      nonce: stored.nonce,
    })
      .setProtectedHeader({ alg: "RS256", kid: "mock-issuer-kid-1" })
      .setIssuer(ISSUER)
      .setAudience(CLIENT_ID)
      .setSubject("mock-teacher-001")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);

    return send(res, 200, {
      id_token: idToken,
      access_token: "mock-access-token",
      token_type: "Bearer",
      expires_in: 300,
    });
  }
  send(res, 404, { error: "not_found" });
});

server.listen(PORT, () => {
  console.log(`mock-issuer listening on ${ISSUER}`);
  console.log(`  CLIENT_ID = ${CLIENT_ID}`);
});
