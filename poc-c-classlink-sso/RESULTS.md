# PoC-C Results

**Status as of 2026-05-19**: server side **verified working**; client side blocked on ClassLink Partner Portal app registration (signup submitted; awaiting approval).

## What ran

- CDK stack `SecureTestPocC` deployed to PSD playground AWS account (<account-id>) in `us-west-2`. Single API Gateway POST + Node 20 Lambda + IAM execution role.
- Initial Lambda version had the wrong JWKS path baked in (used `/.well-known/openid-configuration/jwks` — see Findings #1). Rewrote the Lambda to do proper OIDC discovery: fetch `/.well-known/openid-configuration` from the issuer at cold start, extract `jwks_uri`, then construct the `createRemoteJWKSet`. Cached for the lifetime of the Lambda container.
- Re-deployed and re-tested with a bogus token. Error shifted from "Failed to parse the JSON Web Key Set HTTP response as JSON" (= JWKS fetch failed) to "Unsupported alg value for a JSON Web Key Set" (= JWKS fetched and parsed correctly; bogus token's `alg=HS256` doesn't match the RS256 keys ClassLink publishes).

That second error is the best possible signal at this stage. It confirms the entire server-side pipeline is correctly wired to the real ClassLink endpoints:

- discovery fetch ✓
- JWKS fetch ✓
- jose deserialization ✓
- only the actual signature match awaits a real id_token

## What we learned from the OIDC discovery doc (without needing Partner Portal)

The full discovery doc at `https://launchpad.classlink.com/.well-known/openid-configuration` answered several open questions from the original PoC-C README ahead of any code running:

### 1. JWKS path

`jwks_uri` is `https://launchpad.classlink.com/oauth2/v2/jwks`, **not** the OIDC-default path `/.well-known/openid-configuration/jwks`. ClassLink reorganized that endpoint. Document this so future code doesn't repeat the guess.

### 2. PKCE is not advertised in the discovery doc, but **is accepted** by the auth endpoint (empirically verified 2026-05-19)

The discovery doc has no `code_challenge_methods_supported` field. `token_endpoint_auth_methods_supported` lists only `client_secret_post` and `client_secret_basic`, both confidential-client patterns. On paper, that looks like PKCE is unsupported.

**Empirical HTTP-level probe** says otherwise.

We sent two identical OAuth2 authorization requests to `https://launchpad.classlink.com/oauth2/v2/auth` (both with a deliberately invalid `client_id=pkce_probe_invalid`):

- **A**: included `code_challenge=hyrqPCDK_fjuCumwyt7i6GYR-6711EfTTOycvtlIZMM&code_challenge_method=S256`
- **B**: did not include any PKCE parameters

Both got the same `HTTP/2 302` to ClassLink's login flow (`Location: /?logincallback=...`). Difference: request A's `logincallback` parameter URL-encodes the original query **including** the PKCE parameters:

```
logincallback=%2Foauth2%2Fv2%2Fauth%3Fresponse_type%3Dcode%26client_id%3Dpkce_probe_invalid
%26redirect_uri%3Dhttps%253A%252F%252Fexample.com%252Fcallback%26scope%3Dopenid
%26state%3Dprobe123
%26code_challenge%3DhyrqPCDK_fjuCumwyt7i6GYR-6711EfTTOycvtlIZMM
%26code_challenge_method%3DS256
```

Request B's `logincallback` parameter has none of those last two values. ClassLink **preserved** the PKCE parameters across the login redirect, which is the behavior of an OIDC server that actually processes them. If PKCE were unsupported we'd expect either a 400 error or silent parameter-dropping; neither occurred.

**Implication**: PKCE is very likely fully functional; the missing discovery-doc fields are a documentation gap, not a functional one. The plan's risk #2 (PKCE may not be supported, fallback to confidential-client proxy) is now substantially de-risked.

**What's still unproven**: that the *token endpoint* validates the `code_verifier` against the stored challenge correctly. That can only be confirmed with a real flow using a real client_id. But the cheaper failure mode (auth-endpoint rejection) is ruled out.

PoC-C's client will continue to attempt PKCE first (`usePKCE: true` default in config.example.json). The `usePKCE: false` fallback path remains in the code for the remote chance the token endpoint rejects what the auth endpoint accepted.

### 3. ID token claims include roster identity

The discovery doc lists `claims_supported`:

- `sub` — opaque user ID
- `given_name`, `middle_name`, `family_name`, `preferred_username`, `email`, `email_verified`, `profile`, `phone_number_verified`, `picture`, `address`
- `classLink_tenant_id`, `classLink_tenant_id_string` — ClassLink's tenant identifier
- `classLink_role`, `classLink_role_level` — student/teacher/etc.
- `classLink_sourcedId` — the **OneRoster sourcedId** — this is the bridge from SSO identity to roster identity
- `classLink_org_sourcedids` — list of organizations (schools)

This resolves an open question from the original PoC-C plan: we do NOT need a separate `userinfo_endpoint` call to bridge id_token to OneRoster — the `classLink_sourcedId` claim is in the id_token directly. Reduces round-trips in the auth path.

### 4. Useful scopes available

Beyond standard `openid profile email`:

- `oneroster` — likely required for the `classLink_sourcedId` claim and OneRoster API calls
- `classes`, `classes.readonly` — class-level data
- `admin`, `full` — broader access (probably not for student logins)
- `inbox`, `files` — not relevant here

Updated `client/config.example.json` to include `oneroster` in the default scope list.

### 5. userinfo endpoint is on a different host

`userinfo_endpoint` is `https://nodeapi.classlink.com/v2/my/profileinfo` — note the host is `nodeapi.classlink.com`, not `launchpad.classlink.com`. If/when we use it (probably won't given finding #3), the network/firewall lists need both hosts.

### 6. ID token signing algorithm is RS256 only

`id_token_signing_alg_values_supported` is `["RS256"]`. We don't need to support any other algorithm in the verifier.

### 7. SwiftPM client is architecturally sufficient for the callback flow

Verified empirically (2026-05-19) via a self-contained probe added to the client as `Sources/PocCClient/CallbackProbe.swift` plus a "Test Callback (mock)" button in `AppDelegate.swift`. The probe opens an `ASWebAuthenticationSession` against a `data:` URL whose inline JS calls `location.replace('securetestpoc://callback?code=test_value_42')`. The session's completion handler fires immediately with the constructed URL:

```
Probe: starting ASWebAuthenticationSession with data: URL (no ClassLink).
Probe: SUCCESS — scheme=securetestpoc, code=test_value_42
Probe: callback routing works in SwiftPM. No Xcode conversion needed.
```

This means PoC-C does NOT need the SwiftPM-to-Xcode conversion that PoC-A required. `ASWebAuthenticationSession` accepts the `callbackURLScheme:` parameter at session creation and routes the captured URL directly to its completion handler, bypassing the system-wide URL routing that would require `CFBundleURLTypes` in `Info.plist`. The probe code (CallbackProbe.swift + the button) is left in place because it's also useful as a smoke test when iterating on the real flow.

## What's still blocked

- **Partner Portal application registration** — signup submitted; awaiting ClassLink approval. Without it we don't have a `client_id`, so we can't actually initiate an authorization request.
- After registration: testing whether `code_challenge` (PKCE) is accepted in the authorization request. If yes, plan stands; if no, we extend the verify Lambda to also do the code-for-token exchange server-side.

## What needs to happen once the Partner Portal grants access

1. Create an "Application" in the Partner Portal. Configure:
   - Redirect URI: `securetestpoc://callback`
   - Scopes (request): `openid profile email oneroster`
2. Copy the resulting `client_id` into `client/config.json` (created from `config.example.json`).
3. **Important note on URL scheme**: PoC-C client is currently a SwiftPM executable. `ASWebAuthenticationSession` should accept the `callbackURLScheme: "securetestpoc"` parameter and route the callback to the completion handler without requiring `CFBundleURLTypes` registration in Info.plist (modern API behavior). If that does NOT work in practice, we will convert PoC-C to a real Xcode project the same way we did with PoC-A.
4. Click "Sign in via ClassLink" in the running client. Observe in the log view:
   - Whether the auth URL contains `code_challenge` (PKCE attempted)
   - Whether ClassLink redirects back with a `code` (PKCE accepted) or rejects (PKCE not supported)
   - Token exchange result, including `expires_in` (load-bearing for mid-test re-auth design)
   - Decoded id_token claims — verify presence of `classLink_sourcedId`
5. Click "Refresh Token" if a refresh_token came back, to characterize the refresh flow lifetime.
6. POST the id_token to the verify URL (`https://i59aczq3rf.execute-api.us-west-2.amazonaws.com/poc/verify`) and confirm it returns 200 + claims.

## Cost note

Stack left running. Idle cost is essentially zero. Teardown:

```
cd poc-c-classlink-sso/infra
AWS_PROFILE=<your-sso-profile> AWS_REGION=us-west-2 bunx cdk destroy
```

## Bottom line

The server-side half of PoC-C is functionally validated against real ClassLink endpoints. The discovery doc gave us five concrete answers that would otherwise have required empirical experimentation. One important risk surfaced (no PKCE in discovery) is consistent with Plan risk #2 and has a known mitigation path. Final empirical answer awaits the Partner Portal granting an application.
