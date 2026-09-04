import type { APIGatewayProxyHandlerV2 } from "aws-lambda";
import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWSHeaderParameters } from "jose";

const issuer = process.env.OIDC_ISSUER!;

// Resolve jwks_uri via OIDC discovery on cold start. This is more robust than
// guessing the path — ClassLink, for example, serves JWKS at /oauth2/v2/jwks,
// not /.well-known/openid-configuration/jwks.
let cachedJwks: ReturnType<typeof createRemoteJWKSet> | null = null;

async function getJwks() {
  if (cachedJwks) return cachedJwks;
  const discoveryURL = new URL("/.well-known/openid-configuration", issuer);
  const res = await fetch(discoveryURL.toString());
  if (!res.ok) {
    throw new Error(`discovery fetch failed: ${res.status}`);
  }
  const config = await res.json() as { jwks_uri?: string };
  if (!config.jwks_uri) {
    throw new Error("discovery document has no jwks_uri");
  }
  cachedJwks = createRemoteJWKSet(new URL(config.jwks_uri));
  return cachedJwks;
}

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  const body = event.body ? JSON.parse(event.body) : null;
  const idToken = body?.id_token as string | undefined;
  if (!idToken) {
    return json(400, { ok: false, error: "missing id_token" });
  }
  try {
    const jwks = await getJwks();
    const { payload, protectedHeader } = await jwtVerify<JWTPayload>(
      idToken,
      jwks,
      { issuer },
    );
    return json(200, {
      ok: true,
      header: protectedHeader as JWSHeaderParameters,
      claims: payload,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return json(401, { ok: false, error: message });
  }
};

function json(statusCode: number, body: unknown) {
  return {
    statusCode,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}
