# Drawing item — pen size, colour, eraser, undo

Design note, 2026-09-08. Roadmap **4c** (`docs/roadmap-2026-09.md`), from
finding **S-7** of the 2026-09-08 client sitting
(`docs/client-ui-pass-design.md`): James asked for drawing tools on the
drawing item — pen size, colour, an eraser and undo — with the PNG contract
from `docs/drawing-background-design.md` unchanged. Client only; nothing on
the server or in the shared schema moves. Decisions marked **D-n** are
James's and are listed at the end; **§Progress says what is built**
(nothing yet).

## What exists that this stands on

- **The canvas** (`AssessmentPage.swift` `drawingField`, ~line 1382): one
  `<canvas class="drawing-canvas">` at the authored size (800 × 600
  fallback), `max-width: 100%; height: auto` so zoom cannot push it off the
  page (batch 4 slice B). Pointer handlers on the canvas: `pointerdown`
  begins a path, `pointermove` does `lineTo` + `stroke` **incrementally**,
  `pointerup` / `pointerleave` end it. Coordinates are mapped through the
  live `getBoundingClientRect()` so a CSS-scaled canvas still records in
  canvas pixels. The pen is fixed: `lineWidth 2.5`, `strokeStyle #1c1c1e`,
  round cap and join (`PEN_WIDTH` / `PEN_COLOR`). Nothing remembers a
  stroke after it is drawn — the canvas bitmap is the only state.
- **The paper is painted into the canvas** (`paintBackground`, D-3 of the
  background page): for `grid` / `axes`, an opaque white `fillRect`, then
  the minor and major lines, then the axes. A `blank` canvas gets **no
  paint at all** — it stays transparent, byte-for-byte as before that
  slice. The paint runs at build (before the resume restore) and again from
  Clear.
- **Clear** is `clearRect` over the whole canvas, then `paintBackground`;
  it also drops the restored picture (below) and un-marks the answer.
- **Save drawing** posts `toDataURL('image/png')` to the host over the
  `upload` channel; the host uploads to a presigned slot and calls
  `__secureTestDrawingResult` back. **The PNG is the whole answer**: the
  teacher's view (F-1, an `<img>` in the review queue) and the resume
  prefill show its pixels and know nothing about a grid or a tool. That is
  the contract this note keeps: whatever the tools do, they do it to the
  same canvas, and the saved bytes are still "what the student saw".
- **Resume prefill** (P-1, `docs/resume-prefill-design.md` D-5): the
  delivery bundle carries the saved PNG / JPEG inline in `saved_uploads`
  when it is ≤ 2 MB; the page draws it with `drawImage` **after** the paper
  paint (the saved picture already carries its own paper, so the pixels
  agree). The restored picture is a flat bitmap — it has no strokes to undo.
- **`marked`** (the "Draw something first." guard) flips true on the first
  `pointerdown` or on a restore, false on Clear.
- **The test shim** (`RendererHarness.swift` `__canvas`) records context
  calls as ops — `lineWidth`, `lineCap`, `lineJoin`, `strokeStyle`,
  `fillStyle`, `fillRect`, `beginPath`, `moveTo`, `lineTo`, `stroke`,
  `clearRect`, `drawImage` — and `createElement('canvas')` hands back a
  shimmed canvas, so an offscreen canvas would be recordable too. No
  `globalCompositeOperation`, no `save` / `restore`, no keyboard events.
  `RendererDrawingBackgroundTests` pins the exact op stream of the paint and
  the fact that a blank canvas records only the four pen-setup ops.
- **Theme and accommodations** (batch 4): every rule in `itemStyles` reads
  a token (`--paper`, `--ink`, `--line-strong`, `--accent`, `--accent-ink`
  …) and `PageShellTests` fails on any literal hex outside `:root`; the
  eight contrast sets redefine all twelve tokens on `html[data-contrast]`;
  nine zoom levels scale the root font size, so anything sized in `rem`
  grows with them. The grid paper's colours are canvas paint, deliberately
  **not** tokens, because they are baked into the PNG (batch 4 row: "the
  paper is unchanged under a contrast set").
- **Two things noticed while reading, both defects today:**
  - `.drawing-controls` and `.drawing-status` have **no CSS rule at all**
    — Clear and Save drawing are WebKit's default buttons, the same class
    of bug as the essay box (client-fixes #4) and the hand-in block
    (batch 4 slice A). The toolbar slice styles them with the same rules.
  - Under a **dark contrast set** (Reverse Contrast, Yellow on Black,
    Yellow on Blue, White on Red) a **blank** drawing canvas is transparent
    over a dark page, and the pen is `#1c1c1e`: the student draws dark ink
    on a dark ground and sees almost nothing. Grid / axes items are fine
    (opaque white paper). The fix belongs in this slice because the colour
    tools make it worse (a black swatch that draws invisible ink) — see
    **D-6**.
- **No Undo menu item.** The app's Edit menu deliberately carries no
  Undo / Redo (`AppDelegate.swift` ~line 828); Cut / Copy / Paste are
  disabled unless the bundle allows the clipboard. A page-level keyboard
  shortcut is therefore the page's own affair (the order item already
  reads Escape on `document.onkeydown` and chains the previous handler).

## Proposed shape

### The toolbar

One `<div class="drawing-tools" role="toolbar" aria-label="Drawing tools">`
**between the prompt image and the canvas** — above the canvas, so it is
in tab order before the surface it controls, sits where the hand is, and
cannot be pushed off screen by a tall canvas. `Clear` / `Save drawing` /
the status stay **below** the canvas exactly where they are (commit and
destroy stay away from the tools a student reaches for every few seconds).

Three groups, all native `<button type="button">`s (keyboard, focus ring and
VoiceOver come free), state carried by `aria-pressed`:

| Group | Buttons | Default | Notes |
|---|---|---|---|
| Tool | **Pen**, **Eraser** | Pen | one pressed at a time |
| Size | **Thin**, **Medium**, **Thick** | Medium (= today's 2.5) | `lineWidth` 1.5 / 2.5 / 5 for the pen; the eraser is 4× (6 / 10 / 20) so the same three buttons serve both tools |
| Colour | **Black**, **Red**, **Blue**, **Green** | Black (= today's `#1c1c1e`) | `#1c1c1e` / `#c8102e` / `#1f4fd8` / `#1e7d3a` — canvas paint, not tokens, chosen dark enough to read on white paper and apart from each other and from the grid greys; disabled while the eraser is active |
| — | **Undo** | disabled until there is a stroke | at the end of the strip |

A colour button is a swatch dot **plus its name as visible text**, not a
dot alone: a black dot is invisible on Reverse Contrast's black `--paper`,
and colour alone is not a state (WCAG 1.4.1). The pressed state is the
`.pager-strip button[aria-current]` treatment — `--accent` fill,
`--accent-ink` text — which every contrast set already inverts to the
pair's ink on paper. A hint line under the toolbar is not needed; the
buttons say what they are.

Markup is shared with nothing else, so no existing renderer test changes
meaning; `RendererDrawingTests.testOffersClearAndSave` counts two buttons
**in `.drawing-controls`**, which stays true (the toolbar's buttons live in
`.drawing-tools`).

### Where the state lives — a stroke list, replayed

Today the bitmap is the state. The tools need a second thing: **a list of
strokes** per canvas, each `{ tool: 'pen' | 'eraser', width, color,
points: [[x, y], …] }`. Drawing stays incremental (a `pointermove` still
does one `lineTo` + `stroke`, so nothing gets slower); the list is
appended as the pointer moves and is read only by **undo** and by the
eraser's repaint.

`rebuild()` = `clearRect` → `paintBackground` → `drawImage(baseline)` if a
restored picture exists → every stroke in order → the under-paint (next
section). Undo pops the last stroke and calls `rebuild()`. Porter-Duff
`over` is associative, so a replay lands on the same pixels as the
incremental drawing did.

- **The restored picture is a baseline, not strokes.** Undo stops at it
  (the button disables when the list is empty); the eraser works on it like
  on anything else (below). Clear still takes the baseline away.
- **Clear is not undoable** (D-4): it empties the list and the baseline,
  repaints the paper, and the Undo button disables. Making Clear one undo
  step is cheap with a list, but "Clear then Undo brings it all back" is a
  second mental model for a button whose copy says what it does.
- **`marked`** becomes "any pen stroke in the list, or a baseline" —
  undoing everything makes "Draw something first." true again, and
  eraser-only work on a blank canvas is not an answer.
- **Memory**: points are numbers in arrays; a long session on a 1000 × 700
  canvas is thousands of points, not megabytes. No cap.

### The eraser and the paper

Two ways an eraser can work on a canvas that carries its own paper:

1. **Paint the paper colour.** Wrong on both canvas kinds: on grid / axes
   it leaves white blobs with the grid lines missing; on blank it turns a
   transparent canvas into a white-blotched one, and the PNG changes
   shape for the teacher.
2. **Erase to transparent, then put the paper back underneath** —
   `globalCompositeOperation = 'destination-out'` for the eraser stroke,
   then the paper painted with `'destination-over'`, which fills only the
   pixels the eraser made transparent. The grid is deterministic, so the
   lines come back exactly where they were; a blank canvas gets nothing
   painted under it and stays transparent, which is its blank state.

**Recommended: 2 (D-3).** The under-paint is `paintBackground` with the
order reversed — axes, then lines, then the paper fill — because under
`destination-over` the first thing painted wins and the opaque paper must
go last. One flag on the existing function (`under: true`); the build-time
and Clear paths keep today's order and their pinned op stream. The
under-paint runs on every eraser `pointermove` (≈100 canvas ops on a 1000 ×
700 grid — nothing on any Mac; and if it ran only at `pointerup` a student
on a dark contrast set would see the page ground through the hole
mid-stroke) and once at the end of `rebuild()`. The eraser is round-capped
like the pen, so its trail is a smooth band. Alternative considered: paint
the paper once into an offscreen canvas and `drawImage` it under; simpler
per move but it moves the paint off the main canvas and rewrites the eight
background tests for no visible gain.

The pixels of an erased-and-underpainted region match the untouched paper
except along the band's anti-aliased edge, where a partially transparent
ink pixel now sits over fresh white — the same colour it sat over before.
Not testable headlessly; a hand-run row opens the saved PNG.

### Keyboard and VoiceOver

- Every tool is a button: Tab reaches them in reading order (Pen, Eraser,
  Thin, Medium, Thick, Black, Red, Blue, Green, Undo), Space / Return
  presses, `aria-pressed` tells VoiceOver which is on, `disabled` on Undo
  and the colours-under-eraser says why they do nothing. The focus ring is
  the page's `--accent` ring on `:focus-visible` (slice A).
- **Cmd-Z undoes the last stroke (D-5)** while focus is inside the drawing
  item (any toolbar button, or the canvas, which gets `tabindex="0"` and
  `aria-label="Drawing area"` so it can hold focus at all). Read on the
  item's `wrap` with `onkeydown`, not on the document — two drawing items
  on a page must not undo each other, and the essay's own Cmd-Z in a
  `<textarea>` is untouched because focus is not inside a drawing. There
  is no Edit → Undo menu item to route through, so WebKit hands the key
  event to the page; **whether that holds inside a real AAC session is a
  hand-run row**, and the button is the path that must work regardless.
  No Redo (a second stack for a feature James did not ask for).
- The canvas itself is a pointer surface. Drawing by keyboard is not in
  scope; VoiceOver users reach the tools and the buttons around it, and
  the accommodation for a student who cannot draw is the teacher's item
  choice, as today.
- The status span is not made `aria-live` for tool changes; a pressed
  toggle already announces its state. Undo announces nothing extra.

### Contrast sets and zoom

- The toolbar is styled **entirely in tokens and `rem`**: `--paper`
  buttons with a `--line-strong` border, `--ink` text, pressed = `--accent`
  / `--accent-ink`, gaps and padding in `rem`, `flex-wrap: wrap` so at
  zoom 3× the strip becomes two or three rows instead of overflowing. The
  no-literal-hex test keeps passing.
- The **swatch dot is the one literal colour**, inline as a `style`
  attribute on a `<span>` inside the button (not in the stylesheet, so the
  hex test is untouched and the dot always shows the ink it draws). It is
  ringed with a `--ink` border so it reads on every ground, and the name
  beside it carries the meaning.
- The ink colours and eraser are canvas paint and stay identical under
  every set, like the paper — the PNG is viewed on white by the teacher.
  That is what makes **D-6** necessary: a blank canvas must present the
  same white ground the PNG will be seen on, or a dark-set student cannot
  see their own ink.
- Zoom: sizes are `lineWidth` in canvas pixels and scale with the canvas's
  CSS size like today's pen; the pointer mapping is unchanged.

### What stays out

Shapes, text, fill / bucket, line straightening, a colour picker beyond the
four, an eraser that erases the restored baseline "as strokes", redo,
touch-pressure width, and any change to the PNG, the upload channel, the
delivery bundle or the design tool. The teacher's preview / print hint
keeps saying "Drawing canvas: W × Hpx".

## Slices

1. **Build — the tools (Opus 5 / medium, M).** `AssessmentPage.swift`:
   `itemStyles` rules for `.drawing-tools`, its buttons and the swatch, plus
   the missing `.drawing-controls` / `.drawing-status` rules;
   `drawingField` gains the toolbar, the stroke list, `rebuild()`, the
   eraser's composite modes and under-paint, Cmd-Z on the wrap, the new
   `marked` rule; `paintBackground(context, canvas, kind, under)`.
   Harness: `globalCompositeOperation` setter recorded as an op; a
   `keydown`-shaped call is plain `wrap.onkeydown({ key, metaKey,
   preventDefault })`, no dispatch needed. Tests, a new
   `RendererDrawingToolsTests`: the toolbar's buttons, labels and defaults;
   size / colour set `lineWidth` / `strokeStyle` before the next stroke;
   the eraser stroke records `destination-out`, then the reversed-order
   under-paint (axes → lines → paper, on the axes fixture), then
   `source-over` back; on a blank canvas the under-paint records nothing;
   undo replays paint → baseline → remaining strokes → under-paint with the
   op count pinned, and disables at zero; Cmd-Z on the wrap undoes, on the
   document does not; Clear empties the list and disables Undo; `marked`
   after undo-to-zero and after eraser-only; the two-button count in
   `.drawing-controls` unchanged; `PageShellTests`' hex test still passes;
   `RendererDrawingBackgroundTests` unchanged (build and Clear paint the
   same op stream). `swift test`, `xcodebuild`. One commit.
2. **Auto-save (Opus 5 / medium, S–M; D-8).** The page's
   debounce, dirty / in-flight state and flushes per §Auto-save; the host's
   in-flight counter on the submit path; the timer shim in the harness and
   the tests listed there. One commit.
3. **Hand-run rows (Sonnet 5 / medium, then James at the keyboard).** A
   block in `client/MANUAL-CHECKS.md`, on a Published assessment with a
   blank, a grid and an axes drawing (the `Client rows hand-run 2026-09-08`
   fixture has the grid + axes one; add a blank): each size and colour
   draws as labelled; the eraser removes ink and leaves the grid and axes
   intact, including across the band's edge; the eraser on a blank canvas
   leaves it transparent (open the PNG: no white blobs); undo removes one
   stroke at a time, the paper never goes, the button disables at zero;
   Cmd-Z with focus on a tool / on the canvas / in the essay; erase part of
   a restored picture after a relaunch; Clear then Undo does nothing;
   "Draw something first." after undoing everything; the saved PNG carries
   ink, erasures and paper; auto-save (if built): "Saved." appears on its
   own ~5 s after the last stroke with one `drawing saved` line per idle
   period, turning the page saves at once, Finish pressed mid-stroke still
   hands in with the drawing, nothing auto-saves offline; the toolbar
   under Reverse Contrast and Yellow
   on Blue (swatches readable, pressed state readable), at zoom 3× (wraps,
   ink lands under the pointer); VoiceOver reads each button's name and
   state; inside a **real** AAC session, Cmd-Z and the toolbar both work.

## Model and effort

Roadmap table row 4c: design note Fable / medium (this page); build Opus 5
/ medium in a fresh session from this page, diff reviewed and both checks
re-run in the main session before the commit; rows Sonnet 5 / medium.
Client only — no deploy; ships in the next client release
(`client/RELEASING.md`).

## Auto-save (James's question, 2026-09-08)

Asked after the decisions below: can the drawing save itself? Yes, on the
page, with one small host change. What it costs and how it would work:

- **Each save is a full upload**, not a diff: `toDataURL` → host →
  `requestUpload` (a new slot) → presigned PUT (a new S3 object) → the
  response PUT through the spool. A 1000 × 700 PNG with the grid is
  roughly 20–100 KB; the old objects stay until the attempt is deleted.
  Saving on every stroke would be dozens of three-round-trip uploads per
  item. So: **idle-debounced**, not per stroke.
- **When**: a timer restarted on every change (`pointerup` of a pen or
  eraser stroke, Undo, Clear-with-ink-present); fires after **5 s idle**;
  also **flushed at once** on a page turn in paged mode, when focus leaves
  the drawing item, and when Finish is pressed. Nothing fires while the
  canvas is untouched (`marked` false) or the picture is unchanged since
  the last successful save (a `dirty` flag).
- **One in flight at a time**: while a save is out, further changes set
  `dirty`; the `__secureTestDrawingResult` callback sends the next one if
  `dirty`. This keeps the host's Tasks from racing each other for the same
  item, and the "Saved." label true.
- **The status** reads "Saving…" → "Saved." on its own, and "Could not
  save. Tell your teacher." on a failure, retried on the next change. The
  **Save drawing button stays**: it is the offline path's evidence
  (`drawing ignored` + "Offline mode: not saved to a server."), the only
  thing that says "Draw something first.", and a student's way to force a
  save now. Offline (`OFFLINE_MODE`) auto-save is off — every save would
  be ignored and relabelled.
- **The host change** (`AssessmentViewController.handleDrawing`): an
  upload starts its own Task and the response only reaches the spool
  after the PUT, so a hand-in pressed while an upload is in flight can
  submit before that drawing's response exists. Today that window needs a
  student to press Save and Finish within a second; with auto-save the
  flush-on-Finish opens it on purpose. Fix: the host counts in-flight
  drawing uploads and the submit path waits for zero (bounded, say 20 s)
  before flushing the spool; `submit refused: N answers still unsent`
  already covers the spool half. Small, testable in
  `SecureTestCore` only if the counter lives there — otherwise a hand-run
  row.
- **Tests**: the debounce is a `setTimeout` in the page — the harness has
  no timers, so add a recordable `setTimeout` / `clearTimeout` shim
  (fires on demand) and assert: no post before the timer, one after, none
  when unchanged, a second post after the result callback when dirty,
  flush on Finish, nothing offline.

Cost of doing it in this slice: the build slice grows from M toward L and
touches the host. Alternative: ship the tools first, auto-save as its own
slice right after (same session, second commit) — recommended, so the
tools' diff stays reviewable on its own.

## Decisions (James, 2026-09-08)

- **D-1 sizes** — three (1.5 / 2.5 / 5 px), Medium = today's pen, eraser
  4×. **Decided: yes.**
- **D-2 colours** — four (Black, Red, Blue, Green), swatch + name.
  **Decided: yes.**
- **D-3 eraser mechanism** — `destination-out` + paper re-painted with
  `destination-over` on every move. **Decided: accepted.**
- **D-4 Clear is not undoable.** **Decided: yes.**
- **D-5 Cmd-Z** undoes while focus is inside the drawing item; no Redo.
  **Decided: yes.**
- **D-6 blank canvas ground** — opaque white on screen only, through a
  `--canvas-paper: #ffffff` token the contrast sets do not override; the
  PNG stays transparent. **Decided: the recommendation.**
- **D-7 Undo placement** — end of the toolbar. **Decided: yes.**
- **D-8 auto-save** — as described above. **Decided: a second slice after
  the tools.**

## Progress

This page written 2026-09-08 (read-only session); D-1…D-8 decided by James
the same day.

**Slice 1 BUILT 2026-09-08 (local, uncommitted at the time of writing → one
commit).** The tools, as designed, all in `client/SecureTestCore`:

- `AssessmentPage.swift`: the `.drawing-tools` toolbar between the prompt
  image and the canvas (Pen / Eraser, Thin / Medium / Thick, Black / Red /
  Blue / Green as swatch + name, Undo last — D-1, D-2, D-7), `aria-pressed`
  state, colours disabled under the eraser; the per-canvas stroke list,
  `rebuild()` (clear → paint → baseline → strokes → under-paint), `undo()`,
  `isMarked()` (any pen stroke, or a saved answer); the eraser as
  `destination-out` with the paper put back by `paintBackground(…, under)`
  in reversed order under `destination-over` on every move and at the
  stroke's end (D-3); Clear empties the list and drops the baseline (D-4);
  Cmd-Z on the item's wrap only, canvas `tabindex="0"` + "Drawing area"
  (D-5); the previously missing `.drawing-controls` / `.drawing-status`
  rules; `.drawing-canvas { background: var(--canvas-paper) }` (D-6). Two
  readings the page left open: the pen hand-back after a paint is the
  current tool's width / colour, kept on the element as `canvas.__pen`
  rather than a fifth parameter; on a blank canvas the under-paint records
  nothing, so the caller restores `source-over`.
- `PageShell.swift`: `--canvas-paper: #ffffff` on `:root`, outside the
  twelve tokens the contrast sets swap.
- Harness: `globalCompositeOperation` recorded as an op. Tests: new
  `RendererDrawingToolsTests` (17 — order and defaults of the strip,
  controls row unchanged, width / colour before a stroke, the eraser's
  modes and the reversed under-paint on the axes fixture with the
  mid-stroke count pinned, nothing put back on a blank canvas, undo replays
  the paint then the remaining stroke and disables at zero, undo-to-zero
  and eraser-only are unanswered, Clear repaints exactly the build paint,
  Cmd-Z on the wrap and not the document, plain Cmd-Z only, a restored
  picture redrawn after the paper on a rebuild, the D-6 token declared and
  never overridden). The existing drawing tests now scope their Clear /
  Save lookups to `.drawing-controls` (the item has twelve buttons, not
  two); every pinned paint op stream in `RendererDrawingBackgroundTests`
  passes verbatim. `PageShellTests`' `:root` hex count 12 → 13. `swift
  test` 465 pass (was 448); `xcodebuild … build` succeeds.
- Not testable headlessly: what an erased band looks like across a grid
  line, the swatch dot on each contrast set, Cmd-Z inside a real AAC
  session, the wrap at zoom 3×. Slice 3's rows.

Built by an Opus 5 / medium subagent from this page; diff reviewed and
both checks re-run in the main session before the commit.

**Slice 2 BUILT 2026-09-08 (local, one commit).** Auto-save, as §Auto-save
describes:

- `AssessmentPage.swift`: per-item `dirty` / `inFlight` / idle timer.
  `touched()` runs at the end of a real stroke (a `pointerleave` with no
  pointer down does nothing), on Undo and on Clear; it restarts the 5 s
  timer when the item is answered, and when it is not (undo-to-zero, Clear,
  eraser-only on a blank canvas) it schedules nothing and drops `dirty` — a
  blank PNG is not an answer and the server keeps the last saved picture.
  `flushNow()` is the single entry point: off offline, no-op unless dirty
  and answered, deferred while a save is in flight, else "Saving…" + one
  post. The host callback clears `inFlight` and, on success with new work
  dirty, posts again at once; on failure nothing retries on its own. The
  manual Save drawing button keeps its copy and guard and rides the same
  single-flight path (offline it behaves exactly as before). Flush points:
  every drawing block registers in `DRAWING_FLUSHES`; the pager's `show(n)`
  (the one funnel for Previous / Next / strip / review jumps) and Finish's
  onclick (before the submit post) call `flushAllDrawings()`;
  `wrap.onfocusout` flushes when `relatedTarget` is outside the item.
- `UploadGate.swift` (new, Core): an actor counting uploads in flight —
  `begin()` / `end()` / `inFlight` / `waitForIdle(timeout:)` resumed from
  `end()` by continuation, with a timeout that returns the count still out.
- `AssessmentViewController.swift`: `handleDrawing` brackets its Task with
  `begin()` and a deferred `end()`; `handleSubmit` waits for idle (20 s)
  before the spool flush and refuses with `submit refused: N drawing
  upload(s) still in flight` + a `submit_blocked` error event.
- Harness: `Node.contains`, a recording `setTimeout` / `clearTimeout`,
  `__fireTimers()`, `__pendingTimers()`. Tests: `RendererDrawingAutoSaveTests`
  (19) and `UploadGateTests` (5). `swift test` 489 pass (was 465);
  `xcodebuild … build` succeeds.
- Three readings, recorded: (1) a manual Save pressed while an upload is
  out sets `dirty` without a timer, so if that upload then FAILS the newer
  picture waits for the student's next change — the label says "Could not
  save. Tell your teacher.", nothing is silent; (2) Clear on a canvas that
  had a saved picture uploads nothing, so the server's last picture stays
  the answer until the student draws again — withdrawing a drawing for
  real is not a student path today; (3) the gate's `begin()` runs inside
  the upload Task and the submit's `waitForIdle` inside its own, both
  hopping from the main actor to the gate in enqueue order — FIFO among
  equal-priority jobs in practice, not a language guarantee. If a hand-run
  ever shows a submit overtaking an upload, the fix is a `@MainActor` gate
  whose `begin()` is synchronous before the Task is spawned.
- Not testable headlessly: the real 5 s cadence, the `focusout` path in
  WebKit, the host gate under a real hand-in. Slice 3's rows.

Built by an Opus 5 / medium subagent (one interrupted, a second finished
and verified the tree); diff reviewed and both checks re-run in the main
session before the commit.

**Slice 3 — rows WRITTEN 2026-09-08, NOT run.** Thirty-five rows in
`client/MANUAL-CHECKS.md` "Drawing tools — pen size, colour, eraser, undo,
auto-save (2026-09-08)": the strip and its defaults, each size and colour,
the eraser over grid / axes / blank / a restored picture, Undo semantics
(mixed strokes, the restored baseline, after Clear, to zero), Cmd-Z in a
real AAC session (toolbar focus, canvas focus, the essay untouched), the
stored PNG, Reverse Contrast and Yellow on Blue incl. the D-6 blank canvas
on screen vs its transparent PNG, zoom 3×, VoiceOver, the styled Clear /
Save buttons; then auto-save (one `drawing saved` per idle period,
continuous drawing, re-post during "Saving…", Undo saves, undo-to-zero /
Clear do not, the manual button, page turn, focus-out, Finish within a
second, the offline bundle, the relaunch). Needs a client rebuild, the
2026-09-08 fixture plus a blank and a grid drawing, the one-day
teacher-row script, and a real session for the Cmd-Z and hand-in rows.
Written by a Sonnet 5 / medium subagent from this page; reviewed in the
main session.
