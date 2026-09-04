# Drawing item — a grid or coordinate-axes background

Design page, 2026-09-03. Decisions marked **D-n** are James's (all three
made 2026-09-03); **§Progress says what is built** (nothing yet). Source:
James's request 2026-09-03 — a graph background for graphing questions,
with a full graphing suite (labelled axes, scale, plotted points,
auto-scoring) deferred post-MVP. Context: PDF import already maps "make a
graph" prompts to `drawing_upload` (E2, `docs/pdf-import-enhancements.md`)
and James's rule is typed work for math, drawing only for graphs and
figures (E4) — so today every graph a student draws lands on a blank,
transparent canvas.

## What exists that this stands on

- **The drawing item carries two config fields**, both purely
  presentational and both in the `items.config` jsonb bag (no migration for
  a new field): `prompt_asset_id` and `canvas: { width, height }`
  (`packages/schema/src/items.ts:185-195` `DrawingCanvasSchema`;
  `db/schema.ts:137`). The same `DrawingCanvasSchema` is the delivery shape
  (`delivery.ts:115`).
- **`canvas` is passed through whole** everywhere it travels:
  `buildDeliveryBundle.ts:158`, `exportBundle.ts:185`, `importBundle.ts:390`,
  `lib/api/items.ts:442` (`itemConfigForWrite`). A new sub-field on
  `canvas` rides all four for free **once the Zod schema admits it** —
  Zod strips unknown keys silently, so a schema that is not updated drops
  the field with no error anywhere. There is no compiler guard for a new
  field on an existing type (unlike a new type, which fails every
  `assertNever`); the file list below is a checklist, not a build error.
- **The editor's drawing branch is inline** in `AssessmentEditor.tsx:2018-2133`
  (reference image picker + width × height pair; the half-filled-pair rule
  at `:959-966` saves "no canvas"). Defaults `canvas: null`
  (`defaultItemFor`, `:469`).
- **Preview / print** (`lib/preview/renderHtml.ts:295-309`): a blank
  `.write-area` box and the hint "Drawing canvas: W × Hpx". The print view
  is what a paper form is printed from.
- **The client's canvas is transparent** (`AssessmentPage.swift:722-841`):
  sized from `item.canvas` with an 800 × 600 fallback, `strokeStyle
  #1c1c1e`, `lineWidth 2.5`; **Clear** is `clearRect` over the whole
  canvas; **Save drawing** posts `toDataURL('image/png')`. The Swift mirror
  is `DrawingCanvas { width, height }` (`DeliveryItem.swift:51`).
- **The harness canvas records context calls** (`RendererHarness.swift:159-185`
  `__ops`: `lineWidth`, `strokeStyle`, `beginPath`, `moveTo`, `lineTo`,
  `stroke`, `clearRect`) — a background paint is assertable as ops, not as
  pixels. `fillRect` / `fillStyle` are not in the shim yet.
- **The installed client tolerates a new field** — the page reads
  `item.canvas.width/height` and ignores what it does not know; an older
  client shows a blank canvas for an item that asks for a grid. Safe
  direction.

## Proposed shape

**One optional value on `canvas` (D-1, D-2).**

```
canvas: { width, height, background?: "grid" | "axes" }
```

Absent = blank, exactly today. `grid` = square graph paper; `axes` = the
same grid with x and y axes through the centre, small arrowheads, no
numbers. Anything else (labels, scale, origin placement, plotted points,
auto-scoring) is the post-MVP suite.

**Geometry.** Cell = 40 px in canvas pixels (800 × 600 → 20 × 15 cells;
1000 × 700 → 25 × 17.5, the last row partial — accepted, the alternative
is a cell size that varies per canvas). Lines fall on `x + 0.5` for crisp
1 px strokes. Colours: paper `#ffffff`, minor lines `#dfe3ea`, every fifth
line `#b8c0cc`, axes `#1c1c1e` at 1.5 px with 8 px arrowheads and 4 px
ticks at every cell.

**Painted into the canvas (D-3).** The background is drawn first, strokes go
on top, so **the saved PNG carries the paper** — the teacher's view (when
one exists, F-1 in `docs/resume-prefill-design.md`) and the P-1 restore
see exactly what the student saw, and nothing downstream has to know the
grid exists. `Clear` becomes `clearRect` **then repaint**. A `blank`
canvas is not painted white — today's behaviour, byte-for-byte, so no
existing drawing changes. The P-1 restore draws the saved image *after*
the paint (the saved PNG already carries its paper, so the pixels agree).

**Editor.** A `Background` select — *Blank / Grid / Grid with axes* —
beside width × height in the drawing branch. Choosing a background with
no size filled in saves the 800 × 600 default explicitly (so `canvas` is
never `{ background }` alone; the schema keeps width and height required).
The half-filled-pair rule stays.

**Preview / print.** Hint reads "Drawing canvas: 800 × 600px · grid" /
"· grid with axes". The `.write-area` in print gets CSS graph paper
(`repeating-linear-gradient` at the same 40 px cell, scaled to the box);
axes are not drawn in print (a printed form's axes are a suite concern —
recorded as a limit).

**PDF import — not touched.** E2's verb rule keeps proposing
`drawing_upload`; suggesting `axes` for "graph / plot" verbs is a one-line
follow-up once teachers have used the toggle.

**Out of scope, v1.** Labelled axes, numeric scale, origin placement,
cell-size choice, plotted points, colour / width tools, auto-scoring,
axes in print, a new item type.

## Slices

1. **Design tool.** `packages/schema/src/items.ts` (`DrawingCanvasSchema`
   + `background`; `bun run build`); `db/schema.ts` (`DrawingCanvas` type);
   `lib/api/items.ts` (body schema — the shared Zod object carries it);
   `AssessmentEditor.tsx` (the `canvas` view type `:115`/`:204`, the
   select, the save payload `:959-966` with the default-size rule);
   `lib/preview/renderHtml.ts` (hint + print CSS); export / import need no
   code change but get a test each proving the field round-trips.
   `scripts/generate-delivery-fixture.ts:189` seeds `background: "axes"`
   and the Swift fixture is regenerated (every id churns — existing
   behaviour). Tests: `items-api` (accepted values, `sideways` refused,
   stored in config), `delivery-api` (rides the bundle), `import-api`
   (round trip), `preview-render` (hint + print class). Size S.
2. **Client.** `DeliveryItem.swift` (`DrawingCanvas.background: String?`);
   `AssessmentPage.swift` (`paintBackground(context, canvas, kind)` called
   at build and from Clear; unknown value → blank; `data-background` on the
   canvas element so the DOM says what was asked); harness: `fillStyle`,
   `fillRect` ops. Tests (`RendererDrawingTests`): blank paints nothing
   (ops byte-identical to today), `grid` paints `fillRect` + the expected
   line count for 800 × 600, `axes` adds the two axis strokes, Clear
   repaints (ops after `clearRect` are the paint), `DeliveryBundleTests`
   (fixture decodes `axes`). `swift test`, `xcodebuild`. Size S–M. **Rides
   the batch's client rebuild.**
3. **Hand-run rows.** Design tool: set each background, preview and print
   show it, export / import keep it, the bundle carries it. Client: grid
   and axes render under the strokes, Clear keeps the paper, the saved
   drawing carries the paper (open the PNG from storage), a blank item is
   unchanged.

## Decisions (James, 2026-09-03)

- **D-1 a toggle on `drawing_upload`, not a new item type.** A tenth union
  member fails every exhaustive switch on both sides and forces the
  rebuild anyway; a field on the existing type is the `canvas` precedent
  and degrades to a blank canvas on an older client. **Decided: toggle.**
- **D-2 values.** `grid` only vs `grid` + `axes` (unlabelled). **Decided:
  both.**
- **D-3 rendering.** Painted into the canvas so the PNG carries the paper,
  vs CSS-only behind a transparent canvas (every viewer would need its own
  grid). **Decided: painted in.**

## Progress

Slices 1–2 are batch 3 of `docs/client-fixes-batch-2026-09.md`, after P-1
(both touch `packages/schema`, the fixture and the Swift bundle model — one
owner at a time).

**Slice 1 BUILT 2026-09-03 (local).** The design tool.

- `packages/schema/src/items.ts`: `DrawingCanvasBackgroundSchema =
  z.enum(["grid", "axes"])`, `DrawingCanvasSchema.background?`; type
  exported. `dist` rebuilt. The one schema change carries the field
  everywhere `canvas` is passed through whole — `db/schema.ts`
  (`DrawingCanvas` is inferred from the package), the items body schema,
  the delivery / export / import branches — **none of those files needed an
  edit**; each is proven by a test instead (the design page listed
  `db/schema.ts` as a touchpoint; it was not).
- `AssessmentEditor.tsx`: the `canvas` view type carries `background`; a
  *Background* select (Blank / Grid / Grid with axes) beside width × height;
  `persistItem` sends `background` inside `canvas`, a background with no
  complete size (empty or half-filled) saves the 800 × 600 default
  explicitly, Blank omits the key. Minor: after saving a background with
  the size fields empty, the row stores 800 × 600 while the two inputs stay
  visually empty until reload — a hand-run glance.
- `lib/preview/renderHtml.ts`: hint `Drawing canvas: W × Hpx · grid` /
  `· grid with axes`; the `.write-area` gets `write-area--grid` (CSS graph
  paper at the client's 40 px cell, `print-color-adjust: exact`) **on screen
  and in print** — the slice-3 row says preview and print both show it —
  and axes are not drawn in either (the documented limit).
- `scripts/generate-delivery-fixture.ts` seeds `background: "axes"`; the
  Swift fixture regenerated (every id churned, as always). The client's
  `DrawingCanvas` ignores the unknown key — `swift test` 353 pass after two
  P-1 prefill tests were corrected in the same slice: they asserted the
  order item's shuffled labels as literals, and the shuffle is seeded from
  ids that churn on every regeneration; they now read the labels off the
  bundle.
- Tests: schema `items` (+3: grid / axes accepted, absent = blank, `dots`
  refused) and `delivery` (+1: the delivery drawing item keeps it);
  `items-api` (+4: stored in config and exported; PATCH back to Blank drops
  the key; `dots` → 400; `{ background }` with no size → 400 — the editor
  supplies the default, the API does not invent one); `delivery-api` (+1);
  `import-api` (+2: round trip; an older bundle reads blank);
  `preview-render` (+3). Schema 114 pass; design-tool 1119 pass; typecheck
  clean.

Built by an Opus 5 subagent from this page; diff reviewed and all suites
re-run in the main session.

**Slice 2 BUILT 2026-09-03 (local).** The client.

- `DeliveryItem.swift`: `DrawingCanvas.background: String?` — a plain
  string, not an enum, so a value a newer design tool starts sending can
  never fail the decode; the page decides what it means (unknown = blank).
- `AssessmentPage.swift`: `paintBackground(context, canvas, kind)` at build
  (after the pen setup, BEFORE the P-1 restore's `drawImage`) and from Clear
  (after `clearRect`). Only `grid` / `axes` paint; anything else records no
  op, so a blank canvas is byte-identical to before. Geometry as designed:
  40 px cells on the half pixel, white paper, `#dfe3ea` minor lines with
  every fifth `#b8c0cc` (drawn as two colour passes — visually identical,
  assertable as two ops); `axes` adds the centre axes in `#1c1c1e` at 1.5 px,
  8 px arrowheads at the +x (right) and +y (top) ends, and ticks. The pen is
  handed back explicitly (`lineWidth 2.5`, `strokeStyle #1c1c1e`). The
  canvas carries `data-background` for `grid` / `axes`. Three readings the
  page left open, all commented in the code: an arrowhead spreads 4 px
  either side of the axis; a tick reaches 4 px either side; **ticks sit on
  the grid lines**, not measured from the centre — the centre axis of a
  1000 px canvas is not on a grid line, and a tick should sit on paper the
  student can count. Centre = `floor(w/2) + 0.5`.
- Harness: `fillStyle` / `fillRect` ops.
- Tests: `RendererDrawingBackgroundTests` (new, 8): blank (key removed, and
  `dots`) records exactly the four pen-setup ops and no `data-background`;
  grid paints paper then the derived line counts (`lines(span) = #{n ≥ 0 :
  n·40 + 0.5 < span}`, 25 + 18 on 1000 × 700, 9 of them major) with the
  total op count pinned; the pen is handed back; axes on the fixture asserts
  the two axis lines through (·, 350.5) and (500.5, ·), both arrowheads, the
  first ticks and the counts; Clear repaints exactly the build-time paint,
  and on a blank canvas is a bare `clearRect`; the P-1 `drawImage` lands
  immediately after the paint; an unsized `grid` canvas gets 800 × 600
  paper. `RendererDrawingTests`: the two pen tests moved to a blank variant
  (the fixture now paints axes; they were about the pen).
  `DeliveryBundleTests` (+1): the fixture decodes `axes`; absent → nil;
  `dots` carried, not refused. `swift test` 362 pass (was 353); `xcodebuild
  … build` succeeds. Nine client rows in `client/MANUAL-CHECKS.md`
  ("Drawing background — grid and axes").
- Not testable headlessly: any pixel — crispness of the half-pixel lines,
  the round `lineCap` on tick ends, that `toDataURL` captures the paper, the
  real async `Image` decode order on resume. The rows cover them.

Built by an Opus 5 subagent from this page; diff reviewed and `swift test`
+ `xcodebuild` re-run in the main session.

**Slice 3 — hand-run DONE 2026-09-03 afternoon (origin, rev 10).** The
fixture carried Blank / Grid (800 × 500) / Grid with axes (800 × 600); the
demo student drew on all three, cleared and redrew the grid one, quit and
resumed. Eight of nine rows ✅, most of them by reading the stored PNGs back
from S3 (`aws s3 cp`, since the teacher side cannot show a drawing — F-1):
the grid paper with every fifth line darker and no axes; the axes with
arrowheads at the right and top ends and a tick per cell; dark thick strokes
on top of the paper; the paper intact across a Clear; the grid IN the saved
picture; the restored picture with no doubling reported; the blank canvas
transparent with only the stroke; the half-cell bottom row cut off. Not run:
the older-client row. Detail in `client/MANUAL-CHECKS.md` "Drawing
background — grid and axes".
