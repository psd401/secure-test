# Math entry for short-text items — keypad, and a handwriting spike

Design note, 2026-09-08. Roadmap **4b** (`docs/roadmap-2026-09.md`), from
finding **S-6** of the 2026-09-08 client sitting
(`docs/client-ui-pass-design.md`): James asked for a calculator-style keypad
for math entry on short-text items, and for a look at handwriting
recognition from the touchpad. The keypad is the deliverable; handwriting is
a **spike** with a go / no-go, post-pilot unless it turns out cheap.
Decisions marked **D-n** are James's and are listed at the end in `#.#`
form; **§Progress says what is built** (nothing yet). Read-only session; no
code touched.

Scope line, stated up front: the keypad is client work, but **one thing it
inserts (`\frac`, `\sqrt`) cannot be scored today**, so the slice carries a
small, additive change to the design tool's short-text fold
(`lib/scoring/auto.ts`) as its own commit and one deploy. Everything else
stays in `AssessmentPage.swift`.

## What exists that this stands on

- **The field** (`AssessmentPage.swift` `shortTextField`, ~line 681): one
  `<input type="text" class="short-text">`, `autocomplete` / `autocapitalize`
  off, `spellcheck` from the per-student accommodation. `onchange` posts
  `{type:'short_text', text}` — the **raw typed string**, nothing else
  (`ItemResponse.shortText(text:)`, the schema's `ItemResponseSchema`).
  `oninput` re-renders the preview. P-1 restores the saved text and its
  preview on resume.
- **The preview** (E7(b), batch 0b slice 2, S-4): `formulaTex(text)` strips
  `$`, escapes `% # & ~`, trims, turns each whitespace run into `\ `, and
  wraps the whole thing in `\mathrm{…}` — so a plain word reads upright and
  `H_2O` / `x^2` / `10^{-4}` render as the student meant. Backslash
  commands, braces, `^`, `_` and Unicode pass through untouched, so
  `\mathrm{\frac{1}{2}}` and `\mathrm{3 × 10^{5}}` already render. It is
  rendered with `throwOnError: true` inside a try/catch (S-4): on a parse
  failure the last good render is repainted from `data-last-good` and a
  plain note in `--ink-soft` says "Can't read that as math yet — keep
  typing." KaTeX's red error markup never reaches the page. The preview is
  an `aria-live="polite"` region, and KaTeX's default output carries a
  MathML twin of the picture, which is what VoiceOver reads.
- **The hint** ("Subscript with _ and superscript with ^ (H_2O, x^2). Your
  answer shows below as it will be read.") appears only when the **stem
  carries `$`** — the page's one existing signal that a question is
  math-shaped. The delivery item (`DeliveryShortTextItemSchema`) has no other
  flag; nothing tells the client "this item wants math input".
- **KaTeX in the client** (ADR 0009 addendum 2026-09-01): `katex.min.js`,
  `katex.min.css` (woff2 faces inlined as data URIs), `auto-render.min.js`
  and the `KATEX_MACROS` constant are inlined into the page; CSP is
  `script-src 'unsafe-inline'`, `style-src 'unsafe-inline'`, `font-src data:`,
  `img-src data:` — no network, no CDN, ever. `strict: 'ignore'`, `trust:
  false`. The vendored version is the design tool's; `bun scripts/vendor-katex.mjs`
  after a bump.
- **The macros** (`packages/schema/src/macros.ts`, mirrored into
  `GeneratedKatexMacros.swift`, drift-checked by the schema package's macros
  test): six K-12 entries — `\degree`, `\percent`, `\plusminus`, `\half`,
  `\third`, `\quarter`. The keypad needs **none** of them and adds none
  (the ADR's rule: removing one is a breaking change for every saved stem).
- **Scoring** (`lib/scoring/auto.ts` `shortTextMatches`, "plain or folded",
  James 2026-09-02): normalise both sides (trim, collapse whitespace,
  lower-case) and compare; if unequal **and either side carries one of
  `$ \ { } ^ _`**, fold both and compare again. The fold: `$` go;
  `\mathrm` / `\textrm` / `\text` / `\mathit` / `\mathbf{…}` unwrap; braces
  go; `\,` `\;` `\!` `\:` `\ ` go; all whitespace goes; `_` goes (a
  subscript reads the same inline); **`^` stays** (an exponent changes the
  value). **Every other backslash command survives the fold unchanged** —
  `\frac{1}{2}` folds to `\frac12`, `\pi` stays `\pi`, `\times` stays
  `\times` — so none of them can match a teacher's key today. Unicode
  passes through both sides untouched: a student's `π` equals a teacher's
  `π` and nothing else.
- **How keys are written today**: the editor's "Correct answer" is a plain
  text input with a `MathPreview` under it that renders only `$…$` spans;
  E7(a) decided keys are **plain text on purpose** (`H2O`, `45`), because
  the scorer was an exact match. The PDF importer writes plain keys. So the
  answer-key side is a teacher typing on a Mac keyboard: `1/2`, `x^2`,
  `3.2 x 10^5`, `sqrt(2)` or `√2` (Option-V), `45°C` (Option-Shift-8), `pi`
  or `π` (Option-P). The teacher's review queue and the results pages show
  the student's **raw text**; nothing on the teacher side renders a
  student's answer through KaTeX.
- **What the teacher-authored samples actually use** (the 13 imports under
  `design-tool/samples/import-run/`, notation only — no content is quoted
  here): the chemistry quizzes carry `$\mathrm{…}$` chemical formulas with
  **single-digit subscripts**, including parenthesised groups with a
  subscript outside the parenthesis, and the **degree sign** on
  temperatures; the AP Biology exam carries one **capital sigma**
  (statistics); the gas-law quizzes are numeric short answers with units
  and their working would want **scientific notation** (`× 10^n`); no
  fraction, root, lower-case Greek or inequality appears in any stem or key,
  and every key is plain text. So the evidence-backed must-haves are
  subscript, superscript, `×`, degree, and Δ / Σ; the rest of the list
  (fraction, root, Greek, ±, ÷, ≤ ≥ ≠, π) is James's ask for the math
  classrooms the samples do not yet cover.
- **What the sitting found** (S-4, roadmap 4b's "closes the `\mathrm{…`
  confusion for good"): a student who does not know the notation types
  something half-right and sees either nothing useful or, before S-4, the
  library's error text. The message fix removed the scary part; it did not
  give the student a way to produce the notation.
- **Test harness** (`RendererHarness.swift`): a JavaScriptCore DOM shim —
  nodes, attributes, handlers, a recordable canvas, a `setTimeout` shim, an
  `Image`. **No selection API on inputs** (`selectionStart`, `setRangeText`,
  `setSelectionRange`, `focus`), no `KeyboardEvent`, no real KaTeX (S-4's
  tests use a stub that throws on unbalanced input). The keypad's caret
  logic is exactly what that shim does not have yet.
- **Batch 4** (theme, accommodations): every rule in `itemStyles` reads a
  token and `PageShellTests` fails on any literal hex outside `:root`; eight
  contrast sets redefine the twelve tokens on `html[data-contrast]`;
  `optional_font` swaps `--font-body` / `--font-heading` to Atkinson
  Hyperlegible in front of Inter; nine zoom levels scale the root font size
  and everything sized in `rem` follows. The drawing toolbar (4c) is the
  precedent for a button strip on an item: native `<button>`s in a
  `role="toolbar"`, `aria-pressed`, tokens + `rem`, `flex-wrap`.
- **No Edit → Undo menu item**; Cut / Copy / Paste are disabled unless the
  bundle allows the clipboard; the system keyboard viewer and Character
  Viewer are not reachable inside an AAC session, and predictive text is
  off in a real session (8.4 closed). A student's only ways to produce `π`
  today are knowing `\pi`, or an Option-key chord they were never taught.

## Proposed shape

### The principle: insert the lightest text that renders AND scores

Two candidate notations were weighed for what a key puts into the field:

- **Raw LaTeX everywhere** (`\times`, `\pi`, `\le`, `\frac{}{}` …): the
  preview is guaranteed to render, but the field fills with backslashes,
  the results page and CSV show `3.2 \times 10^{5}` to a teacher, and the
  scorer needs a synonym table for every command anyway because the
  teacher's key is plain text.
- **A lighter notation**: **the Unicode character wherever one exists**
  (`×` `÷` `±` `≤` `≥` `≠` `°` `π` `Δ` …) and **LaTeX only where layout
  needs it** — the four structures with no single-character form:
  `\frac{}{}`, `\sqrt{}`, `^{}`, `_{}`. KaTeX renders every one of those
  Unicode symbols in math mode directly (they are in its symbol table, and
  `strict: 'ignore'` already silences the text-in-math warning), including
  inside `\mathrm{…}`. The field reads as math to a human, the CSV reads as
  math to a teacher, Unicode already round-trips the fold untouched, and the
  scorer learns exactly four commands plus a synonym table for the symbols a
  teacher might type differently.

**Recommendation: the lighter notation (D-1).** It is what a calculator
shows, it is what a teacher can type into the key field, and it keeps the
raw-text response contract (ItemResponse unchanged, no schema change, no
migration).

**Evidence (2026-09-08, scratchpad script against the design tool's
vendored `katex`, the same version the client inlines):** every insertion
in the table below, wrapped by today's `formulaTex` — `\frac{}{}` and
`\frac{1}{2}`, `x^{}`, `10^{-4}`, `x_{}`, `H_{2}O`, `\sqrt{}`, `( )`, each
of `× ÷ ± ≤ ≥ ≠ °`, `45°C`, all nine Greek letters, `3.2 × 10^{5}`, the
Unicode `x² y₂`, `√2`, and the optional `→`, `∞`, `\sqrt[3]{8}` — renders
with `throwOnError: true`, `strict: 'ignore'`, the K-12 macros loaded. The
empty structures render (an empty fraction bar, an empty radical), which is
what makes the preview a live guide while a slot is still being filled.
`katex.min.js` is a UMD bundle whose `document.*` references are all on the
`render` path (plus one `compatMode` probe), so `renderToString` in a bare
`JSContext` with the harness's `document` stub is a realistic headless test.

### What each key inserts

| Key (visible label) | `aria-label` | Inserts | Caret / selection | Scorer canonical form |
|---|---|---|---|---|
| a⁄b (KaTeX `\frac{a}{b}` when the library is present, text `a/b` otherwise) | Fraction | `\frac{}{}` | caret in the numerator; **a selection becomes the numerator** and the caret lands in the denominator | `A/B`, parentheses only around a multi-atom side: `\frac{x+1}{2}` → `(x+1)/2`, `\frac{1}{2}` → `1/2`; a teacher's `(1)/(2)` reaches the same `1/2` |
| x² | Exponent | `^{}` | caret inside; a selection is wrapped | braces go, `^` stays (today's rule): `10^{-4}` ≡ `10^-4` |
| x₂ | Subscript | `_{}` | caret inside; a selection is wrapped | `_` and braces go (today's rule): `H_{2}O` ≡ `H_2O` ≡ `H2O` |
| √ (KaTeX `\sqrt{a}`) | Square root | `\sqrt{}` | caret inside; a selection is wrapped | `√A` for one atom, `√(A)` otherwise; a teacher's `sqrt(2)` / `√(2)` / `√2` all reach `√2` |
| ( ) | Open parenthesis / Close parenthesis | `(` / `)` | after | unchanged |
| × | Times | `×` U+00D7 | after | `×`; synonyms `\times`, `\cdot`, `·`, `*` fold to it — see **D-3** for the letter `x` |
| ÷ | Divided by | `÷` U+00F7 | after | `÷`; synonym `\div` (a `/` is **not** a synonym — `1/2` is a fraction) |
| ± | Plus or minus | `±` U+00B1 | after | `±`; synonyms `\pm`, `\plusminus`, `+/-`, `+-` |
| ≤ ≥ ≠ | Less than or equal to / Greater than or equal to / Not equal to | U+2264 / U+2265 / U+2260 | after | synonyms `\le` `\leq` `<=`, `\ge` `\geq` `>=`, `\ne` `\neq` `!=` |
| ° | Degrees | `°` U+00B0 | after | `°`; synonyms `\degree`, `^\circ`, `^{\circ}` |
| π θ α β Δ λ μ Σ Ω (the Greek row) | the letter's name ("Pi", "Theta", "Alpha", "Beta", "Delta", "Lambda", "Mu", "Sigma", "Omega") | the Unicode letter | after | the letter; synonyms `\pi` … `\Omega` for every Greek letter KaTeX names, not only the nine on the keypad |

Notes on the table:

- The **structure keys wrap a selection** ("select `x+1`, press Fraction"),
  which is how a student fixes an answer they already typed without
  retyping it. With no selection they insert the empty structure and put the
  caret in the first slot. `\frac{}{}` with empty groups parses in KaTeX, so
  the fraction bar appears in the preview the moment the key is pressed and
  the numerator fills in as the student types — the preview is the
  confirmation that the caret is where they think.
- **Moving between slots is the plain arrow key**: from the end of the
  numerator, Right twice (`}` then `{`) lands in the denominator. This is
  the known weakness of LaTeX in a plain input and the reason the caret
  behaviour is a hand-run row; an equation editor would fix it and is out of
  scope (below). If the rows show students getting lost, the follow-up is a
  "next slot" behaviour on the keypad (a → key that jumps to the next empty
  `{}`), not an editor.
- **Numbers, letters and `+ − = /` are not on the keypad** — the Mac has a
  keyboard, and twelve digit keys nobody needs would push the keys they do
  need below the fold at zoom 3× (**D-4**). Minus is the keyboard's `-`;
  KaTeX renders it as a proper minus in math mode.
- **What the answer-key side must do**: nothing new for the teacher —
  keys stay plain text exactly as E7(a) decided, and the scorer's fold
  grows a canonicalisation step (below) so `1/2`, `sqrt(2)`, `3.2 x 10^5`,
  `45°C`, `pi`-as-`π` keys match what the keypad produces. The design tool's
  key field and `MathPreview` are untouched in this slice; a keypad on the
  key field, and rendering a student's raw answer through KaTeX in the
  review queue and results pages, are follow-ups (§Follow-ups).

### The scorer's fold, extended (server commit, additive)

`foldFormula` in `lib/scoring/auto.ts` gains a **canonicalisation pass that
runs before the existing brace / whitespace / `_` steps**, on both sides,
only on the fold path (so, as with E7(b), it can only ever ADD a match to a
pair the plain comparison rejected — a prose key is never touched):

1. `\frac{A}{B}` / `\dfrac{A}{B}` → `A/B` with `(A)` / `(B)` when the side
   is more than one atom (an atom: a decimal number, or a single letter
   optionally followed by `^…` / `_…`); innermost first, two passes for one
   level of nesting. Then parentheses around a single atom are dropped
   everywhere (`(1)/(2)` → `1/2`) so a teacher's parenthesised key meets it.
2. `\sqrt{A}` → `√A` / `√(A)` by the same atom rule; `sqrt(A)`, `sqrt A`,
   `√(A)` → the same.
3. Symbol synonyms → the Unicode character: the table above (`\times`,
   `\cdot`, `·`, `*` → `×`; `\div` → `÷`; `\pm`, `\plusminus`, `+/-`, `+-`
   → `±`; `\le`, `\leq`, `<=` → `≤`; `\ge`, `\geq`, `>=` → `≥`; `\ne`,
   `\neq`, `!=` → `≠`; `\degree`, `^\circ`, `^{\circ}` → `°`; every
   KaTeX-named Greek command → its letter, case kept).
4. **D-3**: a lone letter `x` between two digit groups (`3.2 x 10^5`,
   `2x3`) → `×`. Narrow on purpose: `2x` (two times a variable) and
   `x^2` are untouched because there is no digit on both sides.
5. Then today's steps: `$` go, `\mathrm{}`-family unwrap, braces go, TeX
   spacing goes, whitespace goes, `_` goes.

The trigger set for the fold path grows from `[$\\{}^_]` to include the
Unicode symbols and Greek letters, so a student's `3.2 × 10^5` against a
key `3.2 x 10^5` reaches the fold at all (today `^` triggers it; a `π`
alone would not).

**Known limits, accepted rather than solved (the fold is a string rule, not
algebra):** a mixed number `1\frac{1}{2}` folds to `1(1/2)`, a teacher's
`1 1/2` to `11/2`, so they do NOT match — teachers key improper fractions
or decimals; `1/2` never equals `0.5` (numeric equivalence for short text is
a policy question, §Follow-ups); `\frac{1}{2}` never equals `\frac{2}{4}`;
`x²` typed as the Unicode superscript two (Option-key chords on some
layouts) is a literal character KaTeX renders as a superscript but the fold
does not equate with `^2` — add U+00B2 / U+00B3 / U+2070–2079 →
`^n` and U+2080–2089 → `_n` to step 3 (cheap, included).

Tests (design-tool `bun test`, `test/scoring/auto.test.ts` or its sibling):
each row of the table against its plain teacher key; every synonym; the
mixed-number non-match pinned as a limit; the plain path still rejects
"cell wall" vs "cellwall"; a prose key with an `x` in it is never folded
because the plain comparison never falls through with no markup on either
side.

### Where the keypad sits

- **Under the preview, per item**: field → preview (as today, so the
  rendered answer stays directly under the text it renders and S-4's note
  stays where it is) → a **"Math keys" toggle button** → the keypad
  (**D-5**). Above the preview it would push the picture off the bottom at
  zoom 3× exactly while the student is pressing keys.
- **Per item, not per page**: an insertion has one target input; a shared
  page-level pad would need "which field did you mean" tracking, and an
  inline item set puts several short-text fields on one page.
- **Toggle, open by default on math-shaped questions** (**D-6**): every
  short-text field gets the toggle (`aria-expanded`, `aria-controls`), so a
  student can open it on any question — the client cannot know a
  history-class answer from a chemistry one. It **opens by default when the
  stem carries `$`**, the same signal the hint uses today, and stays
  collapsed otherwise so a prose question does not grow a 22-button grid.
  State is per item for the life of the page (a paging turn rebuilds the
  page; re-open is one click). Always-on was rejected for the prose case; a
  per-item teacher flag (`math_input`) is the right long-term signal but
  touches the schema, the editor, both bundles and a migration, so it is a
  follow-up, not this slice.
- The existing hint line changes to "Use the math keys below, or type _ for
  a subscript and ^ for an exponent. Your answer shows below as it will be
  read." and still appears only where the stem carries `$`.

### Layout

One `<div class="math-keys" role="toolbar" aria-label="Math keys">` holding
three visual rows (`flex-wrap: wrap`, gaps in `rem`, so at zoom 3× the
rows simply become more rows):

| Row | Keys |
|---|---|
| Structure | Fraction, Exponent, Subscript, Square root, `(`, `)` |
| Operators | `×`, `÷`, `±`, `≤`, `≥`, `≠`, `°` |
| Greek | `π`, `θ`, `α`, `β`, `Δ`, `λ`, `μ`, `Σ`, `Ω` |

Twenty-two native `<button type="button">`s, each `min-height: 2.75rem`
and `min-width: 2.75rem` (the S-3 lesson: rows too tight to hit), `--paper`
fill, `--line-strong` border, `--ink` text, the page's `--accent` ring on
`:focus-visible`, active state = `--accent` / `--accent-ink` for the
pressed instant. The structure keys' labels are rendered through KaTeX when
the library is present (`\frac{a}{b}`, `x^{2}`, `x_{2}`, `\sqrt{a}`) so the
key shows the shape it makes; the text fallback (`a/b`, `x²`, `x₂`, `√a`)
is what the harness sees. Every label is `aria-hidden` and the button
carries the words in `aria-label`. Greek keys and symbol keys are their own
character in `--font-body` — Inter has full Greek; Atkinson Hyperlegible's
coverage of Greek is partial, and the font stack falls back to Inter per
glyph, so a Greek key under the optional font may render in Inter beside
Atkinson body text (a hand-run row looks at this; it is legible either way).

Optional keys James may want on the strip (**D-7**): `→` (chemical
equations — the solubility-style items are formulas today, not equations),
`∞`, a cube-root key (`\sqrt[3]{}` — the fold would need `∛` / `cbrt(`),
`·` as a separate dot-times. Recommendation: none in v1; add from a
teacher's request, each is one row in the table.

### Caret, selection and focus in a WKWebView under lockdown

- **Insertion** is `input.setRangeText(text, start, end, 'end')` over the
  current selection (or the caret), then `setSelectionRange(pos, pos)` to
  place the caret in the first slot for a structure key, then the preview
  re-render, then **an immediate post** of the new value — see the trap
  below. `setRangeText` is standard WebKit and needs no `execCommand`.
- **Pointer clicks must not steal focus from the field**: every key handles
  `pointerdown` with `preventDefault()` (the drawing toolbar's pointer
  tracking proved pointer events land under a real AAC session, S-1), so
  the input keeps focus and its live selection, and `click` does the
  insertion. A student clicking keys in a row never has to click back into
  the field.
- **Keyboard activation keeps focus on the key** (**D-8**): a student who
  Tabbed to the keypad and pressed Space on Fraction is inserting at the
  selection the input remembers from when it had focus (WebKit keeps
  `selectionStart` across blur), and wants to press Exponent next, not be
  yanked back to the field. Refocus only after a pointer activation
  (`event.detail > 0`); keyboard users return with Shift-Tab.
- **One Tab stop for the whole pad**: the WAI-ARIA toolbar pattern —
  roving `tabindex` (`0` on one key, `-1` on the rest), Left / Right move
  between keys, Home / End to the ends, Tab leaves. Twenty-two Tab stops
  between the field and the next question would be a real cost for a
  keyboard-only student; the drawing toolbar's ten Tab stops predate this
  decision and are not changed here.
- **The `change` trap (must be built, is a test):** `onchange` fires when
  the input loses focus — but a programmatic `value` change fires neither
  `input` nor `change`. Without the immediate post, a student who types,
  presses a key by keyboard (focus leaves the field → `change` posts the
  OLD value), then presses Next, hands in the pre-keypad text. So every
  insertion posts through the same `post(item.id, {type:'short_text',
  text})` the `change` handler uses, and the answered-mark logic is
  unchanged (any post marks the item).
- **No system input UIs**: no Character Viewer, no keyboard viewer, no
  predictive text inside a session — the keypad is the only path to a
  symbol, which is why it lists every symbol rather than relying on chords.
  Undo of an insertion is WebKit's own Cmd-Z on the input (`setRangeText`
  participates in the field's undo stack; a hand-run row confirms this
  inside a real session, as 4c's Cmd-Z rows do for the canvas).
- **Paste** is disabled unless the bundle allows the clipboard (unchanged);
  a pasted `$\frac{1}{2}$` when it is allowed still strips its `$` in the
  preview and folds on the server as today.

### Keyboard reach and VoiceOver, key by key

- The toggle: "Math keys, button, collapsed / expanded".
- Each key: its `aria-label` from the table ("Fraction", "Times", "Pi", …),
  "button". No `aria-pressed` — these are momentary, not toggles; the
  drawing toolbar's pressed model does not apply.
- After an insertion, the **preview announces** — it is already
  `aria-live="polite"`, and KaTeX's MathML output is what VoiceOver
  speaks: "one half", "x squared", not "backslash f r a c". That is the
  single biggest accessibility argument for this design (next section): the
  student never has to hear or read the LaTeX. On a parse failure the S-4
  note is announced instead, unchanged.
- The input's own value is spoken when the student returns focus to it
  (VoiceOver reads a text field's contents) — the raw text, which for a
  student who cannot see the preview is the one place LaTeX is audible.
  The rows record what VoiceOver says for `\frac{1}{2}`; if it is
  unusable, the follow-up is an `aria-describedby` on the input pointing at
  the preview's MathML.
- The roving tabindex is announced as a toolbar with N items; arrow keys
  move; Escape does nothing (nothing modal to close).

### Contrast sets, Atkinson, zoom

- **Tokens and `rem` only** — `PageShellTests`' no-literal-hex rule holds
  without exception here (unlike the drawing swatches, no key has a colour
  of its own). Each contrast set inverts the active-state pair through
  `--accent` / `--accent-ink` exactly as the pager pips do.
- **Atkinson**: the key labels use `--font-body`, so the optional font
  applies; Greek falls back per glyph (above). The KaTeX-rendered structure
  labels and the preview use KaTeX's own faces regardless of the
  accommodation — as the preview does today; the answer *text* in the input
  is in the body face.
- **Zoom**: keys are `rem`-sized and the strip wraps, so 3× produces a
  taller pad, not a horizontal scroll; the toggle-closed default keeps a
  prose page short. The rows check that a key's hit target grows with the
  label.

### What stays out

An equation editor (MathLive / MathQuill — a WYSIWYG field would change
the response from raw text to an editor's serialisation, needs a library
we do not vendor, and its own accessibility story); graphing; any computer
algebra or numeric equivalence (`1/2` vs `0.5` vs `2/4` — a scoring policy
question for James, §Follow-ups, not a keypad question); matrices,
integrals, limits, summation notation, chemistry arrows and equilibrium
signs (none in the samples; **D-7**); a digit pad (**D-4**); changes to the
delivery bundle, `ItemResponse`, the schema package or the macros; any
change to the design tool's editor or results pages in this slice.

### Why a keypad, and what "the same answer" means

The students this serves are the ones the sitting showed: they know the
mathematics and not the notation. Raw LaTeX asks a ninth-grader to learn a
typesetting language during a timed test, penalises a typo with a red
message (fixed by S-4) or a silent non-match (not fixable by a message),
and reads aloud as gibberish to a screen reader. A keypad puts the symbol
set in front of the student as a menu, makes each key show the shape it
produces, confirms the result at once as a picture and, through MathML, as
speech, and needs no Option-key chords the district never teaches. It also
serves motor-impaired students better than typing `\frac{}{}` does, and it
is the input model students already know from calculators and from the
state test's own equation tool (SBA's math items have an on-screen keypad;
`docs/accommodations-data-dictionary.md` lists the SBA math tools this
client does not implement).

The **equivalence rules** a keyed answer is held to are therefore stated
plainly, so a teacher writing a key knows them:

1. Plain text first: what the student typed, trimmed, whitespace-collapsed
   and case-folded, must equal the key. (Unchanged.)
2. Only if that fails and either side carries math markup (a backslash,
   braces, `^`, `_`, `$`, or one of the keypad's symbols), both sides are
   folded and compared again. (Trigger set widened.)
3. Folding equates **notation, not value**: a stacked fraction and a slash
   fraction; a root sign and `sqrt(`; a Unicode symbol and its LaTeX or
   ASCII synonym; braces present or absent; a subscript written or flat;
   spacing. It does **not** equate `1/2` with `0.5`, `2/4`, or `50%`; it
   does not simplify; it does not reorder (`2×3` ≠ `3×2`). Case is folded,
   so `Δ` and `δ` are the same letter — a known cost of the existing
   lower-casing; if a chemistry teacher ever keys on that distinction, the
   fold path can keep case for Greek only (noted, not built).
4. A key that is itself in keypad notation (`\frac{1}{2}` typed by a
   teacher who learned it) works identically — the fold is symmetric.

## Handwriting recognition — the spike

James asked whether a student could write the answer on the trackpad and
have it become text. What is and is not available:

- **PencilKit is iOS / iPadOS only**; there is no AppKit ink-to-text API.
  Apple's own handwritten-math recognition (Math Notes, macOS 15+) is a
  private framework with no public entry point.
- **Vision** (`VNRecognizeTextRequest`, macOS 10.15+) recognises **text
  lines** in an image — Latin script plus a handful of languages, on
  device, no network (it must be checked that the request returns inside a
  real AAC session; the framework is in-process but the DNS surprise of
  10.7 is the reminder that a session can break more than UI). It returns
  candidate strings per line with a bounding box per line and, on request,
  a bounding box per character range. It has **no notion of a fraction, a
  superscript or a radical**: a stacked `1/2` comes back as two lines "1"
  and "2"; `x²` comes back as `x2` or `x^2` by luck; `√` and `π` are
  outside the character set (expect `V`, `TT`, `n`). macOS 26 adds
  `RecognizeDocumentsRequest` (Swift Vision, structured text: paragraphs,
  lists, tables) — still text, still no math structure.
- **The trackpad is a poor pen**: a finger dragging a mouse pointer, no
  pressure, no hover, cursor lag, and the student cannot rest a palm. 4c's
  stroke list gives the spike its input for free (render the strokes to a
  CGImage at 2–3×, thick black ink on white, a margin), but the strokes
  themselves will be worse than any handwriting corpus Vision was tuned on.

**The spike (Opus 5 / high, half a day, go / no-go):**

1. A throwaway SwiftPM target (or a test in `SecureTestCore` behind a
   `#if canImport(Vision)`) that takes a stroke list, renders it, runs
   `VNRecognizeTextRequest` at `.accurate` with `usesLanguageCorrection =
   false` (language correction turns `10^5` into words) and
   `recognitionLanguages = ["en-US"]`, and prints the top candidate plus
   per-character boxes.
2. A fixed set of **20 answers** of the kinds the samples and the keypad
   cover — integers, decimals, a negative, `H2O`-style with subscripts,
   `x^2`, a stacked and a slash fraction, `3.2 x 10^5`, `√2`, `π`, `45°C`,
   a two-token answer with a unit — each written **on a trackpad** by three
   adults (students only after a go, and only in a sitting James runs).
3. A **superscript / subscript heuristic** from the per-character boxes
   (a glyph whose baseline sits above / below its neighbours' by more than
   ~35 % of x-height becomes `^{…}` / `_{…}`), because without it the
   feature cannot even reproduce what the keypad does for chemistry.
4. **Go** = ≥ 90 % exact on the plain numeric answers AND the heuristic
   recovers subscripts and superscripts on ≥ 80 % of those samples AND the
   request returns inside a real AAC session. **No-go** = anything less;
   record the numbers and stop.
5. If go, the feature is **M–L, not S**: a "Write" surface (a small canvas
   in the short-text item, sharing 4c's stroke code), a Convert action, the
   recognised text landing **in the field for the student to check and
   edit** (never straight into the response), the preview as confirmation,
   and hand-run rows in a real session. Fractions and roots would still
   come from the keypad.

**Cost**: no service cost (on device); the spike is engineering time only.
**Why post-pilot unless cheap**: the keypad covers every notation James
listed with a deterministic result; a student who genuinely needs to write
by hand already has the drawing item (hand-scored, 4c's tools); the
trackpad is the wrong instrument for handwriting and the pilot Macs have no
pen; and a recogniser that is right 85 % of the time on a timed test is a
new way to lose an answer, which is worse than a keypad that is right 100 %
of the time. If the spike comes back "go" cheaply, it slots in after the
pilot's first findings as its own design note.

## Slices

0. **Decisions** — James answers the `#.#` list below. Read-only until
   then.
1. **Build (Opus 5 / medium, M) — two commits, one slice.**
   - **1a, server (deploy, no migration):** `lib/scoring/auto.ts`
     `foldFormula` canonicalisation pass + widened trigger set, per §The
     scorer's fold; tests per that section. Additive only: every existing
     scorer test keeps passing unchanged. Deployable on its own and safe to
     deploy **before** the client ships (it can only add matches).
   - **1b, client:** `AssessmentPage.swift` — `itemStyles` rules for
     `.math-keys`, `.math-keys-toggle`, the keys and the KaTeX-rendered
     labels; `shortTextField` gains the toggle (default from the stem's
     `$`), the pad with roving tabindex and arrow handling, `insertAt(input,
     text, slotOffset)` over `setRangeText` / `setSelectionRange` with the
     wrap-a-selection rule, pointer-down `preventDefault`, refocus-on-pointer
     only, and the immediate post; the hint copy. **Harness** gains
     `value` / `selectionStart` / `selectionEnd` / `setSelectionRange` /
     `setRangeText` / `focus` (records the focused node) on input nodes, and
     an `event.detail` on the synthetic click. **Tests**, a new
     `RendererMathKeysTests`: the 22 keys, order, labels, `aria-hidden`
     glyphs; toggle default open with `$` in the stem and closed without;
     `aria-expanded` / `aria-controls`; insertion at the caret with the
     caret in the first slot for each structure key; wrap-a-selection for
     Fraction / Exponent / Subscript / Root; a symbol key inserts one
     character after the caret; **a post follows every insertion with the
     new value** (the `change` trap); the preview's `data-tex` after each key
     (`\mathrm{\frac{}{}}`, …); pointer activation refocuses the input,
     keyboard activation does not; roving tabindex — exactly one key at
     `tabindex=0`, Right / Left / Home / End move it; the S-4 tests and the
     E7(b) tests unchanged; `PageShellTests`' hex test passes. **Try one
     more:** load the vendored `katex.min.js` into a `JSContext` (it is UMD
     and needs no DOM for `renderToString`) and assert that
     `katex.renderToString(formulaTex(insertion), {throwOnError: true})`
     succeeds for every key's insertion and for each key with a
     placeholder filled — the only headless proof that each key renders;
     if the library will not evaluate in JavaScriptCore, drop it and make
     it a hand-run row. `swift test`, `xcodebuild`.
2. **Hand-run rows (Sonnet 5 / medium writes them; James at the
   keyboard).** A block in `client/MANUAL-CHECKS.md` on a Published, paged
   assessment with short-text items whose stems carry `$` and whose keys
   are plain (`1/2`, `x^2`, `H2O`, `sqrt(2)`, `3.2 x 10^5`, `45°C`, `pi` as
   `π`, `≤` typed as `<=`), plus one prose short-text item: the toggle's
   default per item; every key inserts what the table says and the preview
   shows the shape; caret in the numerator, Right-Right to the denominator;
   select-then-Fraction wraps; pointer clicks keep focus in the field;
   Tab → arrows across the pad → Space inserts → Shift-Tab back; **type,
   press a key by keyboard, press Next at once → the teacher side shows the
   keypad text, not the pre-keypad text**; Cmd-Z after an insertion inside
   a **real** AAC session; VoiceOver on the toggle, three keys, and the
   preview after a Fraction (what it says for the MathML); Reverse Contrast
   and Yellow on Blue (keys readable, active state readable); zoom 3× (the
   pad wraps, targets grow); the optional font (Greek keys legible);
   hand in, then on the teacher side **every keyed item auto-scores 1**
   against its plain key (the fold), the results page shows the raw text,
   and the CSV carries it. Fixture built from a file, per the rule learned
   2026-09-03 (`design-tool/samples/_build-client-rows-fixture.ts` is the
   pattern); no student identifiers in the doc.
3. **Spike (Opus 5 / high, fresh session, half a day)** per §Handwriting,
   its result recorded under §Progress here as go / no-go with the numbers;
   nothing ships from it.

## Model and effort

Roadmap table row 4b: design note Fable / high (this page); keypad Opus 5 /
medium in a fresh session from this page — diff reviewed and `swift test`
+ `xcodebuild` + design-tool `bun test` / `typecheck` re-run in the main
session before each commit; rows Sonnet 5 / medium; handwriting spike Opus
5 / high, go / no-go. Commit 1a needs a deploy (`bunx cdk diff` then
`deploy`, James's call, no migration); 1b ships in the next client release
(`client/RELEASING.md`). One commit per slice, gitleaks on the staged
changes before each, no push without James's go-ahead.

## Follow-ups (recorded, not built)

- A per-item **teacher flag** (`math_input`) on short-text items so the
  keypad opens by default without a `$` in the stem — schema, editor,
  ItemBundle + DeliveryBundle, migration; roadmap item.
- The **key field in the editor** gets the same symbol keys and a hint
  naming the equivalence rules, and the **review queue / results / print**
  render a student's short-text answer through `\mathrm{…}` KaTeX the way
  the client does, so a hand-scorer sees `¾` rather than `\frac{3}{4}`.
- **Numeric equivalence for short text** (`1/2` ≡ `0.5`, tolerance) — the
  table item already compares plain decimals (E3 D-3); extending that to
  short text is a scoring policy for James, adjacent to E11.
- Greek **case preserved** in the fold if a teacher needs `Δ` ≠ `δ`.
- A **"next slot"** key if the rows show students lost between `}` and `{`.
- The drawing toolbar's ten Tab stops → roving tabindex, for consistency,
  once this pad proves the pattern.

## Decisions (James, 2026-09-08 — "accept all recommendations")

- **1.1 Notation** — Unicode symbols + LaTeX only for fraction / root /
  exponent / subscript. **Decided: yes.**
- **1.2 Server fold** — commit 1a, additive canonicalisation in `auto.ts`,
  deploy, no migration. **Decided: yes.**
- **1.3 `x` between digits → `×`** in the fold path. **Decided: yes.**
- **1.4 Fraction contract** — `\frac{}{}`, caret in the numerator, a
  selection becomes the numerator; mixed numbers a recorded limit.
  **Decided: yes.**
- **2.1 Placement** — field → preview → toggle → pad. **Decided: yes.**
- **2.2 Toggle default** — every short-text field has the toggle; open by
  default only when the stem carries `$`; not persisted across a page
  rebuild. **Decided: yes.**
- **2.3 Key set** — the 22 keys in §Layout, the nine Greek letters as
  listed. **Decided: yes.**
- **2.4 No digit pad** — **Decided: not in v1; on the pilot-feedback list**
  (`docs/roadmap-2026-09.md` §Pilot feedback) — asked of the pilot
  teachers and students, built if they want it.
- **2.5 Optional keys** (`→`, `∞`, cube root, `·`) — **Decided: none in
  v1.**
- **3.1 Focus model** — pointer activation keeps focus in the field;
  keyboard activation stays on the key; one Tab stop, arrows across the
  pad. **Decided: yes.**
- **3.2 Immediate post on every insertion.** **Decided: yes.**
- **4.1 Keep the `\mathrm{…}` wrapper** in the preview. **Decided: yes.**
- **4.2 Hint copy** as written. **Decided: yes.**
- **5.1 Spike timing** — post-pilot. **Decided: yes.**
- **5.2 Go / no-go thresholds** as written. **Decided: yes.**
- **6.1 Follow-ups** added to `docs/roadmap-2026-09.md` as unscheduled
  rows. **Decided: yes.**

## Progress

This page written 2026-09-08 (read-only session); decisions 1.1–6.1 made by
James the same day, all recommendations accepted. Nothing built yet.
