# Client release plan — sign, notarize, package, publish

Written 2026-09-03. Batch 2 of `docs/roadmap-2026-09.md`. The client has
never been released: no git tag, no GitHub release, no `.pkg`, no
Installomator label; development-signed only (`client/README.md`
"Signing"). This is the critical path to any student Mac and to the
batched IT afternoon.

## What exists that this stands on

- **The `psd-sign` recipe** (`~/.claude/skills/psd-sign/SKILL.md`, v0.3.0,
  outside the repo): archive Release → `codesign --deep --force --options
  runtime` with `Developer ID Application: Peninsula School District
  (<TEAM_ID>)` → zip → `notarytool submit --wait` (keychain profile
  `notarytool`) → staple → `pkgbuild` signed with the Installer identity →
  notarize + staple the pkg → `gh release create v{version}` with the
  single `.pkg`. Installomator then uses `downloadURLFromGit` /
  `versionFromGit` against `/releases/latest`: tag `v{version}`, version
  digits-and-dots equal to `CFBundleShortVersionString`, never draft or
  prerelease.
- **This app is not a generic PSD app.** It carries the restricted
  `com.apple.developer.automatic-assessment-configuration` entitlement
  (cleared by Apple 2026-08-26, App ID flipped to
  `net.psd401.securetest.client` 2026-09-03), plus sandbox,
  `network.client` and `files.user-selected.read-only` synthesized from
  build settings and merged at signing (`SecureTest.entitlements` header
  comment — verify with `codesign -d --entitlements -`). `MARKETING_VERSION
  1.0`, `GENERATE_INFOPLIST_FILE = YES` (no plist file to edit),
  `PRODUCT_NAME` "SecureTest".
- **The repo is private** (`psd401/secure-test`), and the decision of
  record is to publish a FRESH swept repository later, never to flip this
  one public (`CLAUDE.md`). Installomator downloads release assets with an
  unauthenticated `curl` — a private repo's assets are not reachable.
- **TCC keys on code identity.** PoC-A's Screen Recording grant lived on
  its bundle id + signature; the shipping client's grants are "a separate
  request once packaged" (internal — see the ops repository). Live
  monitoring rebased on in-process `cacheDisplay` (finding #14), so the
  shipping client may need **no** Screen Recording grant at all — to be
  proven on the signed build.
- `client/MANUAL-CHECKS.md` "Real AAC session (AAC-2a)" is the row block
  that proves a build can lock and unlock the Mac; it has not been run on
  the new App ID.

## Gotchas the generic recipe does not cover (each is a step below)

1. **`codesign --deep --force` without `--entitlements` strips the
   entitlements** the archive signed in — the AAC entitlement, the sandbox,
   the network client. The app would launch, sign in, and `begin()` would
   fail; lockdown silently gone. The re-sign step must pass
   `--preserve-metadata=entitlements,requirements,flags,runtime` or the
   explicit entitlements file, and step 2 verifies with `codesign -d
   --entitlements -` **before** notarizing.
2. **A restricted entitlement under Developer ID needs an embedded
   provisioning profile** (`Contents/embedded.provisionprofile`, a
   Developer ID profile for the App ID that carries the AAC capability).
   The archive must be built with that profile selected (manual signing
   for Release, or the automatic Developer ID profile if Xcode has one for
   this App ID); `codesign -d` shows it, and the real-session row proves
   it.
3. **Hardened runtime** (`--options runtime`) is fine: WKWebView's JIT
   runs in the WebContent XPC process, so no JIT entitlement is needed;
   the sandbox already governs file access. Verify the sign-in sheet still
   loads Google under the hardened build.
4. **A public home for releases.** Installomator needs an unauthenticated
   release URL. **D-R1 (James, 2026-09-03): the swept public source
   repository is that home** — development moves there
   (`docs/public-release-plan.md`, roadmap batch 2b) and the `.pkg`
   publishes there. It does not gate the first signed build: slices 1–2
   below need no GitHub at all; only slice 3 (the `gh release`) waits for
   the public repo. A releases-only repository was considered and dropped.
5. **Version scheme.** `1.0` satisfies Installomator, but three parts read
   better in a release list and in error reports: `1.0.0` (D-R2,
   recommended). The build stamp (git sha) goes in an `Info.plist` key by
   a build phase, shown in About and carried on every error line
   (`docs/observability-design.md`).
6. **Installomator label + Jamf policy are IT's** (a label fragment
   naming the releases repo, the expected Team ID, the pkg name pattern;
   a policy scoped to the test fleet) — drafted here, handed over in the
   batched afternoon, never nudged (James's rule).
7. **First install on a real student Mac** needs the Jamf scope decision
   (open question 6.4) — until then a signed `.pkg` installed by hand on
   one district Mac is the proving ground.

## Slices

1. **Project prep** (`client/SecureTest.xcodeproj`, by hand in the
   pbxproj): `MARKETING_VERSION 1.0.0`; a run-script phase writing
   `PSDBuildCommit` (git sha) into the generated Info.plist; the asset
   catalog, icon, accent, display name and About item from
   `docs/client-ui-pass-design.md` slice C; Release configuration's
   signing settings (Developer ID, the App ID's profile); confirm
   `ENABLE_APP_SANDBOX` etc. hold in Release. `xcodebuild archive` succeeds
   locally. Size S–M. Opus 5 / medium; James supplies the Developer ID
   certificate and profile in his Keychain / Xcode account.
2. **First signed build, proven** (James at the keyboard for
   `notarytool` and Keychain prompts): the recipe with the re-sign step
   corrected (gotcha 1); `codesign -d --entitlements -` shows AAC +
   sandbox + network client; `spctl -a -vv` accepts; **the real AAC session
   row block on the signed `.app`** (the Mac locks and unlocks; sign-in
   through the sheet works under the hardened runtime); observe whether
   any TCC prompt appears (Screen Recording expected: none). Record in
   `client/MANUAL-CHECKS.md` under a new "Signed build" section. Size S in
   code, an afternoon in hand-runs.
3. **`psd-sign` 0.4.0** (the skill lives outside this repo at
   `~/.claude/skills/psd-sign/`; commit it wherever PSD versions its
   skills): the re-sign step passes
   `--preserve-metadata=entitlements,requirements,flags,runtime` (or
   `--entitlements <file>` when the project has one); a mandatory
   `codesign -d --entitlements -` check before notarization that aborts
   when the archive's entitlements are not all present; a check for
   `Contents/embedded.provisionprofile` when a restricted entitlement is
   present; a release-repo input (`--repo`) so the `.pkg` can publish to a
   repository other than the source checkout's. The stripping bug is not
   specific to this app — every PSD app that carries an entitlement has
   it. Size S. Sonnet 5 / medium; James reviews, since it is PSD-wide.
4. **Release** (after `docs/public-release-plan.md` slices 1–4 have moved
   development to the public repo): the 0.4.0 recipe through `pkgbuild` →
   notarize → `gh release create v1.0.0` in the public repo; `pkgutil
   --check-signature`; install the `.pkg` by hand on one district Mac and
   repeat the lockdown row from the installed copy. `client/RELEASING.md`
   records the app-specific facts the skill cannot know (the entitlement
   list to expect, the profile, the version rule, the hand-install row).
   Size S.
5. **IT handoff drafts** (internal — see the ops repository): the Installomator label
   fragment, the Jamf policy ask (fleet scope 6.4), the PPPC statement
   ("no TCC grant required" if slice 2 proves it, else the exact grant),
   the dictation-profile ask already on the list. Drafts only, sent in the
   batched afternoon.

## Decisions

- **D-R1 (James, 2026-09-03)** releases publish to the swept public source
  repository, which becomes the development repo (roadmap batch 2b,
  `docs/public-release-plan.md`); no releases-only repo.
- **D-R5 (James, 2026-09-03)** the `psd-sign` skill itself is fixed
  (slice 3), not only documented around.
- **D-R2 (recommended)** version `1.0.0`, tag `v1.0.0`, sha in the plist.
- **D-R3 (James, 2026-09-03)** display name and icon ship in this first
  package and may change later — TCC keys on bundle id + signing identity,
  not the name.
- **D-R4 CONFIRMED 2026-09-07 (slice 2)** the shipping client needs NO TCC
  grant: a real session on the notarized build showed no prompt at launch,
  sign-in, join, lockdown or hand-in. IT's offered PPPC profile is not
  needed; say so in the handoff (slice 5).

## Progress

**Slice 1 BUILT 2026-09-03 evening** (Opus 5 / medium agent, reviewed and
re-run in the main session): `MARKETING_VERSION 1.0.0` (D-R2 taken),
`CFBundleDisplayName` "Secure Test", `Assets.xcassets` by hand (AppIcon =
the white emblem on a Pacific Big Sur tile, AccentColor = Cedar, a
`psd-emblem-white` imageset), a "Stamp build commit" run-script phase
writing `PSDBuildCommit` into the generated Info.plist (needs
`ENABLE_USER_SCRIPT_SANDBOXING = NO` on the target — build-time only,
unrelated to the app sandbox), `AppVersion.buildStamp` + an About item
showing `1.0.0 (<sha>)`, the peek strip in Whulge, the sign-in sheet
header on a Pacific ground with the emblem, and Release = Manual /
Developer ID / `PROVISIONING_PROFILE_SPECIFIER "SecureTest Developer ID"`
(a placeholder name; Debug stays Automatic). Verified: `swift test` 365,
Debug build green, entitlements all four keys, `.icns` present, package
references intact; `xcodebuild archive` fails ONLY on the missing profile
("No profile for team '<TEAM_ID>' matching 'SecureTest Developer ID'").
Nine branding rows in `client/MANUAL-CHECKS.md`, unrun. **Slice 2 waits on
James:** a Developer ID provisioning profile for
`net.psd401.securetest.client` with the AAC capability, installed locally.
**Slice 3 BUILT 2026-09-03 evening** — `~/.claude/skills/psd-sign/SKILL.md`
is 0.4.0 (outside this repo, unversioned — James decides where PSD keeps
it): step 2 keeps an archive already signed Developer ID + hardened
runtime and otherwise re-signs with
`--preserve-metadata=entitlements,requirements,flags,runtime` (or
`--entitlements <file>`), never a bare `--deep --force`; the archive's
entitlements are recorded before signing and a mandatory step 2a aborts
on any loss (and on a Debug `get-task-allow`); step 2b requires
`Contents/embedded.provisionprofile` when a `com.apple.developer.*` key
is present and prints its name / team / expiry; `--repo` for the release
repository with an unauthenticated `curl` check of `/releases/latest`.
Snippets exercised against the Debug app (list, diff, restricted grep).
Slice 4 waits for the public repository.

**Slice 2 DONE 2026-09-07** (James at the keyboard for Keychain / notarytool,
this session driving the build): IT delivered the profile 2026-09-04
(`SecureTest Developer ID`, App ID `net.psd401.securetest.client`, Developer
ID, AAC capability, `ProvisionsAllDevices`, expires 2044-08-30) plus the
note that the Developer ID Application + Installer certs issued in March
(private keys on this Mac, LessonLens signed with them, expire 2031-03-19)
are the ones to use — `find-identity` shows exactly one of each. Xcode's
double-click did NOT install the profile; copying it by UUID into
`~/Library/Developer/Xcode/UserData/Provisioning Profiles/` did. Then, with
no project change: `xcodebuild archive` (Release, generic/platform=macOS)
succeeded; `-exportArchive` with method `developer-id` / manual /
`Developer ID Application` / the profile mapped to the bundle id; the
exported app carries all four of our entitlement keys plus the profile's
identifiers, `embedded.provisionprofile`, the runtime flag, and `spctl`
accepted it; `notarytool submit --wait` (keychain profile `notarytool`, the
LessonLens one) came back Accepted; `stapler staple` worked; `spctl` now
says `source=Notarized Developer ID`. Build stamp `1.0.0 (c719eb586e45)`.
The real-session row block ran on that app against the origin
(`Chemistry sample`, demo student): `REAL AEAssessmentSession` → `DID BEGIN`
→ four responses → handed in → `DID END`, no TCC prompt anywhere (D-R4
confirmed), KaTeX sub/superscripts fine; the predictive-text check (8.4)
stays OPEN — not watched for. Rows in `client/MANUAL-CHECKS.md` "Signed
build"; five of the nine branding rows closed, four not looked at. Two
gotchas for slice 4 / `client/RELEASING.md`: `SECURE_TEST_SIMULATE_LOCKDOWN`
lives in `design-tool/.env.local` and the launcher forwards it (blank it on
the command line for a real session, and read the log's `lockdown session:`
line), and an attempt is unique per assessment + student with no delete
path (roadmap finding 2026-09-07). One archive-time warning to clear in
slice 4: no `LSApplicationCategoryType`. The export sits in the session
scratchpad only; nothing tracked changed for this slice.

**Slice 4 DONE 2026-09-07 (bar the hand-install row)**, same morning, on
the same exported app: `pkgbuild --identifier net.psd401.securetest.client
--version 1.0.0 --install-location /` signed with the Developer ID Installer
cert (`pkgutil --check-signature`: distribution cert, trusted timestamp);
the pkg notarized (Accepted) and stapled — a second submission, separate
from the app's; `gh release create v1.0.0` on the public `psd401/secure-test`
with the single asset `SecureTest-1.0.0.pkg`, target `main` (= `c719eb5`,
the commit the build stamped), one-line notes;
`/releases/latest/download/SecureTest-1.0.0.pkg` answers `HTTP/2 302`
unauthenticated, so Installomator can fetch it. The classifier blocked the
`gh release create` from the session; James ran it. `client/RELEASING.md`
written (inputs, version rule, steps, the entitlement list to check, the
`.env.local` simulate gotcha, the hand-install row). **Still open:** install
the pkg by hand on one district Mac and repeat the lockdown row from
`/Applications/SecureTest.app` (row in `client/MANUAL-CHECKS.md` "Signed
build"). Slice 5 (IT handoff drafts, ops repo) next: Installomator label
fragment, Jamf policy + fleet scope (IT asked which group), "no PPPC
needed" (D-R4), the dictation DDM is ready on IT's side.

**Slice 5 DRAFTED 2026-09-07** (internal — see the ops repository): the
reply to IT (profile worked, v1.0.0 published, no PPPC per D-R4, hold the
dictation DDM for the scope), the Installomator `securetest` label fragment
(with the blocking-process caveat: an update must never land on a locked
Mac), and the Jamf policy ask. The fleet scope is James's to name. Decision
(James, 2026-09-07): the v1.0.0 floor stays `LSMinimumSystemVersion 26.5`
(IT's DDM floor is 26.4; Macs on 26.4 update first). Batch 2 is complete
except the hand-install row on a district Mac.

**Next release = v1.1.0 (James, 2026-09-07 evening).** `v1.0.0` was built
from `c719eb5`, before batch 3's client half (errors.log, crash capture,
drain, the `client_error` event) and batch 4 (theme, accommodations,
entry screen, drag-and-drop). Order: hand-run the client rows on a Debug
build first (batch 3 "Observability slice 4", batch 4's 74 rows with the
drag-and-drop AAC gate on top); bump `MARKETING_VERSION` to `1.1.0` in one
commit; then the `client/RELEASING.md` steps (archive → export → notarize
app → pkg → notarize pkg → `gh release create v1.1.0`); hand-install on a
district Mac from that pkg closes batch 2's last row; Installomator's
`/releases/latest` picks it up.

**v1.1.0 STARTED 2026-09-08 ~15:10 PT** from `0e52d02` (the bump commit;
carries batch 3's client half, batch 4 A–E and the S-0…S-9 fixes from the
2026-09-08 sitting). Archive + export done (1.1.0, stamp `0e52d0232fb0`, all
four entitlements, profile embedded, Gatekeeper accepted); the
notarization, pkg notarization and `gh release` are James's `!` steps as for
v1.0.0. Hand-install on a district Mac from this pkg closes batch 2.

**v1.1.0 PUBLISHED 2026-09-08 ~15:20 PT** on `psd401/secure-test`
(`SecureTest-1.1.0.pkg`, app + pkg both notarized and stapled, tag on
`main` = `a10d80e` which contains the build commit `0e52d02`;
`/releases/latest/download/SecureTest-1.1.0.pkg` → 302). Installomator's
`/releases/latest` now serves 1.1.0. Still open: the hand-install row on a
district Mac (batch 2's last), and IT's fleet scope.
