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
- **Release repository**: `psd401/secure-test` (public; Installomator
  fetches `/releases/latest` unauthenticated). Tag `v<version>`, one `.pkg`
  asset named `SecureTest-<version>.pkg`.

## Version rule

`MARKETING_VERSION` in the pbxproj is the version (digits and dots only —
Installomator strips everything else). Bump it before archiving; the build
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

## Open

- No `LSApplicationCategoryType` yet (archive warning); add
  `public.app-category.education` in a later slice.
- The packaged copy's hand-install on a district Mac (slice 4's last row)
  is not done until `MANUAL-CHECKS.md` says so.
