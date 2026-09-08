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

### E. Order as drag-and-drop (D-D2)

Slice E design note, 2026-09-07. The 2026-09-03 sitting found the order
item answerable only through Move up / Move down (`docs/roadmap-2026-09.md`),
which reads as unfinished to a student holding a mouse or a trackpad.

- **Pointer drag on the rows.** Each `.order-row` gets `draggable="true"`
  and `dragstart` / `dragover` / `dragleave` / `drop` / `dragend`. The
  `dataTransfer` payload is the sealed entry id, `effectAllowed = "move"`,
  `dropEffect = "move"`; `dragover` calls `preventDefault()` so the row is
  a drop target at all. A touchpad is a pointer, so nothing extra.
- **Drop indicator.** No new element: the hovered row carries
  `drop-before` or `drop-after` depending on whether the pointer is in its
  top or bottom half (`clientY` against `getBoundingClientRect()`), drawn
  as a `0.125rem` inset `--accent` line, so it scales with `data-zoom`.
  The dragged row carries `dragging` (opacity `.5`).
- **One code path.** Both the buttons and a drop call `move(from, to)`,
  which splices through the pure top-level `reorderIDs(list, from, to)`
  (adjacent splice == the old swap, so the button behaviour is unchanged)
  and posts exactly one `{type: 'order', ordered_ids}` — per drop, never
  per `dragover`. The response format, the answered mark (`post()` marks)
  and every identifier are untouched.
- **Keyboard path unchanged.** The Move buttons stay and remain the
  VoiceOver path; the list gains an `aria-describedby` hint, "Drag to
  reorder, or use the Move buttons", and an `aria-live="polite"` status
  line that announces "<label> moved to position k of n" — for a button
  press as well as a drop, so the two paths announce identically.
- **Cancel.** Escape ends the drag with `dragend` and no `drop`, which
  clears the indicator and changes nothing; a drop on the row being
  dragged is likewise a no-op.
- **Risk, to be settled by hand-run:** `LockedDownWebView` calls
  `unregisterDraggedTypes()` and refuses `draggingEntered` /
  `performDragOperation`, which is aimed at drags in from other apps. On
  macOS an in-page WebKit drag is also an `NSDraggingSession` whose
  destination is the same view, so the drop may never be delivered inside
  the client even though it works in a plain WKWebView. That view is not
  changed here (hard rule); the AAC row in `client/MANUAL-CHECKS.md`
  decides it. If the drop is swallowed, the fallback is a pointer-tracking
  drag (`mousedown` / `mousemove` / `mouseup` on the list) driving the same
  `move()`, with no change to the view or the CSP.

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
- **D-B3 streamlined-only zoom levels stay clamped** to the 1.5–3.0 ramp
  (James, 2026-09-07); Streamlined Interface Mode is not built.
- **D-B4 three contrast pairs adjusted from the dictionary's literals**
  (recorded 2026-09-07): Medium Gray on Light Gray `#595959`/`#e0e0e0`
  (literal 2.63:1 → 5.31:1), Red on White `#d40000` (4.00 → 5.53), White on
  Red `#c40000` (4.00 → 6.27); names and intent unchanged.
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

Nothing built.

**Slice D BUILT 2026-09-07** (entry screen + AppKit branding + a11y, D-D1 as
proposed). New `client/SecureTest/PSDColor.swift` names the palette once for
the AppKit side — Pacific `#25424c`, ink-soft `#5a6c73`, Whulge `#346780`
(plus a pressed `#274e62`), Skylight `#fffaec`, Cedar `#466857`, Sea Foam
`#eeebe4`, Driftwood `#d7cdbe`, Mist `#f3f8fa`, paper, line, warn, danger —
and carries `PSDPrimaryButton`, a borderless Whulge/Skylight button that
still draws AppKit's own focus ring. The window's background, the assessment
container behind the web view and the entry screen's ground are Pacific, so
nothing the student sees is system grey; `contentMinSize` is 720 × 620.
`SessionEntryViewController` is rebuilt on Auto Layout: a white card capped at
520 pt, centred, with a Pacific header carrying the white emblem and "Secure
Test" (system face — the app ships no font files), and sitting rows that are
full-width and TWO lines, which closes the 250-px truncation finding. "Done ✓"
became the word "Done" plus a Cedar `checkmark.circle.fill`. Accessibility
labels on every control, a help string on the code field, each row a labelled
group. The titlebar "End secure session" and "Back to your tests" buttons take
the Whulge primary style (titles, targets, actions and Cmd-E untouched). The
notice pages are restyled through `PageShell.document(styles:)` — a new
`AssessmentViewController.noticeStyles` sheet whose colours read the slice-A
tokens with the literals as fallbacks, so it is correct before and after slice
A; the `#6b6b70` literal is gone. The peek strip and the sign-in sheet header
now read their (identical) colours from `PSDColor`. `xcodebuild` green;
`swift test` 387 pass. Everything visual is a hand-run row — see
`client/MANUAL-CHECKS.md` "Client UI pass — slice D". Not done on the AppKit
side: the session-ended `NSAlert`'s buttons cannot be restyled without
replacing the alert (copy is contract), and the notice pages' `<h1>` /
structural markup still comes from this file rather than Core.

**Slice B BUILT 2026-09-07.** The three rendering accommodations —
`color_contrast`, `optional_font`, `zoom` — are applied. They are resolved
once, in Swift, at page-build time, from the effective per-student map the
delivery bundle already carries, into attributes on `<html>`:
`data-contrast="<TIDE value>"`, `data-font="optional"`,
`data-zoom="<TIDE value>"`. The renderer script never learns any of it, which
is the point — an accommodation that changed the DOM would change what a peek
shows the teacher and what `cacheDisplay` captures, and it would have to be
re-applied on every page turn. `PageAccommodations` (new file) owns the table;
`PageShell.accommodationStyles` emits it after the token block so every rule
overrides a `:root` default. `AssessmentPage.html` reads the map out of the
bundle's own bytes by default, so neither AppKit caller changed.

The values are TIDE's own strings verbatim
(`design-tool/lib/accommodations/tide-catalog.json`), not a re-encoding. An
absent tool, an off-ish value ("Off" / "None (Default)" / blank — the same set
`lib/accommodations/effective.ts` filters on, re-checked here) or a value this
client has not heard of emits **no attribute at all**, so an unaccommodated
page is byte-identical to before apart from the always-shipped stylesheet.

**The eight contrast sets.** Each defines all twelve tokens — a set that
defined only paper and ink would leave panels, hairlines, accent and the three
state colours sitting in the PSD palette on a black or a rose ground. The
derivation is one rule applied eight times: `--ink-soft` = `--ink` (a student
who needs Yellow on Blue needs the eyebrow and the hints in it too; hierarchy
is carried by size and weight); `--panel` = ink mixed 6 % into paper,
`--line` / `--panel-line` 35 %; `--line-strong` = `--ink`, so every interactive
boundary passes 1.4.11 by construction; `--accent` = `--ink` and
`--accent-ink` = `--paper`, so the filled finish button and the current pip
invert the pair and carry their text at the body ratio.

| Set | ink on paper | body ratio | ink on panel |
|---|---|---|---|
| Black on Rose | `#000000` on `#ffd7e8` | 16.14:1 | 14.17:1 |
| Black on White | `#000000` on `#ffffff` | 21.00:1 | 18.43:1 |
| Medium Gray on Light Gray | `#595959` on `#e0e0e0` | **5.31:1** | 4.91:1 |
| Red on White | `#d40000` on `#ffffff` | **5.53:1** | 4.96:1 |
| Reverse Contrast | `#ffffff` on `#000000` | 21.00:1 | 19.17:1 |
| White on Red | `#ffffff` on `#c40000` | **6.27:1** | 5.95:1 |
| Yellow on Black | `#ffff00` on `#000000` | 19.56:1 | 17.96:1 |
| Yellow on Blue | `#ffff00` on `#0000cc` | 10.45:1 | 10.57:1 |

**Three pairs are adjusted** (bold above), keeping the pair's intent and its
TIDE name, because the literal reading fails AA: **Medium Gray on Light Gray**
as `#808080` on `#d3d3d3` is 2.63:1 — a designated support below the floor —
darkened to `#595959` on `#e0e0e0`, still unmistakably grey-on-grey and still
the lowest-contrast set of the eight, which is what the student is asking for;
**Red on White** and **White on Red** on a literal `#ff0000` are both 4.00:1,
deepened to `#d40000` and `#c40000`, both still plainly red. `--ok` / `--warn`
/ `--danger` keep green / amber / red — `#14532d` / `#6b3d09` / `#7f1d1d` on
the light grounds, `#c8fad6` / `#ffeeb3` / `#ffdada` on the dark ones — and
every one of the 48 combinations clears 4.5:1 on both the paper and the panel;
`PageAccommodationsTests` recomputes all of it from the hexes, so a future edit
cannot quietly drop a set below AA.

One slice A rule had to change for this: `.finish button:focus-visible` drew a
plain `--ink` ring, which is invisible on an `--ink` fill in every set here. It
is now a `--paper` halo hugging the button with the ink ring outside it, which
reads in all eight and in the default palette.

**Optional font (D-B1).** Atkinson Hyperlegible, SIL OFL 1.1, from the Braille
Institute — vendored from `@fontsource/atkinson-hyperlegible` **5.2.8** (that
package is what publishes the *subset* woff2 files; the upstream release ships
full ttf/otf only), latin subset, regular **and** bold, pinned by version and
by SHA-256 in the fonts `MANIFEST`. Bold matters: without it a `<strong>` in a
stem would be a synthesised bold, which is exactly the letterform ambiguity the
accommodation exists to remove. `html[data-font="optional"]` puts it in front
of the brand stack for **both** `--font-body` and `--font-heading`. D-B2 holds:
`PageFonts.assets(optionalFont:)` inlines the two faces only when the attribute
is set; every other page pays nothing.

**Zoom.** Nine `html[data-zoom="…"]` rules setting `--zoom`, which slice A
already wired to the root font size. The five ordinary levels map to the number
in their name (1 / 1.5 / 1.75 / 2.5 / 3). The four "(Streamlined Mode Only)"
levels are valid only alongside Streamlined Interface Mode, which this client
does not implement — rendering one literally would hand a student a page with
two words on it — so they ramp monotonically into the range this layout holds
(1.5 / 2 / 2.5 / 3). **D-B3 (James, 2026-09-07): keep the clamp** for the
pilot; a streamlined layout is not scheduled. Revisit if a student's overlay
carries a streamlined-only level. Layout work the
3× case needed: `body`'s gutters are `rem` (the fixed pager grew past a px
bottom gutter and hid the finish block), `.pager` is `rem` with
`max-height: 60vh; overflow-y: auto`, `.pager-row` wraps and `.pager-current`
has `min-width: 0`, and `.drawing-canvas` gets `max-width: 100%` — its pointer
mapping divides by the live `getBoundingClientRect()` width on every move, so a
CSS-scaled canvas still records in canvas coordinates (read, not changed).

**Payload:** an unaccommodated page goes **821 244 → 825 725 characters**
(+4 481, +0.5 %) — 3 028 of it the accommodation stylesheet, which ships always
so the attributes have something to match. A contrast or zoom page adds the
attribute only (+31). The optional font adds **46 677** (+5.7 %), and only for
the students who selected it.

Tests: `swift test` **402 → 424**, 0 failures (21 new in
`PageAccommodationsTests` — attribute selection for all eight contrast values,
all nine zoom levels, the optional font, the absence case, off-ish and unknown
values, the recomputed ratios, the eight sets and nine zoom rules in the
stylesheet, the `@font-face` present only when selected, and the bundle-bytes
path; 1 new in `PageFontsTests`, whose MANIFEST drift check now covers the two
Atkinson files and their licence). `xcodebuild` green.

Nothing visual is verified: 28 rows + a payload note are in
`client/MANUAL-CHECKS.md` ("Client UI pass — slice B (accommodations)"), NOT
run — one sitting cycling the values through the per-student accommodations
overlay, a screenshot per contrast pair, the optional font, zoom 1 / 2.5 / 3
with the pager and finish block, KaTeX and the drawing under both.

**Slice E BUILT 2026-09-07** (order drag-and-drop, D-D2 — the finding from the
2026-09-03 sitting). `AssessmentPage.swift` only: the order rows are
`draggable="true"` with `dragstart` / `dragover` / `dragleave` / `drop` /
`dragend`, the hovered row carries `drop-before` / `drop-after` (a `0.125rem`
inset `--accent` line, so it scales under `data-zoom`) and the dragged row
`dragging`; a drop and a Move press both call `move(from, to)` through the new
pure `reorderIDs(list, from, to)`, so one post leaves per drop and none per
`dragover`. The list gained an `aria-describedby` hint and an `aria-live`
status line that announces every move, button or drop. The Move buttons, the
`{type:'order', ordered_ids}` payload, the answered mark and every identifier
are unchanged; `.order` / `.order-row` also gained the CSS they never had.
`swift test` 401 (was 387; 14 new in `RendererOrderDragTests`), `xcodebuild`
green. NOT hand-run: "Client UI pass — slice E" in `client/MANUAL-CHECKS.md`,
whose first row is the gate on whether `LockedDownWebView` lets an in-page drag
complete at all.

Slices A–D: nothing built.

**Batch 4 slices A–E ALL BUILT and merged 2026-09-07 evening** (`9e0356e`;
swift test 438, xcodebuild green). Slice D's and E's worktrees branched
before A merged — D's notice-page CSS still carries literal fallbacks
beside the tokens (harmless; drop in a tidy-up), E's stylesheet hunk was
rebased onto the tokens in the merge. Slice 6 (rows) is next and needs
James at the keyboard: 16 (A) + 28 (B) + 18 (D) + 12 (E) rows in
`client/MANUAL-CHECKS.md`, no deploy needed (client only). The first E row
is a gate: whether an in-page drag survives `LockedDownWebView`'s
unregistered drag types could not be proven headlessly.
