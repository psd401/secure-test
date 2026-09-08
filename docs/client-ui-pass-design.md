# Client UI pass — theme, accommodations rendering, branding, a11y

Design page, 2026-09-03. Batch 4 of `docs/roadmap-2026-09.md` (slice C
ships early, with batch 2's first package). Decisions marked **D-n** are
James's where dated; the rest are recommendations awaiting his call. The
student client has never had a UX or accessibility pass; both UX passes
scoped it out (`docs/ux-pass-1.md` §1, §6) while noting that "the student
client is the surface inside the rule" (DOJ Title II → WCAG 2.1 AA by
April 2027; WaTech 2.2 AA).

## What exists that this stands on

- **Zero branding.** No app icon, no asset catalog (`client/SecureTest/Resources/`
  holds one JSON fixture; the pbxproj names `AppIcon` / `AccentColor` that
  do not exist, so the generic macOS icon and system accent ship). Three
  names in play: target/Dock "SecureTest", window title "Secure Test",
  design tool "Secure-Test". `MARKETING_VERSION 1.0`, no About item, no
  version shown anywhere. The only non-system colour in AppKit is the
  peek strip's `systemIndigo`.
- **The test page is web content** (`PageShell.baseStyles` +
  `AssessmentPage.itemStyles`): ~40 literal hexes, system font stack, the
  accent `#0b5cd6`, panels `#f5f7fb` / `#d6dce8`, eyebrow ink `#3a4a6a`,
  answered / partial pips `#2e7d32` / `#b7791f` — colour-only state
  (WCAG 1.4.1). `.finish` / `.finish-status` (the "Finish and hand in"
  block) have **no CSS at all** — the same class of bug as the essay box
  fixed 2026-09-03. `color-scheme: light dark` is declared with no dark
  tokens.
- **CSP** (`PageShell.swift`): `default-src 'none'; style-src 'unsafe-inline';
  script-src 'unsafe-inline'; font-src data:; img-src data:`. Fonts and
  logos must be inlined as `data:` URIs; nothing external, nothing `'self'`.
- **Accommodations are not rendered.** `ACCOMMODATIONS` is read for one
  thing — `spellcheck` on four fields. `color_contrast` (8 values in
  `docs/accommodations-data-dictionary.md`), `optional_font`
  ("dyslexia-friendly") and `zoom` (9 levels) exist in the catalog
  (`design-tool/lib/accommodations/catalog.ts`), reach the bundle, and do
  nothing on screen; the design tool's preview toolbar shows them as inert
  buttons. `docs/accommodations.md` intended them "CSS-variable themed;
  ship all 8".
- **AppKit surface:** `AppDelegate` main window 980 × 700; `SessionEntryViewController`
  on absolute frames (a 460 × 560 block top-left in the big window; the
  row detail clamped to 250 px — the known truncation, `docs/phase-7-slices.md`);
  the sign-in sheet's native 40 px header (the one natural home for an
  emblem); titlebar accessories (lockdown status, way home); the
  session-ended `NSAlert`; notice pages with inline styles and an
  `<h1>Secure Test</h1>` as the app's only wordmark.
- **Already right, must not break:** `aria-live` on the formula preview
  and the pager label; focus to the page heading on navigation; ARIA on
  order / hotspot / table / strip; Touch Bar `nil`, context menu, Services
  and drag suppressed (`LockedDownWebView`); the Safari-shaped sign-in UA;
  the peek strip drawn in `draw(_:)` so `cacheDisplay` captures it; the
  hand-in copy contract with the teacher's "Handed in" (`docs/ux-pass-1.md`
  glossary).
- **Shareable from the design tool:** PSD tokens with computed contrast
  ratios (`design-tool/app/globals.css`, `docs/ux-pass-1.md` §tokens),
  vendored variable woff2 for Inter and Josefin Sans
  (`design-tool/app/fonts/`), two emblem PNGs in `public/brand/`, 19 logo
  PNGs in the `psd-branding` skill.
- **Testing constraint:** CSS is not harness-testable; `PageShellTests` /
  `AssessmentPageTests` can assert the emitted stylesheet text and the
  presence of variables; everything visual is a row in
  `client/MANUAL-CHECKS.md`.

## Proposed shape

### A. Theme layer (the prerequisite for everything else)

`PageShell.baseStyles` declares the page's tokens once and every rule
reads them:

```
--paper #ffffff   --ink #25424c (Pacific)   --ink-soft #3a4a6a → Pacific 70%
--line #cddadf    --line-strong #7d888d      --panel #eeebe4 (Sea Foam)  --panel-line #d7cdbe (Driftwood)
--accent #346780 (Whulge)   --accent-ink #fffaec    --ok #466857 (Cedar)   --warn #8d5d1c   --danger #a04034
--font-body Inter   --font-heading Josefin Sans   --zoom 1
```

Recommended mapping (D-A1): white paper, not the design tool's Mist —
a test page is read for long stretches and the paper should be the
quietest thing on it; Pacific ink; Whulge accent replaces `#0b5cd6`
everywhere it appears (stimulus rule, passage link, current pip); Cedar
for "answered"; the offline notice keeps its amber pair mapped to
`--warn`. Light only (D-A2), like the design tool. Fonts inlined as
`data:` from the same woff2 files, with the system stack as fallback;
`font: inherit` on controls stays. The `.finish` block gets a real
primary button (`--accent` fill) and status text; pips get an icon glyph
plus the text they already carry in `aria-label`, so state is not colour
alone. Every existing literal hex is replaced by a token — the diff is
mechanical and the emitted DOM is unchanged, so every renderer test keeps
meaning what it means.

### B. Accommodations rendering (the equity half)

- `color_contrast`: the eight named pairs become eight variable sets on
  `html[data-contrast="…"]` (Black on Rose, Black on White, Medium Gray on
  Light Gray, Red on White, Reverse Contrast, White on Red, Yellow on
  Black, Yellow on Blue — values from the data dictionary; each pair
  checked to ≥ 4.5:1 for body text, recorded in the page like
  `ux-pass-1.md` does). Panels, lines and the accent derive from the pair
  so nothing on the page stays in the default palette.
- `optional_font`: one dyslexia-friendly face inlined as `data:` and
  switched by `html[data-font="optional"]`. **D-B1 to decide:** OpenDyslexic
  (the literal reading of the catalog label, SIL OFL) vs Atkinson
  Hyperlegible (also OFL, smaller, stronger legibility evidence).
  Recommended: Atkinson Hyperlegible, with the label kept as the catalog
  says.
- `zoom`: the nine levels map to `--zoom` multipliers on the root font
  size (1.0 → 3.0 in the catalog's steps); layout is already fluid, the
  drawing canvas maps pointer coordinates at pointer time, so zoom costs
  nothing structural. Verify the pager bar and the strip wrap at 3.0.
- Applied at build from `ACCOMMODATIONS` (the effective per-student set
  the bundle already carries), no teacher-side change. The design tool's
  inert preview buttons stay inert (a later pass can make the preview
  honour the same attributes — same CSS).
- Payload note: the four inlined fonts add roughly 250–350 KB of base64
  to a page that is built once per attempt. Acceptable; if it is not,
  only the selected optional font is inlined (D-B2, recommended).

### C. AppKit branding (ships with batch 2's first package)

- An **asset catalog added by hand-editing the pbxproj** (Xcode's UI
  corrupted it before — `docs/phase-7-slices.md` "Xcode note"): `AppIcon`
  from the skill's square logo (needs a 1024 px source; `iconutil` from a
  generated iconset), `AccentColor` = Cedar.
- One name: `CFBundleDisplayName` "Secure Test" (D-C1 — James: the name
  and icon can change later, yes; the rename decision itself stays
  post-pilot per `docs/ecs-deploy-plan.md`). The window title and the
  notice pages' `<h1>` follow.
- An **About** item in the app menu (standard panel) showing version and
  build; `MARKETING_VERSION` → `1.0.0`; `CURRENT_PROJECT_VERSION` or an
  `Info.plist` key set to the git sha by a build phase — the same stamp
  the observability page puts in every error line.
- The peek strip → Whulge (drawn in `draw(_:)` exactly as now).
- The sign-in sheet header gets the white emblem at 20 px beside its
  title.

### D. AppKit layout and a11y (batch 4)

- `SessionEntryViewController` on Auto Layout: a centred column, the
  list rows full width with two lines (teacher · closes <time>), which
  closes the truncation finding; an accessibility label on the code
  field; the "Done ✓" literal becomes text plus a symbol image with a
  label.
- Notice pages (loading / bundle failed / no bundle) use the theme layer
  instead of inline styles.
- `.page-label { outline: none }` reconsidered: keep the heading focusable
  and give it a visible focus ring that meets 2.4.7 / 2.4.11 instead of
  hiding it.
- A VoiceOver pass over one full paged test as a row block.
- **Wanted after the first signed build (James, 2026-09-07):** brand the
  grey ground the app shows inside an AAC session, the home / entry screen,
  and the hand-in buttons — the PSD tokens from §A on the AppKit side too.

**Not touched:** anything in `LockedDownWebView`'s suppressions, the
sign-in UA, the CSP, the `cacheDisplay` draw path, the hand-in copy
contract, identifiers.

## Slices

1. **A — theme layer** (`PageShell.swift`, `AssessmentPage.swift`
   `itemStyles`, `KatexBundle`-style font embedding helper for the two
   woff2 files). Tests: `PageShellTests` asserts the variable block and
   that no literal hex from the old palette remains in either stylesheet;
   renderer tests unchanged and green. Rows: the page in its new clothes,
   the finish button, the pips. Size M. Opus 5 / high.
2. **B — accommodations rendering** (parallel with D) (`PageShell` attributes from
   `ACCOMMODATIONS`, the eight contrast sets, the optional font, zoom).
   Tests: attribute selection from the bundle for every value and the
   absence case; the stylesheet carries each set. Rows: one student per
   contrast pair is unrealistic — one sitting cycling the values through
   the accommodations overlay, screenshots per pair, the zoom extremes.
   Size M. Opus 5 / high.
3. **C — AppKit branding** (pbxproj + asset catalog, About, name, stamp,
   peek colour, emblem). No headless test possible beyond `xcodebuild`.
   Rows: icon in Dock and Finder, About shows version + sha, window title.
   Size S–M. Opus 5 / medium — **rides batch 2** so the first package
   carries it.
4. **D — entry screen + a11y + AppKit branding (D-D1)** (Auto Layout rewrite of
   `SessionEntryViewController`, notice pages on the theme, focus ring).
   Rows: the row shows two lines with no truncation at 980 px and at the
   window's minimum; VoiceOver reads every control; keyboard-only join.
   Size M. Opus 5 / high.
5. **E — order drag-and-drop** (D-D2): `AssessmentPage` order renderer
   gains HTML5 drag events with a drop indicator; buttons stay; tests on
   the emitted markup + the response posted after a drop (harness). Size
   M. Opus 5 / high.
6. **Rows** in `client/MANUAL-CHECKS.md` per slice; a "client a11y"
   section modelled on `docs/ux-pass-1.md` §a11y.

## Decisions

- **D-A1 palette mapping** (as written in §A) and **D-A2 light only** —
  taken as recommended for slice A (James, 2026-09-07: "begin batch 4").
- **D-B1 optional font = Atkinson Hyperlegible** (James, 2026-09-07); the
  catalog label stays "dyslexia-friendly".
- **D-B2 inline only the selected optional font** (James, 2026-09-07).
- **D-C1 display name "Secure Test" now, rename post-pilot** (James
  2026-09-03) — shipped in batch 2.
- **D-S sequencing (James, 2026-09-07):** A first; then B and D in parallel
  worktrees; then order drag-and-drop as the last slice of this batch.
- **D-D1 AppKit branding scope (James, 2026-09-07: "as proposed"):** the
  grey ground inside a session and behind the web view → Pacific; the entry
  screen gets the emblem + a Josefin heading like the sign-in header; the
  hand-in / primary AppKit buttons → Whulge fill with `--accent-ink` text.
- **D-D2 order drag-and-drop is IN this batch** (James, 2026-09-07):
  pointer drag on the order item (HTML drag events in WKWebView), a drop
  indicator, the Move up / down buttons kept as the keyboard + VoiceOver
  path, the answered mark unchanged; short design note in the slice.

## Progress

**Slice A BUILT 2026-09-07.** The theme layer is in and the page has no
literal colour left in it. `PageShell.baseStyles` opens with the `:root`
token block from §A exactly as D-A1 maps it — `--paper #ffffff`, `--ink`
Pacific, `--ink-soft` the design tool's derived Pacific-grey helper ink
(`#5a6c73`, 5.30:1 on white — the `→ Pacific 70%` in §A), `--line` /
`--line-strong` / `--panel` / `--panel-line`, `--accent` Whulge with
`--accent-ink` Skylight (5.97:1), `--ok` Cedar, `--warn` Ochre, `--danger`
Clay, `--font-body` / `--font-heading` and `--zoom: 1` — plus
`html { font-size: calc(16px * var(--zoom)) }`, which is the single lever
slice B's nine zoom levels pull, and `color-scheme: light` (D-A2; the old
`light dark` declared a dark mode with no tokens behind it). Every type size
in both stylesheets is `rem` now so that lever actually moves them.

Retired literals, collected by grepping the two stylesheets before the change
and pinned as gone by `PageShellTests`: `#0b5cd6` (accent — stimulus rule,
passage link, current pip, hotspot focus, and the three `rgba(11, 92, 214, …)`
washes), `#1c1c1e`, `#1d1d1f`, `#2e7d32` (answered), `#3a4a6a` (eyebrow),
`#555`, `#6b4a00` / `#fff4d6` / `#e6c46a` (the offline notice's amber, now
`--warn` with `color-mix` for its wash and border), `#6b6b70`, `#b7791f`
(partial), `#c00`, `#c7c7cc`, `#c9d1e0`, `#d6dce8`, `#e5e5ea`, `#f5f7fb`,
`#fff`. A second test proves the stronger property: outside the `:root`
block, neither stylesheet contains a hex at all.

Also in the slice: `.finish` / `.finish-status` finally have rules (a filled
`--accent` primary button with `--accent-ink` text and a focus ring; the
hand-in copy is untouched); the partly-answered pip gets a `…` glyph in CSS
`::after` so state is never colour alone (the answered pip already carries a
check mark in its own text, and both carry it in `aria-label`) — CSS-only, so
the emitted DOM is unchanged and every renderer test keeps its meaning; and
§D's focus item is taken here, since `.page-label` was suppressing the ring
on the very heading the pager focuses (`outline: 2px solid var(--accent)`).

Fonts ride the `KatexBundle` pattern: `client/scripts/vendor-fonts.mjs`
copies the two latin-subset variable woff2 files and their OFL licences from
`design-tool/app/fonts/` into `Resources/fonts/` with a `MANIFEST` of sizes
and SHA-256s, and `PageFonts` inlines them as `@font-face` / `data:` rules
(`font-src data:` is all the CSP allows). `PageShell.document` emits them
ahead of the tokens, so a notice page gets them too; a missing resource costs
the face and nothing else. `PageFontsTests` drift-checks the vendored bytes
against both the MANIFEST and the design tool's originals.

**Payload:** a one-item page goes **718 067 → 821 244 characters**, +103 177
(+14.4 %), all of it the two faces; built once per attempt. Recorded with the
rows.

Tests: `swift test` **387 → 402** (10 new in `PageShellTests`, 5 in
`PageFontsTests`), 0 failures; `xcodebuild` green and the built app carries
`SecureTestCore_SecureTestCore.bundle/Contents/Resources/fonts/`. One existing
test changed meaning by necessity: `AssessmentPageTests`'
"page without KaTeX" row asserted no `data:font/woff2` appeared at all, which
is now false by design — it asks about KaTeX's own families instead.

Nothing visual is verified: 16 rows + the payload note are in
`client/MANUAL-CHECKS.md` ("Client UI pass — slice A (theme)"), NOT run. Slice
B is unblocked — its contrast pairs, optional font and zoom levels are now
variable sets on the root and one `--zoom` value.
