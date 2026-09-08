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
2. **B — accommodations rendering** (`PageShell` attributes from
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
4. **D — entry screen + a11y** (Auto Layout rewrite of
   `SessionEntryViewController`, notice pages on the theme, focus ring).
   Rows: the row shows two lines with no truncation at 980 px and at the
   window's minimum; VoiceOver reads every control; keyboard-only join.
   Size M. Opus 5 / high.
5. **Rows** in `client/MANUAL-CHECKS.md` per slice; a "client a11y"
   section modelled on `docs/ux-pass-1.md` §a11y.

## Decisions

- **D-A1 palette mapping** (recommended above). **D-A2 light only**
  (recommended). **D-B1 optional font** (recommended Atkinson Hyperlegible;
  James to confirm against what teachers expect from "dyslexia-friendly").
  **D-B2 inline only the selected optional font** (recommended).
  **D-C1 display name "Secure Test" now, rename post-pilot** (James
  2026-09-03: changeable later — yes).
- **D-S sequencing:** C with batch 2; A → B → D as batch 4, with B moving
  ahead of the observability batch if a sitting with accommodated students
  is scheduled first (roadmap D-0).

## Progress

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
