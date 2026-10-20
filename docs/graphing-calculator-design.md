# Graphing calculator: our own, Desmos-like (roadmap row DC)

Status: DECIDED 2026-10-19 (James: D-1, D-2 (a) MathLive, D-4 (a) own
interval arithmetic, D-7 with the no-calculator accommodation case
deferred, D-9 v1 as proposed); D-3, D-5, D-6, D-8, D-10–D-12 stand as
recommended unless James says otherwise. Nothing built. Branch: `graphing-calculator`
(long-lived, kept off `main` so it holds up no other work). Side: both.

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
  permissive licence; no copyleft (D-1, James 2026-10-19).

"Desmos-like" means the layout and interaction model students know —
expression list on the left, live math entry, a graph that pans and zooms,
sliders, tappable points of interest. It does not mean Desmos's code,
icons, fonts, colours or name: none of those are copied, and the product
never says "Desmos" except where a state catalog id already does (D-10).

## What the codebase gives us (survey, 2026-10-19)

- **Test page.** All page JS/CSS are Swift string literals in
  `AssessmentPage.swift` (`rendererScript`, `itemStyles`), spliced with
  `\#(name)`; CSP `default-src 'none'` — inline script/style only, fonts
  and images only as `data:`, **no `unsafe-eval`**, no network
  (`PageShell.swift:31`). No calculator, notepad or line reader exists.
- **Served renderer (v2.0, merged).** `packages/renderer` extracts
  `renderer.js` / `renderer.css` from those literals (bridge mode, byte-
  checked); signed, 16 MB per-file cap, today ~330 KB. A new module = a new
  literal spliced into `rendererScript`. KaTeX still ships in the shell
  until renderer slice 5. New bridge terms (`requires`) need a shell
  release; `response.generic` (256 KB, depth 8) already carries answer
  types the shell does not know.
- **Generated-literal precedent.** `client/scripts/vendor-katex.mjs`
  already turns a TS source (`macros.ts`) into a Swift file
  (`GeneratedKatexMacros.swift`). The same pattern can carry a built
  graphing bundle into the page (D-3).
- **Schemas.** Ten item types; `drawing_upload` is a hand-scored PNG and
  its schema comment already names "plotted points and auto-scoring" as the
  deferred graphing suite. New served-renderer-only types gate on client
  `2.0.0` (`clientSupport.ts`). Teacher vs student wire formats stay
  separate (ADR 0016): keys never enter `DeliveryBundleSchema`.
- **Settings and accommodations.** Per-test settings are `assessments`
  columns (`allow_clipboard`, `allow_highlighting`, …); the effective
  accommodation map reaches the page as `BUNDLE.accommodations`.
  `desmos_calculator` exists in the catalog (universal, T2, strategy A) but
  is not in `VISIBLE_IDS`.
- **Math scoring today** is string folding + numeric tolerance
  (`lib/scoring/auto.ts`); no algebraic equivalence.
- **Tests.** Page JS runs headless in the JSC harness
  (`RendererHarness.swift`): DOM shim, canvas is an op recorder, no layout,
  no pixels. Design tool and packages use `bun test`.
- **Licence gap found in passing (not fixed here):** KaTeX is inlined in
  the student page but its MIT notice is not shipped with the client. MIT
  requires it. Suggested as a separate one-line fix on `main`.

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
| MathLive (math input + virtual keyboard) | MIT, no deps | candidate (D-2) |
| Cortex Compute Engine | MIT | too big (4.4 MB min), 0.x churn, `compile()` uses `new Function` (blocked by our CSP) |
| math.js | Apache-2.0 | allowed, not useful: its own syntax, not the LaTeX math input emits, and none of the Desmos grammar (implicit multiplication, user functions); CSP fit unverified |
| interval-arithmetic | BSL-1.0 | allowed — option for D-4's interval sub-decision |
| function-plot | MIT; deps d3 = ISC, interval-arithmetic = BSL-1.0 | licences fine; excluded because its evaluator compiles with `new Function` (CSP) |
| nerdamer | Apache-2.0 | allowed, not needed (CAS) |
| MathQuill (what Desmos uses) | MPL-2.0 | excluded (copyleft) |
| JSXGraph | MIT OR LGPL-3.0 | elect MIT if ever used; not needed |
| liblouis (braille) | LGPL | excluded (copyleft) |

**D-2 Math input. DECIDED (James, 2026-10-19): (a) MathLive.**
- (a) **Decided — MathLive.** MIT, no dependencies, Desmos-style live
  2D entry (`/` stacks a fraction, `^` raises, `sqrt` → √) plus a virtual
  keyboard and screen-reader speech. 844 KB min / 228 KB gz. No `eval`.
  Under our CSP: it skips font loading when the KaTeX families are already
  in `document.fonts` (our inlined `data:` faces) or with
  `fontsDirectory = null`; `soundsDirectory = null` turns sounds off.
  Unverified until the spike (slice 3): constructable stylesheets under
  CSP in WKWebView, VoiceOver behaviour, keyboard inside an AAC session.
- (b) Our own structural editor on KaTeX output — fully ours, small, but a
  large, fiddly build (cursor model, selection, accessibility).
- (c) The lighter typed notation from `docs/math-entry-design.md` with a
  KaTeX preview — cheapest, least Desmos-like.

**D-3 Where the code lives and how it reaches the page.** Recommended: a
new workspace package `packages/graphing` (TypeScript, MIT header, no
runtime deps) holding the engine; a build step emits one plain-JS file
(no imports, no `eval`, no `</`) and a generator writes it into a Swift
literal (the `vendor-katex.mjs` pattern), spliced into `rendererScript`
so bridge-mode extraction and signing are unchanged. The same package is
imported by the design tool (preview, authoring, scoring) and run under
`bun test` — one evaluator for the student's screen and the server's
score. MathLive, if chosen, is vendored the same way.

**D-4 Engine — build our own.** Recommended, all MIT, all pure functions
testable in `bun test` and the JSC harness:
- Parser for the LaTeX subset MathLive emits (or our notation): numbers,
  variables, `\frac`, `^`, `\sqrt`, `|x|`, trig/log/ln, `\pi`, `e`,
  function definitions and calls, points `(a,b)`, lists, relations
  `= < > ≤ ≥`, restrictions `{x>0}`, implicit multiplication (`2x`,
  `2(x+1)`, `2\sin x`; `f(x)` is a call only when `f` is defined).
- Evaluator compiled to nested closures (no `new Function`), real and
  interval modes; dependency graph with cycle detection; free variables
  become slider candidates.
- Explicit curves: adaptive sampling with discontinuity detection.
- Implicit equations and inequalities: quadtree + interval evaluation +
  marching squares. Sub-decision DECIDED (James, 2026-10-19): (a) **our
  own interval arithmetic** — it runs over our own AST, so no adapter, (b) vendor
  Compute Engine's MIT `interval` module (60 KB gz, MathJSON input, needs
  an adapter), or (c) the BSL-1.0 `interval-arithmetic` package (allowed
  under D-1; operations only, needs an evaluator adapter).
- Points of interest: intercepts, extrema, pairwise intersections.

**D-5 Rendering.** Recommended: Canvas 2D at device-pixel ratio for
curves, grid and fills (cache the bitmap during a drag, re-sample on
gesture end), with a **parallel DOM layer** for everything a screen
reader or keyboard must reach — focusable points, the trace cursor, a
live region, the graph's text description. VoiceOver cannot read canvas
pixels. The same engine also emits **SVG** server-side for the design
tool's no-script preview and for print (stimulus graphs, answer review).

**D-6 Calculator modes and configuration.** Recommended:
- Three calculators on one engine: four-function, scientific, graphing.
- Configuration as our own named flags (keypad layout, degree/radian
  default, disabled function groups, implicit/inequality plotting on/off,
  folders/notes/images off), with two presets:
  - **"State test (WA)"**, matching the published Washington SBAC
    graphing configuration: degrees by default; alphabetical keypad; no
    images/folders/notes/actions/recursion; no decimal↔fraction; no
    reciprocal or hyperbolic trig, distance/midpoint, stat plots,
    distributions, `random`, or inference. Scientific: no function
    definitions. Four-function: a fraction key.
  - **"Full"** for classroom-style tests.
- Grade bands are a teacher choice, not enforced (SBAC: Gr 6 four-function,
  Gr 7–8 scientific, HS graphing).

**D-7 Per-test setting + accommodation (James: both). DECIDED 2026-10-19:**
- **Test setting:** `calculator` on `assessments` = none / four-function /
  scientific / graphing (+ preset). Default none. A per-item
  "no calculator on this item" override **is in v1** (James), to mirror
  SBAC's calculator / no-calculator sessions.
- **Accommodation:** `desmos_calculator` (identifier kept — it is the
  TIDE/OSPI catalog id) grants the test's calculator to a student the
  teacher picks; added to `VISIBLE_IDS`; teacher-facing label
  "Calculator" (D-10). Construct-altering flag works as for other
  accommodations. **When the test has no calculator, the accommodation
  grants nothing for now — DEFERRED** (James, 2026-10-19; candidate later:
  grant the scientific calculator).

**D-8 Graph as stimulus.** Recommended: the item stem may carry a
teacher-authored graph — an expression list + viewport, rendered
read-only (pan/zoom allowed, editing not) — with **required alt text**,
drafted automatically from the expressions and points of interest. Lives
in both bundles (it is content, not a key).

**D-9 Graph as answer — a new item type `graph`. DECIDED (James,
2026-10-19): v1 tools and scoring modes as below.** From from
how CAI/SBAC, TestNav, Learnosity, Möbius and WeBWorK do it:
- Students place objects with tools, each defined by snapped points in
  click order: point, line, segment, ray, circle (centre + point),
  parabola (vertex + point, vertical axis). Typed coordinates `(x, y)` are
  an equal alternative (keyboard and WCAG 2.5.7).
- Teacher config: board extent, grid, snap (rational), allowed tools,
  max objects, optional fixed objects. The key is drawn on the same board;
  the editor reads it back ("y = 2x + 1") for confirmation.
- Scoring: canonicalise each object with **exact rational arithmetic**
  (line → reduced `ax+by=c`, circle → centre + r², …), dedupe, compare as
  multisets. `all` (default, all-or-nothing) or `per_object`
  (matched ÷ key; more objects than the key → 0). Snap replaces
  tolerance.
- Wire: key only in `ItemBundleSchema`; `DeliveryBundleSchema` carries
  board + tools; response rides `response.generic` with a pinned schema;
  `MIN_CLIENT_VERSION_FOR_TYPE.graph = "2.0.0"`.
- Later: inequality regions, sine/exponential/absolute value, polygons,
  open/closed endpoints, "graph this expression" scored by sampled
  equivalence. QTI export: points-only maps to `select-point`; the rest is
  lossy.

**D-10 Naming.** Recommended: product UI says "Calculator" / "Graphing
calculator" (`PRODUCT_NAME` conventions apply); "Desmos" appears only in
the catalog id and in docs that describe the request. We are not
presenting this as Desmos.

**D-11 Accessibility baseline (v1, not later).** Recommended: full
keyboard operation with an Esc exit from the graph; typed-coordinate
equivalents for every placement; live-region announcements; required
stimulus alt text; 24 px targets; focus ring on the focused point; 3:1
contrast and non-colour curve encoding (dash/label); VoiceOver row per
feature in `client/MANUAL-CHECKS.md` (run per the VoiceOver method:
James, Claude quit). Later: audio trace / sonification (Web Audio),
spoken graph summary, Nemeth/UEB (no MIT braille library exists),
embossing export.

**D-12 Branch.** `graphing-calculator` stays off `main`, rebased on
`main` periodically; it merges only when a slice is shippable and James
says so. Nothing reaches students before then, and every student-facing
piece is behind a default-off setting and the `2.0.0` gate.

## Slices

| # | Slice | Proves | Test |
|---|---|---|---|
| 0 | This note | decisions | — |
| 1 | `packages/graphing` engine: parser, closure evaluator, dependency/slider pass, adaptive sampler, points of interest | the maths | `bun test` |
| 2 | Playground: local page (expression list + canvas graph + MathLive if D-2a), look-and-feel review | it feels right | James by hand |
| 3 | Spike in the client (Debug, simulated lockdown): engine + MathLive + canvas under the real CSP; fonts, keyboard, VoiceOver | it runs in the page | hand rows + JSC harness |
| 4 | Implicit curves + inequality shading (interval + quadtree) | D-4 sub-decision | `bun test` |
| 5 | Calculator panel in tests: setting, accommodation, presets, four-function / scientific / graphing | the tool ships | JSC + hand rows + design-tool tests |
| 6 | Graph stimulus: authoring, SVG preview/print, alt text | stimuli | design-tool tests + hand rows |
| 7 | `graph` answer type: tools, typed entry, canonical scoring, key authoring, review | answers | `bun test` (scorer), JSC, hand rows |
| 8 | Accessibility extras: audio trace, graph summary | parity | hand rows |

Slices 1–2 touch no shipping code. The first slice that touches the
client is 3 (a Debug-only spike).

## Not verified (carry into slices)

- MathLive's constructable stylesheets under our CSP in WKWebView;
  MathLive + VoiceOver; Web Audio inside an AAC session.
- Canvas performance at retina in WKWebView.
- The Washington four-function configuration (Desmos sheet: fraction key
  instead of √; OSPI paper policy: √ and %) — confirm with OSPI.
- SBAC's toolbar and scoring rules for graphing items (not public).

## Sources

- Desmos API docs v1.11 and API plans (row DC); Washington and College
  Board Desmos calculator configuration PDFs (desmos.com static assets);
  OSPI calculator policy; calculators.smarterbalanced.org.
- Pearson TestNav graphing interaction docs; IMS QTI 3.0 implementation
  guide; TAO line & point interaction; Möbius sketch question docs;
  WeBWorK GraphTool docs (ideas only — no code).
- W3C WCAG 2.2 Understanding pages (2.5.7 dragging, 1.4.10 reflow);
  Illinois CITL review of Desmos accessibility; WebKit bugs 187695,
  240656.
- npm registry metadata and repository LICENSE files for every package in
  the D-1 table.

## Questions for James

All answered 2026-10-19: Q-1 MathLive; Q-2 own interval arithmetic;
Q-3 accommodation with no test calculator grants nothing (deferred);
Q-4 per-item override in v1; Q-5 D-9 v1 as proposed; Q-6 KaTeX licence
notice fixed on `main` as its own change.

## Deferred

- D-7: what the calculator accommodation grants when the test has no
  calculator (candidate: the scientific calculator).

## Progress

- 2026-10-19 — slice 0 drafted on `graphing-calculator`; D-1 decided
  (permissive dependencies, no copyleft); Q-1…Q-6 answered.
