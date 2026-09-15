# Releasing the client

The app-specific facts the `psd-sign` skill (PSD-wide, 0.4.0+) cannot know.
`docs/client-release-plan.md` is the design record; this file is the
checklist. First release: `v1.0.0`, 2026-09-07.

## Inputs

- **Bundle id** `net.psd401.securetest.client`; **pkg identifier** the same.
- **Signing**: Release configuration is Manual, `Developer ID Application`,
  hardened runtime, provisioning profile `SecureTest Developer ID`
  (Developer ID type, carries the AAC capability, expires 2044-08-30). The
  profile must be in Xcode's store: `~/Library/Developer/Xcode/UserData/
  Provisioning Profiles/<UUID>.provisionprofile`. Double-clicking the file
  did not install it on 2026-09-07 — copy it there by its UUID
  (`security cms -D -i <file> | plutil -p - | grep UUID`).
- **Identities** (login keychain, private keys on the maintainer's Mac):
  one `Developer ID Application: Peninsula School District (<TEAM_ID>)` and
  one `Developer ID Installer: …`; `security find-identity -v -p
  codesigning | grep "Developer ID Application"` must print exactly one line.
- **Notarization**: keychain profile `notarytool` (shared with LessonLens).
- **Release repository**: `psd401/secure-test` (public). Tag `v<version>`,
  one `.pkg` asset named `SecureTest-<version>.pkg`, never draft or
  prerelease.
- **How the fleet gets it (IT, 2026-09-15)**: a custom **AutoPkg** recipe
  (GitHub releases → Jamf), NOT Installomator — GitHub allows only 60
  unauthenticated API calls per hour per IP, so IT uses AutoPkg for every
  GitHub-hosted app. The pipeline auto-updates any release past 1.3.0
  (confirmed by the fleet moving to v1.3.1 on its own). The release shape
  above is what both tools key on, so it does not change; the Installomator
  label drafted in the ops repository is moot.

## Version rule

`MARKETING_VERSION` in the pbxproj is the version (digits and dots only —
the update pipeline reads it from the tag). Bump it before archiving; the build
stamps the git sha into `PSDBuildCommit`, so About shows
`<version> (<sha>)`. Tag = `v<MARKETING_VERSION>`; never reuse a tag.

## Steps

```
cd client
xcodebuild archive -project SecureTest.xcodeproj -scheme SecureTest \
  -configuration Release -destination 'generic/platform=macOS' \
  -archivePath <work>/SecureTest.xcarchive
xcodebuild -exportArchive -archivePath <work>/SecureTest.xcarchive \
  -exportOptionsPlist <work>/export.plist -exportPath <work>/export
```

`export.plist`: `method` developer-id, `signingStyle` manual,
`signingCertificate` "Developer ID Application", `teamID`, and
`provisioningProfiles` mapping the bundle id to `SecureTest Developer ID`.

Then the psd-sign recipe from its step 2a onward (the archive is already
signed; the skill must NOT re-sign with a bare `--deep --force` — that
strips the AAC entitlement): entitlement check, `notarytool submit --wait`
on a zip of the app, `stapler staple`, `pkgbuild --root <payload>
--identifier net.psd401.securetest.client --version <v> --install-location /
--sign "Developer ID Installer: …"`, notarize + staple the pkg,
`pkgutil --check-signature`, `gh release create v<v> <pkg> --repo
psd401/secure-test --title "Secure Test v<v>" --notes "<one line>"`
(`--generate-notes` is fine here since the source lives in the same repo).

## What to check on the exported app, every release

`codesign -d --entitlements :- <app>` must list ALL of:

- `com.apple.developer.automatic-assessment-configuration` = true
- `com.apple.security.app-sandbox` = true
- `com.apple.security.network.client` = true
- `com.apple.security.files.user-selected.read-only` = true
- plus the profile's `application-identifier` and `team-identifier`

`Contents/embedded.provisionprofile` present; `codesign -dvv` shows
`flags=0x10000(runtime)`; `spctl -a -vv` says `Notarized Developer ID` after
stapling; `plutil -p Contents/Info.plist | grep PSDBuildCommit` matches the
release commit.

## Release vs Debug behaviour

Security slice 2 (2026-09-15) put every development affordance behind
`BuildPosture` (`#if DEBUG`, app target only — `SecureTestCore` stays
configuration-agnostic and takes explicit parameters, because SwiftPM builds it
in debug for `swift test`). **An exported Release build therefore has none of
the following**, and a hand-run that expects one is testing the wrong binary:

- **No watchdog.** `Timings.watchdog` is nil and `SECURE_TEST_WATCHDOG_SECONDS`
  is not read. (Debug keeps the 600 s default. The watchdog counts from
  `begin()` and never resets, which ended every fleet sitting at ten minutes —
  the 2026-09-15 finding.) The teardown grace backstop is NOT the watchdog and
  is unchanged.
- **No `SECURE_TEST_SIMULATE_LOCKDOWN`.** A Release build always takes the real
  path; the knob used to be read before the entitlement.
- **No `--token` / `SECURE_TEST_TOKEN`.** Google sign-in only.
- **No `SECURE_TEST_NO_FULLSCREEN`**, **no `SECURE_TEST_DEBUG_CRASH`** menu
  item.
- **No offline bundle path.** `--bundle` is ignored and there is no File menu,
  so no File → Open Test Bundle… (Cmd-O).
- **Managed preferences outrank everything.** A profile's `ServerURL` /
  `GoogleClientID` beats `--server` and `SECURE_TEST_SERVER` (which remain the
  fallback when no profile is installed, so an unmanaged Release build is still
  configurable).
- **No entitlement means no session.** A Release build whose AAC entitlement is
  missing or stripped refuses to begin (`RefusedLockdownSession`) and shows
  "Couldn't start a secure session" — it does NOT fall back to the cooperative
  simulation a Debug build uses.

At launch the app logs `build posture: RELEASE — development overrides ignored`
on stderr. Check for it before running any Release row in `MANUAL-CHECKS.md`.

## Configuration profile

**The app is unusable without one.** It reads its server origin and its
Google client id from its own managed preferences first in a Release build
(security slice 2: a forced profile value cannot be overridden from a Terminal
launch), falling back to launch arguments and then the environment when no
profile is installed — and a Finder or Jamf launch supplies neither argument
nor environment. There is no longer a localhost fallback (v1.2.0 shipped one
and district Macs came up with a blank card, 2026-09-11); an unconfigured Mac
now shows "This Mac isn't set up for Secure Test yet."

Deploy a `com.apple.ManagedClient.preferences` profile alongside the pkg —
`client/config-profile.example.mobileconfig` is the skeleton:

| Preference domain | Key | Type | Value |
|---|---|---|---|
| `net.psd401.securetest.client` | `ServerURL` | string | the design-tool origin, e.g. `https://<origin>` |
| `net.psd401.securetest.client` | `GoogleClientID` | string | the NATIVE OAuth client id (not the web client) |

`ServerURL` must be an `http(s)` URL with a host; anything else is logged as
unusable and treated as missing. An empty or whitespace-only value counts as
unset at every level, so a blank key in a profile does not shadow the
environment.

Precedence, highest first:

1. `--server <url>` / `--google-client-id <id>` launch arguments
2. `SECURE_TEST_SERVER` / `SECURE_TEST_GOOGLE_CLIENT_ID` environment
3. the `ServerURL` / `GoogleClientID` managed preferences

The launch log names the source of each value at startup:
`config: server URL from managed preference`,
`config: google client id from environment`,
`config: server URL not configured`.

### Checking it without Jamf

```
defaults write net.psd401.securetest.client ServerURL https://<origin>
defaults write net.psd401.securetest.client GoogleClientID <native-google-client-id>
# launch /Applications/SecureTest.app from Finder, then:
defaults delete net.psd401.securetest.client
```

A profile's `Forced` payload and a local `defaults write` land in the same
place as far as the app is concerned, so this exercises the real code path.
The dev launcher (`client/scripts/launch-client.ts`) always sets the
environment variables, so development is unaffected either way.

## Hand-run before announcing

One real AAC session from the packaged copy (install the `.pkg` on a
district Mac, launch from `/Applications`, sign in, join, answer, hand in)
with the log's `lockdown session: REAL AEAssessmentSession` line, and no
TCC prompt (the client needs no Screen Recording grant — D-R4). For a dev
launch against the origin, blank the simulator variable on the command
line: `SECURE_TEST_SIMULATE_LOCKDOWN= SECURE_TEST_SERVER=<origin> bun
--env-file=design-tool/.env.local client/scripts/launch-client.ts <app>` —
`.env.local` sets it and the launcher forwards it. Record in
`client/MANUAL-CHECKS.md` under "Signed build".

## Released

- **v1.3.2 — 2026-09-15** (built from `fa39945`, tag on `main`, published
  ~11:25 PT): the end-state audit's two security slices (`ebe20ab` the
  test page exists only while the session is active — no "Stay here", a
  failed or hung begin() refuses instead of rendering; `49ac102` the dev
  watchdog is OFF in Release — v1.3.1 ended every real session at 600 s —
  and every development knob is Debug-only, no-entitlement refuses,
  managed preferences outrank arguments) plus C-8(a) Beside / Above on
  own_page sets. Archive already Developer ID + hardened runtime, six
  entitlements intact, profile embedded; app + pkg notarized and stapled
  from the session (psd-sign 0.5.0), `gh release create` by James.
  `/releases/latest` = 1.3.2, 302. The v1.3.0 profile works unchanged. The
  37 rows of the three 2026-09-15 sections in `MANUAL-CHECKS.md` are the
  hand-run on THIS build (a real session). v1.3.1's 10-minute self-end is
  the reason to move the fleet promptly.
- **v1.3.1 — 2026-09-14** (built from `48afe60`, tag on `main`): deployment
  target 26.4 (was 26.5; IT asked — see "Open" below for the evidence) and
  the T-1 time-limit banner fix. Archive already Developer ID + hardened
  runtime, six entitlements intact, profile embedded; app + pkg notarized
  and stapled from the session (psd-sign 0.5.0), `gh release create` by
  James. `/releases/latest` = 1.3.1, 302. Release notes flag that no real
  session has run on 26.4; the v1.3.0 configuration profile works unchanged.
- **v1.3.0 — 2026-09-11** (built from `c37921e`): managed-preference
  configuration (the section above), no localhost fallback, the not-set-up
  message; plus the time limit, math keypad, drawing tools and the
  multi-source follow-ups since v1.2.0. Release notes carry the "Requires
  configuration profile" block (placeholders). First release that needs the
  profile scoped alongside the pkg. **Installed through Jamf (policy +
  profile) on district Macs 2026-09-14**; the first real-student sittings
  on a Jamf-installed build ran the same day.

## Open

- No `LSApplicationCategoryType` yet (archive warning); add
  `public.app-category.education` in a later slice.
- ~~The packaged copy's hand-install on a district Mac (slice 4's last
  row).~~ DONE 2026-09-14 — v1.3.0 reached a district student Mac through
  Jamf (the pkg policy plus the configuration profile above, installed by
  IT without incident); a Finder launch showed Sign in with Google, a real
  student sat two real sessions and handed in, no TCC prompt.
  `MANUAL-CHECKS.md` "Signed build" is the record.
- ~~Next release~~ v1.3.1 (PUBLISHED 2026-09-14) carries the
  time-limit banner fix (the × froze the strip instead of hiding it —
  finding T-1, `docs/time-limit-and-unfinished-attempts-design.md`) and
  **drops the deployment target from 26.5 to 26.4** (IT asked, 2026-09-14).
  Nothing in the client needs 26.5: the highest-gated API it calls is
  `allowsAccessibilityLiveCaptions` at macOS 26.1, there are no
  `#available` checks, and the compiler enforces the floor (a 26.5+ symbol
  would fail the build). The 26.5 floor was a 2026-09-07 decision matching
  the measurement Mac (26.6.2), not a requirement. **26.4 is unverified in a
  real session** — every AAC / TCC / DNS measurement so far ran on 26.6.2
  and James has no 26.4 Mac; the release notes must say so, and IT runs one
  real session on a 26.4 district Mac before the fleet scope widens.
