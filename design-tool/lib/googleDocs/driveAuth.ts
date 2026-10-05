import { createHash } from "node:crypto";
import { EncryptJWT, SignJWT, jwtDecrypt, jwtVerify, type JWTPayload } from "jose";

// Row GD slice 2 (docs/google-docs-release-design.md, R-1): a teacher's
// one-hour Drive token, obtained by a Google authorization run for the
// `drive.file` scope alone and kept in an encrypted, httpOnly cookie. Nothing
// is stored in the database: no refresh token, no key to rotate, nothing to
// revoke. The next send after the hour runs the authorization again, which
// Google answers with a redirect once the teacher has consented.
//
// Finding GD-P1: `include_granted_scopes=true` folded every earlier grant from
// the teacher to this OAuth client (gmail.send among them) into the token. It
// is never sent, and the callback refuses any token whose granted scopes are
// not exactly `drive.file`.

export const DRIVE_FILE_SCOPE = "https://www.googleapis.com/auth/drive.file";
export const GOOGLE_AUTHORIZE_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
export const DRIVE_ABOUT_ENDPOINT =
  "https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)";

export const DRIVE_CALLBACK_PATH = "/api/google/drive/callback";
export const DRIVE_STATE_COOKIE_NAME = "secure-test-gdrive-pkce";
export const DRIVE_TOKEN_COOKIE_NAME = "secure-test-gdrive";
/** The send route lives under here (slice 3); the token goes nowhere else. */
export const DRIVE_TOKEN_COOKIE_PATH = "/api/assessments";

const STATE_TTL_SECONDS = 10 * 60;
const STATE_ISSUER = "secure-test/design-tool/gdrive-pkce";
const TOKEN_ISSUER = "secure-test/design-tool/gdrive-token";
/** Google's access tokens last an hour; drop the cookie a minute early. */
const TOKEN_MAX_SECONDS = 3600;
const TOKEN_SAFETY_SECONDS = 60;

/** The `?gdrive=` outcome the callback hands back to the page that asked. */
export type DriveAuthOutcome =
  | "ok"
  | "denied"
  | "expired"
  | "state_mismatch"
  | "exchange_failed"
  | "scope_mismatch"
  | "wrong_account";

function sessionSecret(): string {
  const raw = process.env.DESIGN_TOOL_SESSION_SECRET;
  if (!raw) throw new Error("DESIGN_TOOL_SESSION_SECRET is not set");
  return raw;
}

function stateKey(): Uint8Array {
  return new TextEncoder().encode(`${STATE_ISSUER}:${sessionSecret()}`);
}

/** 32 bytes for A256GCM, derived so it never equals the session's HMAC key. */
function tokenKey(): Uint8Array {
  return new Uint8Array(
    createHash("sha256").update(`${TOKEN_ISSUER}:${sessionSecret()}`).digest(),
  );
}

export function driveRedirectUri(origin: string): string {
  return new URL(DRIVE_CALLBACK_PATH, origin).toString();
}

export function buildDriveAuthorizeUrl(options: {
  clientId: string;
  redirectUri: string;
  state: string;
  challenge: string;
  loginHint: string;
}): string {
  const u = new URL(GOOGLE_AUTHORIZE_ENDPOINT);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", options.clientId);
  u.searchParams.set("redirect_uri", options.redirectUri);
  u.searchParams.set("scope", DRIVE_FILE_SCOPE);
  u.searchParams.set("access_type", "online");
  u.searchParams.set("login_hint", options.loginHint);
  u.searchParams.set("state", options.state);
  u.searchParams.set("code_challenge", options.challenge);
  u.searchParams.set("code_challenge_method", "S256");
  return u.toString();
}

// ---- state cookie (PKCE verifier + state + where to return) ---------------

export interface DriveStatePayload extends JWTPayload {
  verifier: string;
  state: string;
  /** The staff session that started the run; the callback must match it. */
  sub: string;
  next: string;
}

export async function mintDriveStateCookie(payload: DriveStatePayload): Promise<string> {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setIssuer(STATE_ISSUER)
    .setExpirationTime(`${STATE_TTL_SECONDS}s`)
    .sign(stateKey());
}

export async function verifyDriveStateCookie(token: string): Promise<DriveStatePayload> {
  const { payload } = await jwtVerify<DriveStatePayload>(token, stateKey(), {
    issuer: STATE_ISSUER,
  });
  return payload;
}

export function driveStateCookieAttributes() {
  return {
    name: DRIVE_STATE_COOKIE_NAME,
    httpOnly: true as const,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/api/google/drive",
    maxAge: STATE_TTL_SECONDS,
  };
}

// ---- token exchange + checks ----------------------------------------------

export interface DriveTokenResponse {
  access_token: string;
  expires_in: number;
  scope: string;
}

type Fetcher = typeof fetch;

/** Google's token endpoint. No id_token is expected — drive.file only. */
export async function exchangeDriveCode(
  options: {
    code: string;
    verifier: string;
    redirectUri: string;
    clientId: string;
    clientSecret: string;
  },
  fetchImpl: Fetcher = fetch,
): Promise<DriveTokenResponse> {
  const res = await fetchImpl(GOOGLE_TOKEN_ENDPOINT, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: options.code,
      code_verifier: options.verifier,
      redirect_uri: options.redirectUri,
      client_id: options.clientId,
      client_secret: options.clientSecret,
    }).toString(),
  });
  if (!res.ok) {
    throw new Error(`token endpoint returned ${res.status}`);
  }
  const json = (await res.json()) as Partial<DriveTokenResponse>;
  if (!json.access_token || typeof json.expires_in !== "number") {
    throw new Error("token response missing access_token or expires_in");
  }
  return { access_token: json.access_token, expires_in: json.expires_in, scope: json.scope ?? "" };
}

/** GD-P1: exactly drive.file — an extra scope is refused, not ignored. */
export function grantedScopeIsExactlyDriveFile(scope: string): boolean {
  const granted = scope.split(/\s+/).filter(Boolean);
  return granted.length === 1 && granted[0] === DRIVE_FILE_SCOPE;
}

/**
 * The Google account that granted the token. `login_hint` only suggests the
 * teacher's account; the consent screen lets them pick another, and a Doc
 * created through that token would land in someone else's Drive.
 */
export async function driveAccountEmail(
  accessToken: string,
  fetchImpl: Fetcher = fetch,
): Promise<string | null> {
  const res = await fetchImpl(DRIVE_ABOUT_ENDPOINT, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) return null;
  const json = (await res.json()) as { user?: { emailAddress?: string } };
  return json.user?.emailAddress ?? null;
}

export function sameEmail(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

// ---- token cookie ---------------------------------------------------------

interface DriveTokenClaims extends JWTPayload {
  at: string;
  sub: string;
}

export function driveTokenLifetimeSeconds(expiresIn: number): number {
  return Math.max(0, Math.min(expiresIn, TOKEN_MAX_SECONDS) - TOKEN_SAFETY_SECONDS);
}

export async function mintDriveTokenCookie(
  accessToken: string,
  sub: string,
  lifetimeSeconds: number,
): Promise<string> {
  return new EncryptJWT({ at: accessToken, sub } satisfies DriveTokenClaims)
    .setProtectedHeader({ alg: "dir", enc: "A256GCM" })
    .setIssuedAt()
    .setIssuer(TOKEN_ISSUER)
    .setExpirationTime(`${lifetimeSeconds}s`)
    .encrypt(tokenKey());
}

/**
 * The Drive access token for THIS staff session, or null when the cookie is
 * absent, expired, tampered with, or minted for another session's sub. Slice
 * 3's send route answers null with 401 `drive_auth_needed`.
 */
export async function readDriveToken(
  cookieValue: string | undefined,
  sub: string,
): Promise<string | null> {
  if (!cookieValue) return null;
  try {
    const { payload } = await jwtDecrypt<DriveTokenClaims>(cookieValue, tokenKey(), {
      issuer: TOKEN_ISSUER,
    });
    if (payload.sub !== sub || typeof payload.at !== "string") return null;
    return payload.at;
  } catch {
    return null;
  }
}

export function driveTokenCookieAttributes(maxAge: number) {
  return {
    name: DRIVE_TOKEN_COOKIE_NAME,
    httpOnly: true as const,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: DRIVE_TOKEN_COOKIE_PATH,
    maxAge,
  };
}

/** Reads one cookie from a raw `Cookie` header. */
export function cookieFromHeader(header: string | null, name: string): string | undefined {
  if (!header) return undefined;
  const hit = header
    .split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${name}=`));
  return hit ? decodeURIComponent(hit.slice(name.length + 1)) : undefined;
}

/** `next` with `gdrive=<outcome>` added, resolved against the app origin. */
export function returnUrl(next: string, origin: string, outcome: DriveAuthOutcome): string {
  const u = new URL(next, origin);
  u.searchParams.set("gdrive", outcome);
  return u.toString();
}
