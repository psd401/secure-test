import Foundation

/// Builds the page that presents an assessment.
///
/// The bundle reaches the page as its ORIGINAL JSON bytes rather than being
/// re-encoded from `DeliveryBundle`. The Swift model exists to validate the
/// payload and to give the host typed access to it; round-tripping through it
/// on the way to the renderer would mean any field the model does not yet know
/// about is silently dropped from what the student sees. Decode first to prove
/// the bytes are sound, then hand the page the bytes.
public enum AssessmentPage {
    /// - Parameters:
    ///   - title: assessment title, used for `<title>` and the heading.
    ///   - bundleJSON: the delivery response body, verbatim.
    ///   - offline: true on the offline path (`--bundle`, File → Open Test
    ///     Bundle…), where the host deliberately ignores uploads and hand-ins
    ///     (`drawing ignored` / `submit ignored`). Finding 8.5: with no result
    ///     callback ever coming, "Saving…" / "Handing in…" stuck forever, so
    ///     the page is told up front and labels the offline truth instead.
    ///     The server path leaves this at its default; the only difference in
    ///     the emitted document is the value of the `OFFLINE` constant.
    ///   - katex: the KaTeX assets to inline (ADR 0009). The default is the
    ///     vendored bundle; tests pass an empty one to see the page without it.
    ///   - accommodations: client UI pass slice B. The rendering
    ///     accommodations — contrast, optional font, zoom — become attributes
    ///     on `<html>` (`PageAccommodations`). The default reads them back out
    ///     of `bundleJSON`, which is what the two app callers get: they already
    ///     hand over the bundle's own bytes, and the effective per-student map
    ///     is a field of those bytes, so no caller has to learn a new argument
    ///     for the page to honour a student's settings. Passing the map
    ///     explicitly is for tests.
    public static func html(
        title: String,
        bundleJSON: String,
        offline: Bool = false,
        katex: KatexBundle.Assets = KatexBundle.shared,
        accommodations: [String: String]? = nil
    ) -> String {
        PageShell.document(
            title: title,
            styles: [katex.css, itemStyles],
            scripts: [
                // KaTeX first, so the renderer's closing math pass finds it.
                // A pure library; it touches nothing until asked. C-2
                // (2026-09-09): auto-render is NO LONGER inlined — the
                // renderer splits with its own `mathSegments` instead.
                katex.js,
                "const BUNDLE = \(JSONEmbedding.escapeForScriptElement(bundleJSON));",
                "const OFFLINE = \(offline);",
                KatexBundle.macrosScript,
                rendererScript,
            ],
            body: """
            <h1>\(HTMLEscape.text(title))</h1>
            <div id="items"></div>
            """,
            accommodations: accommodations ?? accommodationsIn(bundleJSON)
        )
    }

    /// Slice B: the effective accommodations map out of the bundle's own bytes.
    ///
    /// Deliberately lenient and deliberately narrow — it reads ONE object of
    /// strings and returns nothing on any surprise. The bundle has already been
    /// decoded and validated by the time a page is built (that is the whole
    /// contract in the type doc above); this exists so the page can be told how
    /// to paint itself without every caller threading a second argument, and a
    /// failure here must cost the accommodation, never the test.
    static func accommodationsIn(_ bundleJSON: String) -> [String: String] {
        guard let data = bundleJSON.data(using: .utf8),
              let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let raw = root["accommodations"] as? [String: Any]
        else { return [:] }
        return raw.compactMapValues { $0 as? String }
    }

    /// Client UI pass slice A (`docs/client-ui-pass-design.md` §A): every rule
    /// below reads a token from `PageShell.baseStyles`; no literal colour is
    /// left in this stylesheet. The old palette it replaced — `#0b5cd6`
    /// accent, `#f5f7fb` / `#d6dce8` panels, `#3a4a6a` eyebrow ink,
    /// `#2e7d32` / `#b7791f` pips, the assorted `#c7c7cc` / `#555` greys and
    /// the offline notice's `#6b4a00` / `#fff4d6` / `#e6c46a` amber — is
    /// pinned as gone by `PageShellTests`.
    static let itemStyles = """
    .choice { display: block; margin: 8px 0; line-height: 1.4; }
    .choice input { margin-right: 8px; }
    /* Client-fixes batch 1b (#3, 2026-09-03): withdraws a multiple-choice answer. */
    .clear-answer {
      font: inherit; font-size: 0.8125rem; padding: 4px 10px; margin-top: 6px;
      border: 1px solid var(--line-strong); border-radius: 6px; background: var(--paper); color: var(--ink);
    }
    .clear-answer:disabled { opacity: .4; }
    .short-text {
      width: 100%; box-sizing: border-box; padding: 8px 10px; font: inherit;
      border: 1px solid var(--line-strong); border-radius: 6px;
    }
    /* Client-fixes batch 1b (#4, 2026-09-03): the essay box had no rule at all, so
       WebKit's default two-row textarea showed. About ten lines, draggable taller. */
    .essay {
      width: 100%; box-sizing: border-box; min-height: 240px; padding: 8px 10px;
      font: inherit; border: 1px solid var(--line-strong); border-radius: 6px; resize: vertical;
    }
    /* Multi-source stimulus slice 1 (2026-09-09, docs/multi-source-stimulus-design.md):
       authored newlines were plain whitespace, so a poem or a paragraphed passage
       collapsed into one run of prose. pre-line keeps the breaks and still wraps. */
    .stem { white-space: pre-line; }
    .stem img { max-width: 100%; max-height: 360px; display: block; margin: 8px 0;
      border: 1px solid var(--line); border-radius: 4px; }
    /* Batch 0b slice 1 (2026-09-03): the hotspot had no rules at all since slice 57, so the
       frame was never positioned and the regions rendered as default buttons UNDER the image
       (hand-run finding, docs/roadmap-2026-09.md). The frame hugs the image so the regions'
       percent offsets resolve against the picture; a region is invisible until hovered or
       focused (James, 2026-09-03 — the picture is the question) and fills when selected. */
    .hotspot-frame { position: relative; display: inline-block; max-width: 100%; margin: 8px 0; line-height: 0; }
    .hotspot-frame img { display: block; max-width: 100%; height: auto; border: 1px solid var(--line); border-radius: 4px; }
    .hotspot-region {
      position: absolute; box-sizing: border-box; margin: 0; padding: 0; cursor: pointer;
      background: transparent; border: 2px dashed transparent; border-radius: 4px;
    }
    .hotspot-region:hover {
      background: color-mix(in srgb, var(--accent) 12%, transparent);
      border-color: color-mix(in srgb, var(--accent) 55%, transparent);
    }
    .hotspot-region:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; }
    /* Fix slice S-5 + S-5b (2026-09-08 sitting): the selected region needs to read as
       chosen on a busy picture, but a 45% wash hid the picture under it — 30% accent,
       a 3px accent border and an inset paper hairline; hover stays lighter. */
    .hotspot-region.selected {
      background: color-mix(in srgb, var(--accent) 30%, transparent);
      border: 3px solid var(--accent);
      box-shadow: 0 0 0 2px var(--paper) inset;
    }
    .hotspot-region.selected:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; }
    /* Fix slice S-9 (2026-09-08 sitting): the match item had no rules at all —
       the rows sat flush under the stem at browser-default size, hard to read
       and hard to hit. Sizing is rem throughout so it scales with data-zoom;
       colours are slice A tokens so the eight contrast sets restyle it too. */
    .match { margin-top: 1rem; }
    .match-row {
      display: flex; align-items: center; gap: 0.75rem; min-height: 2.75rem;
      padding: 0.6rem 0.75rem; font-size: 1rem; margin: 0.5rem 0;
    }
    .match-left { flex: 1; line-height: 1.4; }
    .match-select { font: inherit; padding: 0.4rem 0.6rem; min-width: 12rem; }
    /* Slice B: the canvas keeps its intrinsic pixel size (that is the answer's
       resolution and must not move), but it may not be wider than the column —
       at zoom 3X the rem gutters alone are 240 px and an 800 px canvas would
       push the page sideways. The pointer mapping is unaffected: it divides by
       the LIVE getBoundingClientRect width every time a pointer moves, so a
       CSS-scaled canvas still records strokes in canvas coordinates. */
    /* Drawing tools D-6: the canvas presents white paper on screen even when it
       paints none into its own bitmap. A blank canvas is transparent, so under a
       dark contrast set the student drew dark ink on a dark ground and saw
       almost nothing. `--canvas-paper` is the one token no contrast set
       overrides; the saved PNG is unaffected. */
    .drawing-canvas { max-width: 100%; height: auto; background: var(--canvas-paper); }
    /* Drawing tools slice 1 (docs/drawing-tools-design.md): the pen / eraser /
       size / colour strip ABOVE the canvas, so it is in tab order before the
       surface it controls and cannot be pushed off screen by a tall canvas.
       `.drawing-controls` and `.drawing-status` had no rule at all since slice
       68 — Clear and Save drawing rendered as WebKit's default buttons, the same
       class of bug as the essay box — so they are styled here too, with the same
       treatment as `.clear-answer` / `.order-move`. Tokens and rem only, so the
       eight contrast sets and the nine zoom levels reach the strip; `flex-wrap`
       is what turns it into two or three rows at 3X instead of overflowing. The
       swatch's colour is an inline style on the span, the one literal colour on
       the page — it must show the ink it actually draws. */
    .drawing-tools {
      display: flex; flex-wrap: wrap; align-items: center; gap: 0.375rem; margin: 0.5rem 0;
    }
    .drawing-tools button {
      font: inherit; font-size: 0.8125rem; padding: 0.3rem 0.6rem;
      display: inline-flex; align-items: center; gap: 0.35rem;
      border: 1px solid var(--line-strong); border-radius: 6px;
      background: var(--paper); color: var(--ink); cursor: pointer;
    }
    .drawing-tools button:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; }
    /* The pressed treatment is the pager strip's: every contrast set inverts
       the pair, so the chosen tool reads as chosen on all eight. */
    .drawing-tools button[aria-pressed="true"] {
      background: var(--accent); color: var(--accent-ink); border-color: var(--accent);
    }
    .drawing-tools button:disabled { opacity: .4; cursor: default; }
    .drawing-swatch {
      display: inline-block; width: 0.75rem; height: 0.75rem;
      border-radius: 50%; border: 1px solid var(--ink);
    }
    .drawing-controls {
      display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem; margin-top: 0.5rem;
    }
    .drawing-controls button {
      font: inherit; font-size: 0.8125rem; padding: 0.3rem 0.6rem;
      border: 1px solid var(--line-strong); border-radius: 6px;
      background: var(--paper); color: var(--ink); cursor: pointer;
    }
    .drawing-controls button:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; }
    .drawing-status { font-size: 0.8125rem; color: var(--ink-soft); }
    .drawing-status.saved { color: var(--ok); }
    .missing-asset { color: var(--danger); font: 0.75rem ui-monospace, monospace; }
    .unsupported { color: var(--ink-soft); font-style: italic; font-size: 0.875rem; }
    .offline-notice {
      color: var(--warn); background: color-mix(in srgb, var(--warn) 12%, var(--paper));
      border: 1px solid color-mix(in srgb, var(--warn) 45%, var(--paper));
      border-radius: 6px; padding: 8px 12px; font-size: 0.875rem; margin: 0 0 16px;
    }
    /* E5 slice 2: the stimulus block above a set, and its questions indented under it. */
    .stimulus { margin: 24px 0 8px; padding: 12px 14px; background: var(--panel); border: 1px solid var(--panel-line); border-left: 4px solid var(--accent); border-radius: 6px; }
    .stimulus-label { margin: 0 0 6px; font-family: var(--font-heading); font-size: 0.75rem; font-weight: 600; letter-spacing: .04em; text-transform: uppercase; color: var(--ink-soft); }
    .stimulus-body { margin: 0; line-height: 1.5; white-space: pre-line; }
    .stimulus-body img { max-width: 100%; max-height: 480px; display: block; margin: 8px 0; border: 1px solid var(--line); border-radius: 4px; }
    /* Multi-source stimulus slice 4: the labelled sources under a set's
       introduction. Tokens only, so the eight contrast sets and the zoom levels
       (batch 4) reach the pane with no rule of their own. */
    .source-pane { margin-top: 12px; }
    .source-tabs { display: flex; flex-wrap: wrap; gap: 4px; border-bottom: 1px solid var(--panel-line); }
    .source-tab { font: inherit; font-size: 0.875rem; padding: 6px 12px; border: none; border-bottom: 3px solid transparent; background: transparent; color: var(--ink-soft); cursor: pointer; }
    .source-tab-open { border-bottom-color: var(--accent); color: var(--accent-ink); background: var(--accent); border-radius: 4px 4px 0 0; }
    .source-tab:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    .source-label { margin: 0 0 6px; font-family: var(--font-heading); font-size: 0.8125rem; font-weight: 600; color: var(--ink-soft); }
    /* A two-page article must not push the answer box off the screen, so the
       panel scrolls inside the pane rather than growing the page. */
    .source-panel { max-height: 60vh; overflow: auto; padding: 8px 2px 0; }
    .source-panel[hidden] { display: none; }
    .source-panel:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    .source-body { margin: 0; line-height: 1.5; white-space: pre-line; }
    .source-body img { max-width: 100%; max-height: 480px; display: block; margin: 8px 0; border: 1px solid var(--line); border-radius: 4px; }
    /* side_by_side: the sources left, the question(s) right, each column
       scrolling on its own. The columns are chosen at build time (>= 1100 px);
       this query is the safety net for a window dragged smaller afterwards. */
    .side-by-side { display: flex; gap: 24px; align-items: flex-start; }
    .side-by-side > .side-source { flex: 0 0 55%; min-width: 0; max-height: 78vh; overflow: auto; }
    .side-by-side > .side-questions { flex: 1 1 auto; min-width: 0; max-height: 78vh; overflow: auto; }
    @media (max-width: 1099px) {
      .side-by-side { display: block; }
      .side-by-side > .side-source, .side-by-side > .side-questions { max-height: none; overflow: visible; }
    }
    /* C-1 (2026-09-09, docs/multi-source-stimulus-design.md): the student's own
       choice of where the sources sit. `stacked` is deliberately the SAME
       collapse the query above performs — "above the question" is the narrow
       presentation, asked for rather than forced — duplicated instead of joined
       to it because the query's rules must stay conditional on the width and
       these must not. The toggle takes `.drawing-controls button` /
       `.pager-strip button` treatment: tokens and rem only, so the eight
       contrast sets and the nine zoom levels (batch 4) reach it for free. */
    .side-by-side.stacked { display: block; }
    .side-by-side.stacked > .side-source, .side-by-side.stacked > .side-questions { max-height: none; overflow: visible; }
    .layout-toggle { display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem; margin: 0 0 0.5rem; }
    .layout-toggle-label { font-size: 0.8125rem; color: var(--ink-soft); }
    .layout-toggle button {
      font: inherit; font-size: 0.8125rem; padding: 0.3rem 0.6rem;
      border: 1px solid var(--line-strong); border-radius: 6px;
      background: var(--paper); color: var(--ink); cursor: pointer;
    }
    .layout-toggle button[aria-pressed="true"] { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); }
    .layout-toggle button:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; }
    /* E7(b): a short-text answer typed as a formula previews as rendered math. */
    .formula-hint { margin: 4px 0 0; font-size: 0.75rem; color: var(--ink-soft); }
    .formula-preview { min-height: 1.6em; margin: 4px 0 0; padding: 2px 6px; color: var(--ink); }
    .formula-preview:empty { display: none; }
    /* Fix slice S-4 (2026-09-08 sitting): half-typed math is normal, so a parse failure
       says so in words instead of showing KaTeX's red error markup. */
    .formula-preview-note { display: inline-block; margin-left: 0.25rem; font-size: 0.8125rem; color: var(--ink-soft); }
    /* Roadmap 4b slice 1b (2026-09-08, docs/math-entry-design.md): the math
       keypad under the short-text preview (D-2.1 — field, preview, toggle, pad,
       so the picture is never pushed off the bottom at zoom 3X while the student
       is pressing keys). Tokens and rem ONLY: the eight contrast sets and the
       nine zoom levels reach the pad for free, and PageShellTests' no-literal-hex
       rule holds without exception here — unlike the drawing swatches, no key has
       a colour of its own. The toggle and the keys take the same treatment as
       `.pager-strip button` / `.drawing-controls button`; the active pair is
       `--accent` / `--accent-ink`, which every contrast set inverts, so the
       pressed instant reads on all eight. Keys are `min-height` / `min-width`
       2.75rem (the S-3 lesson: targets too tight to hit), and the three rows
       each take a full line (`flex: 1 0 100%`) so the pad reads as Structure /
       Operators / Greek at 1X and wraps into more lines at 3X rather than
       scrolling sideways. The pad is collapsed with the `hidden` attribute, so
       the rule below is what beats `display: flex`. */
    .math-keys-toggle {
      font: inherit; font-size: 0.8125rem; padding: 0.3rem 0.6rem; margin-top: 0.5rem;
      border: 1px solid var(--line-strong); border-radius: 6px;
      background: var(--paper); color: var(--ink); cursor: pointer;
    }
    .math-keys-toggle:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; }
    .math-keys { display: flex; flex-wrap: wrap; gap: 0.375rem; margin-top: 0.5rem; }
    .math-keys[hidden] { display: none; }
    .math-keys-row { display: flex; flex-wrap: wrap; gap: 0.375rem; flex: 1 0 100%; }
    .math-keys button {
      min-height: 2.75rem; min-width: 2.75rem;
      font: inherit; font-size: 1rem; padding: 0 0.6rem;
      border: 1px solid var(--line-strong); border-radius: 6px;
      background: var(--paper); color: var(--ink); cursor: pointer;
    }
    .math-keys button:active {
      background: var(--accent); border-color: var(--accent); color: var(--accent-ink);
    }
    .math-keys button:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; }
    /* E12 slice 3: the outline a student writes in place of a missing earlier answer. */
    .outline-inline { margin-top: 10px; }
    .outline-hint { margin: 0 0 6px; font-size: 0.8125rem; color: var(--ink-soft); }
    .outline-inline textarea { width: 100%; min-height: 140px; font: inherit; padding: 8px 10px; border: 1px solid var(--line-strong); border-radius: 4px; }
    .outline-status { margin: 4px 0 0; font-size: 0.75rem; color: var(--ink-soft); }
    /* Client UI pass slice E (D-D2, 2026-09-07), reworked by fix slice S-1 (2026-09-08):
       the order item is draggable as well as button-operable, and the drag is POINTER
       tracking, not HTML5 drag-and-drop — under a real AAC session the drop never landed
       and the row snapped back. The drop indicator is drawn on the row under the pointer
       rather than as an extra element, in rem so it scales with data-zoom. `touch-action`
       and `user-select` are off on a row so a drag does not scroll or select instead.
       S-3: the rows were too tight to read or to hit; heights, padding and type are up.
       Colours are slice A tokens, so the eight contrast sets (slice B) restyle it too. */
    .order { margin-top: 1rem; margin-bottom: 0.5rem; }
    .order-row {
      display: flex; align-items: center; gap: 0.75rem;
      min-height: 2.75rem; padding: 0.6rem 0.75rem; margin: 0.25rem 0; font-size: 1rem;
      border: 1px solid var(--line); border-radius: 6px; background: var(--paper); cursor: grab;
      touch-action: none; -webkit-user-select: none; user-select: none;
    }
    .order-row:active { cursor: grabbing; }
    .order-position { min-width: 1.6em; font-size: 1rem; color: var(--ink-soft); }
    .order-label { flex: 1; line-height: 1.4; }
    .order-move { font: inherit; padding: 2px 8px; border: 1px solid var(--line-strong); border-radius: 6px; background: var(--paper); color: var(--ink); cursor: pointer; }
    .order-move:disabled { opacity: .4; cursor: default; }
    .order-row.dragging { opacity: .5; position: relative; z-index: 1; cursor: grabbing; }
    .order-row.drop-before { box-shadow: inset 0 0.125rem 0 0 var(--accent); }
    .order-row.drop-after { box-shadow: inset 0 -0.125rem 0 0 var(--accent); }
    .order-hint { margin: 0 0 6px; font-size: 0.8125rem; color: var(--ink-soft); }
    .order-status { margin: 4px 0 0; font-size: 0.75rem; color: var(--ink-soft); }
    .item.in-set { margin-left: 16px; padding-left: 12px; border-left: 3px solid var(--panel-line); }
    /* E3 slice 3: the table the student fills in — one text field per body cell. */
    .fill-table-wrap { overflow-x: auto; margin: 8px 0; }
    .fill-table { border-collapse: collapse; font: inherit; }
    .fill-table th, .fill-table td { border: 1px solid var(--line-strong); padding: 4px 6px; text-align: left; vertical-align: middle; }
    .fill-table th { background: var(--panel); font-weight: 600; }
    .fill-table .table-cell { width: 7em; box-sizing: border-box; padding: 6px 8px; font: inherit; border: 1px solid var(--line-strong); border-radius: 4px; }
    /* Client paging: one page at a time, a bar fixed to the bottom to move between them. */
    .page[hidden] { display: none; }
    .page-label { margin: 0 0 12px; font-family: var(--font-heading); font-size: 0.8125rem; font-weight: 600; letter-spacing: .04em; text-transform: uppercase; color: var(--ink-soft); }
    /* Slice A takes the §D item that is cheap here: the heading is focused on
       every page change (tabindex -1), and it used to suppress the ring the
       browser draws for that, so a keyboard student saw nothing move.
       A ring on both :focus and :focus-visible — a programmatic focus() on a
       tabindex -1 element does not always satisfy :focus-visible. */
    .page-label:focus, .page-label:focus-visible {
      outline: 2px solid var(--accent); outline-offset: 4px; border-radius: 3px;
    }
    .page .item { border-bottom: none; }
    .passage-ref { margin: 0 0 16px; }
    .passage-ref summary { cursor: pointer; font-size: 0.875rem; color: var(--accent); }
    .passage-ref .stimulus { margin-top: 8px; }
    .review-list { list-style: none; margin: 0 0 24px; padding: 0; display: flex; flex-wrap: wrap; gap: 8px; }
    .review-list button, .pager-strip button { font: inherit; font-size: 0.8125rem; padding: 4px 10px; border: 1px solid var(--line-strong); border-radius: 6px; background: var(--paper); color: var(--ink); }
    /* Slice B: the bar and everything in it is sized in `rem` and allowed to
       wrap, so at zoom 3X the row becomes three stacked lines inside a taller
       bar instead of overflowing the window; `min-width: 0` lets the label
       shrink rather than push the buttons off the edge. */
    .pager { position: fixed; left: 0; right: 0; bottom: 0; max-height: 60vh; overflow-y: auto; padding: 0.625rem 2.5rem 0.75rem; background: var(--panel); border-top: 1px solid var(--panel-line); }
    .pager-row { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 0.75rem; }
    .pager-row button { font: inherit; padding: 0.5rem 1rem; border: 1px solid var(--line-strong); border-radius: 6px; background: var(--paper); color: var(--ink); }
    .pager-row button:disabled { opacity: .4; }
    .pager-current { font-size: 0.875rem; font-weight: 600; color: var(--ink); min-width: 0; }
    .pager-strip { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
    .pager-strip button[aria-current="page"] { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); }
    .pager-strip button.answered { border-color: var(--ok); color: var(--ok); }
    .pager-strip button.partial { border-color: var(--warn); color: var(--warn); }
    .pager-strip button.answered[aria-current="page"], .pager-strip button.partial[aria-current="page"] { color: var(--accent-ink); }
    /* Slice A, WCAG 1.4.1: a pip's state is never colour alone. The renderer
       already appends a check mark to a fully-answered pip's TEXT (and every pip
       carries the state in its aria-label); a partly-answered one gets its
       glyph here, in CSS, so the emitted DOM is unchanged. */
    .pager-strip button.partial::after { content: " \\2026"; }
    /* Slice A: the hand-in block had NO rules at all — the same class of bug as
       the essay box (client-fixes #4). The one filled button on the page.
       Its text and the status copy are the hand-in contract and are untouched. */
    .finish { margin: 32px 0 0; padding: 20px 0 0; border-top: 1px solid var(--line); }
    .finish button {
      font: inherit; font-size: 1rem; font-weight: 600; padding: 10px 20px;
      border: 1px solid var(--accent); border-radius: 8px;
      background: var(--accent); color: var(--accent-ink); cursor: pointer;
    }
    .finish button:disabled { opacity: .5; cursor: default; }
    /* Slice B: every contrast set makes --accent the ink and --accent-ink the
       paper (so the filled button carries its label at the body ratio), which
       would have left slice A's plain --ink ring invisible ON an --ink fill.
       A --paper halo hugs the button and the ink ring sits outside it, so the
       ring reads on the fill AND on the page in all eight sets. */
    .finish button:focus-visible {
      outline: 3px solid var(--ink); outline-offset: 3px;
      box-shadow: 0 0 0 2px var(--paper);
    }
    .finish-status { margin: 10px 0 0; font-size: 0.875rem; color: var(--ink-soft); }
    """

    // No `</` sequence appears in this script, so it cannot close its own
    // element. Item content never reaches innerHTML — every piece of authored
    // text becomes a text node — so a stem shaped like markup renders as the
    // characters it is.
    static let rendererScript = #"""
    (function () {
      'use strict';

      var ASSETS = (BUNDLE && BUNDLE.assets) || {};
      // tool_id -> setting value, already resolved for this student.
      var ACCOMMODATIONS = (BUNDLE && BUNDLE.accommodations) || {};
      // Slice 69: absent means locked. A client that has not heard of this flag
      // stays closed rather than open.
      var ALLOW_CLIPBOARD = !!(BUNDLE && BUNDLE.allow_clipboard);
      // Finding 8.5: on the offline path the host ignores uploads and
      // hand-ins by design, so the "in flight" labels would never resolve.
      // Anything short of an explicit true is the server path.
      var OFFLINE_MODE = OFFLINE === true;

      // Page-level enforcement, paired with the host disabling its Edit menu.
      // Both are needed: the menu governs the keyboard shortcuts, and these
      // govern the paths that never reach a menu — a trackpad gesture, a
      // scripted clipboard call, or a drag out of a text field.
      if (!ALLOW_CLIPBOARD) {
        var deny = function (event) {
          if (event && event.preventDefault) event.preventDefault();
          return false;
        };
        document.oncopy = deny;
        document.oncut = deny;
        document.onpaste = deny;
      }
      var ITEMS = (BUNDLE && BUNDLE.items) || [];
      // E5 slice 2: stimuli shared by contiguous items. The server guarantees
      // contiguity, so a set opens at its first member and every member is
      // marked; an id that is not in ITEMS is ignored, and a layout the page
      // does not know renders like inline (one scrolling page — own_page has
      // nothing to attach to until per-question paging exists).
      var SETS = (BUNDLE && BUNDLE.item_sets) || [];
      var ASSET_REF_RE = /!\[([^\]]*)\]\(asset:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\)/gi;

      // Client paging follow-up (D-4): which questions hold an answer —
      // seeded from the server (this attempt's saved responses, honest after
      // a relaunch) and kept current as the page posts. Read only by the
      // paged bar and review page; scroll mode never consults it.
      var ANSWERED = {};
      ((BUNDLE && BUNDLE.answered_item_ids) || []).forEach(function (id) {
        if (typeof id === 'string') ANSWERED[id] = true;
      });
      var onAnswered = null;
      function markAnswered(itemId) {
        ANSWERED[itemId] = true;
        if (typeof onAnswered === 'function') onAnswered();
      }

      // P-1 (docs/resume-prefill-design.md): the ANSWERS behind those marks —
      // this attempt's own saved responses, keyed by item id, and the drawing
      // bytes they name. The 2026-09-03 sitting is why: the marks were right
      // and the fields under them were empty, so a student read a green check
      // over an empty box as a lost answer and typed it again.
      //
      // Restoring is done at BUILD time by each field builder, by setting
      // `.checked` / `.value` / `selected[...]` / the entries order directly.
      // That fires no `onchange`, so nothing is posted and nothing is marked
      // for a restore (D-3): the saved state IS the baseline, and the spool
      // sees nothing until the student changes something.
      var SAVED = (BUNDLE && BUNDLE.saved_responses) || {};
      var SAVED_UPLOADS = (BUNDLE && BUNDLE.saved_uploads) || {};

      // The saved answer for one item, or null. A value is used only when it
      // is an object whose `type` is this item's own type — an item whose
      // type changed under a saved answer (or a value shaped like something
      // else) costs one prefilled field, never a broken field.
      function savedFor(item) {
        if (!item || typeof item.id !== 'string') return null;
        if (!Object.prototype.hasOwnProperty.call(SAVED, item.id)) return null;
        var value = SAVED[item.id];
        if (!value || typeof value !== 'object') return null;
        return value.type === item.type ? value : null;
      }

      // Batch 0b slice 3 (2026-09-03): `mark === false` posts without touching
      // the answered mark — the caller decides (match marks on completeness).
      function post(itemId, response, mark) {
        try {
          window.webkit.messageHandlers.response.postMessage({
            item_id: itemId,
            response: response
          });
          if (mark !== false) markAnswered(itemId);
        } catch (e) {
          console.log('response post failed: ' + (e && e.message));
        }
      }

      // Client-fixes batch 1b (#3, 2026-09-03): the mirror of markAnswered —
      // an item goes back to unanswered so the paged strip button loses its
      // mark and the review count drops.
      function markUnanswered(itemId) {
        delete ANSWERED[itemId];
        if (typeof onAnswered === 'function') onAnswered();
      }

      function withdraw(itemId) {
        try {
          window.webkit.messageHandlers.withdraw.postMessage({ item_id: itemId });
        } catch (e) {
          console.log('withdraw post failed: ' + (e && e.message));
        }
        markUnanswered(itemId);
      }

      // E6 (decision James 2026-09-02): `**bold**` and `_italic_` in authored
      // text, by the same rules as the design tool's renderItemContent —
      // never inside `$…$` / `$$…$$` (a `$x_1$` subscript stays math), an
      // italic run opens at a word boundary and closes before one, a run is
      // never empty, never starts or ends with whitespace, never crosses a
      // newline, a blank line of underscores is not a run, bold is parsed
      // first with italic inside it. Still DOM only: the markers become
      // strong / em ELEMENTS with text-node children; nothing authored is
      // parsed as markup. Math segments are left as plain text nodes for
      // the closing math pass to find afterwards.
      var BOLD_RE = /\*\*([^*\s](?:[^*\n]*?[^*\s])?)\*\*/g;
      var ITALIC_RE = /(^|[\s(\[{"'\u201c\u2018])_([^_\s](?:[^_\n]*?[^_\s])?)_(?=$|[\s.,;:!?)\]}"'\u201d\u2019])/g;

      // Math-aware split: [{ math: bool, text }] in order, `\$` kept literal.
      function mathSegments(text) {
        var segs = [], i = 0, start = 0, len = text.length;
        while (i < len) {
          var ch = text.charAt(i);
          if (ch === '\\' && text.charAt(i + 1) === '$') { i += 2; continue; }
          if (ch === '$') {
            var display = text.charAt(i + 1) === '$';
            // C-2 (James, 2026-09-09, docs/multi-source-stimulus-design.md): a
            // single `$` whose next character is a digit is money, not an
            // opener — `$57,600 … $30,000` in a pilot stimulus rendered as
            // math. `$$` display openers and `\$` escapes are unchanged; an
            // author who wants math starting with a digit writes `${5x+3}$`
            // or `$ 5x+3$`.
            if (!display && text.charAt(i + 1) >= '0' && text.charAt(i + 1) <= '9') {
              i += 1;
              continue;
            }
            var open = display ? 2 : 1;
            var scan = i + open, close = -1;
            while (scan < len) {
              if (text.charAt(scan) === '\\' && text.charAt(scan + 1) === '$') { scan += 2; continue; }
              if (text.charAt(scan) === '$') {
                if (display) {
                  if (text.charAt(scan + 1) === '$') { close = scan; break; }
                  scan += 1; continue;
                }
                close = scan; break;
              }
              scan += 1;
            }
            if (close === -1) { i += 1; continue; }
            if (i > start) segs.push({ math: false, text: text.slice(start, i) });
            segs.push({ math: true, text: text.slice(i, close + open) });
            i = close + open; start = i;
            continue;
          }
          i += 1;
        }
        if (start < len) segs.push({ math: false, text: text.slice(start) });
        return segs;
      }

      function italicNodes(text, into) {
        var last = 0, m;
        ITALIC_RE.lastIndex = 0;
        while ((m = ITALIC_RE.exec(text)) !== null) {
          var before = text.slice(last, m.index) + m[1];
          if (before) into.appendChild(document.createTextNode(before));
          var em = document.createElement('em');
          em.appendChild(document.createTextNode(m[2]));
          into.appendChild(em);
          last = m.index + m[0].length;
        }
        if (last < text.length) into.appendChild(document.createTextNode(text.slice(last)));
      }

      function emphasisNodes(text) {
        var frag = document.createDocumentFragment();
        if (typeof text !== 'string' || text.length === 0) return frag;
        mathSegments(text).forEach(function (seg) {
          if (seg.math) { frag.appendChild(document.createTextNode(seg.text)); return; }
          var last = 0, m;
          BOLD_RE.lastIndex = 0;
          while ((m = BOLD_RE.exec(seg.text)) !== null) {
            italicNodes(seg.text.slice(last, m.index), frag);
            var strong = document.createElement('strong');
            italicNodes(m[1], strong);
            frag.appendChild(strong);
            last = m.index + m[0].length;
          }
          italicNodes(seg.text.slice(last), frag);
        });
        return frag;
      }

      // For places that can only hold plain text (a select's options): the
      // markers go, the words stay.
      function stripEmphasis(text) {
        if (typeof text !== 'string') return '';
        return mathSegments(text).map(function (seg) {
          if (seg.math) return seg.text;
          return seg.text.replace(BOLD_RE, '$1').replace(ITALIC_RE, '$1$2');
        }).join('');
      }

      // Splits `![alt](asset:uuid)` refs out of authored text, emitting text
      // nodes (with E6 emphasis) for the prose and img elements for the refs.
      // Built as DOM rather than markup so nothing authored can become an
      // element.
      function textWithAssets(text) {
        var frag = document.createDocumentFragment();
        if (typeof text !== 'string' || text.length === 0) return frag;
        var last = 0, m;
        ASSET_REF_RE.lastIndex = 0;
        while ((m = ASSET_REF_RE.exec(text)) !== null) {
          if (m.index > last) {
            frag.appendChild(emphasisNodes(text.slice(last, m.index)));
          }
          var alt = m[1] || '';
          var id = m[2].toLowerCase();
          var asset = ASSETS[id];
          if (asset && asset.base64 && asset.content_type) {
            var img = document.createElement('img');
            img.src = 'data:' + asset.content_type + ';base64,' + asset.base64;
            img.alt = alt;
            frag.appendChild(img);
          } else {
            var span = document.createElement('span');
            span.className = 'missing-asset';
            span.textContent = '[image not found: ' + (alt || id) + ']';
            frag.appendChild(span);
          }
          last = m.index + m[0].length;
        }
        if (last < text.length) {
          frag.appendChild(emphasisNodes(text.slice(last)));
        }
        return frag;
      }

      function choiceList(item, multi) {
        var wrap = document.createElement('div');
        var inputs = [];
        // Client-fixes batch 1b (#3): enabled only while a choice is
        // checked. Recomputed rather than tracked with a flag, because a
        // later slice (P-1) sets `checked` at build time from a restored
        // answer and this must reflect that too.
        var clearBtn = document.createElement('button');
        clearBtn.type = 'button';
        clearBtn.className = 'clear-answer';
        clearBtn.textContent = 'Clear answer';
        function refreshClear() {
          clearBtn.disabled = !inputs.some(function (i) { return i.checked; });
        }
        (item.choices || []).forEach(function (choice) {
          var label = document.createElement('label');
          label.className = 'choice';
          var input = document.createElement('input');
          input.type = multi ? 'checkbox' : 'radio';
          input.name = 'item-' + item.id;
          input.value = choice.id;
          inputs.push(input);
          input.onchange = function () {
            refreshClear();
            if (multi) {
              var picked = inputs.filter(function (i) { return i.checked; })
                                 .map(function (i) { return i.value; });
              // The wire schema requires at least one id, and an unanswered
              // item is represented by the ABSENCE of a response rather than an
              // empty one. Clearing every box therefore withdraws the saved
              // response instead of posting an empty one.
              if (picked.length === 0) { withdraw(item.id); return; }
              post(item.id, { type: 'multiple_choice_multi', choice_ids: picked });
            } else {
              post(item.id, { type: 'multiple_choice_single', choice_id: choice.id });
            }
          };
          label.appendChild(input);
          label.appendChild(emphasisNodes(choice.text || ''));
          wrap.appendChild(label);
        });
        clearBtn.onclick = function () {
          // A radio cannot be unchecked by clicking it again, so this button
          // is the only way to clear a single-choice item; for multi it is
          // a shortcut for unchecking every box by hand.
          inputs.forEach(function (i) { i.checked = false; });
          refreshClear();
          withdraw(item.id);
        };
        // P-1: a saved answer comes back checked. Before refreshClear(), so a
        // restored item starts with an enabled Clear button — the student can
        // withdraw an answer they gave last session without re-picking it.
        var savedChoice = savedFor(item);
        if (savedChoice) {
          var wanted = {};
          if (multi) {
            (savedChoice.choice_ids || []).forEach(function (id) { wanted[id] = true; });
          } else if (typeof savedChoice.choice_id === 'string') {
            wanted[savedChoice.choice_id] = true;
          }
          inputs.forEach(function (i) {
            if (Object.prototype.hasOwnProperty.call(wanted, i.value)) i.checked = true;
          });
        }
        refreshClear();
        wrap.appendChild(clearBtn);
        return wrap;
      }

      // E7(b) (2026-09-02): a short-text answer previews as rendered math under
      // the field, so a student sees the subscript they meant (H_2O, x^2,
      // 10^{-4}, or pasted `$…$`). Batch 0b slice 2 (James, 2026-09-03): EVERY
      // non-empty answer previews, not only one carrying `_ ^ $ \` — a plain
      // word shows upright as it will be read, and a space survives as `\ `
      // (math mode would swallow it). The response is the raw typed text —
      // the design tool's scorer folds formula markup on both sides
      // (lib/scoring/auto.ts). The preview is `\mathrm{…}` of the typed text
      // with TeX specials escaped; when the KaTeX library is absent (the test
      // harness, a stripped build) the preview stays empty and only the
      // data-tex attribute records what would render.
      function formulaTex(text) {
        var inner = String(text).replace(/\$/g, '').replace(/([%#&~])/g, '\\$1').trim().replace(/\s+/g, '\\ ');
        return inner ? '\\mathrm{' + inner + '}' : '';
      }
      // Fix slice S-4 (2026-09-08 sitting): a student halfway through typing `\frac{`
      // has not made a mistake, and KaTeX's own error markup — red source text with a
      // parse message — reads as one. So the render is asked to THROW
      // (throwOnError: true) and the failure is caught here: the last good render stays
      // on screen, and a plain note in --ink-soft says the input is not readable as math
      // yet. `data-last-good` carries the last tex that parsed, so the note can be added
      // without losing the picture the student already had. aria-live stays polite, so
      // the note is announced without interrupting.
      function katexOptions(throwOnError) {
        return {
          throwOnError: throwOnError,
          strict: 'ignore',
          trust: false,
          macros: (typeof KATEX_MACROS === 'object' && KATEX_MACROS) ? KATEX_MACROS : {}
        };
      }
      function formulaPreviewNote(preview) {
        var note = document.createElement('span');
        note.className = 'formula-preview-note';
        note.textContent = "Can't read that as math yet — keep typing.";
        preview.appendChild(note);
      }
      function renderFormulaPreview(preview, text) {
        var tex = formulaTex(text);
        if (!tex) {
          preview.textContent = '';
          preview.removeAttribute('data-tex');
          preview.removeAttribute('data-last-good');
          return;
        }
        preview.setAttribute('data-tex', tex);
        if (typeof katex === 'object' && katex && typeof katex.render === 'function') {
          try {
            katex.render(tex, preview, katexOptions(true));
            preview.setAttribute('data-last-good', tex);
          } catch (e) {
            var lastGood = preview.getAttribute('data-last-good');
            preview.textContent = '';
            if (lastGood) {
              // Repainting the last good tex rather than keeping the node untouched,
              // because katex.render may have emptied it before it threw.
              try {
                katex.render(lastGood, preview, katexOptions(false));
              } catch (e2) {
                preview.textContent = '';
              }
            }
            formulaPreviewNote(preview);
          }
        }
      }

      // Roadmap 4b slice 1b (2026-09-08, docs/math-entry-design.md): the math
      // keypad. D-1.1: a key inserts the UNICODE character wherever one exists
      // (× ÷ ± ≤ ≥ ≠ ° and the Greek letters) and LaTeX only for the four
      // structures that have no single character (\frac, ^{}, _{}, \sqrt{}) —
      // so the field reads as math to a human, the results page and the CSV
      // read as math to a teacher, and the response contract is unchanged raw
      // text. D-2.3: these 22 keys, in these three rows; no digit pad (D-2.4)
      // and none of the optional keys (D-2.5).
      // `key` is a stable name on `data-key` so a test (and a hand-run) can name
      // a button without depending on its glyph; `label` is the aria-label, the
      // words VoiceOver says; `tex` is the KaTeX-rendered face of a structure
      // key (the key shows the shape it makes) and `text` its fallback when the
      // library is absent — the harness, or a stripped build.
      var MATH_KEY_ROWS = [
        [
          { key: 'fraction', label: 'Fraction', tex: '\\frac{a}{b}', text: 'a/b', before: '\\frac{', after: '}{}', wrappedBack: 1 },
          { key: 'exponent', label: 'Exponent', tex: 'x^{2}', text: 'x²', before: '^{', after: '}' },
          { key: 'subscript', label: 'Subscript', tex: 'x_{2}', text: 'x₂', before: '_{', after: '}' },
          { key: 'sqrt', label: 'Square root', tex: '\\sqrt{a}', text: '√a', before: '\\sqrt{', after: '}' },
          { key: 'open-paren', label: 'Open parenthesis', text: '(', before: '(' },
          { key: 'close-paren', label: 'Close parenthesis', text: ')', before: ')' }
        ],
        [
          { key: 'times', label: 'Times', text: '×', before: '×' },
          { key: 'divide', label: 'Divided by', text: '÷', before: '÷' },
          { key: 'pm', label: 'Plus or minus', text: '±', before: '±' },
          { key: 'le', label: 'Less than or equal to', text: '≤', before: '≤' },
          { key: 'ge', label: 'Greater than or equal to', text: '≥', before: '≥' },
          { key: 'ne', label: 'Not equal to', text: '≠', before: '≠' },
          { key: 'degree', label: 'Degrees', text: '°', before: '°' }
        ],
        [
          { key: 'pi', label: 'Pi', text: 'π', before: 'π' },
          { key: 'theta', label: 'Theta', text: 'θ', before: 'θ' },
          { key: 'alpha', label: 'Alpha', text: 'α', before: 'α' },
          { key: 'beta', label: 'Beta', text: 'β', before: 'β' },
          { key: 'delta', label: 'Delta', text: 'Δ', before: 'Δ' },
          { key: 'lambda', label: 'Lambda', text: 'λ', before: 'λ' },
          { key: 'mu', label: 'Mu', text: 'μ', before: 'μ' },
          { key: 'sigma', label: 'Sigma', text: 'Σ', before: 'Σ' },
          { key: 'omega', label: 'Omega', text: 'Ω', before: 'Ω' }
        ]
      ];

      // D-1.4: the caret contract. With nothing selected the insertion is the
      // empty structure and the caret lands in its FIRST slot, so the preview
      // shows an empty fraction bar the moment the key is pressed and fills in
      // as the student types. With a selection, the selection becomes the first
      // slot and the caret lands where the student writes next — inside the
      // denominator for a fraction (`wrappedBack` 1, one character back from
      // the end), after the closing brace for ^ / _ / root, and after the
      // character for a symbol key.
      function insertMath(input, before, after, wrappedBack) {
        after = after || '';
        var value = (input.value === null || input.value === undefined) ? '' : String(input.value);
        var start = typeof input.selectionStart === 'number' ? input.selectionStart : value.length;
        var end = typeof input.selectionEnd === 'number' ? input.selectionEnd : start;
        if (start > end) { var swap = start; start = end; end = swap; }
        if (start < 0) start = 0;
        if (end > value.length) end = value.length;
        var selected = value.slice(start, end);
        var text = before + selected + after;
        var caret = selected
          ? start + text.length - (wrappedBack || 0)
          : start + before.length;
        // setRangeText is standard WebKit and participates in the field's own
        // undo stack, so Cmd-Z undoes an insertion without an Edit menu (there
        // is none). The splice is the fallback for a host without it.
        if (typeof input.setRangeText === 'function') {
          input.setRangeText(text, start, end, 'end');
        } else {
          input.value = value.slice(0, start) + text + value.slice(end);
        }
        if (typeof input.setSelectionRange === 'function') {
          input.setSelectionRange(caret, caret);
        }
      }

      // The keypad for one short-text field. Per item, not per page: an
      // insertion has exactly one target input, and an inline item set puts
      // several short-text fields on one page.
      function mathKeypad(item, input, preview) {
        var padId = 'math-keys-' + item.id;
        var toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = 'math-keys-toggle';
        toggle.textContent = 'Math keys';
        toggle.setAttribute('aria-controls', padId);

        var pad = document.createElement('div');
        pad.className = 'math-keys';
        pad.setAttribute('id', padId);
        pad.setAttribute('role', 'toolbar');
        pad.setAttribute('aria-label', 'Math keys');

        // D-2.2: every short-text field gets the toggle — the client cannot tell
        // a history answer from a chemistry one — but it OPENS by default only
        // where the stem carries `$`, the page's one existing signal that a
        // question is math-shaped (the same signal the hint uses). State is per
        // item, in this closure, and is not persisted: a paging turn rebuilds
        // the page and re-opening is one click.
        var open = /\$/.test(item.stem || '');
        function applyOpen() {
          toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
          if (open) pad.removeAttribute('hidden');
          else pad.setAttribute('hidden', '');
        }
        toggle.onclick = function () {
          open = !open;
          applyOpen();
        };

        var keyButtons = [];
        var rovingIndex = 0;
        // D-3.1, the WAI-ARIA toolbar pattern: ONE Tab stop for the whole pad.
        // Twenty-two Tab stops between the field and the next question would be
        // a real cost for a keyboard-only student.
        function setRoving(index) {
          rovingIndex = index;
          for (var i = 0; i < keyButtons.length; i++) {
            keyButtons[i].setAttribute('tabindex', i === index ? '0' : '-1');
          }
        }

        function keyButton(spec) {
          var button = document.createElement('button');
          button.type = 'button';
          button.setAttribute('data-key', spec.key);
          // No aria-pressed: these are momentary, not toggles — the drawing
          // toolbar's pressed model does not apply.
          button.setAttribute('aria-label', spec.label);
          var glyph = document.createElement('span');
          glyph.setAttribute('aria-hidden', 'true');
          var rendered = false;
          if (spec.tex && typeof katex === 'object' && katex && typeof katex.render === 'function') {
            try {
              var options = katexOptions(false);
              options.displayMode = false;
              katex.render(spec.tex, glyph, options);
              rendered = true;
            } catch (e) {
              rendered = false;
            }
          }
          if (!rendered) glyph.textContent = spec.text;
          button.appendChild(glyph);
          // D-3.1: a pointer click must never take focus off the field, or the
          // student's caret and selection are gone before the insertion runs.
          button.onpointerdown = function (e) {
            if (e && typeof e.preventDefault === 'function') e.preventDefault();
          };
          button.onclick = function (event) {
            insertMath(input, spec.before, spec.after, spec.wrappedBack);
            renderFormulaPreview(preview, input.value);
            // D-3.2, the `change` trap: a programmatic value change fires
            // neither `input` nor `change`, so without this post a student who
            // typed, pressed a key by keyboard (focus leaves the field ->
            // `change` posts the OLD value) and pressed Next would hand in the
            // pre-keypad text.
            post(item.id, { type: 'short_text', text: input.value });
            // Refocus only after a POINTER activation. A student who Tabbed to
            // the pad and pressed Space wants to press the next key, not be
            // yanked back to the field; they return with Shift-Tab.
            if (event && event.detail > 0 && typeof input.focus === 'function') {
              input.focus();
            }
          };
          return button;
        }

        for (var r = 0; r < MATH_KEY_ROWS.length; r++) {
          var row = document.createElement('div');
          row.className = 'math-keys-row';
          for (var k = 0; k < MATH_KEY_ROWS[r].length; k++) {
            var button = keyButton(MATH_KEY_ROWS[r][k]);
            keyButtons.push(button);
            row.appendChild(button);
          }
          pad.appendChild(row);
        }
        setRoving(0);

        // Left / Right move between keys and wrap; Home / End go to the ends.
        // Read on the pad, so it covers every key without 22 handlers.
        pad.onkeydown = function (event) {
          if (!event || !keyButtons.length) return;
          var next = -1;
          if (event.key === 'ArrowRight') next = (rovingIndex + 1) % keyButtons.length;
          else if (event.key === 'ArrowLeft') next = (rovingIndex + keyButtons.length - 1) % keyButtons.length;
          else if (event.key === 'Home') next = 0;
          else if (event.key === 'End') next = keyButtons.length - 1;
          else return;
          if (typeof event.preventDefault === 'function') event.preventDefault();
          setRoving(next);
          if (typeof keyButtons[next].focus === 'function') keyButtons[next].focus();
        };

        applyOpen();
        return { toggle: toggle, pad: pad };
      }

      function shortTextField(item) {
        var wrap = document.createElement('div');
        wrap.className = 'short-text-wrap';
        var input = document.createElement('input');
        input.type = 'text';
        input.className = 'short-text';
        input.autocomplete = 'off';
        input.autocapitalize = 'off';
        // AAC-2b follow-up 3.3 (James, 2026-08-28): the spell-check grant
        // covers every field the student writes prose into, not just the
        // essay — same per-student gate as essayField below.
        input.spellcheck = !!ACCOMMODATIONS.spell_check;
        input.onchange = function () {
          post(item.id, { type: 'short_text', text: input.value });
        };
        wrap.appendChild(input);
        // The hint only where the question itself carries math or a formula.
        if (/\$/.test(item.stem || '')) {
          var hint = document.createElement('p');
          hint.className = 'formula-hint';
          // Roadmap 4b slice 1b (D-4.2): the hint now names the keypad first —
          // typing the notation is the fallback, not the instruction.
          hint.textContent = 'Use the math keys below, or type _ for a subscript and ^ for an exponent. Your answer shows below as it will be read.';
          wrap.appendChild(hint);
        }
        var preview = document.createElement('div');
        preview.className = 'formula-preview';
        preview.setAttribute('aria-live', 'polite');
        wrap.appendChild(preview);
        input.oninput = function () { renderFormulaPreview(preview, input.value); };
        // Roadmap 4b slice 1b (D-2.1): field -> preview -> toggle -> pad, so the
        // rendered answer stays directly under the text it renders and the pad
        // is below both.
        var keypad = mathKeypad(item, input, preview);
        wrap.appendChild(keypad.toggle);
        wrap.appendChild(keypad.pad);
        // P-1: the typed text comes back, and its formula preview with it —
        // otherwise a restored `H_2O` would show without the subscript the
        // student was shown when they typed it.
        var savedShort = savedFor(item);
        if (savedShort && typeof savedShort.text === 'string') {
          input.value = savedShort.text;
          renderFormulaPreview(preview, input.value);
        }
        return wrap;
      }

      // The design-tool preview is no-script (ADR 0009) and cannot demonstrate
      // a live word cap, so this is the first place max_word_count means
      // anything. Counting matches the obvious reading — whitespace-separated
      // tokens — rather than anything cleverer, because a student comparing the
      // counter to their own count must not be surprised by it.
      function countWords(text) {
        var trimmed = (text || '').trim();
        if (trimmed.length === 0) return 0;
        return trimmed.split(/\s+/).length;
      }

      function rubricNode(rubric) {
        var box = document.createElement('div');
        box.className = 'rubric';
        var heading = document.createElement('h2');
        heading.textContent = 'How this will be scored';
        box.appendChild(heading);
        (rubric.criteria || []).forEach(function (criterion) {
          var wrap = document.createElement('div');
          wrap.className = 'rubric-criterion';
          var name = document.createElement('div');
          name.className = 'rubric-criterion-name';
          name.textContent = criterion.name || '';
          wrap.appendChild(name);
          (criterion.levels || []).forEach(function (level) {
            var row = document.createElement('div');
            row.className = 'rubric-level';
            var label = document.createElement('span');
            label.textContent = level.label || '';
            row.appendChild(label);
            var points = document.createElement('span');
            points.className = 'rubric-level-points';
            points.textContent = ' (' + level.points + ' pts)';
            row.appendChild(points);
            if (level.descriptor) {
              row.appendChild(document.createTextNode(' — ' + level.descriptor));
            }
            wrap.appendChild(row);
          });
          box.appendChild(wrap);
        });
        return box;
      }

      function essayField(item) {
        var wrap = document.createElement('div');
        var area = document.createElement('textarea');
        area.className = 'essay';
        area.autocomplete = 'off';
        area.autocapitalize = 'off';
        // Spell-check stays off unless THIS STUDENT has it. macOS AAC does NOT
        // restrict spell-check or autocorrect the way iPadOS does, so the
        // WebKit-level attribute is the only control there is. Slice 62: the
        // bundle now carries the effective per-student set, so a child entitled
        // to spell-check gets it and a classmate who is not does not — from the
        // same assessment.
        area.spellcheck = !!ACCOMMODATIONS.spell_check;
        if (item.placeholder) area.placeholder = item.placeholder;
        wrap.appendChild(area);

        var counter = null;
        if (typeof item.max_word_count === 'number') {
          counter = document.createElement('p');
          counter.className = 'word-count';
          wrap.appendChild(counter);
        }

        function refresh() {
          if (!counter) return;
          var n = countWords(area.value);
          counter.textContent = n + ' / ' + item.max_word_count + ' words';
          // Over-limit is SHOWN, never truncated. Silently deleting a student's
          // words is a worse failure than an over-length response, and the
          // submit-time gate belongs with submission (slice 64) where there is
          // something to gate.
          if (n > item.max_word_count) counter.className = 'word-count over';
          else counter.className = 'word-count';
        }

        area.oninput = refresh;
        area.onchange = function () {
          post(item.id, { type: 'essay', text: area.value });
        };
        // P-1: before the counter runs, so a restored response shows its own
        // word count rather than 0 / 400.
        var savedEssay = savedFor(item);
        if (savedEssay && typeof savedEssay.text === 'string') area.value = savedEssay.text;
        refresh();

        if (item.rubric) wrap.appendChild(rubricNode(item.rubric));
        return wrap;
      }

      // Each left gets a dropdown of every right. A dropdown rather than
      // drag-and-drop because it is keyboard-operable and works with assistive
      // technology out of the box — in an assessment client that has to serve
      // students with accommodations, a drag-only interaction would exclude
      // some of them from answering at all.
      //
      // The client cannot tell a correct pairing from an incorrect one: the
      // delivery bundle carries lefts and rights as independent arrays and
      // nothing that associates them (slice 51). It records what the student
      // chose; scoring happens server-side against the key.
      function matchField(item) {
        var wrap = document.createElement('div');
        wrap.className = 'match';
        var rows = [];

        // Batch 0b slice 3 (James, 2026-09-03): a match is ANSWERED when every
        // left has a right — the 2026-09-03 sitting showed the strip going
        // green on the first pair. Partial pairings still post (the server
        // keeps what the student has so far); only the mark waits.
        function complete() {
          return rows.length > 0 && rows.every(function (row) { return !!row.select.value; });
        }

        function emit() {
          var matches = {};
          var any = false;
          rows.forEach(function (row) {
            if (row.select.value) {
              matches[row.leftId] = row.select.value;
              any = true;
            }
          });
          if (complete()) markAnswered(item.id); else markUnanswered(item.id);
          // Same rule as multi-select: an unanswered item is the ABSENCE of a
          // response, so a fully-cleared item has nothing valid to send.
          if (!any) return;
          post(item.id, { type: 'match', matches: matches }, false);
        }

        // P-1: the saved pairing. Its ids are the SAME per-attempt sealed ids
        // the bundle's own rights carry, but each row is still checked against
        // the options actually built for it — a value that names nothing on
        // screen leaves that row on "Choose…" rather than selecting nothing.
        var savedMatch = savedFor(item);
        var savedPairs = (savedMatch && savedMatch.matches && typeof savedMatch.matches === 'object')
          ? savedMatch.matches
          : null;

        (item.lefts || []).forEach(function (left) {
          var row = document.createElement('div');
          row.className = 'match-row';

          var label = document.createElement('span');
          label.className = 'match-left';
          label.appendChild(emphasisNodes(left.text || ''));
          row.appendChild(label);

          var select = document.createElement('select');
          select.className = 'match-select';
          var blank = document.createElement('option');
          blank.value = '';
          blank.textContent = 'Choose…';
          select.appendChild(blank);
          var optionValues = [];
          (item.rights || []).forEach(function (right) {
            var option = document.createElement('option');
            option.value = right.id;
            option.textContent = stripEmphasis(right.text || '');
            select.appendChild(option);
            optionValues.push(right.id);
          });
          select.onchange = emit;

          if (savedPairs && Object.prototype.hasOwnProperty.call(savedPairs, left.id)) {
            var chosen = savedPairs[left.id];
            if (optionValues.indexOf(chosen) !== -1) select.value = chosen;
          }

          rows.push({ leftId: left.id, select: select });
          row.appendChild(select);
          wrap.appendChild(row);
        });
        // The server marks ANY saved response as answered; for match the mark
        // means "every pair set", so a restored partial pairing starts
        // unmarked (the strip reads ANSWERED after the whole page is built).
        if (ANSWERED[item.id] === true && !complete()) delete ANSWERED[item.id];
        return wrap;
      }

      // Moves the entry at `from` to index `to`, splice semantics, without
      // touching the list it is given. Both the Move buttons and a pointer drop
      // go through it, so the two paths cannot drift: for an adjacent move a
      // splice is exactly the swap the buttons always did, and for a drag across
      // several places it is what the drop indicator promised.
      function reorderIDs(list, from, to) {
        var out = list.slice();
        if (from === to) return out;
        if (from < 0 || from >= out.length) return out;
        if (to < 0 || to >= out.length) return out;
        out.splice(to, 0, out.splice(from, 1)[0]);
        return out;
      }

      // Move up / Move down buttons AND drag-and-drop (client UI pass slice E,
      // D-D2). The buttons are not an implementation detail that dragging
      // replaces: dragging is not keyboard-operable and does not work with
      // assistive technology, which in an assessment client would mean some
      // students could not answer the item at all. So the buttons stay, remain
      // the VoiceOver path, and both paths call the same move().
      //
      // Rows stay put and their CONTENTS move, rather than the list being
      // rebuilt. That keeps focus where the student left it — a rebuilt list
      // drops focus after every press, which turns a four-item reorder into a
      // navigation puzzle for anyone working by keyboard.
      function orderField(item) {
        var entries = (item.entries || []).slice();
        // P-1: the arrangement the student left, restored BEFORE the rows are
        // built — the rows then render it the way they render the server's
        // shuffle, and nothing is posted (a post here would claim the student
        // moved something this session). Ids the saved list names come first,
        // in its order; an entry it does not name keeps its relative shuffled
        // position after them, so every entry still appears exactly once even
        // if the sequence gained one since the answer was saved.
        var savedOrder = savedFor(item);
        if (savedOrder && savedOrder.ordered_ids && savedOrder.ordered_ids.length) {
          var byId = {};
          entries.forEach(function (entry) { byId[entry.id] = entry; });
          var placed = {};
          var named = [];
          savedOrder.ordered_ids.forEach(function (id) {
            if (typeof id !== 'string') return;
            if (!Object.prototype.hasOwnProperty.call(byId, id)) return;
            if (Object.prototype.hasOwnProperty.call(placed, id)) return;
            placed[id] = true;
            named.push(byId[id]);
          });
          if (named.length > 0) {
            entries = named.concat(entries.filter(function (entry) {
              return !Object.prototype.hasOwnProperty.call(placed, entry.id);
            }));
          }
        }
        var rows = [];

        var wrap = document.createElement('div');
        wrap.className = 'order-field';

        var hintID = 'order-hint-' + item.id;
        var hint = document.createElement('p');
        hint.className = 'order-hint';
        hint.id = hintID;
        hint.setAttribute('id', hintID);
        hint.textContent = 'Drag to reorder, or use the Move buttons.';
        wrap.appendChild(hint);

        var list = document.createElement('div');
        list.className = 'order';
        list.setAttribute('aria-describedby', hintID);
        wrap.appendChild(list);

        // Both paths announce here, so a drop and a button press sound alike.
        var status = document.createElement('p');
        status.className = 'order-status';
        status.setAttribute('aria-live', 'polite');
        wrap.appendChild(status);

        function refresh() {
          rows.forEach(function (row, index) {
            row.position.textContent = (index + 1) + '.';
            row.label.textContent = entries[index].label || '';
            row.up.disabled = index === 0;
            row.down.disabled = index === entries.length - 1;
          });
        }

        function move(from, to) {
          if (to < 0 || to >= entries.length) return;
          if (from < 0 || from >= entries.length) return;
          if (from === to) return;
          entries = reorderIDs(entries, from, to);
          refresh();
          status.textContent = (entries[to].label || 'Item')
            + ' moved to position ' + (to + 1) + ' of ' + entries.length + '.';
          // Posted only after a move: the arrangement the student was handed is
          // the server's shuffle, not an answer they gave. One post per move —
          // a drag posts on its drop, never on the dragover stream.
          post(item.id, {
            type: 'order',
            ordered_ids: entries.map(function (entry) { return entry.id; })
          });
        }

        // -- drag state (fix slice S-1, 2026-09-08) --------------------------
        // POINTER tracking, not HTML5 drag-and-drop. The 2026-09-08 sitting found
        // the HTML5 drop never landing inside a real AAC session: LockedDownWebView
        // unregisters its dragged types and refuses the drag destination, which is
        // aimed at drags in from other apps but also swallows an in-page drop, so
        // the row lifted and snapped back with nothing moved. That view is not
        // touched (hard rule); the interaction is rebuilt on pointer events, which
        // never become an NSDraggingSession. A touchpad is a pointer, so nothing
        // extra is needed for it. There is deliberately no second HTML5 path — two
        // paths would be two chances to reorder differently.
        //
        // dragFrom is the index the drag started from; -1 means no drag is in
        // flight, which is also what Escape and pointercancel leave behind.
        var dragFrom = -1;
        var dragPointerID = null;
        var dragStartY = 0;
        // Row geometry is snapshotted at pointerdown: the dragged row is moved with
        // a transform, and a live getBoundingClientRect would then report the moved
        // box and hit-test against itself.
        var dragBoxes = [];

        function paintIndicators(over, before) {
          rows.forEach(function (other, otherIndex) {
            other.node.className = otherIndex === dragFrom
              ? 'order-row dragging'
              : 'order-row';
          });
          if (over >= 0 && over !== dragFrom) {
            rows[over].node.className = 'order-row ' + (before ? 'drop-before' : 'drop-after');
          }
        }

        function endDrag() {
          if (dragFrom >= 0 && dragPointerID !== null) {
            var node = rows[dragFrom].node;
            if (typeof node.releasePointerCapture === 'function') {
              try { node.releasePointerCapture(dragPointerID); } catch (e) { /* already gone */ }
            }
          }
          dragFrom = -1;
          dragPointerID = null;
          dragBoxes = [];
          rows.forEach(function (row) {
            row.node.className = 'order-row';
            if (row.node.style) row.node.style.transform = '';
          });
        }

        function boxOf(index) {
          var node = rows[index].node;
          if (typeof node.getBoundingClientRect !== 'function') return null;
          var box = node.getBoundingClientRect();
          if (!box || typeof box.top !== 'number' || typeof box.height !== 'number') return null;
          return box;
        }

        // Which row is under the pointer, and whether the pointer is in its top
        // half ("land above it") or its bottom half ("below"). Above the first row
        // and below the last are clamped to the ends rather than dropped, so a
        // student who overshoots the list still lands the move they aimed at.
        function hitTest(y) {
          if (typeof y !== 'number' || dragBoxes.length === 0) return null;
          for (var i = 0; i < dragBoxes.length; i++) {
            var box = dragBoxes[i];
            if (!box) continue;
            if (y < box.top) {
              return { over: i, before: true };
            }
            if (y < box.top + box.height) {
              return { over: i, before: y < box.top + (box.height / 2) };
            }
          }
          return { over: dragBoxes.length - 1, before: false };
        }

        function targetIndex(over, before) {
          return before
            ? (dragFrom > over ? over : over - 1)
            : (dragFrom < over ? over : over + 1);
        }

        function beginDrag(at, event) {
          dragFrom = at;
          dragStartY = (event && typeof event.clientY === 'number') ? event.clientY : 0;
          dragBoxes = rows.map(function (row, index) { return boxOf(index); });
          dragPointerID = (event && typeof event.pointerId !== 'undefined') ? event.pointerId : null;
          var node = rows[at].node;
          if (dragPointerID !== null && typeof node.setPointerCapture === 'function') {
            // Capture keeps pointermove / pointerup on this row even when the
            // pointer leaves it, which is the whole reason the rows can stay put.
            try { node.setPointerCapture(dragPointerID); } catch (e) { dragPointerID = null; }
          }
          paintIndicators(-1, true);
        }

        function dragTo(event) {
          if (dragFrom < 0) return null;
          var y = (event && typeof event.clientY === 'number') ? event.clientY : dragStartY;
          var node = rows[dragFrom].node;
          if (node.style) node.style.transform = 'translateY(' + (y - dragStartY) + 'px)';
          var hit = hitTest(y);
          paintIndicators(hit ? hit.over : -1, hit ? hit.before : true);
          return hit;
        }

        // Escape cancels mid-drag. It is read on the document because the drag is
        // driven by the pointer and no row holds keyboard focus during one; the
        // previous handler is chained so a second order item on the page keeps its
        // own Escape.
        var previousKeydown = document.onkeydown;
        document.onkeydown = function (event) {
          if (dragFrom >= 0 && event && event.key === 'Escape') {
            endDrag();
            return;
          }
          if (typeof previousKeydown === 'function') return previousKeydown(event);
        };

        entries.forEach(function (entry, index) {
          var row = document.createElement('div');
          row.className = 'order-row';

          var position = document.createElement('span');
          position.className = 'order-position';
          row.appendChild(position);

          var label = document.createElement('span');
          label.className = 'order-label';
          row.appendChild(label);

          var up = document.createElement('button');
          up.className = 'order-move';
          up.type = 'button';
          up.textContent = '▲';
          up.setAttribute('aria-label', 'Move up');
          up.onclick = (function (at) {
            return function () { move(at, at - 1); };
          })(index);
          row.appendChild(up);

          var down = document.createElement('button');
          down.className = 'order-move';
          down.type = 'button';
          down.textContent = '▼';
          down.setAttribute('aria-label', 'Move down');
          down.onclick = (function (at) {
            return function () { move(at, at + 1); };
          })(index);
          row.appendChild(down);

          // A press that starts on a Move button is a button press, not a drag —
          // otherwise the keyboard path would be unusable with a mouse.
          function onAMoveButton(event) {
            var node = event && event.target;
            while (node) {
              if ((' ' + (node.className || '') + ' ').indexOf(' order-move ') !== -1) return true;
              node = node.parentNode;
            }
            return false;
          }

          row.onpointerdown = (function (at) {
            return function (event) {
              if (dragFrom >= 0) return;
              if (event && typeof event.button === 'number' && event.button !== 0) return;
              if (onAMoveButton(event)) return;
              beginDrag(at, event);
            };
          })(index);

          row.onpointermove = function (event) {
            if (dragFrom < 0) return;
            dragTo(event);
          };

          row.onpointerup = function (event) {
            if (dragFrom < 0) return;
            var hit = dragTo(event);
            var from = dragFrom;
            var to = hit ? targetIndex(hit.over, hit.before) : from;
            endDrag();
            if (!hit || hit.over === from) return;
            if (to < 0) to = 0;
            if (to > entries.length - 1) to = entries.length - 1;
            move(from, to);
          };

          // A cancelled pointer (Escape handled above, a system gesture, the pointer
          // being taken away) restores the row and posts nothing.
          row.onpointercancel = function () { endDrag(); };

          rows.push({
            node: row,
            position: position,
            label: label,
            up: up,
            down: down
          });
          list.appendChild(row);
        });

        refresh();
        return wrap;
      }

      // Regions are absolutely-positioned buttons over the image, sized from
      // the item's normalised 0-1 coordinates as percentages, so they track the
      // image at whatever size it renders.
      //
      // Buttons rather than click handlers on the image, so a region is
      // focusable and activatable from the keyboard, and announces itself with
      // an aria-label and aria-pressed state. A bare click-the-picture
      // interaction would be unanswerable without a mouse.
      // 0.55 * 100 is 55.00000000000001 in binary floating point. CSS accepts
      // that, but emitting it is sloppy and the noise compounds when regions are
      // authored by dragging. Rounded to four decimals, which is far finer than
      // any region a teacher can draw.
      function pct(value) {
        return (Math.round(value * 1000000) / 10000) + '%';
      }

      function hotspotField(item) {
        var wrap = document.createElement('div');
        wrap.className = 'hotspot';

        var ref = item.image_asset_id ? String(item.image_asset_id).toLowerCase() : null;
        var asset = ref ? ASSETS[ref] : null;
        var regions = item.regions || [];

        // A hotspot may legitimately be a draft — the teacher creates the item,
        // then draws regions afterwards — and an image ref can also fail to
        // bundle. Either way the item cannot be answered, and saying so beats
        // presenting a stem with an invisible answer surface.
        if (!asset || !asset.base64 || !asset.content_type || regions.length === 0) {
          var notice = document.createElement('p');
          notice.className = 'hotspot-unavailable';
          notice.textContent = 'This item is missing its image and cannot be answered.';
          wrap.appendChild(notice);
          return wrap;
        }

        var frame = document.createElement('div');
        frame.className = 'hotspot-frame';

        var img = document.createElement('img');
        img.src = 'data:' + asset.content_type + ';base64,' + asset.base64;
        // Empty alt: the image IS the question, and any description of it would
        // be describing the answer. The stem carries the prompt.
        img.alt = '';
        frame.appendChild(img);

        var selected = {};

        // P-1: the regions the student marked. Only ids that are still regions
        // on this item count, and the buttons below are built already carrying
        // the class and aria-pressed state — a restore never runs the click
        // handler, so nothing is posted.
        var savedHotspot = savedFor(item);
        if (savedHotspot && savedHotspot.region_ids) {
          savedHotspot.region_ids.forEach(function (id) {
            regions.forEach(function (region) {
              if (region.id === id) selected[id] = true;
            });
          });
        }

        function emit() {
          var ids = regions
            .filter(function (region) { return selected[region.id]; })
            .map(function (region) { return region.id; });
          // Same rule as the other multi-value types: an unanswered item is the
          // ABSENCE of a response, and the wire schema requires at least one id.
          if (ids.length === 0) return;
          post(item.id, { type: 'hotspot', region_ids: ids });
        }

        regions.forEach(function (region, index) {
          var button = document.createElement('button');
          button.type = 'button';
          var wasSelected = selected[region.id] === true;
          button.className = wasSelected ? 'hotspot-region selected' : 'hotspot-region';
          button.style.left = pct(region.x);
          button.style.top = pct(region.y);
          button.style.width = pct(region.w);
          button.style.height = pct(region.h);
          button.setAttribute('aria-label', 'Region ' + (index + 1));
          button.setAttribute('aria-pressed', wasSelected ? 'true' : 'false');
          button.onclick = function () {
            var on = !selected[region.id];
            selected[region.id] = on;
            button.className = on ? 'hotspot-region selected' : 'hotspot-region';
            button.setAttribute('aria-pressed', on ? 'true' : 'false');
            emit();
          };
          frame.appendChild(button);
        });

        wrap.appendChild(frame);
        return wrap;
      }

      // Drawing answers cannot be posted like the others: the page's CSP
      // forbids it from making any network request at all, so the bytes go to
      // the host over a second named channel and the host does the upload. The
      // student's own machine is the only thing that ever holds the image
      // before it reaches storage.
      function postDrawing(itemId, dataURL) {
        try {
          window.webkit.messageHandlers.upload.postMessage({
            item_id: itemId,
            data_url: dataURL
          });
        } catch (e) {
          console.log('drawing post failed: ' + (e && e.message));
        }
      }

      // Drawing auto-save (docs/drawing-tools-design.md §Auto-save, D-8, slice
      // 2). Every save is a full upload — toDataURL, a new slot, a new S3
      // object — so it is idle-debounced rather than per stroke: five seconds
      // after the student stops, and at once at the points where the work is
      // about to leave the screen.
      var AUTO_SAVE_IDLE_MS = 5000;

      // The flush hook of every drawing item on the page, so a page turn and
      // Finish can save them all without knowing where they are. Each hook is a
      // no-op unless that item is dirty, so the flush points never post a
      // redundant upload.
      var DRAWING_FLUSHES = [];
      function flushAllDrawings() {
        for (var f = 0; f < DRAWING_FLUSHES.length; f++) {
          try {
            DRAWING_FLUSHES[f]();
          } catch (e) {
            console.log('drawing flush failed: ' + (e && e.message));
          }
        }
      }

      // Drawing background (docs/drawing-background-design.md, D-1..D-3): the
      // graph paper is painted INTO the canvas, before any stroke and before
      // the P-1 restore, so `toDataURL` carries the paper with the work and
      // nothing downstream — the upload, the teacher's view, the restore —
      // has to know a grid exists. Geometry from the design page: 40 canvas-px
      // cells, lines on the half pixel so a 1 px stroke lands on one pixel row.
      //
      // `kind` is whatever the bundle said. Only 'grid' and 'axes' paint;
      // anything else (absent, or a value from a newer design tool) paints
      // NOTHING AT ALL, which is a blank transparent canvas exactly as before
      // this slice — the safe degradation the design page relies on.
      var GRID_CELL = 40;
      var GRID_PAPER = '#ffffff';
      var GRID_MINOR = '#dfe3ea';
      var GRID_MAJOR = '#b8c0cc';
      var GRID_AXIS = '#1c1c1e';
      var GRID_ARROW = 8;
      // A tick reaches this far either side of its axis.
      var GRID_TICK = 4;
      var PEN_COLOR = '#1c1c1e';
      var PEN_WIDTH = 2.5;

      // Drawing tools slice 1 (docs/drawing-tools-design.md, D-1 / D-2). Three
      // sizes, Medium being today's pen; the eraser is 4x the pen at each size,
      // so the same three buttons serve both tools. The four inks are canvas
      // paint, not tokens — they are baked into the PNG the teacher reads on
      // white, so they stay identical under every contrast set (like the paper).
      var PEN_SIZES = { pen: [1.5, 2.5, 5], eraser: [6, 10, 20] };
      var PEN_SIZE_LABELS = ['Thin', 'Medium', 'Thick'];
      var PEN_SIZE_DEFAULT = 1;
      var PEN_INKS = [
        ['Black', PEN_COLOR],
        ['Red', '#c8102e'],
        ['Blue', '#1f4fd8'],
        ['Green', '#1e7d3a']
      ];

      // Grid-line offsets across `span` canvas pixels: 0.5, 40.5, ... while
      // still inside the canvas. A canvas that is not a whole number of cells
      // (1000 x 700 is 25 x 17.5) simply ends mid-cell, as the design page
      // accepts.
      function gridLines(span) {
        var out = [];
        for (var at = 0.5; at < span; at += GRID_CELL) out.push(at);
        return out;
      }

      // Drawing tools slice 1 (docs/drawing-tools-design.md, D-3): `under` paints
      // the SAME paper UNDER what is already on the canvas, with
      // `destination-over`, which is how the eraser works — it cuts to
      // transparent (`destination-out`) and the paper is then put back in the
      // hole it made. Under `destination-over` the FIRST thing painted wins, so
      // the whole paint runs in reverse: the axes, then the lines, then the
      // opaque paper last. A blank canvas paints nothing either way and so gets
      // nothing put back under it — its blank state IS transparent.
      //
      // Returns whether it painted, so a caller can tell whether the
      // compositing mode and the pen were handed back here or are still its own
      // to restore.
      function paintBackground(context, canvas, kind, under) {
        if (!context) return false;
        if (kind !== 'grid' && kind !== 'axes') return false;

        var width = canvas.width;
        var height = canvas.height;
        var columns = gridLines(width);
        var rows = gridLines(height);
        var i;

        function paper() {
          context.fillStyle = GRID_PAPER;
          context.fillRect(0, 0, width, height);
        }

        // One pass per colour rather than a colour change per line: every fifth
        // line is darker so the student can count cells, and grouping by colour
        // keeps the op stream short without changing what is drawn. Reversing
        // the two passes under `destination-over` keeps the same line on top at
        // every crossing.
        function linePass(major) {
          context.strokeStyle = major ? GRID_MAJOR : GRID_MINOR;
          context.beginPath();
          for (i = 0; i < columns.length; i++) {
            if ((i % 5 === 0) !== major) continue;
            context.moveTo(columns[i], 0);
            context.lineTo(columns[i], height);
          }
          for (i = 0; i < rows.length; i++) {
            if ((i % 5 === 0) !== major) continue;
            context.moveTo(0, rows[i]);
            context.lineTo(width, rows[i]);
          }
          context.stroke();
        }

        function lines() {
          context.lineWidth = 1;
          if (under) {
            linePass(true);
            linePass(false);
          } else {
            linePass(false);
            linePass(true);
          }
        }

        function axes() {
          if (kind !== 'axes') return;
          // Through the centre, on the half pixel like the grid. Unlabelled and
          // unscaled — numbers, origin placement and plotted points are the
          // post-MVP graphing suite.
          var cx = Math.floor(width / 2) + 0.5;
          var cy = Math.floor(height / 2) + 0.5;
          context.strokeStyle = GRID_AXIS;
          context.lineWidth = 1.5;
          context.beginPath();
          context.moveTo(0, cy);
          context.lineTo(width, cy);
          context.moveTo(cx, 0);
          context.lineTo(cx, height);
          // Arrowheads at the positive ends only: +x is the right edge, +y is
          // the TOP edge (canvas y grows downward).
          context.moveTo(width - GRID_ARROW, cy - GRID_TICK);
          context.lineTo(width, cy);
          context.lineTo(width - GRID_ARROW, cy + GRID_TICK);
          context.moveTo(cx - GRID_TICK, GRID_ARROW);
          context.lineTo(cx, 0);
          context.lineTo(cx + GRID_TICK, GRID_ARROW);
          // Ticks at every cell, on the grid lines rather than measured from
          // the centre, so a tick always sits on paper the student can count.
          for (i = 0; i < columns.length; i++) {
            context.moveTo(columns[i], cy - GRID_TICK);
            context.lineTo(columns[i], cy + GRID_TICK);
          }
          for (i = 0; i < rows.length; i++) {
            context.moveTo(cx - GRID_TICK, rows[i]);
            context.lineTo(cx + GRID_TICK, rows[i]);
          }
          context.stroke();
        }

        if (under) {
          context.globalCompositeOperation = 'destination-over';
          axes();
          lines();
          paper();
        } else {
          paper();
          lines();
          axes();
        }

        // Hand the pen back. Explicit re-assignment rather than save/restore:
        // one fewer thing for a stripped runtime (and the test shim) to have.
        // Cap and join were never changed, so they are not re-set. With the
        // tools the "pen" is whatever tool is selected on THIS canvas — the
        // eraser's width, say — which the field records on the element rather
        // than passing down, so an item's tools cannot reach another item's.
        var pen = canvas.__pen || { width: PEN_WIDTH, color: PEN_COLOR };
        context.lineWidth = pen.width;
        context.strokeStyle = pen.color;
        if (under) context.globalCompositeOperation = 'source-over';
        return true;
      }

      function drawingField(item) {
        var wrap = document.createElement('div');
        wrap.className = 'drawing';

        var promptRef = item.prompt_asset_id
          ? String(item.prompt_asset_id).toLowerCase()
          : null;
        var promptAsset = promptRef ? ASSETS[promptRef] : null;
        if (promptAsset && promptAsset.base64 && promptAsset.content_type) {
          var promptImage = document.createElement('img');
          promptImage.className = 'drawing-prompt';
          promptImage.src =
            'data:' + promptAsset.content_type + ';base64,' + promptAsset.base64;
          promptImage.alt = '';
          wrap.appendChild(promptImage);
        }

        // The authored canvas size is honoured when given. A student handed a
        // box of a different shape than the teacher drew for would be answering
        // a different question.
        var width = (item.canvas && item.canvas.width) || 800;
        var height = (item.canvas && item.canvas.height) || 600;

        // Blank unless the teacher asked for paper. An unknown value is blank
        // too — the page decides what a background means, the model only
        // carries the string.
        var background = (item.canvas && item.canvas.background) || null;

        var canvas = document.createElement('canvas');
        canvas.className = 'drawing-canvas';
        canvas.width = width;
        canvas.height = height;
        // Drawing tools: the canvas can hold focus, so Cmd-Z works with the
        // hand still on the drawing surface, and VoiceOver has a name for it.
        canvas.setAttribute('tabindex', '0');
        canvas.setAttribute('aria-label', 'Drawing area');
        if (background === 'grid' || background === 'axes') {
          // So the DOM says what was asked, assertable without pixels.
          canvas.setAttribute('data-background', background);
        }

        // --- tool state -----------------------------------------------------
        // The bitmap used to be the only state. The tools need a second one: a
        // list of strokes, so undo can replay what is left and the eraser can
        // put the paper back. Drawing stays incremental (a pointermove is still
        // one lineTo + stroke); the list is only read by undo and by rebuild.
        var drawing = false;
        var strokes = [];
        var current = null;
        // A restored picture is a flat bitmap, not strokes: undo stops at it,
        // and `savedPresent` is true even when the bytes did not ride the
        // bundle (P-1, D-5) because the answer still exists on the server.
        var baseline = null;
        var savedPresent = false;
        var tool = 'pen';
        var size = PEN_SIZE_DEFAULT;
        var color = PEN_INKS[0][1];

        function widthNow() { return PEN_SIZES[tool][size]; }

        // --- auto-save state (D-8) -----------------------------------------
        // `dirty` is "the picture has changed since the last save we started";
        // `inFlight` is "one upload is already out". One at a time: the host
        // starts a Task per upload, and two racing for the same item would make
        // the "Saved." label a guess.
        var dirty = false;
        var inFlight = false;
        var idleTimer = null;

        // What `paintBackground` hands the pen back to. Kept on the element so
        // one item's tools can never reach another item's canvas.
        function recordPen() {
          canvas.__pen = { width: widthNow(), color: color };
        }
        recordPen();

        // --- the toolbar ----------------------------------------------------
        var tools = document.createElement('div');
        tools.className = 'drawing-tools';
        tools.setAttribute('role', 'toolbar');
        tools.setAttribute('aria-label', 'Drawing tools');

        var toolButtons = [];
        var sizeButtons = [];
        var colorButtons = [];

        function pressGroup(buttons, index) {
          for (var b = 0; b < buttons.length; b++) {
            buttons[b].setAttribute('aria-pressed', b === index ? 'true' : 'false');
          }
        }

        function toolbarButton(label, pressed) {
          var button = document.createElement('button');
          button.type = 'button';
          button.textContent = label;
          button.setAttribute('aria-pressed', pressed ? 'true' : 'false');
          tools.appendChild(button);
          return button;
        }

        var TOOL_NAMES = ['pen', 'eraser'];
        var TOOL_LABELS = ['Pen', 'Eraser'];
        for (var t = 0; t < TOOL_NAMES.length; t++) {
          (function (index) {
            var button = toolbarButton(TOOL_LABELS[index], index === 0);
            button.onclick = function () {
              tool = TOOL_NAMES[index];
              pressGroup(toolButtons, index);
              // A colour cannot mean anything while the eraser is on, and a
              // disabled button says so where a silently ignored one would not.
              for (var c = 0; c < colorButtons.length; c++) {
                colorButtons[c].disabled = tool === 'eraser';
              }
              recordPen();
            };
            toolButtons.push(button);
          })(t);
        }

        for (var s = 0; s < PEN_SIZE_LABELS.length; s++) {
          (function (index) {
            var button = toolbarButton(PEN_SIZE_LABELS[index], index === size);
            button.onclick = function () {
              size = index;
              pressGroup(sizeButtons, index);
              recordPen();
            };
            sizeButtons.push(button);
          })(s);
        }

        for (var k = 0; k < PEN_INKS.length; k++) {
          (function (index) {
            var button = document.createElement('button');
            button.type = 'button';
            button.setAttribute('aria-pressed', index === 0 ? 'true' : 'false');
            var swatch = document.createElement('span');
            swatch.className = 'drawing-swatch';
            // The one literal colour on the page, inline rather than in the
            // stylesheet: the dot has to show the ink it actually draws. Colour
            // alone is never the state (WCAG 1.4.1) — the name is beside it.
            swatch.style.background = PEN_INKS[index][1];
            button.appendChild(swatch);
            button.appendChild(document.createTextNode(PEN_INKS[index][0]));
            button.onclick = function () {
              color = PEN_INKS[index][1];
              pressGroup(colorButtons, index);
              recordPen();
            };
            colorButtons.push(button);
            tools.appendChild(button);
          })(k);
        }

        // D-7: at the end of the strip, and disabled until there is a stroke to
        // take back. A restored picture is not a stroke.
        var undoButton = document.createElement('button');
        undoButton.type = 'button';
        undoButton.textContent = 'Undo';
        undoButton.disabled = true;
        undoButton.onclick = function () { undo(); };
        tools.appendChild(undoButton);

        wrap.appendChild(tools);
        wrap.appendChild(canvas);

        var context = canvas.getContext ? canvas.getContext('2d') : null;
        if (context) {
          context.lineWidth = PEN_WIDTH;
          context.lineCap = 'round';
          context.lineJoin = 'round';
          context.strokeStyle = PEN_COLOR;
          // Before any stroke and before the P-1 restore below.
          paintBackground(context, canvas, background);
        }

        // Porter-Duff `over` is associative, so replaying the list lands on the
        // same pixels the incremental drawing did.
        function rebuild() {
          if (!context) return;
          context.clearRect(0, 0, canvas.width, canvas.height);
          paintBackground(context, canvas, background);
          if (baseline) {
            context.drawImage(baseline, 0, 0, canvas.width, canvas.height);
          }
          for (var i = 0; i < strokes.length; i++) {
            var stroke = strokes[i];
            context.lineWidth = stroke.width;
            context.strokeStyle = stroke.color;
            context.globalCompositeOperation =
              stroke.tool === 'eraser' ? 'destination-out' : 'source-over';
            context.beginPath();
            context.moveTo(stroke.points[0][0], stroke.points[0][1]);
            for (var p = 1; p < stroke.points.length; p++) {
              context.lineTo(stroke.points[p][0], stroke.points[p][1]);
            }
            context.stroke();
          }
          // The paper goes back under whatever the replayed erasers cut out. A
          // blank canvas paints nothing, so the mode is restored here instead.
          if (!paintBackground(context, canvas, background, true)) {
            context.globalCompositeOperation = 'source-over';
          }
        }

        function undo() {
          if (!strokes.length) return;
          strokes.pop();
          rebuild();
          undoButton.disabled = strokes.length === 0;
          touched();
        }

        // The "Draw something first." guard. Eraser-only work on a blank canvas
        // is not an answer, and undoing everything makes the guard true again.
        function isMarked() {
          if (savedPresent) return true;
          for (var i = 0; i < strokes.length; i++) {
            if (strokes[i].tool === 'pen') return true;
          }
          return false;
        }

        // --- auto-save (D-8) ------------------------------------------------
        // Guarded: a runtime without timers (a stripped build) simply never
        // auto-saves, and the Save drawing button is still the whole path.
        function cancelIdle() {
          if (idleTimer !== null && typeof clearTimeout === 'function') {
            window.clearTimeout(idleTimer);
          }
          idleTimer = null;
        }

        // Every change the student makes to the picture: the end of a pen or
        // eraser stroke, an undo, a Clear. The timer restarts from zero, so a
        // student mid-drawing is never interrupted by an upload.
        function touched() {
          cancelIdle();
          if (!isMarked()) {
            // Nothing to upload, and that is not the same as nothing happening:
            // the student may have just undone or cleared everything they had.
            // A blank PNG is not an answer, and the server keeps the last
            // picture that WAS saved — so no timer is scheduled and the dirty
            // flag goes with it. Clearing an answer for real is the teacher's
            // path, not a blank upload.
            dirty = false;
            return;
          }
          dirty = true;
          if (typeof setTimeout !== 'function') return;
          idleTimer = window.setTimeout(function () {
            idleTimer = null;
            flushNow();
          }, AUTO_SAVE_IDLE_MS);
        }

        // The idle timer's callback, and the flush points' one entry point.
        function flushNow() {
          cancelIdle();
          // Offline every save is ignored by the host and relabelled, so
          // auto-save is off there; the manual button still posts, because the
          // host's "drawing ignored" line is the hand-run evidence.
          if (OFFLINE_MODE) return;
          if (!dirty || !isMarked()) return;
          // The result callback sends what is dirty when it arrives.
          if (inFlight) return;
          inFlight = true;
          dirty = false;
          status.className = 'drawing-status';
          status.textContent = 'Saving…';
          postDrawing(item.id, canvas.toDataURL('image/png'));
        }
        DRAWING_FLUSHES.push(flushNow);
        // The per-block hook the pager and Finish reach for; also what a test
        // presses.
        wrap.__flushDrawing = flushNow;

        // Focus leaving the item — Tab into the next question, a page turn's
        // focus move — is a save point: the work is about to leave the screen.
        // Focus moving between the toolbar and the canvas is not.
        wrap.onfocusout = function (event) {
          var to = event ? event.relatedTarget : null;
          if (to && typeof wrap.contains === 'function' && wrap.contains(to)) return;
          flushNow();
        };

        // D-5: Cmd-Z undoes while focus is inside THIS drawing item — read on
        // the wrap, not the document, so two drawing items cannot undo each
        // other and a Cmd-Z in the essay's textarea is untouched. There is no
        // Edit -> Undo menu item to route through (AppDelegate), so WebKit hands
        // the key to the page; the button is the path that must work regardless.
        // No Redo — a second stack for something nobody asked for.
        wrap.onkeydown = function (event) {
          if (!event || !event.metaKey || event.shiftKey) return;
          if (event.key !== 'z' && event.key !== 'Z') return;
          if (typeof event.preventDefault === 'function') event.preventDefault();
          undo();
        };

        function positionOf(event) {
          var box = canvas.getBoundingClientRect ? canvas.getBoundingClientRect() : null;
          if (!box || !box.width) return { x: event.offsetX || 0, y: event.offsetY || 0 };
          // The element is scaled to fit, so pointer coordinates are mapped back
          // into the canvas's own pixel space — otherwise a stroke lands away
          // from the cursor on any display that scales it.
          return {
            x: (event.clientX - box.left) * (canvas.width / box.width),
            y: (event.clientY - box.top) * (canvas.height / box.height)
          };
        }

        canvas.onpointerdown = function (event) {
          if (!context) return;
          drawing = true;
          var at = positionOf(event);
          current = {
            tool: tool,
            width: widthNow(),
            color: color,
            points: [[at.x, at.y]]
          };
          strokes.push(current);
          undoButton.disabled = false;
          context.lineWidth = current.width;
          context.strokeStyle = current.color;
          // D-3: the eraser cuts to transparent rather than painting the paper
          // colour — a white blob would lose the grid lines under it, and on a
          // blank canvas it would turn a transparent PNG into a blotched one.
          context.globalCompositeOperation =
            current.tool === 'eraser' ? 'destination-out' : 'source-over';
          context.beginPath();
          context.moveTo(at.x, at.y);
        };
        canvas.onpointermove = function (event) {
          if (!drawing || !context) return;
          var at = positionOf(event);
          current.points.push([at.x, at.y]);
          context.lineTo(at.x, at.y);
          context.stroke();
          if (current.tool === 'eraser'
              && paintBackground(context, canvas, background, true)) {
            // Under-painting on every move, not once at the end: otherwise a
            // student on a dark contrast set sees the page ground through the
            // hole mid-stroke. The paint strokes paths of its own, so the
            // eraser's is restarted where it had reached.
            context.globalCompositeOperation = 'destination-out';
            context.beginPath();
            context.moveTo(at.x, at.y);
          }
        };
        function endStroke() {
          // Only a stroke that actually happened restarts the auto-save timer:
          // pointerleave fires on a pointer that was never down too.
          var drew = current !== null;
          drawing = false;
          if (context && current && current.tool === 'eraser') {
            // The under-paint hands the normal mode back itself when it paints;
            // a blank canvas paints nothing, so it is restored here.
            if (!paintBackground(context, canvas, background, true)) {
              context.globalCompositeOperation = 'source-over';
            }
          }
          current = null;
          if (drew) touched();
        }
        canvas.onpointerup = endStroke;
        canvas.onpointerleave = endStroke;

        var controls = document.createElement('div');
        controls.className = 'drawing-controls';

        var status = document.createElement('span');
        status.className = 'drawing-status';

        var clear = document.createElement('button');
        clear.type = 'button';
        clear.textContent = 'Clear';
        clear.onclick = function () {
          if (context) {
            context.clearRect(0, 0, canvas.width, canvas.height);
            // Clear takes the work away, not the paper (D-3 of the background
            // page).
            paintBackground(context, canvas, background);
          }
          // D-4: Clear is not undoable. It empties the stroke list and drops the
          // restored picture too — "Clear then Undo brings it all back" is a
          // second mental model for a button whose copy says what it does.
          strokes = [];
          current = null;
          baseline = null;
          savedPresent = false;
          undoButton.disabled = true;
          status.className = 'drawing-status';
          status.textContent = '';
          // Cancels a pending auto-save of work that is now gone; schedules
          // nothing, because a cleared canvas is not an answer to upload.
          touched();
        };
        controls.appendChild(clear);

        var save = document.createElement('button');
        save.type = 'button';
        save.textContent = 'Save drawing';
        save.onclick = function () {
          if (!isMarked()) {
            // Handing in a blank canvas looks identical to not answering, and
            // would cost the student an upload slot to say nothing.
            status.className = 'drawing-status';
            status.textContent = 'Draw something first.';
            return;
          }
          status.className = 'drawing-status';
          // Offline, no __secureTestDrawingResult will ever arrive, so the
          // label states the outcome now. The post still goes: the host's
          // "drawing ignored" log line is the hand-run evidence.
          status.textContent = OFFLINE_MODE
            ? 'Offline mode: not saved to a server.'
            : 'Saving…';
          // Offline the button is exactly what it was before auto-save: post,
          // label, no state to keep (no callback will ever arrive to clear it).
          if (OFFLINE_MODE) {
            postDrawing(item.id, canvas.toDataURL('image/png'));
            return;
          }
          // Otherwise it is the same single-flight path the timer uses: a
          // student forcing a save now must not start a second upload beside
          // the one already out. The result callback sends this one.
          cancelIdle();
          if (inFlight) {
            dirty = true;
            return;
          }
          inFlight = true;
          dirty = false;
          postDrawing(item.id, canvas.toDataURL('image/png'));
        };
        controls.appendChild(save);
        controls.appendChild(status);
        wrap.appendChild(controls);

        // P-1 (D-1, James: restore the picture, not just a badge): the bytes
        // ride the bundle in `saved_uploads` — the `assets` precedent — rather
        // than a second fetch, because the page cannot reach the network at
        // all. Guarded for a runtime without an image decoder (the test shim,
        // a stripped build): the status still tells the truth there.
        //
        // The background paint happens at build time, above, and so before
        // this drawImage — painting it here would cover the student's restored
        // work. The saved PNG already carries its own paper, so the two agree.
        var savedDrawing = savedFor(item);
        if (savedDrawing) {
          var uploadId = savedDrawing.upload_id;
          var blob = (typeof uploadId === 'string'
            && Object.prototype.hasOwnProperty.call(SAVED_UPLOADS, uploadId))
            ? SAVED_UPLOADS[uploadId]
            : null;
          if (blob && blob.base64 && blob.content_type
              && context && typeof context.drawImage === 'function'
              && typeof Image === 'function') {
            var restored = new Image();
            // onload before src: a data URL can decode immediately, and a
            // handler attached afterwards would miss the event.
            restored.onload = function () {
              // Kept as the baseline so a rebuild after an undo can redraw it
              // under the remaining strokes. Assigned in `onload`, so `rebuild`
              // never draws an image that has not decoded.
              baseline = restored;
              context.drawImage(restored, 0, 0, canvas.width, canvas.height);
            };
            restored.src = 'data:' + blob.content_type + ';base64,' + blob.base64;
          }
          // Marked and labelled whether or not the bytes came: the answer IS
          // saved on the server, and a student pressing Save on work they did
          // last session must not be told to draw something first.
          savedPresent = true;
          status.className = 'drawing-status saved';
          status.textContent = 'Saved.';
        }

        // The host calls this back once the bytes are actually stored, so the
        // student is told their work is saved only when it is.
        wrap.__drawingSaved = function (ok) {
          inFlight = false;
          status.className = ok ? 'drawing-status saved' : 'drawing-status';
          status.textContent = ok ? 'Saved.' : 'Could not save. Tell your teacher.';
          // Drew more while the upload was out: send that now, so the label is
          // true of the picture on screen. On a failure nothing is retried on
          // its own — a loop against a broken network would post forever; the
          // next change starts the idle timer again.
          if (ok && dirty) flushNow();
        };
        canvas.__markedForTest = function () { return isMarked(); };

        return wrap;
      }

      // E3 slice 3: a grid of text fields, one per body cell. Headings and row
      // labels go through emphasisNodes (KaTeX + E6) like a match side; the
      // label column shows only when some row has a label (D-5). Every change
      // posts the cells that hold text; an all-blank grid posts nothing — the
      // same rule as match and multi-select: an unanswered item is the
      // absence of a response. The client cannot tell a right cell from a
      // wrong one: the bundle carries no expected text (cell_keys is dropped
      // server-side); scoring happens there against the key.
      function tableField(item) {
        var wrap = document.createElement('div');
        wrap.className = 'fill-table-wrap';
        var table = document.createElement('table');
        table.className = 'fill-table';
        table.setAttribute('aria-label', 'Table to fill in');
        var columns = item.columns || [];
        var rows = item.rows || [];
        var showLabels = rows.some(function (r) {
          return String(r.label || '').trim().length > 0;
        });

        var thead = document.createElement('thead');
        var head = document.createElement('tr');
        if (showLabels) {
          var corner = document.createElement('th');
          corner.setAttribute('scope', 'col');
          corner.className = 'table-corner';
          corner.appendChild(emphasisNodes(item.corner || ''));
          head.appendChild(corner);
        }
        columns.forEach(function (c) {
          var th = document.createElement('th');
          th.setAttribute('scope', 'col');
          th.appendChild(emphasisNodes(c.label || ''));
          head.appendChild(th);
        });
        thead.appendChild(head);
        table.appendChild(thead);

        var inputs = [];
        function emit() {
          var cells = {};
          var any = false;
          inputs.forEach(function (entry) {
            var value = entry.input.value;
            if (value === undefined || value === null || value === '') return;
            if (!cells[entry.rowId]) cells[entry.rowId] = {};
            cells[entry.rowId][entry.colId] = String(value);
            any = true;
          });
          if (!any) return;
          post(item.id, { type: 'table', cells: cells });
        }

        // P-1: the cells the student filled, row id → column id → text. A
        // saved cell whose row or column is gone is simply not restored.
        var savedTable = savedFor(item);
        var savedCells = (savedTable && savedTable.cells && typeof savedTable.cells === 'object')
          ? savedTable.cells
          : null;

        var tbody = document.createElement('tbody');
        rows.forEach(function (r, ri) {
          var tr = document.createElement('tr');
          if (showLabels) {
            var th = document.createElement('th');
            th.setAttribute('scope', 'row');
            th.appendChild(emphasisNodes(r.label || ''));
            tr.appendChild(th);
          }
          columns.forEach(function (c, ci) {
            var td = document.createElement('td');
            var input = document.createElement('input');
            input.type = 'text';
            input.className = 'table-cell';
            var savedRow = (savedCells
              && Object.prototype.hasOwnProperty.call(savedCells, r.id))
              ? savedCells[r.id]
              : null;
            var savedCell = (savedRow && typeof savedRow === 'object'
              && Object.prototype.hasOwnProperty.call(savedRow, c.id))
              ? savedRow[c.id]
              : null;
            input.value = typeof savedCell === 'string' ? savedCell : '';
            input.autocomplete = 'off';
            input.autocapitalize = 'off';
            // Same per-student gate as every field the student types into.
            input.spellcheck = !!ACCOMMODATIONS.spell_check;
            var rowName = stripEmphasis(r.label || '').trim() || ('Row ' + (ri + 1));
            var colName = stripEmphasis(c.label || '').trim() || ('Column ' + (ci + 1));
            input.setAttribute('aria-label', rowName + ', ' + colName);
            input.onchange = emit;
            inputs.push({ rowId: r.id, colId: c.id, input: input });
            td.appendChild(input);
            tr.appendChild(td);
          });
          tbody.appendChild(tr);
        });
        table.appendChild(tbody);
        wrap.appendChild(table);
        return wrap;
      }

      function unsupported(kind) {
        var p = document.createElement('p');
        p.className = 'unsupported';
        p.textContent = 'This item type (' + kind + ') is not available yet.';
        return p;
      }

      function answerFor(item) {
        switch (item.type) {
          case 'multiple_choice_single': return choiceList(item, false);
          case 'multiple_choice_multi': return choiceList(item, true);
          case 'short_text': return shortTextField(item);
          case 'essay': return essayField(item);
          case 'match': return matchField(item);
          case 'order': return orderField(item);
          case 'hotspot': return hotspotField(item);
          case 'drawing_upload': return drawingField(item);
          case 'table': return tableField(item);
          default: return unsupported(item.type);
        }
      }

      // The host resolves an item id back to its rendered block so it can
      // report an upload result to the right one.
      var BLOCKS = {};
      window.__secureTestDrawingResult = function (itemId, ok) {
        var block = BLOCKS[itemId];
        if (block && block.__drawingSaved) block.__drawingSaved(ok);
        // A drawing counts as answered once the host says the bytes are stored.
        if (ok) markAnswered(itemId);
      };

      // Slice 73: handing the test in. Its own channel, like drawings, because
      // the page cannot reach the network and the host has to make the call and
      // then clear the local queue.
      function buildFinish() {
        var wrap = document.createElement('div');
        wrap.className = 'finish';

        var button = document.createElement('button');
        button.type = 'button';
        button.textContent = 'Finish and hand in';

        var status = document.createElement('p');
        status.className = 'finish-status';

        button.onclick = function () {
          button.disabled = true;
          // Auto-save flush point (D-8), BEFORE the submit goes: a drawing
          // changed in the last five seconds would otherwise be handed in
          // unsaved. The host's upload gate is the other half — it holds the
          // submit until the bytes these posts start have landed.
          flushAllDrawings();
          // Offline, no __secureTestSubmitResult will ever arrive: the
          // hand-in completes here, so the label says so and the button stays
          // disabled as it would after a confirmed hand-in. The post still
          // goes, for the host's "submit ignored" log line.
          status.textContent = OFFLINE_MODE
            ? 'Finished. Offline mode: nothing was sent to a server.'
            : 'Handing in…';
          try {
            window.webkit.messageHandlers.submit.postMessage({ confirm: true });
          } catch (e) {
            button.disabled = false;
            status.textContent = 'Could not hand in. Tell your teacher.';
          }
        };

        wrap.appendChild(button);
        wrap.appendChild(status);

        window.__secureTestSubmitResult = function (ok) {
          if (ok) {
            // Left disabled on success: handing in is not something to undo by
            // pressing the button again.
            status.textContent = 'Handed in. You can close the app.';
            // UX pass 2 (James, 2026-08-31): a clear way home beside the
            // notice — the titlebar route alone was too subtle.
            if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.home) {
              var homeBtn = document.createElement('button');
              homeBtn.textContent = 'Back to your tests';
              homeBtn.style.marginLeft = '12px';
              homeBtn.onclick = function () {
                try { window.webkit.messageHandlers.home.postMessage({}); } catch (e) {}
              };
              wrap.appendChild(homeBtn);
            }
          } else {
            button.disabled = false;
            status.textContent = 'Could not hand in. Tell your teacher.';
          }
        };
        return wrap;
      }

      // Client paging (docs/client-paging-design.md, D-1): only an explicit
      // "paged" pages. Anything else — absent, or a value this build has not
      // heard of — is the one scrolling page, and that path builds the same
      // tree it did before the flag existed.
      var PAGED = !!(BUNDLE && BUNDLE.layout === 'paged');

      // Multi-source stimulus slice 4: `side_by_side` is two columns only when
      // there is room for them. Read ONCE, at build time — re-paging on a
      // resize would rebuild the tree and take unsaved typing and unsaved
      // strokes with it, and the client is fullscreen by default (batch 4,
      // S-8). Narrower than the threshold the set behaves exactly like
      // own_page; the two-column body itself collapses in CSS if the window is
      // dragged smaller after the build. `__forceWide` is the test harness's
      // hook — JavaScriptCore has no window metrics at all.
      var LAYOUT_MIN_WIDE_PX = 1100;
      var WIDE = typeof window.__forceWide === 'boolean'
        ? window.__forceWide
        : (typeof window.innerWidth === 'number' ? window.innerWidth >= LAYOUT_MIN_WIDE_PX : true);

      var root = document.getElementById('items');
      // Offline path (James, 2026-08-28, follow-up to finding 8.5): a standing
      // notice under the heading, because MC / short-text / essay answers
      // carry no status label of their own and would otherwise show no
      // offline signal at all.
      if (OFFLINE_MODE) {
        var offlineNotice = document.createElement('p');
        offlineNotice.className = 'offline-notice';
        offlineNotice.textContent = 'Offline mode: answers are not saved to a server.';
        root.appendChild(offlineNotice);
      }
      var setAtFirst = {};   // item id → set that opens there
      var setOfItem = {};    // item id → set it belongs to
      var indexOf = {};
      ITEMS.forEach(function (item, i) { indexOf[item.id] = i; });
      SETS.forEach(function (set) {
        var members = (set.item_ids || []).filter(function (id) {
          return Object.prototype.hasOwnProperty.call(indexOf, id);
        });
        if (members.length === 0) return;
        members.sort(function (a, b) { return indexOf[a] - indexOf[b]; });
        set.__first = indexOf[members[0]];
        set.__last = indexOf[members[members.length - 1]];
        setAtFirst[members[0]] = set;
        members.forEach(function (id) { setOfItem[id] = set; });
      });

      // Multi-source stimulus slice 4: which source a set has open, kept in
      // memory only (nothing posts) so a page turn inside the set comes back
      // to the source the student was reading.
      var OPEN_SOURCE = {};

      // The labelled sources under a set's introduction. Several sources are
      // tabs — the WAI-ARIA tab pattern, with the roving-tabindex model the
      // math keypad already uses (D-3.1), so the strip is ONE Tab stop. One
      // source is a labelled panel: a strip of one tab is furniture.
      function sourcePane(set) {
        var sources = (set.sources || []).filter(function (source) {
          return source && typeof source.label === 'string' && typeof source.text === 'string';
        });
        if (sources.length === 0) return null;
        var pane = document.createElement('div');
        pane.className = 'source-pane';
        var panels = [];
        var single = sources.length === 1;
        sources.forEach(function (source, i) {
          var panel = document.createElement('div');
          panel.className = 'source-panel';
          panel.setAttribute('id', 'source-' + set.id + '-' + i);
          // The panel scrolls (CSS), so it is focusable — a keyboard student
          // must be able to scroll a long source without a pointer.
          panel.setAttribute('tabindex', '0');
          panel.setAttribute('aria-labelledby', 'source-tab-' + set.id + '-' + i);
          if (single) {
            panel.setAttribute('role', 'group');
            var heading = document.createElement('h3');
            heading.className = 'source-label';
            heading.setAttribute('id', 'source-tab-' + set.id + '-' + i);
            heading.textContent = source.label;
            panel.appendChild(heading);
          } else {
            panel.setAttribute('role', 'tabpanel');
          }
          var body = document.createElement('div');
          body.className = 'source-body';
          body.appendChild(textWithAssets(source.text));
          panel.appendChild(body);
          panels.push(panel);
        });
        if (single) {
          pane.appendChild(panels[0]);
          return pane;
        }
        var strip = document.createElement('div');
        strip.className = 'source-tabs';
        strip.setAttribute('role', 'tablist');
        strip.setAttribute('aria-label', 'Sources');
        var tabs = [];
        var open = OPEN_SOURCE[set.id];
        if (typeof open !== 'number' || open < 0 || open >= sources.length) open = 0;
        var select = function (index) {
          open = index;
          OPEN_SOURCE[set.id] = index;
          for (var i = 0; i < tabs.length; i++) {
            tabs[i].setAttribute('aria-selected', i === index ? 'true' : 'false');
            tabs[i].setAttribute('tabindex', i === index ? '0' : '-1');
            tabs[i].className = i === index ? 'source-tab source-tab-open' : 'source-tab';
            if (i === index) panels[i].removeAttribute('hidden');
            else panels[i].setAttribute('hidden', '');
          }
        };
        sources.forEach(function (source, i) {
          var tab = document.createElement('button');
          tab.type = 'button';
          tab.className = 'source-tab';
          tab.setAttribute('role', 'tab');
          tab.setAttribute('id', 'source-tab-' + set.id + '-' + i);
          tab.setAttribute('aria-controls', 'source-' + set.id + '-' + i);
          tab.textContent = source.label;
          tab.onclick = function () { select(i); };
          tabs.push(tab);
          strip.appendChild(tab);
        });
        // Left / Right move between the tabs and wrap; Home / End go to the
        // ends. Read on the strip, so it covers every tab with one handler.
        strip.onkeydown = function (event) {
          if (!event || !tabs.length) return;
          var next = -1;
          if (event.key === 'ArrowRight') next = (open + 1) % tabs.length;
          else if (event.key === 'ArrowLeft') next = (open + tabs.length - 1) % tabs.length;
          else if (event.key === 'Home') next = 0;
          else if (event.key === 'End') next = tabs.length - 1;
          else return;
          if (typeof event.preventDefault === 'function') event.preventDefault();
          select(next);
          if (typeof tabs[next].focus === 'function') tabs[next].focus();
        };
        pane.appendChild(strip);
        panels.forEach(function (panel) { pane.appendChild(panel); });
        select(open);
        return pane;
      }

      function stimulusBlock(set) {
        var block = document.createElement('section');
        block.className = 'stimulus stimulus-' + (set.layout === 'own_page' ? 'own_page' : 'inline');
        var label = document.createElement('p');
        label.className = 'stimulus-label';
        label.textContent = set.__first === set.__last
          ? 'Question ' + (set.__first + 1)
          : 'Questions ' + (set.__first + 1) + '\u2013' + (set.__last + 1);
        block.appendChild(label);
        var body = document.createElement('div');
        body.className = 'stimulus-body';
        body.appendChild(textWithAssets(set.stimulus));
        block.appendChild(body);
        // Slice 4: the introduction on top, the sources beneath it — under
        // every layout, since side_by_side only changes where the block goes.
        var pane = sourcePane(set);
        if (pane) block.appendChild(pane);
        // E12 slice 3 (decision D-4): when the stimulus should be the
        // student's own earlier answer and it did not come from the source
        // assessment, the block carries a writing area — empty when nothing
        // exists yet (source_missing), prefilled and still editable when
        // they wrote it here before. The text posts on the ordinary response
        // channel under inline_item_id; the host PUTs it like any answer.
        if (typeof set.inline_item_id === 'string' && set.inline_item_id) {
          var area = document.createElement('div');
          area.className = 'outline-inline';
          var hint = document.createElement('p');
          hint.className = 'outline-hint';
          hint.textContent = set.source_missing === true
            ? 'You have not written your outline yet. Write it here first — the questions below build on it.'
            : 'Your outline. You can still change it here.';
          area.appendChild(hint);
          var ta = document.createElement('textarea');
          ta.className = 'outline-text';
          ta.autocomplete = 'off';
          ta.spellcheck = !!ACCOMMODATIONS.spell_check;
          ta.value = typeof set.inline_text === 'string' ? set.inline_text : '';
          var status = document.createElement('p');
          status.className = 'outline-status';
          ta.onchange = function () {
            post(set.inline_item_id, { type: 'essay', text: ta.value });
            status.textContent = OFFLINE_MODE ? 'Kept on this Mac (offline mode).' : 'Saved.';
          };
          area.appendChild(ta);
          area.appendChild(status);
          block.appendChild(area);
        }
        return block;
      }

      function itemBlock(item) {
        var wrap = document.createElement('div');
        wrap.className = setOfItem[item.id] ? 'item in-set' : 'item';
        var stem = document.createElement('p');
        stem.className = 'stem';
        stem.appendChild(textWithAssets(item.stem));
        wrap.appendChild(stem);
        var answer = answerFor(item);
        if (answer.__drawingSaved) BLOCKS[item.id] = answer;
        wrap.appendChild(answer);
        return wrap;
      }

      // One page at a time (D-2, D-3). A question with no set is a page; an
      // inline set is ONE page — its stimulus on top, its questions beneath;
      // an own_page set is a passage page and then a page per question with
      // the passage collapsed above it. The passage is ONE element moved
      // between the passage page and the open question's disclosure (never
      // duplicated), so an E12 writing area inside it stays a single
      // textarea with a single post path. A last page reviews and hands in.
      function buildPaged() {
        var total = ITEMS.length;
        var pages = [];
        var setPages = {};   // set id → the page an inline set's members share
        // C-1 (2026-09-09): set id → the student put this set's sources ABOVE
        // the question. In memory only, and never read at build time: the page
        // DOM persists across page turns, so the choice survives without
        // anything being rebuilt, and a relaunch reasonably starts over.
        var stackedSets = {};

        function newPage(kind, label, short) {
          var el = document.createElement('section');
          el.className = 'page';
          el.setAttribute('data-kind', kind);
          var heading = document.createElement('p');
          heading.className = 'page-label';
          heading.setAttribute('tabindex', '-1');
          heading.textContent = label;
          el.appendChild(heading);
          // `body` is where a member item lands: the page itself, or the
          // right-hand column of a side_by_side page (slice 4).
          var page = { el: el, label: label, short: short, heading: heading, holder: null, set: null, items: [], body: el };
          pages.push(page);
          return page;
        }

        // Multi-source stimulus slice 4: what this build actually does with a
        // set's layout. `side_by_side` is two columns on a wide viewport and
        // own_page below the threshold — one place, so the passage page, the
        // disclosure and the member routing all agree.
        function layoutOf(set) {
          if (set.layout === 'side_by_side') return WIDE ? 'side_by_side' : 'own_page';
          return set.layout === 'own_page' ? 'own_page' : 'inline';
        }

        // C-1 (2026-09-09): the two-button group that moves one set's sources
        // between the left column and above the question. A group rather than a
        // single toggle so both destinations are named on screen (James); the
        // pressed one carries aria-pressed="true", which is also what the CSS
        // fills. Nothing is rebuilt — the class on the split is the whole
        // change, so no answer, no stroke and no caret is disturbed.
        function layoutToggle(setId, split) {
          var group = document.createElement('div');
          group.className = 'layout-toggle';
          group.setAttribute('role', 'group');
          group.setAttribute('aria-label', 'Where the sources appear');
          var label = document.createElement('span');
          label.className = 'layout-toggle-label';
          label.textContent = 'Sources:';
          group.appendChild(label);
          var beside = document.createElement('button');
          var above = document.createElement('button');
          var paint = function () {
            var stacked = !!stackedSets[setId];
            split.className = stacked ? 'side-by-side stacked' : 'side-by-side';
            beside.setAttribute('aria-pressed', stacked ? 'false' : 'true');
            above.setAttribute('aria-pressed', stacked ? 'true' : 'false');
          };
          beside.type = 'button';
          beside.textContent = 'Beside the question';
          beside.onclick = function () { stackedSets[setId] = false; paint(); };
          above.type = 'button';
          above.textContent = 'Above the question';
          above.onclick = function () { stackedSets[setId] = true; paint(); };
          group.appendChild(beside);
          group.appendChild(above);
          paint();
          return group;
        }

        function rangeOf(set) {
          return set.__first === set.__last
            ? 'question ' + (set.__first + 1)
            : 'questions ' + (set.__first + 1) + '\u2013' + (set.__last + 1);
        }

        ITEMS.forEach(function (item, index) {
          var opener = setAtFirst[item.id];
          var set = setOfItem[item.id];
          if (opener) {
            var block = stimulusBlock(opener);
            var mode = layoutOf(opener);
            if (mode === 'own_page') {
              opener.__block = block;
              var passage = newPage('passage', 'Passage for ' + rangeOf(opener), 'P');
              passage.holder = document.createElement('div');
              passage.holder.className = 'passage-holder';
              passage.set = opener;
              passage.el.appendChild(passage.holder);
              // Starts on its own page; travels into a member's disclosure
              // when that member is open, and back here when this page is.
              passage.holder.appendChild(block);
            } else {
              var shared = newPage(
                'questions',
                (opener.__first === opener.__last ? 'Question ' : 'Questions ') +
                  rangeOf(opener).replace(/^questions? /, '') + ' of ' + total,
                String(opener.__first + 1) + (opener.__first === opener.__last ? '' : '\u2013' + (opener.__last + 1))
              );
              if (mode === 'side_by_side') {
                // The sources left, the member(s) right, each column scrolling
                // on its own; every member of the set shares this one page.
                var split = document.createElement('div');
                split.className = 'side-by-side';
                var left = document.createElement('div');
                left.className = 'side-source';
                left.appendChild(block);
                var right = document.createElement('div');
                right.className = 'side-questions';
                split.appendChild(left);
                split.appendChild(right);
                // C-1: the student's own "beside / above" choice, above the
                // split it governs. Only a real two-column page gets one — the
                // narrow fallback is already the stacked presentation.
                shared.el.appendChild(layoutToggle(opener.id, split));
                shared.el.appendChild(split);
                shared.body = right;
              } else {
                shared.el.appendChild(block);
              }
              setPages[opener.id] = shared;
            }
          }
          if (set && layoutOf(set) !== 'own_page' && setPages[set.id]) {
            setPages[set.id].body.appendChild(itemBlock(item));
            setPages[set.id].items.push(item.id);
            return;
          }
          var page = newPage('question', 'Question ' + (index + 1) + ' of ' + total, String(index + 1));
          page.items.push(item.id);
          if (set && layoutOf(set) === 'own_page') {
            var ref = document.createElement('details');
            ref.className = 'passage-ref';
            var summary = document.createElement('summary');
            // Slice 4: a set that carries sources calls them sources.
            summary.textContent = (set.sources || []).length > 0
              ? 'Show the sources'
              : 'Show the passage';
            ref.appendChild(summary);
            page.holder = document.createElement('div');
            page.holder.className = 'passage-holder';
            page.set = set;
            ref.appendChild(page.holder);
            page.el.appendChild(ref);
          }
          page.el.appendChild(itemBlock(item));
        });

        var review = newPage('review', 'Review and hand in', 'Review');
        var count = document.createElement('p');
        count.className = 'review-count';
        review.el.appendChild(count);
        var list = document.createElement('ul');
        list.className = 'review-list';
        review.el.appendChild(list);
        review.el.appendChild(buildFinish());

        // The bar: Previous, the current page, Next; a strip of every page.
        var pager = document.createElement('nav');
        pager.className = 'pager';
        pager.setAttribute('aria-label', 'Move through the test');
        var row = document.createElement('div');
        row.className = 'pager-row';
        var prev = document.createElement('button');
        prev.type = 'button';
        prev.className = 'pager-prev';
        prev.textContent = 'Previous';
        var current = document.createElement('span');
        current.className = 'pager-current';
        current.setAttribute('aria-live', 'polite');
        var next = document.createElement('button');
        next.type = 'button';
        next.className = 'pager-next';
        next.textContent = 'Next';
        row.appendChild(prev);
        row.appendChild(current);
        row.appendChild(next);
        pager.appendChild(row);
        var strip = document.createElement('div');
        strip.className = 'pager-strip';
        pager.appendChild(strip);

        var at = 0;
        var stripButtons = [];
        var reviewButtons = [];

        // Answered marks (D-4 follow-up): a question page is answered when
        // its question is; an inline set's page says "n of m"; a passage has
        // nothing to answer. Recomputed from ANSWERED whenever it changes.
        function answeredOf(page) {
          var done = page.items.filter(function (id) { return ANSWERED[id] === true; }).length;
          return { done: done, of: page.items.length };
        }
        function refreshMarks() {
          var answeredTotal = 0;
          ITEMS.forEach(function (item) { if (ANSWERED[item.id] === true) answeredTotal += 1; });
          count.textContent = answeredTotal + ' of ' + total + ' answered. Go back to any question, or hand in.';
          pages.forEach(function (page, i) {
            var a = answeredOf(page);
            var state = a.of === 0 ? '' : a.done === a.of ? 'answered' : a.done > 0 ? 'partly answered' : 'not answered';
            var detail = a.of > 1 && a.done > 0 && a.done < a.of ? a.done + ' of ' + a.of + ' answered' : state;
            var button = stripButtons[i];
            if (button) {
              button.className = a.of === 0 ? '' : a.done === a.of ? 'answered' : a.done > 0 ? 'partial' : 'unanswered';
              button.textContent = page.short + (a.of > 0 && a.done === a.of ? ' \u2713' : '');
              button.setAttribute('aria-label', page.label + (detail ? ', ' + detail : ''));
            }
            var jump = reviewButtons[i];
            if (jump) {
              jump.textContent = page.label.replace(/ of \d+$/, '') + (detail ? ' \u00b7 ' + detail : '');
            }
          });
        }
        onAnswered = refreshMarks;

        function show(n) {
          if (n < 0 || n >= pages.length) return;
          // Auto-save flush point (D-8): a drawing about to be hidden by a page
          // turn saves at once rather than waiting out its idle timer. Every
          // block, not only this page's — a hook with nothing dirty is a no-op,
          // and the pager does not know which page a drawing sits on.
          flushAllDrawings();
          at = n;
          pages.forEach(function (page, i) {
            if (i === n) page.el.removeAttribute('hidden');
            else page.el.setAttribute('hidden', '');
            if (stripButtons[i]) {
              if (i === n) stripButtons[i].setAttribute('aria-current', 'page');
              else stripButtons[i].removeAttribute('aria-current');
            }
          });
          var page = pages[n];
          // The passage travels to whichever page is open (one element).
          if (page.holder && page.set && page.set.__block) page.holder.appendChild(page.set.__block);
          current.textContent = page.label;
          prev.disabled = n === 0;
          next.disabled = n === pages.length - 1;
          if (window.scrollTo) window.scrollTo(0, 0);
          if (typeof page.heading.focus === 'function') page.heading.focus();
        }
        prev.onclick = function () { show(at - 1); };
        next.onclick = function () { show(at + 1); };
        pages.forEach(function (page, i) {
          var button = document.createElement('button');
          button.type = 'button';
          button.textContent = page.short;
          button.setAttribute('aria-label', page.label);
          button.onclick = function () { show(i); };
          stripButtons.push(button);
          strip.appendChild(button);
          if (page.el.getAttribute('data-kind') !== 'review') {
            var li = document.createElement('li');
            var jump = document.createElement('button');
            jump.type = 'button';
            jump.textContent = page.label.replace(/ of \d+$/, '');
            jump.onclick = function () { show(i); };
            li.appendChild(jump);
            list.appendChild(li);
            reviewButtons[i] = jump;
          }
        });

        pages.forEach(function (page) { root.appendChild(page.el); });
        root.appendChild(pager);
        refreshMarks();
        show(0);
      }

      if (PAGED) {
        buildPaged();
      } else {
        ITEMS.forEach(function (item) {
          var opener = setAtFirst[item.id];
          if (opener) root.appendChild(stimulusBlock(opener));
          root.appendChild(itemBlock(item));
        });
        root.appendChild(buildFinish());
      }

      // KaTeX (ADR 0009): render $…$ and $$…$$ in everything authored — stems,
      // choices, match sides, sequence labels, stimuli — now that the tree is
      // built (James, 2026-09-01: all of them, not stems only). The library
      // and the macro constant are inlined ahead of this script; when they are
      // absent (the JavaScriptCore test harness, a stripped build) the source
      // text stays visible rather than the page failing. Same options as the
      // design tool's server-side renderer: errors render red, never throw;
      // strict off; trust off, so no \href / \url / \html* commands.
      //
      // C-2 (2026-09-09, docs/multi-source-stimulus-design.md): the walk below
      // is our own, not KaTeX's auto-render. Auto-render splits with a plain
      // delimiter search — no hook for the "a `$` before a digit is money"
      // rule, and it opens math on a backslash-escaped `\$` too — so it is no
      // longer inlined. This pass uses `mathSegments`, the one tokenizer the
      // client already shares with the design tool's renderers, and unescapes
      // `\$` to `$` in text exactly as `renderLatex`'s pushText does.
      var MATH_SKIP_TAGS = {
        textarea: true, input: true, select: true, script: true, style: true, canvas: true
      };

      // A fragment for one merged run of text, or null when it holds neither
      // math nor an escaped dollar (`\$57,600`, as the importer now writes
      // money, must lose its backslash even in prose with no math at all).
      function mathFragment(text) {
        var segs = mathSegments(text);
        var hasMath = segs.some(function (seg) { return seg.math; });
        if (!hasMath && text.indexOf('\\$') === -1) return null;
        var frag = document.createDocumentFragment();
        segs.forEach(function (seg) {
          if (!seg.math) {
            frag.appendChild(document.createTextNode(seg.text.replace(/\\\$/g, '$')));
            return;
          }
          var display = seg.text.slice(0, 2) === '$$';
          var open = display ? 2 : 1;
          var tex = seg.text.slice(open, seg.text.length - open);
          var span = document.createElement('span');
          try {
            katex.render(tex, span, {
              displayMode: display,
              throwOnError: false,
              errorColor: '#cc0000',
              strict: 'ignore',
              trust: false,
              macros: (typeof KATEX_MACROS === 'object' && KATEX_MACROS) ? KATEX_MACROS : {}
            });
            frag.appendChild(span);
          } catch (e) {
            // throwOnError keeps parse errors red rather than thrown, but a
            // TypeError still can escape; the raw source is better than a gap.
            console.log('KaTeX render failed: ' + (e && e.message));
            frag.appendChild(document.createTextNode(seg.text));
          }
        });
        return frag;
      }

      function renderMathIn(el) {
        var kids = el.childNodes;
        for (var i = 0; i < kids.length; i++) {
          var node = kids[i];
          if (node.nodeType === 3) {
            // Adjacent text nodes are merged first, as auto-render did, so an
            // expression split across nodes still parses as one.
            var text = node.textContent || '';
            var next = node.nextSibling, extra = 0;
            while (next && next.nodeType === 3) {
              text += next.textContent || '';
              next = next.nextSibling;
              extra += 1;
            }
            var frag = mathFragment(text);
            if (!frag) { i += extra; continue; }
            for (var d = 0; d < extra; d++) el.removeChild(node.nextSibling);
            i += frag.childNodes.length - 1;
            el.replaceChild(frag, node);
          } else if (node.nodeType === 1) {
            var tag = (node.nodeName || '').toLowerCase();
            if (MATH_SKIP_TAGS[tag] === true) continue;
            // Never re-enter markup KaTeX itself produced.
            if ((' ' + (node.className || '') + ' ').indexOf(' katex ') !== -1) continue;
            renderMathIn(node);
          }
        }
      }

      if (typeof katex === 'object' && katex && typeof katex.render === 'function') {
        try {
          renderMathIn(root);
        } catch (e) {
          console.log('KaTeX math pass failed: ' + (e && e.message));
        }
      }
    })();
    """#
}
