export interface OidcConfig {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

const cache = new Map<string, OidcConfig>();

export async function getOidcConfig(issuer: string): Promise<OidcConfig> {
  const cached = cache.get(issuer);
  if (cached) return cached;
  const discoveryUrl = new URL("/.well-known/openid-configuration", issuer);
  const res = await fetch(discoveryUrl.toString(), { cache: "no-store" });
  if (!res.ok) {
    throw new Error(`OIDC discovery failed: ${res.status}`);
  }
  const body = (await res.json()) as Partial<OidcConfig>;
  if (
    !body.authorization_endpoint ||
    !body.token_endpoint ||
    !body.jwks_uri
  ) {
    throw new Error("OIDC discovery document missing required endpoints");
  }
  const config: OidcConfig = {
    issuer,
    authorization_endpoint: body.authorization_endpoint,
    token_endpoint: body.token_endpoint,
    jwks_uri: body.jwks_uri,
  };
  cache.set(issuer, config);
  return config;
}

// Test-only helper.
export function _clearDiscoveryCache() {
  cache.clear();
}
