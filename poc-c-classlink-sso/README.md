# PoC-C — ClassLink PKCE OIDC

> **HISTORICAL (2026-08-26).** Retired by ADR 0017: secure-test signs in with
> Google OIDC and rosters from the PSD data warehouse, and the ClassLink
> Partner Portal registration this PoC waited on is no longer sought. Kept as
> the empirical record. Two things here outlived it: the PKCE helper (ported
> into `client/SecureTestCore/Sources/SecureTestCore/PKCE.swift`, slice 80)
> and RESULTS finding #7 — `ASWebAuthenticationSession` routes a custom-scheme
> callback without `CFBundleURLTypes` — which the client relies on.

## Status

**Server side: verified working** against real ClassLink endpoints (2026-05-19). **Client side: blocked** on ClassLink Partner Portal application registration (signup submitted; awaiting approval). See [RESULTS.md](./RESULTS.md) for what was learned from the OIDC discovery doc alone — including a significant risk signal that ClassLink may not support PKCE for native apps.

## Question this answers

Can a native macOS app complete a ClassLink LaunchPad OIDC login flow **with PKCE** (no client secret on device), receive an `id_token` + `refresh_token`, and verify the token server-side against ClassLink's JWKS? What are the actual token lifetimes (matters for mid-test re-auth)?

## Pass / fail

- **Pass-1**: PKCE flow completes — `ASWebAuthenticationSession` opens ClassLink login in the system browser, callback returns to `securetestpoc://callback`, the client exchanges the code (plus `code_verifier`) for tokens at the token endpoint, and at least `id_token` + `access_token` come back. `refresh_token` is bonus.
- **Pass-2**: the stub Lambda accepts the `id_token`, verifies its signature against ClassLink's JWKS, and returns the decoded claims.
- **Pass-3**: refresh works — call `refresh_token` after the initial exchange and get a new `access_token`. Observe `expires_in` for both.
- **Fail-1**: ClassLink rejects the PKCE request (no `code_challenge` support). → confidential-client backend proxy needed; flip `usePKCE: false` and re-spike with a server-side secret.
- **Fail-2**: token lifetime is shorter than a realistic test window (say, < 60 minutes). → MVP needs silent refresh from inside the Mac app.

## Prerequisites

### 1. ClassLink Partner Portal signup (free, self-service)

- Sign up at **https://partnerportal.classlink.com/** — no district-vendor approval needed.
- Create an "Application" in the portal.
- Register the redirect URI exactly as `securetestpoc://callback`.
- Grab the **Client ID** (no secret needed — PKCE).
- (If the portal asks): scopes `openid profile email` are the PoC minimum.
- Note: sandbox endpoint for OneRoster is `https://sandbox-vn-v2.oneroster.com`. The OIDC endpoint is on `launchpad.classlink.com` — confirm exact paths from the Partner Portal app detail page.

### 2. Local config

```
cd client
cp config.example.json config.json
# edit clientId; verify other URLs match what the Partner Portal shows for your app.
```

`config.json` is in `.gitignore` — don't commit it.

### 3. URL scheme registration

A SwiftPM executable doesn't have an `Info.plist`. For the PoC, run via Xcode (`open Package.swift`) and add the URL Type in the scheme's run configuration, OR run from the command line and accept that `ASWebAuthenticationSession` may not route the callback back into a SwiftPM-bare executable. Easiest path: open in Xcode, add the URL Type via the target's Info tab → `URL Types` → identifier `com.psd.securetestpoc`, URL Schemes `securetestpoc`.

## Setup

### Deploy infra

```
cd infra
bun install
bunx cdk bootstrap   # only once per account/region
CLASSLINK_ISSUER="https://launchpad.classlink.com" bunx cdk deploy
```

Note the `VerifyUrl` from stack output.

### Run client

```
cd ../client
swift run
```

Click **Sign in via ClassLink**. The system browser opens to ClassLink LaunchPad. Log in with a Partner Portal test user. The browser redirects back to `securetestpoc://callback`, and the log view fills with:

1. The auth URL the client built (verify `code_challenge` is present).
2. The callback URL.
3. The token-exchange response: `access_token`, `id_token`, `refresh_token`, `expires_in`.
4. The decoded `id_token` claims.

Then click **Refresh Token** to verify the refresh grant works.

To verify the `id_token` server-side, POST it to the deployed `VerifyUrl`:

```
curl -X POST -H 'content-type: application/json' \
     -d '{"id_token":"<paste>"}' \
     <VerifyUrl>
```

The Lambda fetches ClassLink's JWKS, verifies signature + issuer, and returns the decoded claims.

## Teardown

```
cd infra
bunx cdk destroy
```

## What this PoC is NOT

- Not roster-aware — no OneRoster pulls yet. That's MVP work.
- Not a token-storage solution — refresh token lives in memory only. Production puts it in Keychain.
- Not a UI — buttons + log.
- Not multi-tenant — single ClassLink app, single test user.

## Open questions surfaced by this PoC

To record after the spike:

- Does ClassLink LaunchPad accept `code_challenge` + `code_challenge_method=S256`? (Yes/no determines whether MVP needs a confidential-client proxy.)
- What are the actual `expires_in` values for `access_token` and `id_token`?
- Does the refresh grant return a new `refresh_token`, or do we keep the original until it expires?
- Are there ClassLink-specific scopes (`oneroster`, `analytics`, etc.) we need beyond the standard `openid profile email`?
- Does the `id_token` include enough roster identity (user `sourcedId`, role, school) to map directly to a OneRoster pull, or do we need a separate user-info call?
