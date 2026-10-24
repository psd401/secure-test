# Graphing calculator: our own, Desmos-like (roadmap row DC)

Status: DECIDED 2026-10-19 (James: D-1, D-2 (a) MathLive, D-4 (a) own
interval arithmetic, D-7 every student + per-item override honoured in
paged layout only + accommodation cases deferred, D-9 v1 as proposed);
D-3, D-5, D-6, D-8, D-10–D-12 stand as recommended unless James says
otherwise. Revised the same day after an independent three-lens review
(codebase accuracy, product gaps, external claims). Nothing built.
Branch: `graphing-calculator` (long-lived, kept off `main` so it holds up
no other work). Side: both.

## Why

A high-school teacher using Amplify Desmos Math asked for a Desmos
calculator inside SecureTest tests (row DC). Embedding Desmos itself needs
a paid API contract — self-hosting, the only shape that fits the closed
test page, is Enterprise-only — and James judged that unlikely (pursued
separately). So we explore building our own with a look and feel students
already know. James, 2026-10-19:

- Both scientific and graphing; graphing matters more, **as a tool, as an
  item stimulus, and as an answer type**.
- The calculator is both a per-test setting and an accommodation.
- **Our code stays MIT** (the convention for the district's public repos:
  open source, attribution expected when reused). Dependencies may be any
  permissive licence; no copyleft (D-1).

"Desmos-like" means the layout and interaction model students know —
expression list on the left, live math entry, a graph that pans and zooms,
sliders, tappable points of interest. It does not mean Desmos's code,
icons, fonts, colours or name: none of those are copied, and the product
never says "Desmos" in the UI (D-10).

## What the codebase gives us (survey, 2026-10-19)

- **Test page.** All page JS/CSS are Swift string literals in
  `AssessmentPage.swift` (`rendererScript`, `itemStyles`), spliced with
  `\#(name)`; CSP `default-src 'none'` — inline script/style only, fonts
  and images only as `data:`, **no `unsafe-eval`**, no network
  (`PageShell.swift:31`). No calculator, notepad or line reader exists.
  Neither the build (`packages/renderer/scripts/build.ts:39`) nor the v2.0
  shell (`RendererLoader.swift:207`) accepts a `renderer.js` containing
  `</`.
- **Served renderer (v2.0, merged).** `packages/renderer` extracts
  `renderer.js` / `renderer.css` from those literals (bridge mode, byte-
  checked by `check-extraction.sh`); signed, 16 MB per-file cap, today
  ~330 KB. The extractor reads only `CLIENT_SOURCES`
  (`AssessmentPage.swift` + `AssessmentPageRichText.swift`,
  `extract-swift.ts:209`). The served renderer carries only
  `renderer.js` / `renderer.css` — a shell resource (like `katex.min.js`)
  never reaches it. KaTeX still ships in the shell until renderer slice 5.
  New bridge terms (`requires`) need a shell release; the shell already
  accepts `response.generic` (256 KB, depth 8), though `BRIDGE_REQUIRES`
  does not list it yet (`requires.ts:44`).
- **Generated-literal precedent.** `client/scripts/vendor-katex.mjs`
  turns `macros.ts` into `GeneratedKatexMacros.swift` (reaching the page
  through the shell); D-3 extends the idea to a literal the extractor
  reads.
- **Version gate.** The delivery route refuses old clients only by item
  type (`requiredClientUpgrade(…, items.map(i => i.type))`,
  `delivery/route.ts:137`; `MIN_CLIENT_VERSION_FOR_TYPE`,
  `clientSupport.ts:10`). A new setting or field on an existing type is
  silently ignored by a v1.x page unless gated separately.
- **Schemas.** Ten item types; `drawing_upload` is a hand-scored PNG and
  its schema comment already names "plotted points and auto-scoring" as the
  deferred graphing suite. Teacher vs student wire formats stay separate
  (ADR 0016): keys never enter `DeliveryBundleSchema`. Delivery item
  schemas are plain `z.object` and `mapItemForDelivery` is a per-type
  whitelist, so any field not added to both is stripped without error.
- **Settings and accommodations.** Per-test settings are `assessments`
  columns (`allow_clipboard`, `allow_highlighting`, …); `allow_highlighting`
  rides `ItemBundleSchema` so export / import / Duplicate carry it. The
  effective accommodation map reaches the page as `BUNDLE.accommodations`.
  `desmos_calculator` (label "Desmos Calculator", universal, T2) is our
  catalog id for the OSPI universal tool — TIDE does not track it and the
  importer never writes it — and is not in `VISIBLE_IDS`.
  `calculator_non_calc_items` ("Calculator on non-calc items") is a
  separate accommodation (`catalog.ts:109`).
- **Math scoring today** is string folding + numeric tolerance
  (`lib/scoring/auto.ts`); no algebraic equivalence.
- **Tests.** Page JS runs headless in the JSC harness
  (`RendererHarness.swift`), which evaluates all of `rendererScript` and
  fails every suite on any exception. DOM shim only — no `navigator`,
  `HTMLElement`, `customElements`; canvas is an op recorder with no
  `scale`/`setTransform`/`arc`/`setLineDash`/`fillText`/`save`/`restore`.
  No layout, no pixels. Design tool and packages use `bun test`.
- **Licence notice.** KaTeX's MIT notice now ships in the app bundle
  (`fe15517` on `main`); that route does not reach a served renderer
  (D-3).

## Decisions

**D-1 Licence rule. DECIDED (James, 2026-10-19).** Our code is MIT. A
runtime dependency in a shipped bundle may carry any **permissive**
licence — MIT, ISC, BSD-2/3, 0BSD, BSL-1.0, Apache-2.0 (Apache: ship its
NOTICE, mark changed files) — or a dual licence where we elect a
permissive option and record it. **No copyleft of any strength**: MPL,
LGPL, GPL, AGPL are out, because they would ask more of anyone reusing
our work than attribution. Every dependency's licence/notice text ships
with the bundle; dev-only tooling is exempt. Checked 2026-10-19 (npm
registry + repo LICENSE files):

| Candidate | Licence | Verdict |
|---|---|---|
| KaTeX | MIT | in use |
| MathLive (math input + virtual keyboard) | MIT, no deps since 0.111.0 | chosen (D-2) |
| Cortex Compute Engine | MIT | too big (4.4 MB min); `compile()` uses `new Function` (blocked by our CSP) |
| math.js | Apache-2.0 | allowed, not useful: its own syntax, not the LaTeX math input emits, and none of the Desmos grammar (implicit multiplication, user functions); CSP fit unverified |
| interval-arithmetic | BSL-1.0 | allowed; not chosen (D-4) |
| function-plot | MIT; deps d3-* = ISC, built-in-math-eval / interval-arithmetic-eval = MIT, interval-arithmetic = BSL-1.0 | excluded: its `math-codegen` dep compiles with `new Function` (CSP) |
| nerdamer | Apache-2.0 | allowed, not needed (CAS) |
| speech-rule-engine | Apache-2.0 | allowed; later candidate for Nemeth (D-11); size and CSP unverified |
| MathQuill (what Desmos uses) | MPL-2.0 | excluded (copyleft) |
| JSXGraph | MIT OR LGPL-3.0 | elect MIT if ever used; not needed |
| liblouis (braille) | LGPL-2.1+ (C library) / GPL-3.0 (npm) | excluded (copyleft) |

**D-2 Math input. DECIDED (James, 2026-10-19): (a) MathLive.**
- (a) **Decided — MathLive**, pinned to **0.111.1** (≥ 0.111.0 for zero
  dependencies). MIT, Desmos-style live 2D entry (`/` stacks a fraction,
  `^` raises, `sqrt` → √) plus a virtual keyboard and screen-reader speech.
  844 KB min / 228 KB gz. No `eval` / `new Function`. Under our CSP:
  - Fonts: it skips loading when the KaTeX families are already in
    `document.fonts` (our inlined `data:` faces); also set
    `fontsDirectory = null`.
  - Sound: `soundsDirectory = null` stops audio output, but `playSound()`
    still creates an `AudioContext` first — also set
    `keypressSound = null`, `plonkSound = null` and replace
    `MathfieldElement.playSound` with a no-op. Slice 3 checks no
    `AudioContext` is created.
  - Unverified until slice 3: constructable stylesheets under CSP in
    WKWebView, VoiceOver behaviour, keyboard inside an AAC session.
  - Risk accepted: a 0.x, essentially single-maintainer project (~monthly
    releases; 0.111.0 had breaking changes). Upgrades are a deliberate
    slice that re-runs the slice-3 checks; fallback is (c).
- (b) Our own structural editor on KaTeX output — fully ours, but a
  large, fiddly build (cursor model, selection, accessibility).
- (c) The lighter typed notation from `docs/math-entry-design.md` with a
  KaTeX preview — cheapest, least Desmos-like.

**D-3 Where the code lives and how it reaches the page.** Recommended:
- A new workspace package `packages/graphing` (TypeScript, MIT header, no
  runtime deps) holds the engine. The design tool imports it (preview,
  authoring, scoring) and `bun test` runs it — one evaluator for the
  student's screen and the server's score.
- Plumbing: `packages/graphing/package.json` joins the Dockerfile's
  per-package manifest `COPY`s (the frozen install refuses otherwise); a
  "Graphing — build + test" CI step runs before the design-tool
  typecheck; consumers use its `dist` (as with `packages/schema`).
- A generator builds one plain-JS file each for the engine and for
  MathLive and writes them as Swift raw literals in a generated file
  **added to `CLIENT_SOURCES`**, spliced into `rendererScript`, so
  `check-extraction.sh` and signing cover them unchanged. The generator:
  - picks a raw-string hash count whose delimiters do not occur in the
    content (MathLive 0.111.1 contains `\#` and `"""`, so `##"""`;
    checked: the extractor reproduces an 844 KB `##` literal byte for
    byte, and `swiftc` compiles it in ~1.2 s);
  - rewrites every `</` to `<\/` (valid in JS strings, templates, regexes
    and comments; MathLive has 250) and asserts none is left;
  - prepends each bundle's full licence notice as a comment (MathLive's
    MIT text; our MIT header), so the notice travels inside
    `renderer.js`; a build test asserts each is present;
  - refuses CR and tab indentation (extractor rules).
- **MathLive runs lazily.** Its top level needs `navigator` and
  `HTMLElement`, which the JSC harness lacks, and evaluating it eagerly
  would break every renderer suite. The literal is wrapped in a factory
  the page calls only when a calculator or math field first opens. The
  harness gets minimal `HTMLElement` / `customElements` stubs so the
  factory can be referenced; MathLive itself is tested by hand rows only.
- A shell resource is not used: it would not reach the served renderer
  and every MathLive update would need a shell release.

**D-4 Engine — build our own. DECIDED (James, 2026-10-19).** All MIT, all
pure functions testable in `bun test` and the JSC harness:
- Parser for the LaTeX MathLive emits: numbers, variables, `\frac`, `^`,
  `\sqrt`, `|x|` / `\vert`, `\left( \right)` / `\mleft \mright`,
  `\operatorname{…}`, `\placeholder{}`, `\exponentialE`, `\lbrace`,
  trig/log/ln, `\pi`, function definitions and calls, points `(a,b)`,
  lists, relations `= < > ≤ ≥`, restrictions `{x>0}`, implicit
  multiplication (`2x`, `2(x+1)`, `2\sin x`; `f(x)` is a call only when `f`
  is defined). The grammar is fixed against a **corpus of real MathLive
  `getValue()` output** captured in the slice-2 playground (pinned
  version), with MathLive options (`smartFence`, `letterShapeStyle`, …)
  set to keep output in the subset.
- Evaluator compiled to nested closures (no `new Function`), real and
  interval modes; dependency graph with cycle detection; free variables
  become slider candidates.
- Explicit curves: adaptive sampling with discontinuity detection.
- Implicit equations and inequalities: quadtree + **our own interval
  arithmetic** over our AST + marching squares (decided; the Compute
  Engine module and `interval-arithmetic` would each need an adapter).
- Points of interest: intercepts, extrema, pairwise intersections.

**D-5 Rendering.** Recommended:
- Canvas 2D for curves, grid and fills (cache the bitmap during a drag,
  re-sample on gesture end), with a **parallel DOM layer** for everything
  a screen reader or keyboard must reach — focusable points, the trace
  cursor, a live region, the graph's text description. VoiceOver cannot
  read canvas pixels.
- **Accommodations reach the canvas explicitly.** Contrast and zoom act
  only through CSS tokens and the root font size
  (`PageAccommodations.swift`, `PageShell.swift:101`); canvas paint ignores
  both. Canvas colours are read from the page tokens (`getComputedStyle`
  on the ink / paper / line / accent tokens) at draw time; panel and
  canvas are sized in `rem`; the backing store is sized from
  `getBoundingClientRect() × devicePixelRatio` and re-sized on
  magnification change.
- The same engine emits **SVG** server-side for the design tool's
  no-script preview and for print (stimulus graphs, answer review). Every
  inline SVG gets `role="img"` and an accessible name; icon-only buttons
  carry the label on the button with `aria-hidden` on the SVG (WebKit bugs
  187695 / 240656).

**D-6 Calculator modes, configuration, placement.** Recommended:
- Three calculators on one engine: four-function, scientific, graphing.
- Configuration as our own named flags (keypad layout, degree/radian
  default, disabled function groups, implicit and single-variable-implicit
  plotting on/off, decimal↔fraction on/off, folders/notes/images off),
  with two presets:
  - **"State test (WA)"**, from the Desmos Washington (WCAP) configuration
    sheet, SY2026-27, checked 2026-10-19 (re-issued yearly — re-check):
    - Graphing (sheet: Grade 11 Math; OSPI paper policy: HS): degrees by
      default; alphabetical keypad; no images / folders / notes / actions
      / recursion; no decimal↔fraction; no single-variable implicit
      equations; disabled: reciprocal and hyperbolic trig,
      distance / midpoint, `mad` / `cov` / `covp`, histogram / dotplot /
      boxplot, distributions, `random`, inference.
    - Scientific (Gr 7–8 Math, Gr 8 / HS Science): no function
      definitions, no decimal↔fraction, alphabetical keypad.
    - Four-function (Gr 6 Math, Gr 5 Science): a fraction key in place of
      √ (OSPI paper policy says √ and % — unverified which is current).
      **Revised 2026-10-24 (James):** both keypads are laid out like the
      Desmos WA ones — four-function `↶ ↷ clear ⌫ / ( ) a/b ÷ / 7 8 9 × /
      4 5 6 − / 1 2 3 + / 0 . ans ↵` (√ in the fraction's place on "Full"),
      scientific `a² aᵇ |a| 7 8 9 ÷ % a/b / √ ⁿ√ π 4 5 6 × ← → / sin cos
      tan 1 2 3 − ⌫ / ( ) , 0 . ans + ↵`; `ans` is the nearest value above.
      The sheet (re-checked 2026-10-24, SY2026-27) changes only the √ key.
  - **"Full"** for classroom-style tests.
- Grade bands are a teacher choice, not enforced.
- **Placement:** a movable, resizable overlay drawer above the pager
  (z-index above the pager's 2); it never reflows the item columns (the
  `side_by_side` threshold is read once at build), and the time-limit
  strip and pager stay visible.
- **State:** page memory only in v1 — kept across page turns, lost on
  relaunch or resume. No bridge term.

**D-7 Per-test setting + accommodation. DECIDED (James, 2026-10-19):**
- **Test setting:** `calculator` on `assessments` = none / four-function /
  scientific / graphing (+ preset). Default none. **When set, every student
  gets it** (the SBAC universal-tool model).
  - Wire: rides `ItemBundleSchema` as an optional field emitted only when
    not none (the `allow_highlighting` pattern), so export, import and
    Duplicate carry it; reaches the page in `DeliveryBundleSchema`.
  - Migration: `assessments.calculator text NOT NULL DEFAULT 'none'` with a
    check constraint (the `student_layout` precedent). Numbered and
    generated **only in the slice that merges**, right after a rebase —
    never kept on the branch across rebases (`main` already carries
    undeployed 0060 / 0061). Deploy follows the after-15:30 PT /
    `--during-school` rule.
  - **Gate:** a bundle with a calculator is refused (409) below client
    `2.0.0` — a feature-level check beside `requiredClientUpgrade`, not a
    silent drop like highlighting. The calculator is construct-relevant.
- **Per-item "no calculator on this item" override — in v1, honoured in
  paged layout only.** In paged layout the drawer hides on any page that
  holds a no-calculator item (a page mixing both counts as no-calculator).
  In scrolling layout it is not honoured, and the editor warns when a test
  has the override but is not paged. This is per-page hiding, **not**
  SBAC-style session segmentation: students can page back freely.
  - Wire: `no_calculator?: true` in the item's config in `ItemSchema`, and
    in each delivery item schema plus every `mapItemForDelivery` branch;
    a test proves the field survives `DeliveryBundleSchema.parse`.
- **Accommodation:** `desmos_calculator` (identifier kept; teacher label
  becomes "Calculator" in slice 5 — ids are stable, labels are not). With
  every student getting the test's calculator, the accommodation **has
  no v1 effect**, so it stays out of `VISIBLE_IDS` until a deferred case
  gives it one.
- **Deferred:** what the accommodation grants when the test has no
  calculator; whether `calculator_non_calc_items` keeps the calculator on
  no-calculator items.

**D-8 Graph as stimulus.** Recommended: the item or item set may carry a
teacher-authored graph — an expression list + viewport, rendered
read-only — with **required alt text**, drafted automatically from the
expressions and points of interest. Content, not a key: it lives in both
bundles.
- Wire: named placement on `TeacherItemSetSchema` / `DeliveryItemSetSchema`
  or the item config, added to every mapper branch, with a survives-parse
  test (as D-7).
- Gate: a bundle carrying a graph stimulus is refused below `2.0.0` (as
  D-7).

**D-9 Graph as answer — a new item type `graph`. DECIDED (James,
2026-10-19): v1 tools and scoring modes as below.** Drawn from public
docs for Pearson TestNav, Möbius and WeBWorK, Learnosity (search
summaries only — docs blocked), and SBAC/CAI (inferred from public
practice material; their rules are not published):
- Students place objects with tools, each defined by snapped points in
  click order: point, line, segment, ray, circle (centre + point),
  parabola (vertex + point, vertical axis). Click-in-order placement meets
  WCAG 2.5.7; typed coordinates `(x, y)` are an equal alternative for
  keyboard users (2.1.1).
- Teacher config: board extent, grid, snap (rational), allowed tools,
  max objects, optional fixed objects. The key is drawn on the same board.
- Scoring: canonicalise each object with **exact rational arithmetic**
  (line → reduced `ax+by=c`, circle → centre + r², …), dedupe, compare as
  multisets. `all` (default, all-or-nothing) or `per_object`
  (matched ÷ key; more objects than the key → 0). Snap replaces
  tolerance. The scorer lives in `packages/graphing` and is called from
  `lib/scoring/auto.ts` `scoreResponse`.
- **Text readback** ("y = 2x + 1", "circle centre (1, 2), r = 3") is a pure
  function in `packages/graphing`, used by the editor, `buildFeedback`
  (`correctAnswerText` / response text — otherwise `hasAutoKey` reports the
  item keyless), `answerView` (per-object ✓/✗) and the work packet. The
  SVG is for print and review pages only; the client feedback page stays
  text.
- Wire: key only in `ItemBundleSchema`; `DeliveryBundleSchema` carries
  board + tools. `GraphResponseSchema` joins `ItemResponseSchema` in
  `packages/schema` (`bun run build` there) — shape like
  `{type, objects: [{tool, points: [[x, y], …]}]}`, depth ≤ 5 of 8, numbers
  not strings, objects ≤ max objects; a test proves the largest response
  passes both zod and the client's bridge limits. The page posts it via
  `response.generic`, added to `BRIDGE_REQUIRES` in this slice (with the
  `extract.test.ts` drift test). The page restores it from saved
  responses on resume and after offline spool replay.
  `MIN_CLIENT_VERSION_FOR_TYPE.graph = "2.0.0"`. No migration (`items.type`
  is free text).
- v1 limits: not in answer revision history; not offered by AI
  generation (`batchForm` list), PDF import or CSV import; Bedrock
  prompts unchanged.
- Touch points: use the `fill_blank` footprint (32 design-tool / schema
  files — readiness, review queue, results, work packet, CSV import,
  integrity, evidence pack, safeguarding text, preview, export / import
  `assertNever`s, …) as slice 7's checklist.
- Later: inequality regions, sine/exponential/absolute value, polygons,
  open/closed endpoints, "graph this expression" scored by sampled
  equivalence. QTI export: points-only maps to
  `qti-select-point-interaction` (QTI 3.0); the rest is lossy.

**D-10 Naming.** Recommended: product UI says "Calculator" / "Graphing
calculator" (`PRODUCT_NAME` conventions apply); "Desmos" appears only in
the catalog id and in docs that describe the request. We are not
presenting this as Desmos.

**D-11 Accessibility baseline (v1, not later).** Recommended:
- Keyboard: full operation with an Esc exit from the graph (2.1.1,
  2.1.2); typed-coordinate equivalents for every placement.
- Pointer: on-screen zoom in / out / reset and pan buttons for the graph
  and every stimulus, and a tap-to-step alternative for sliders (2.5.7
  dragging; 2.5.1 — pinch is a multipoint gesture).
- 24 px targets (2.5.8); focus ring on the focused point (2.4.7); 3:1
  contrast (1.4.11) and non-colour curve encoding by dash or label
  (1.4.1); required stimulus alt text (1.1.1); live-region announcements
  (4.1.3). The 2D graph itself falls under 1.4.10 Reflow's
  two-dimensional exception; the expression list and toolbar must reflow.
- A VoiceOver row per feature in `client/MANUAL-CHECKS.md` (run per the
  VoiceOver method: James, Claude quit).
- Later: audio trace / sonification (Web Audio), spoken graph summary,
  Nemeth (candidate: speech-rule-engine, Apache-2.0; MathLive has a
  `textToSpeechRules` hook), UEB (no permissive library found),
  embossing export.

**D-12 Branch.** `graphing-calculator` stays off `main`, rebased on
`main` periodically; it merges only when a slice is shippable and James
says so. No migration lives on the branch across a rebase (D-7). Nothing
reaches students before a merge, and every student-facing piece is
behind a default-off setting and a `2.0.0` refusal.

## Slices

| # | Slice | Proves | Test |
|---|---|---|---|
| 0 | This note | decisions | independent review (done) |
| 1 | `packages/graphing` engine: parser, closure evaluator, dependency/slider pass, adaptive sampler, points of interest; package plumbing (Dockerfile, CI, dist) | the maths | `bun test` |
| 2 | Playground: local page (expression list + canvas graph + MathLive); MathLive output corpus captured for the parser; look-and-feel review | it feels right | James by hand; corpus tests |
| 3 | Spike in the client (Debug, simulated lockdown): the generator (`</` rewrite, hash count, notices), lazy MathLive, engine + canvas under the real CSP; fonts, keyboard, no `AudioContext`, VoiceOver | it runs in the page and passes the guards | JSC harness (engine, glue, guards) + hand rows |
| 4 | Implicit curves + inequality shading (interval + quadtree) | D-4 | `bun test` |
| 5 | Calculator drawer in tests: setting + migration (at merge), presets, four-function / scientific / graphing, per-item override (paged), 2.0.0 refusal, export / import / Duplicate, contrast and zoom | the tool ships | design-tool tests (incl. Duplicate, survives-parse), JSC (harness canvas recorder extended: `scale`, `setTransform`, `arc`, `setLineDash`, `fillText`, `save` / `restore`), hand rows (`side_by_side` + drawer, paged at zoom 3X, each contrast set, peek) |
| 6 | Graph stimulus: authoring, SVG preview / print, alt text, 2.0.0 refusal | stimuli | design-tool tests + hand rows |
| 7 | `graph` answer type: tools, typed entry, canonical scoring, readback, key authoring, review, `BRIDGE_REQUIRES` | answers | `bun test` (scorer, readback, response caps), JSC, hand rows |
| 8 | Accessibility extras: audio trace, graph summary | parity | hand rows |

Slices 1–2 touch no shipping code. The first slice that touches the
client is 3 (a Debug-only spike).

## Not verified (carry into slices)

- MathLive's constructable stylesheets under our CSP in WKWebView;
  MathLive + VoiceOver; MathLive after the `</` rewrite; Web Audio inside
  an AAC session (slice 8 constructs the context under the CSP; no sound
  has been heard in the page yet).
- Canvas performance at retina in WKWebView.
- **The teacher's on-demand peek (`cacheDisplay`) shows the drawer and the
  graph canvas**, including inside a real AAC session — no hand row has
  ever covered a canvas in peek. Fallback if blank: the peek shows the
  expression list only.
- The Washington four-function configuration — settled 2026-10-24: the
  Desmos WA layout (fraction key instead of √). OSPI's paper policy (√ and
  %) covers paper tests only.
- SBAC/CAI toolbar and scoring rules for graphing items (not public).

## Sources

- Desmos API docs v1.11 and API plans (row DC); Desmos Washington (WCAP)
  and College Board calculator configuration PDFs (desmos.com static
  assets, SY2026-27); OSPI calculator policy;
  calculators.smarterbalanced.org.
- Pearson TestNav graphing interaction docs; IMS QTI 3.0 implementation
  guide; TAO line & point interaction; Möbius sketch question docs;
  WeBWorK GraphTool docs (ideas only — no code); Learnosity graphplotting
  (search summaries only).
- W3C WCAG 2.2 Understanding pages (2.5.7 dragging, 1.4.10 reflow);
  Illinois CITL review of Desmos accessibility; WebKit bugs 187695,
  240656.
- npm registry metadata and repository LICENSE files for every package in
  the D-1 table; the mathlive 0.111.1 tarball (inspected, not run in the
  page) for the `</`, `AudioContext`, `HTMLElement` and serializer facts.

## Questions for James

All answered 2026-10-19: MathLive; own interval arithmetic; per-item
override in v1, honoured in paged layout only; the setting gives every
student the calculator; D-9 v1 as proposed; KaTeX licence notice fixed on
`main` (`fe15517`).

## Deferred

- D-7: what the calculator accommodation grants when the test has no
  calculator (candidate: the scientific calculator) — until then it has
  no effect and stays hidden.
- D-7: whether `calculator_non_calc_items` keeps the calculator on
  no-calculator items.

## Progress

- 2026-10-19 — slice 0 drafted on `graphing-calculator`; D-1 decided
  (permissive dependencies, no copyleft); questions answered.
- 2026-10-19 — independent review (three lenses, 35 findings); the note
  revised for all of them: MathLive `</` rewrite, lazy init and in-bundle
  notice (D-3); feature-level 2.0.0 refusal (D-7, D-8); paged-only
  per-item override and every-student setting (D-7, James); wire
  placement, migration timing, export / import / Duplicate; canvas and
  accommodations, drawer placement, peek; WA preset corrected; WCAG
  2.5.7 / 2.5.1 controls; MathLive pin, sound stubs, parser corpus;
  package plumbing; slice-7 touch points.
- 2026-10-19 — slice 1 (`e2bdf1a`, fixes `5bb6400`): `packages/graphing`
  engine — parser, closure compiler, analysis, adaptive sampler, points of
  interest; an adversarial sweep (three testers) found and fixed 28 bugs.
- 2026-10-19 — slice 2 (`b41135f`): calculator UI and playground; the
  MathLive output corpus pins the parser.
- 2026-10-19 — slice 3 (`84c4930`): the calculator in the test page under
  the real CSP, checked in real WebKit with a throwaway off-screen probe.
- 2026-10-20 — slice 4 (`076e1a1`): implicit curves and inequality regions
  on our own interval arithmetic (D-4).
- 2026-10-20 — slice 5 (`30362ef`): the per-test setting, presets, the
  paged per-item override, the 2.0.0 feature refusal. **Migration 0062 is on
  this branch only — renumber it if `main` gains a migration first (D-12).**
- 2026-10-20 — slice 6 (`441a63a`): graphs as question stimuli —
  authoring, alt text, SVG preview / print, the student view.
- 2026-10-20 — slice 7 (`d3f0de7`): the `graph` answer type — tools,
  typed entry, exact-rational canonical scoring, readback in words, key
  authoring, review; `response.generic` in `BRIDGE_REQUIRES`.
- 2026-10-20 — slice 8: accessibility extras on every graph (calculator and
  stimulus). S / ≡ describes the graph in words (each curve's axis
  crossings and turning points in the current view, then the view); T
  traces the selected curve with the arrow keys (Shift jumps between
  points of interest, up / down change curve, Esc leaves); H / ♪ plays the
  curve as a three-second sweep (pitch = height, 220–880 Hz; stereo pan =
  position; silence where it is off screen or undefined). The
  `AudioContext` is made on the first sound asked for, never at load, and
  a missing or blocked Web Audio leaves the graph silent and says so. In
  real WebKit (the probe): summary, trace, point-of-interest jumps, curve
  switching and the announcements all work; the context is constructed
  under the CSP (state `suspended` without a real key press). Not run:
  hearing it, VoiceOver, a real AAC session. Still later: Nemeth, UEB,
  embossing.
- 2026-10-20 — independent review of slices 5–8 (21 confirmed findings,
  18 distinct) fixed in `1c6e1b4`; the design-tool hand rows (658–679) run
  on local dev, finding and fixing the editor build break, three editor
  defects (`b37ec83`) and raw JSON in the scoring queue (`835dc210`); CI
  gains `next build` (`8181580a`). Client rows next.
- 2026-10-24 — client hand-run 2 (real AAC; `docs/ledger.md` and
  `client/MANUAL-CHECKS.md` hold the results). Fixes after it: Esc closes
  the panel again (MathLive's Escape bindings dropped, E-1); S moves focus
  to the description so VoiceOver reads it (S-1); the Graph it board takes
  the contrast set's colours and scales its labels (C-1); the four-function
  and scientific keypads follow the Desmos WA layouts with an `ans` key
  (FF-1); the answer box's Math keys on a four-function test start closed
  with six keys (FF-2). Unit and renderer tests pass; none of it re-run in
  the app yet.
- 2026-10-24 — calculator help and the exponent hint. A **?** button in the
  toolbar opens "How to use this calculator" over the calculator, built from
  `helpSections(mode, sqrtKey)` (`src/ui/help.ts`) so each calculator shows
  only what it has; middle-school wording (measured ≈ grade 2–3, a test caps
  it at 8); Esc closes the help and is cancelled so the panel stays. The
  same text is on `/help.html` with the practice advice from findings
  Z-1 / Z-2, and a design-tool test keeps the page in step. The hint: while
  the caret is in a power, subscript, fraction or root (found from MathLive's
  public `getElementInfo` depth and the closing atom's LaTeX, so brackets
  give none) a polite live line under the expressions says "Press → to move
  back out". Tests pass (graphing 496, design-tool 3383, swift 1148); not
  yet tried in the app.
