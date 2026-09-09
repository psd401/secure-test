// Renders an assessment to a static HTML page matching PoC-B's
// LockedDownWebView layout. The preview is read-only: no script tag, no
// message handlers, no clipboard probes — those were PoC-B-specific
// instrumentation, not student UX.
//
// CSP set both as a meta http-equiv (here) and as a response header
// (preview/[id]/route.ts) so the iframe gets the same posture even if a
// caller bypasses the route handler.
//
// Slice 11: stem + choice text run through renderLatex first so $...$ /
// $$...$$ math renders as KaTeX HTML. The full KaTeX stylesheet is
// inlined into the <style> block so the iframe stays no-script.
//
// Slice 12: stem + choice text additionally accept markdown-flavored
// image refs `![alt](asset:<uuid>)`. The renderItemContent pipeline
// resolves them to <img src="/api/assets/<uuid>"> tags when the caller
// supplies an owner-scoped asset map; unresolved refs render as inline
// red placeholders. Math + images are interleaved in one pass.

import type {
  HotspotRegion,
  MatchPair,
  Rubric,
  SequenceEntry,
  TableColumn,
  TableRow,
} from "@secure-test/schema";
import type { ItemType } from "@/db/schema";
import { assertNever } from "@/lib/assertNever";
import { escapeHtml } from "@/lib/escapeHtml";
import { renderItemContent, type ResolvedAsset } from "@/lib/items/renderItemContent";
import { ACCOMMODATION_CATALOG } from "@/lib/accommodations/catalog";
import { getKatexCss } from "./katexCss";

interface Choice {
  id: string;
  text: string;
}

export interface PreviewItem {
  id: string;
  position: number;
  type: ItemType;
  stem: string;
  choices: Choice[];
  correct_choice_ids: string[];
  correct_answer: string | null;
  // Essay-only authoring metadata (slice 32). The preview is no-script
  // (ADR 0009), so the word cap can't be enforced live here — it renders as
  // a visible hint, and `placeholder` fills the disabled textarea.
  max_word_count?: number | null;
  placeholder?: string | null;
  // Essay-only rubric (slice 33). Rendered read-only ONLY when the teacher
  // set student_visibility.during_test — mirroring what the student sees.
  rubric?: Rubric | null;
  // Match-only pair list (slice 47). Rights are displayed sorted so the
  // authored order (which IS the answer key) doesn't give matches away.
  pairs?: MatchPair[] | null;
  // Order-only sequence (slice 48), authored in correct order (the key).
  // Displayed deterministically shuffled, seeded from the item id.
  sequence?: SequenceEntry[] | null;
  // Hotspot-only (slice 49). Regions render as numbered outlines only —
  // the key (correct_region_ids) is deliberately NOT passed to the
  // renderer, so it can never leak into student-visible HTML.
  image_asset_id?: string | null;
  regions?: HotspotRegion[] | null;
  // Drawing/upload-only (slice 50, authoring-only): optional reference
  // image + canvas dimensions (shown as a hint; enforced by the client).
  // `background` (docs/drawing-background-design.md) names the paper the
  // client paints under the strokes; absent = blank.
  prompt_asset_id?: string | null;
  canvas?: { width: number; height: number; background?: "grid" | "axes" } | null;
  // Table-only (E3 slice 1): the grid. The key (cell_keys) is deliberately
  // NOT passed to the renderer, same posture as hotspot's correct_region_ids.
  columns?: TableColumn[] | null;
  rows?: TableRow[] | null;
  corner?: string | null;
}

// E5 slice 1: a stimulus shared by the items listed, rendered once above
// the first of them. `own_page` breaks the page before it in print.
export interface PreviewItemSet {
  id: string;
  stimulus: string;
  layout: "inline" | "own_page";
  item_ids: string[];
  /** E12 slice 4: the stimulus is each student's own answer to this
   * question; the teacher's preview and print show a placeholder there. */
  source?: { stem: string; assessment_name: string } | null;
}

export interface PreviewAssessment {
  id: string;
  name: string;
  // Slice 22: catalog ids the teacher opted into. Drives the visual
  // Tier-1 toolbar above the items. Tier-2+ entries are ignored at
  // preview time — they need runtime work the iframe can't host.
  allowed_accommodations: string[];
}

// Slice 22: render a visual Tier-1 toolbar that mirrors what the
// student will see when the macOS client gains Path B runtime support.
// Purely demonstrative — the spans are styled like buttons but inert
// (no script-src in our CSP). Use aria-disabled on a span instead of
// <button disabled> so screen-reader users still hear the labels.
function renderAccommodationsToolbar(allowed: readonly string[]): string {
  if (allowed.length === 0) return "";
  const allowedSet = new Set(allowed);
  const tier1 = ACCOMMODATION_CATALOG.filter(
    (e) => e.impl_tier === "T1" && allowedSet.has(e.id),
  );
  if (tier1.length === 0) return "";
  const buttons = tier1
    .map(
      (e) =>
        `<span class="tool-btn" role="button" aria-disabled="true">${escapeHtml(e.label)}</span>`,
    )
    .join("");
  return `<div class="accommodations-toolbar" aria-label="Tier 1 accommodations preview">${buttons}</div>`;
}

// Slice 33: a read-only, no-script rendering of a rubric for the student
// preview, shown only when the teacher opted into during-test visibility.
// Uniform across styles — analytic (N criteria × scale), holistic (1
// criterion), single_point (1 target level per criterion) all render the
// same criterion→levels shape.
function renderRubric(rubric: Rubric): string {
  const criteria = rubric.criteria
    .map((c) => {
      const rows = c.levels
        .map((l) => {
          const pts = `${l.points} pt${l.points === 1 ? "" : "s"}`;
          const desc = l.descriptor ? escapeHtml(l.descriptor) : "";
          return (
            `<tr><th scope="row">${escapeHtml(l.label)} ` +
            `<span class="rubric-points">(${escapeHtml(pts)})</span></th>` +
            `<td>${desc}</td></tr>`
          );
        })
        .join("");
      return (
        `<div class="rubric-criterion">` +
        `<p class="rubric-criterion-name">${escapeHtml(c.name)}</p>` +
        `<table class="rubric-levels"><tbody>${rows}</tbody></table>` +
        `</div>`
      );
    })
    .join("");
  return (
    `<div class="rubric" aria-label="Scoring rubric">` +
    `<p class="rubric-title">Scoring rubric</p>${criteria}</div>`
  );
}

// Slice 48: deterministic display order for sequence entries — FNV-1a over
// (itemId + entryId). Stable across renders (the preview must not shimmer)
// but decoupled from the authored order, which IS the answer key.
function fnv1a(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function displayOrder(itemId: string, entries: SequenceEntry[]): SequenceEntry[] {
  return entries
    .slice()
    .sort((a, b) => fnv1a(itemId + a.id) - fnv1a(itemId + b.id));
}

function renderItem(
  item: PreviewItem,
  index: number,
  resolved: Map<string, ResolvedAsset>,
  printMode: boolean,
): string {
  // renderItemContent HTML-escapes its own non-math, non-image text, so
  // we can drop the result straight into innerHTML-equivalent positions
  // without double-escaping.
  const stemHtml = renderItemContent(item.stem, resolved);
  const heading = `<p class="stem"><strong>${index + 1}.</strong> ${stemHtml}</p>`;

  let body = "";
  if (
    item.type === "multiple_choice_single" ||
    item.type === "multiple_choice_multi"
  ) {
    const isMulti = item.type === "multiple_choice_multi";
    body = item.choices
      .map((c, ci) => {
        if (printMode) {
          // Slice 34: paper affordance — a visible empty mark box (round for
          // single-select, square for multi) plus a letter the student marks.
          // Disabled <input> radios print faintly and can't be filled in.
          const letter = String.fromCharCode(65 + ci);
          const mark = isMulti ? "mark-check" : "mark-radio";
          return (
            `<div class="choice print-choice">` +
            `<span class="mark ${mark}" aria-hidden="true"></span>` +
            `<span class="choice-letter">${letter}.</span> ` +
            `${renderItemContent(c.text, resolved)}` +
            `</div>`
          );
        }
        const inputType = isMulti ? "checkbox" : "radio";
        return (
          `<label class="choice">` +
          `<input type="${inputType}" name="q-${escapeHtml(item.id)}" value="${escapeHtml(c.id)}" disabled>` +
          ` ${renderItemContent(c.text, resolved)}` +
          `</label>`
        );
      })
      .join("");
  } else if (item.type === "short_text") {
    body = printMode
      ? `<div class="write-line" aria-hidden="true"></div>`
      : `<input class="short-text" type="text" placeholder="(student answer)" disabled>`;
  } else if (item.type === "match") {
    // Slice 47: static two-column layout. Lefts numbered with a blank slot
    // to write the letter of the matching right; rights lettered, displayed
    // sorted (NOT authored order — that order is the answer key). Same
    // markup on screen and paper: the preview is inert either way.
    const pairs = item.pairs ?? [];
    const rights = pairs
      .map((p) => p.right)
      .slice()
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const rows = pairs
      .map((p, i) => {
        const rightText = rights[i];
        const letter = String.fromCharCode(65 + i);
        return (
          `<tr>` +
          `<td class="match-slot" aria-hidden="true"></td>` +
          // E6 / E7(a) (2026-09-02): pair sides carry emphasis and KaTeX like
          // stems — same renderer (it escapes its own text).
          `<td class="match-left">${i + 1}. ${renderItemContent(p.left, resolved)}</td>` +
          `<td class="match-letter">${letter}.</td>` +
          `<td class="match-right">${rightText !== undefined ? renderItemContent(rightText, resolved) : ""}</td>` +
          `</tr>`
        );
      })
      .join("");
    body =
      `<table class="match-table" aria-label="Matching item">` +
      `<thead><tr><th></th><th>Column A</th><th></th><th>Column B</th></tr></thead>` +
      `<tbody>${rows}</tbody></table>` +
      `<p class="match-hint">Write the letter of the Column B match next to each Column A entry.</p>`;
  } else if (item.type === "order") {
    // Slice 48: entries lettered in a deterministic shuffled order, plus
    // numbered slots to write the sequence. Static on screen and paper.
    const entries = displayOrder(item.id, item.sequence ?? []);
    const list = entries
      .map(
        (e, i) =>
          `<li class="order-entry"><span class="order-letter">${String.fromCharCode(65 + i)}.</span> ${renderItemContent(e.label, resolved)}</li>`,
      )
      .join("");
    const slots = entries
      .map(
        (_, i) =>
          `<span class="order-slot"><span class="order-slot-num">${i + 1}</span><span class="match-slot" aria-hidden="true"></span></span>`,
      )
      .join("");
    body =
      `<ul class="order-list" aria-label="Ordering item">${list}</ul>` +
      `<div class="order-slots">${slots}</div>` +
      `<p class="match-hint">Write the letters in the correct order, first to last.</p>`;
  } else if (item.type === "hotspot") {
    // Slice 49: the image with numbered static region outlines. Regions are
    // absolutely positioned by percentage (normalized 0-1 coords), so they
    // track the image at any render width. Owner-scoped like stem refs: an
    // unresolved image renders the same red placeholder.
    const imageId = item.image_asset_id?.toLowerCase() ?? null;
    const image = imageId ? resolved.get(imageId) : null;
    if (!image) {
      body = `<span class="image-missing">[image not selected or not found]</span>`;
    } else {
      const overlays = (item.regions ?? [])
        .map((r, i) => {
          const pct = (n: number) => `${(n * 100).toFixed(2)}%`;
          return (
            `<span class="hotspot-region" style="left:${pct(r.x)};top:${pct(r.y)};width:${pct(r.w)};height:${pct(r.h)}">` +
            `<span class="hotspot-num">${i + 1}</span></span>`
          );
        })
        .join("");
      body =
        `<div class="hotspot-wrap">` +
        `<img class="hotspot-image" src="/api/assets/${escapeHtml(image.id)}" alt="">` +
        overlays +
        `</div>` +
        `<p class="match-hint">Mark the correct region(s) by number.</p>`;
    }
  } else if (item.type === "drawing_upload") {
    // Slice 50: a blank drawing area (reusing the print write-area box) +
    // the optional reference image. Static — the real canvas is the
    // student client's job; dimensions render as a hint only.
    const promptId = item.prompt_asset_id?.toLowerCase() ?? null;
    const ref = promptId ? resolved.get(promptId) : null;
    const refHtml = ref
      ? `<img class="item-image" src="/api/assets/${escapeHtml(ref.id)}" alt="">`
      : item.prompt_asset_id
        ? `<span class="image-missing">[reference image not found]</span>`
        : "";
    // docs/drawing-background-design.md: the background is named in the hint
    // and drawn as CSS graph paper in the box. Axes are NOT drawn here — a
    // printed form's axes belong to the post-MVP graphing suite (documented
    // limit), so `axes` shows the same paper as `grid`.
    const background = item.canvas?.background ?? null;
    const backgroundHint =
      background === "axes" ? " · grid with axes" : background === "grid" ? " · grid" : "";
    const dims = item.canvas
      ? `<p class="match-hint">Drawing canvas: ${item.canvas.width} × ${item.canvas.height}px${backgroundHint}</p>`
      : "";
    const areaClass = background ? "write-area write-area--grid" : "write-area";
    body = `${refHtml}<div class="${areaClass}" aria-hidden="true"></div>${dims}`;
  } else if (item.type === "table") {
    // E3 slice 1: the grid with blank body cells, screen and paper alike (the
    // preview is inert either way; print gets taller cells to write in). The
    // label column is shown only when some row has a label (D-5). Labels
    // carry KaTeX + emphasis like choices — same renderer, it escapes.
    const columns = item.columns ?? [];
    const rows = item.rows ?? [];
    const showLabels = rows.some((r) => r.label.trim().length > 0);
    const head =
      `<tr>` +
      (showLabels
        ? `<th scope="col" class="table-corner">${item.corner ? renderItemContent(item.corner, resolved) : ""}</th>`
        : "") +
      columns.map((c) => `<th scope="col">${renderItemContent(c.label, resolved)}</th>`).join("") +
      `</tr>`;
    const bodyRows = rows
      .map(
        (r) =>
          `<tr>` +
          (showLabels ? `<th scope="row">${renderItemContent(r.label, resolved)}</th>` : "") +
          columns.map(() => `<td class="table-cell" aria-hidden="true"></td>`).join("") +
          `</tr>`,
      )
      .join("");
    body =
      `<table class="fill-table${printMode ? " fill-table-print" : ""}" aria-label="Table to fill in">` +
      `<thead>${head}</thead><tbody>${bodyRows}</tbody></table>`;
  } else if (item.type === "essay") {
    const limit =
      item.max_word_count != null
        ? `<p class="word-limit">Limit: ${item.max_word_count} words</p>`
        : "";
    // Show the rubric to students only when the teacher opted in for during
    // the assessment (slice 33). with_feedback visibility is Phase 3.
    const rubric =
      item.rubric && item.rubric.student_visibility?.during_test
        ? renderRubric(item.rubric)
        : "";
    if (printMode) {
      // Slice 34: a tall blank box to write the response on paper.
      body = `<div class="write-area" aria-hidden="true"></div>${limit}${rubric}`;
    } else {
      const placeholder = item.placeholder
        ? escapeHtml(item.placeholder)
        : "(student response)";
      body = `<textarea class="essay" rows="6" placeholder="${placeholder}" disabled></textarea>${limit}${rubric}`;
    }
  } else {
    // Same posture as the export route (slice 46): a type nobody handled
    // fails loudly instead of printing a question with no answer area.
    assertNever(item.type, "renderItem: unhandled item type");
  }

  return `<div class="item">${heading}${body}</div>`;
}

export interface RenderOptions {
  // Slice 34: print/PDF rendering for paper accommodations. Drops the
  // teacher-only preview banner + Tier-1 toolbar (meaningless on paper) and
  // swaps disabled inputs for blank write-space. The teacher prints this view
  // from their own (non-headless) browser → Save as PDF; same-origin images
  // resolve via their session cookie, so no data-URI inlining is needed.
  printMode?: boolean;
  // E5 slice 1: item sets. Absent or empty = every item stands alone.
  itemSets?: PreviewItemSet[];
}

// The stimulus block that opens a set. Same renderer as a stem, so KaTeX and
// `![alt](asset:uuid)` refs behave identically; the "Questions N–M" line tells
// a reader on paper which items it belongs to.
function renderStimulus(
  set: PreviewItemSet,
  firstIndex: number,
  lastIndex: number,
  resolved: Map<string, ResolvedAsset>,
): string {
  const range =
    firstIndex === lastIndex
      ? `Question ${firstIndex + 1}`
      : `Questions ${firstIndex + 1}–${lastIndex + 1}`;
  const lead = set.stimulus.trim() ? renderItemContent(set.stimulus, resolved) : "";
  const body = set.source
    ? `${lead}<div class="stimulus-source">Each student&#39;s own answer to &ldquo;${escapeHtml(set.source.stem)}&rdquo; (${escapeHtml(set.source.assessment_name)}) appears here.</div>`
    : lead || `<span class="stimulus-empty">(no stimulus text yet)</span>`;
  return (
    `<section class="stimulus stimulus-${set.layout}" aria-label="Stimulus for ${escapeHtml(range)}">` +
    `<p class="stimulus-label">${escapeHtml(range)}</p>` +
    `<div class="stimulus-body">${body}</div>` +
    `</section>`
  );
}

export function renderAssessmentHtml(
  assessment: PreviewAssessment,
  items: PreviewItem[],
  resolvedAssets: Map<string, ResolvedAsset> = new Map(),
  options: RenderOptions = {},
): string {
  const printMode = options.printMode ?? false;
  const title = escapeHtml(assessment.name);
  const ordered = items.slice().sort((a, b) => a.position - b.position);
  // E5 slice 1: a set's stimulus renders once, before its first item. Sets
  // are contiguous by construction (the API refuses a split), so "first item
  // of the set" is where the block opens and the last member closes it.
  const setByFirstItem = new Map<string, PreviewItemSet>();
  const lastIndexOfSet = new Map<string, number>();
  for (const set of options.itemSets ?? []) {
    const indices = set.item_ids
      .map((id) => ordered.findIndex((it) => it.id === id))
      .filter((i) => i >= 0);
    if (indices.length === 0) continue;
    setByFirstItem.set(ordered[Math.min(...indices)]!.id, set);
    lastIndexOfSet.set(set.id, Math.max(...indices));
  }
  const itemsHtml = ordered
    .map((item, idx) => {
      const set = setByFirstItem.get(item.id);
      const opener = set
        ? renderStimulus(set, idx, lastIndexOfSet.get(set.id) ?? idx, resolvedAssets)
        : "";
      return opener + renderItem(item, idx, resolvedAssets, printMode);
    })
    .join("");
  // Banner + Tier-1 toolbar are teacher-facing; omit them on a paper test.
  const toolbarHtml = printMode
    ? ""
    : renderAccommodationsToolbar(assessment.allowed_accommodations);
  const bannerHtml = printMode
    ? ""
    : `<div class="preview-banner">Preview — students do not see this banner.</div>`;

  return `<!doctype html>
<html lang="en"><head>
  <meta charset="utf-8">
  <!--
    E17: img-src is REQUIRED here. CSP policies intersect — they never relax
    each other — so the route header's "img-src 'self' data:" cannot widen a
    meta policy that omits img-src and therefore falls back to default-src
    'none'. Without this, every stem image, hotspot image, and drawing
    reference is blocked in the preview AND in the print / Save-as-PDF path,
    so a print-accommodation student receives a paper test with the diagrams
    missing. Keep this string in sync with CSP in app/preview/[id]/route.ts.
  -->
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; font-src 'self'">
  <title>${title}${printMode ? "" : " — preview"}</title>
  <style>
    body { font: 16px -apple-system, system-ui, sans-serif; margin: 32px; color: #222; background: #fff; }
    h1 { font-size: 22px; margin: 0 0 8px; }
    .preview-banner { background: #fffae6; border: 1px solid #c1a200; color: #6a5300; padding: 6px 10px; font-size: 12px; border-radius: 4px; margin-bottom: 16px; }
    .item { padding: 16px 0; border-bottom: 1px solid #eee; }
    /* E5 slice 1: the stimulus block above a set. */
    .stimulus { margin: 20px 0 4px; padding: 12px 14px; background: #f5f7fb; border: 1px solid #d6dce8; border-left: 4px solid #0b5cd6; border-radius: 4px; }
    .stimulus-label { margin: 0 0 6px; font-size: 12px; font-weight: 600; letter-spacing: .02em; text-transform: uppercase; color: #3a4a6a; }
    /* Multi-source stimulus slice 1 (2026-09-09): keep authored line breaks —
       a poem or a paragraphed passage collapsed into prose before. */
    .stimulus-body { margin: 0; white-space: pre-line; }
    .stimulus-empty { color: #9b5400; font-size: 12px; font-style: italic; }
    .stimulus-source { margin-top: 8px; padding: 10px 12px; border: 1px dashed #8a94a6; border-radius: 4px; color: #3a4a6a; font-size: 13px; font-style: italic; }
    .stem { margin: 0 0 8px; white-space: pre-line; }
    .choice { display: block; margin: 6px 0; }
    .short-text { width: 100%; padding: 6px 8px; font-size: 14px; border: 1px solid #ccc; border-radius: 4px; }
    .essay { width: 100%; padding: 6px 8px; font-size: 14px; border: 1px solid #ccc; border-radius: 4px; font-family: inherit; resize: vertical; }
    .word-limit { color: #666; font-size: 12px; margin: 4px 0 0; }
    .rubric { margin: 10px 0 0; padding: 10px; background: #f7f8fa; border: 1px solid #e0e3ea; border-radius: 4px; }
    .rubric-title { font-weight: 600; font-size: 13px; margin: 0 0 6px; }
    .rubric-criterion { margin: 0 0 8px; }
    .rubric-criterion-name { font-weight: 600; font-size: 13px; margin: 0 0 2px; }
    .rubric-levels { width: 100%; border-collapse: collapse; font-size: 13px; }
    .rubric-levels th { text-align: left; font-weight: 600; padding: 2px 8px 2px 0; white-space: nowrap; vertical-align: top; }
    .rubric-levels td { padding: 2px 0; color: #444; }
    .rubric-points { font-weight: 400; color: #666; }
    .unsupported { color: #9b5400; font-size: 12px; font-style: italic; margin: 4px 0 8px; }
    .math-error { color: #cc0000; background: #ffeeee; padding: 0 4px; border-radius: 2px; font-family: monospace; }
    .image-missing { color: #cc0000; background: #ffeeee; padding: 0 4px; border-radius: 2px; font-family: monospace; font-size: 12px; }
    .item-image { max-width: 100%; max-height: 360px; height: auto; display: block; margin: 8px 0; border: 1px solid #eee; border-radius: 4px; }
    .accommodations-toolbar { display: flex; flex-wrap: wrap; gap: 6px; margin: 0 0 16px; padding: 8px 10px; background: #f5f7fb; border: 1px solid #d6dce8; border-radius: 4px; }
    .tool-btn { display: inline-block; padding: 4px 10px; font-size: 12px; line-height: 1.4; background: #ffffff; border: 1px solid #c2c8d4; border-radius: 3px; color: #3a3f4a; cursor: default; user-select: none; }
    /* Print/PDF affordances (slice 34) — blank space for paper answers. */
    .print-choice { display: flex; align-items: baseline; gap: 8px; margin: 6px 0; }
    .mark { display: inline-block; width: 14px; height: 14px; border: 1.5px solid #333; flex: 0 0 auto; }
    .mark-radio { border-radius: 50%; }
    .mark-check { border-radius: 2px; }
    .choice-letter { font-weight: 600; }
    .write-line { border-bottom: 1px solid #333; height: 28px; margin: 8px 0; }
    .write-area { border: 1px solid #333; border-radius: 4px; min-height: 160px; margin: 8px 0; }
    /* Drawing background (docs/drawing-background-design.md): CSS graph paper
       at the client's 40px cell, screen and paper alike. print-color-adjust
       keeps the lines when the browser strips backgrounds for printing. Axes
       are deliberately not drawn on paper — a documented v1 limit. */
    .write-area--grid { min-height: 240px; background-color: #fff; background-image: repeating-linear-gradient(to right, #dfe3ea 0 1px, transparent 1px 40px), repeating-linear-gradient(to bottom, #dfe3ea 0 1px, transparent 1px 40px); -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    /* Match items (slice 47) — static two-column layout, screen and paper. */
    .match-table { border-collapse: collapse; margin: 4px 0; }
    .match-table th { text-align: left; font-size: 13px; padding: 2px 12px 4px 0; }
    .match-table td { padding: 3px 12px 3px 0; vertical-align: baseline; }
    .match-slot { min-width: 26px; }
    .match-slot::after { content: ""; display: inline-block; width: 22px; height: 16px; border-bottom: 1px solid #333; }
    .match-letter { font-weight: 600; padding-left: 18px; }
    .match-hint { color: #666; font-size: 12px; margin: 4px 0 0; }
    /* Order items (slice 48). */
    .order-list { list-style: none; margin: 4px 0; padding: 0; }
    .order-entry { margin: 4px 0; }
    .order-letter { font-weight: 600; }
    .order-slots { display: flex; gap: 16px; margin: 8px 0 0; }
    .order-slot { display: inline-flex; align-items: baseline; gap: 6px; }
    .order-slot-num { font-size: 12px; color: #666; }
    /* Table items (E3) — the grid the student fills; blank cells on screen and paper. */
    .fill-table { border-collapse: collapse; margin: 6px 0; font-size: 14px; }
    .fill-table th, .fill-table td { border: 1px solid #999; padding: 4px 8px; text-align: left; vertical-align: top; }
    .fill-table th { background: #f5f7fb; font-weight: 600; }
    .fill-table .table-corner { font-weight: 600; }
    .fill-table .table-cell { min-width: 72px; height: 24px; }
    .fill-table-print .table-cell { height: 32px; }
    /* Hotspot items (slice 49) — static numbered region outlines. */
    .hotspot-wrap { position: relative; display: inline-block; max-width: 100%; margin: 4px 0; }
    .hotspot-image { display: block; max-width: 100%; height: auto; border: 1px solid #eee; border-radius: 4px; }
    .hotspot-region { position: absolute; border: 2px solid #0b5cd6; border-radius: 3px; background: rgba(11, 92, 214, 0.08); }
    .hotspot-num { position: absolute; top: -1px; left: -1px; padding: 0 4px; font-size: 11px; font-weight: 600; color: #fff; background: #0b5cd6; border-radius: 2px 0 3px 0; }
    @media (prefers-color-scheme: dark) {
      body { background: #1a1a1a; color: #ddd; }
      .item { border-bottom-color: #333; }
      .short-text, .essay { background: transparent; color: inherit; border-color: #444; }
      .word-limit { color: #aaa; }
      .rubric { background: #22252c; border-color: #3a3f4a; }
      .rubric-levels td { color: #bbb; }
      .rubric-points { color: #999; }
      .preview-banner { background: #3b2e00; border-color: #6a5300; color: #f0d77a; }
      .accommodations-toolbar { background: #242832; border-color: #3a3f4a; }
      .tool-btn { background: #2d323d; border-color: #3a3f4a; color: #c8cdd6; }
      .stimulus { background: #22252c; border-color: #3a3f4a; border-left-color: #4c8dff; }
      .stimulus-label { color: #a9b6d3; }
      .fill-table th { background: #22252c; }
      .fill-table th, .fill-table td { border-color: #555; }
    }
    /* Slice 34: force a legible light page on paper and keep each item whole,
       regardless of the printing browser's system theme. */
    @page { margin: 18mm; }
    @media print {
      body { margin: 0; background: #fff; color: #000; }
      .item { break-inside: avoid; page-break-inside: avoid; border-bottom-color: #ccc; }
      .stimulus { background: #fff; border-color: #999; border-left-color: #000; break-inside: avoid; page-break-inside: avoid; }
      /* own_page: the stimulus starts a fresh sheet (decision 4.2). */
      .stimulus-own_page { break-before: page; page-break-before: always; }
      .mark, .write-line, .write-area { border-color: #000; }
      .fill-table th { background: #fff; }
      .fill-table th, .fill-table td { border-color: #000; }
      .rubric { background: #fff; border-color: #999; }
      .rubric-levels td, .rubric-points, .word-limit { color: #333; }
    }
    /* KaTeX (inlined for the no-script CSP — see ADR 0009) */
    ${getKatexCss()}
  </style>
</head><body>
  ${bannerHtml}
  ${toolbarHtml}
  <h1>${title}</h1>
  ${itemsHtml || '<p class="unsupported">No items yet.</p>'}
</body></html>`;
}
