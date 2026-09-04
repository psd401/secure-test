import {
  createLocalJWKSet,
  createRemoteJWKSet,
  jwtVerify,
  type JSONWebKeySet,
  type JWTPayload,
} from "jose";

export const GOOGLE_ISSUER = "https://accounts.google.com";

export interface VerifyIdTokenOptions {
  issuer: string;
  /** Required — see `resolveExpectedAudience`; jose skips the check if omitted.
   * A list means "any of these": the web app and the native client are two
   * OAuth clients at Google with two client ids, and both mint sessions here. */
  audience: string | string[];
  /**
   * When provided, verification uses these keys instead of OIDC discovery.
   * Intended for unit tests where we sign our own tokens.
   */
  jwks?: JSONWebKeySet;
}

const remoteJwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

async function resolveJwks(issuer: string) {
  const cached = remoteJwksCache.get(issuer);
  if (cached) return cached;
  const discoveryURL = new URL("/.well-known/openid-configuration", issuer);
  const res = await fetch(discoveryURL.toString());
  if (!res.ok) {
    throw new Error(`discovery fetch failed: ${res.status}`);
  }
  const config = (await res.json()) as { jwks_uri?: string };
  if (!config.jwks_uri) {
    throw new Error("discovery document has no jwks_uri");
  }
  const jwks = createRemoteJWKSet(new URL(config.jwks_uri));
  remoteJwksCache.set(issuer, jwks);
  return jwks;
}

/**
 * The single place the expected `aud` is resolved.
 *
 * jose SKIPS the audience check entirely when `audience` is undefined, so every
 * caller must land on a concrete value or fail closed — a route that passes
 * `process.env.OIDC_AUDIENCE || undefined` silently accepts tokens minted for
 * any other client at the same issuer.
 */
export function resolveExpectedAudience(): string | string[] | undefined {
  const raw = process.env.OIDC_AUDIENCE || process.env.OIDC_CLIENT_ID || "";
  // Slice 77: comma-separated so `OIDC_AUDIENCE` can carry both the web
  // client id (browser callback) and the native client id (client exchange).
  const list = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (list.length === 0) return undefined;
  return list.length === 1 ? list[0] : list;
}

/**
 * Slice 77: Google documents that `iss` in its id_tokens is either
 * `https://accounts.google.com` or `accounts.google.com`. Accept both forms
 * when the configured issuer is Google; every other issuer is matched
 * exactly.
 */
function acceptedIssuers(issuer: string): string | string[] {
  return issuer === GOOGLE_ISSUER ? [GOOGLE_ISSUER, "accounts.google.com"] : issuer;
}

export async function verifyIdToken(
  idToken: string,
  options: VerifyIdTokenOptions,
): Promise<JWTPayload> {
  if (
    !options.audience ||
    (Array.isArray(options.audience) && options.audience.length === 0)
  ) {
    throw new Error(
      "id_token audience check requires OIDC_AUDIENCE or OIDC_CLIENT_ID",
    );
  }
  const keySet = options.jwks
    ? createLocalJWKSet(options.jwks)
    : await resolveJwks(options.issuer);
  const { payload } = await jwtVerify(idToken, keySet, {
    issuer: acceptedIssuers(options.issuer),
    audience: options.audience,
  });
  return payload;
}
