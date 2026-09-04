export interface TokenResponse {
  id_token: string;
  access_token?: string;
  token_type?: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
}

export type FetchLike = (
  input: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number; text(): Promise<string>; json(): Promise<unknown> }>;

export interface ExchangeCodeOptions {
  tokenEndpoint: string;
  code: string;
  verifier: string;
  redirectUri: string;
  clientId: string;
  /** Optional. Required by some IdPs even with PKCE. */
  clientSecret?: string;
  /** Override for tests. Defaults to the platform `fetch`. */
  fetchImpl?: FetchLike;
}

export async function exchangeCode(
  options: ExchangeCodeOptions,
): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: options.code,
    redirect_uri: options.redirectUri,
    client_id: options.clientId,
    code_verifier: options.verifier,
  });
  if (options.clientSecret) {
    body.set("client_secret", options.clientSecret);
  }
  const fetcher: FetchLike = options.fetchImpl ?? ((url, init) =>
    fetch(url, init) as unknown as ReturnType<FetchLike>);
  const res = await fetcher(options.tokenEndpoint, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body: body.toString(),
  });
  if (!res.ok) {
    let detail = "";
    try {
      detail = await res.text();
    } catch {}
    throw new Error(
      `token endpoint returned ${res.status}: ${detail.slice(0, 200)}`,
    );
  }
  const json = (await res.json()) as TokenResponse;
  if (!json.id_token) {
    throw new Error("token response missing id_token");
  }
  return json;
}
