# PoC-B Results

**Status as of 2026-05-19**: PASS. Vertical slice deployed and verified end-to-end against the PSD playground AWS account (<account-id>) in `us-west-2`.

## What ran

1. CDK stack `SecureTestPocB` deployed cleanly: 1 API Gateway, 1 Node 20 Lambda, 1 IAM execution role, 1 log group with 1-week retention.
2. Sanity POST via curl returned `{"ok":true}` and showed up in CloudWatch within ~1 second.
3. SwiftPM client (`swift run`) launched, opened a window with three multiple-choice items rendered in a sandboxed WKWebView from a bundled JSON resource.
4. Three picks via the running app POSTed cleanly to API Gateway → Lambda; all three appeared in CloudWatch with correct payloads (`test_id`, `item_id`, `choice_id`, `answered_at`).

## Measurements

- Cold start (first warm request): 19.82 ms execution after 164.66 ms init.
- Warm: 14.73 ms, then 1.89 ms.
- Memory used: 69–71 MB out of 256 MB allocated. Lambda is over-provisioned — 128 MB would be plenty.
- Response payload size: ~80 bytes per pick. Bandwidth is a non-issue at any plausible class size.
- Round-trip from button click to CloudWatch log entry: visually <1 second.

## What the PoC characterized correctly

- WKWebView + bundled JSON + JS message handler → API Gateway → Lambda → CloudWatch is a viable test-delivery loop.
- `Bundle.module` works for SwiftPM resources once the resource is placed inside the target's source directory (`Sources/PocBClient/Resources/items.json`).
- The JS bridge whitelist (single `response` message handler) successfully captured each radio selection.
- AWS API Gateway + Lambda + CloudWatch with `NodejsFunction` (esbuild-bundled, no Docker) deploys in ~50 seconds from cold.

## WKWebView sandbox-escape characterization (2026-05-19)

Added a sandbox-probe section to the test page (`TestRunner.renderHTML()`) that auto-runs JS-based sandbox checks at page load, plus performed manual GUI checks. Results below.

### Auto-probes (JS, run by the loaded page)

| Probe | Outcome | Notes |
|---|---|---|
| `window.open('https://example.com')` | **BLOCKED** | CSP `default-src 'none'` (combined with `javaScriptCanOpenWindowsAutomatically = false`) prevents this. |
| `localStorage.setItem('probe', 'x')` | **BLOCKED** | Throws `SecurityError: localStorage operation is insecure`. Root cause: `loadHTMLString` with `baseURL: nil` produces a no-origin document, which WebKit denies storage access to. Useful side effect of the chosen rendering path. |
| `document.cookie = 'probe=x'` | **BLOCKED** | Cookie not set. Same no-origin restriction as localStorage. |
| `location.assign` capability | **API EXISTS** | Capability check only; the function is defined and *would* navigate top-frame if called. **Action item for MVP**: implement `WKNavigationDelegate.webView(_:decidePolicyFor:)` to allow only the bundled inline document and reject all other URL navigation. |
| `navigator.clipboard.readText()` | **BLOCKED** | `clipboard.readText` is not defined in WKWebView for non-secure contexts. |
| `fetch('https://example.com')` | **BLOCKED** | CSP blocks the request before the network layer. |

### Manual checks (GUI, performed by operator)

**Right-click context menu**

- With no text selected: only `Reload` is shown.
- With text selected: `Look Up`, `Translate`, **`Search with Google`**, `Copy`, `Copy Link with Highlight`, **`Share…`**, `Speech ›`, **`Services ›`**.
- **Concern**: the default context menu exposes network-using and data-sharing actions (`Search with Google`, `Share…`, `Services`). These are unacceptable in a secure-testing browser. **Action item for MVP**: implement `WKUIDelegate.webView(_:contextMenuConfigurationForElement:completionHandler:)` to either disable the context menu entirely or restrict it to an explicit allowlist (probably just `Copy`/`Paste` inside input fields, nothing else).

**Drag-out of the yellow drag-target**

- **BLOCKED entirely.** No drag was possible. WKWebView's default behavior is acceptable here.

**Paste via Cmd-V into the paste-target input**

- **Cmd-V did NOT work.** No paste occurred.
- **Right-click → Paste DID work.**
- **Root cause**: this is a programmatic AppKit app with no `MainMenu.xib` / nib. There is no application Edit menu, so Cmd-V has no menu item to dispatch to. The context-menu Paste works because it's per-view, not main-menu-driven.
- **Action item for MVP**: provide a minimal programmatic `NSApplication.mainMenu` so standard shortcuts (Cmd-V, Cmd-F, Cmd-Q, Cmd-W) behave normally. Then the question shifts to "should Cmd-V be allowed?" — for accessibility (a student pasting their assistive-tech-generated text), the answer is probably yes in input fields; we can scope it that way.

**Find via Cmd-F**

- **Not available.** Same root cause as Cmd-V (no main menu).

### Implications for the MVP design

Three concrete to-do items emerged that were not previously in the plan:

1. **Implement `WKUIDelegate` to restrict the context menu.** Default exposes external services; that's a real gap.
2. **Implement `WKNavigationDelegate` to block all non-bundled navigations.** `location.href = "https://..."` is presently *capable*; the current pass is incidental (no JS in our payload tries to navigate). Defensive coding requires the explicit policy.
3. **Set a programmatic `NSApplication.mainMenu`.** Without it, standard shortcuts (Cmd-V/F/Q/W) silently no-op. This affects usability for legitimate operations (paste assistive-tech text into input) and operator (Cmd-Q to quit during diagnostics).

The CSP we have is working well at the JS-API level. The remaining hardening is at the WebKit-host level, not the CSP level.

## WKWebView hardening implementation and verification (2026-05-19)

Implemented all three MVP action items above as a reference for the eventual MVP build, and empirically verified each in a follow-up run of PoC-B.

### Implementation summary

**`LockedDownWebView` (subclass of `WKWebView`)** — three overrides:

- `rightMouseDown(with:)`: swallowed entirely; no super call, so no menu construction begins. This is necessary because `willOpenMenu` alone is **insufficient** — macOS injects Services and text-field Autofill through paths that bypass or post-date `willOpenMenu`.
- `validRequestor(forSendType:returnType:)`: returns `nil` so the view contributes nothing to Services contexts, even via keyboard-initiated Services invocations.
- `willOpenMenu(_:with:)`: kept as defense in depth — empties the menu and calls `cancelTracking()`. Won't run in practice now that `rightMouseDown` is swallowed.

`webView.allowsLinkPreview = false` also set, to suppress link-preview Touch Bar / hover behaviors.

**`TestRunner` adopts `WKNavigationDelegate`**:

- The first navigation (`about:blank` from `loadHTMLString(_, baseURL: nil)`) is allowed and a one-shot flag `initialLoadDone` is set.
- Every subsequent navigation is rejected (`decisionHandler(.cancel)`) and logged via the security-event channel.
- Note: a more precise rule (`scheme == "about" && initialLoad`) is used to avoid being tricked by a later `about:blank` navigation.

**`AppDelegate.installMainMenu()`** — programmatically constructs:

- An application menu with a single Quit item bound to Cmd-Q.
- An Edit menu with Cut / Copy / Paste / Select All, bound to standard responder-chain selectors (`NSText.cut(_:)`, etc.). No Undo/Redo (intentional — typical secure-test interactions don't need them and they expand the surface).

Security events are routed from `TestRunner` to `AppDelegate` via a `log: (String) -> Void` closure that writes to stderr with a `[security]` prefix. Visible in the terminal where `swift run` was launched.

The HTML input field also gets `autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false"` as cosmetic defense against autofill prompts.

### Verification results

Same auto-probe table as before plus four manual checks:

| Check | Result |
|---|---|
| `[security] BLOCKED navigation: https://example.com/...` logged when the "Test navigation block" button is clicked | ✅ Logged on every click (4 confirmed) |
| Right-click anywhere on plain page area | ✅ No menu appears |
| Right-click in the paste-target input field | ✅ No Autofill menu — system input-field Autofill is gone |
| Right-click on highlighted text | ✅ No Services menu — system Services injection is suppressed |
| Cmd-V into the input field | ✅ Still works — standard responder chain via the programmatic Edit menu |
| Edit menu visible in menu bar with Cut/Copy/Paste/Select All | ✅ Visible |
| Cmd-Q quits the app | ✅ Works |

All three of the previously-identified MVP gaps are now closed in PoC-B as reference implementations.

### What this does NOT cover

The hardening is responsive to the specific escape paths we observed; it is not a comprehensive lockdown. Open items deferred to MVP:

- Cmd-C (copy) is still functional. Selected text → Cmd-C → goes to system clipboard. Real assessment policy needs to decide whether to allow copy at all, and if so, whether the clipboard should be scrubbed at session end (Apple's AAC offers this via `allowsScreenshots` on macOS 26.1+ for the screenshot clipboard path, but there is no analogous flag for plain text clipboard).
- Touch-bar / function-key shortcuts that bypass the responder chain are untested.
- Drag-IN to the WebView (e.g., dropping a file onto the page) is untested. Likely allowed by default; needs an analogous WKUIDelegate-level block.
- Tab / focus traversal out of the WebView into other system UI (Mission Control, Spotlight) is governed by AAC at session level — out of scope for PoC-B's WebKit hardening.
- This is single-WebView posture; multi-instance behavior is undefined.

These are tracked as part of the broader Plan risk #1 (layered lockdown) and will be revisited at MVP / Phase 1.

## What needs to happen before MVP

- Replace the open POST endpoint with authenticated calls (session JWT after ClassLink SSO, per PoC-C).
- Persist responses (DynamoDB or Aurora — currently they're only in CloudWatch logs).
- Item schema is a placeholder; final schema should be driven by what we ingest from PSD AI Studio or whatever authoring source ends up canonical.
- Drop Lambda memory to 128 MB.
- Add idempotency keys on the client side so retries on flaky networks don't double-record answers.

## Cost note

Stack left running at end of session. Idle cost is essentially zero (no provisioned resources beyond a Lambda that costs only per invocation; API Gateway has no idle cost; CloudWatch log retention is 1 week). Teardown command if/when wanted:

```
cd poc-b-test-loop/infra
AWS_PROFILE=<your-sso-profile> AWS_REGION=us-west-2 bunx cdk destroy
```

## API URL (for re-running the client locally)

```
https://jevcfd1w54.execute-api.us-west-2.amazonaws.com/poc/responses
```

This is in the playground account; it's a stub and not secret, but no need to share more broadly than this repo.

## Bottom line

The test-delivery loop is a solved problem at PoC fidelity. Phase 1 / MVP can build on this pattern without further validation of the basic delivery mechanic. Remaining work for PoC-B is the sandbox-escape check list above.
