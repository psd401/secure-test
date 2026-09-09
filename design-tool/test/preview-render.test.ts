import { describe, expect, test } from "bun:test";
import { renderAssessmentHtml, type PreviewItem } from "../lib/preview/renderHtml";

const assessment = {
  id: "a1",
  name: "Sample <assessment>",
  allowed_accommodations: [] as string[],
};

const items: PreviewItem[] = [
  {
    id: "i1",
    position: 0,
    type: "multiple_choice_single",
    stem: "What is 7 + 5?",
    choices: [
      { id: "a", text: "11" },
      { id: "b", text: "12" },
    ],
    correct_choice_ids: ["b"],
    correct_answer: null,
  },
  {
    id: "i2",
    position: 1,
    type: "multiple_choice_multi",
    stem: "Primary colors?",
    choices: [
      { id: "r", text: "Red" },
      { id: "b", text: "Blue" },
    ],
    correct_choice_ids: ["r", "b"],
    correct_answer: null,
  },
  {
    id: "i3",
    position: 2,
    type: "short_text",
    stem: "Capital of WA?",
    choices: [],
    correct_choice_ids: [],
    correct_answer: "Olympia",
  },
];

describe("renderAssessmentHtml", () => {
  const html = renderAssessmentHtml(assessment, items);

  // E17: this assertion previously locked the bug in — the meta policy omitted
  // img-src, so images fell back to default-src 'none' and were blocked in
  // both the preview and the print/Save-as-PDF path. CSP policies intersect,
  // so the route header could not relax it.
  test("emits the hardened CSP via meta http-equiv (slice 14: + font-src 'self'; E17: + img-src)", () => {
    expect(html).toContain(
      `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; font-src 'self'">`,
    );
  });

  test("the meta CSP matches the route's response-header CSP (E17)", async () => {
    const { CSP } = await import("../app/preview/[id]/route");
    // Both policies apply; anything missing from either is denied. Keeping the
    // two byte-identical is the only way images survive the intersection.
    expect(html).toContain(
      `<meta http-equiv="Content-Security-Policy" content="${CSP.replace(
        "; frame-ancestors 'self'",
        "",
      )}">`,
    );
  });

  test("inlined KaTeX CSS points fonts at /katex-fonts/ (slice 14)", () => {
    expect(html).toContain(`url(/katex-fonts/KaTeX_Main-Regular.woff2)`);
    // The woff and ttf fallback URLs are stripped at vendor time.
    expect(html).not.toMatch(/url\(fonts\/[^)]+\.woff2\)/);
    expect(html).not.toMatch(/url\(fonts\/[^)]+\.woff\)/);
    expect(html).not.toMatch(/url\(fonts\/[^)]+\.ttf\)/);
  });

  test("contains no inline scripts", () => {
    expect(html).not.toContain("<script");
    expect(html).not.toContain("script>");
  });

  test("HTML-escapes the assessment name in the title", () => {
    expect(html).toContain("<title>Sample &lt;assessment&gt; — preview</title>");
    expect(html).toContain("<h1>Sample &lt;assessment&gt;</h1>");
  });

  test("renders each item's stem", () => {
    expect(html).toContain("What is 7 + 5?");
    expect(html).toContain("Primary colors?");
    expect(html).toContain("Capital of WA?");
  });

  test("uses radio inputs for single-select MC choices", () => {
    expect(html).toContain(
      `<input type="radio" name="q-i1" value="a" disabled>`,
    );
    expect(html).toContain(
      `<input type="radio" name="q-i1" value="b" disabled>`,
    );
  });

  test("uses checkbox inputs for multi-select MC choices", () => {
    expect(html).toContain(
      `<input type="checkbox" name="q-i2" value="r" disabled>`,
    );
  });

  test("uses a text input for short-text items", () => {
    expect(html).toContain('<input class="short-text" type="text"');
  });

  test("does not mark any item type as unsupported (slice 8 onward)", () => {
    // The "(not yet supported in student client)" banner was dropped once
    // PoC-B started rendering multi-select + short-text. The .unsupported
    // class is still emitted for the empty-items placeholder, so we look
    // for the banner copy specifically.
    expect(html).not.toContain("not yet supported");
  });

  test("orders items by their position field, not array order", () => {
    const reordered = [items[2]!, items[0]!, items[1]!];
    const out = renderAssessmentHtml(assessment, reordered);
    const i0 = out.indexOf("What is 7 + 5?");
    const i1 = out.indexOf("Primary colors?");
    const i2 = out.indexOf("Capital of WA?");
    // position 0 (i1) first, then position 1 (i2), then position 2 (i3)
    expect(i0).toBeLessThan(i1);
    expect(i1).toBeLessThan(i2);
  });

  test("handles empty items list", () => {
    const out = renderAssessmentHtml(assessment, []);
    expect(out).toContain("No items yet");
  });
});

describe("renderAssessmentHtml — essay items (slice 32)", () => {
  const essay = (extra: Partial<PreviewItem> = {}): PreviewItem => ({
    id: "e1",
    position: 0,
    type: "essay",
    stem: "Write an essay about your summer.",
    choices: [],
    correct_choice_ids: [],
    correct_answer: null,
    ...extra,
  });

  test("renders a disabled textarea for essay items", () => {
    const out = renderAssessmentHtml(assessment, [essay()]);
    expect(out).toContain('<textarea class="essay"');
    expect(out).toContain("disabled");
    expect(out).toContain("(student response)");
  });

  test("shows the word limit as a hint when max_word_count is set", () => {
    const out = renderAssessmentHtml(assessment, [
      essay({ max_word_count: 250, placeholder: "Begin…" }),
    ]);
    expect(out).toContain("Limit: 250 words");
    expect(out).toContain('placeholder="Begin…"');
  });

  test("omits the word-limit hint when max_word_count is absent", () => {
    const out = renderAssessmentHtml(assessment, [essay()]);
    // The .word-limit CSS rule always ships in the inline <style>; only the
    // body-level <p class="word-limit"> element is conditional.
    expect(out).not.toContain('class="word-limit"');
    expect(out).not.toContain("Limit:");
  });

  test("essay adds no script (CSP posture unchanged)", () => {
    const out = renderAssessmentHtml(assessment, [essay()]);
    expect(out).not.toContain("<script");
  });
});

describe("renderAssessmentHtml — essay rubric visibility (slice 33)", () => {
  const essayWithRubric = (during: boolean | null): PreviewItem => ({
    id: "er",
    position: 0,
    type: "essay",
    stem: "Write a persuasive essay.",
    choices: [],
    correct_choice_ids: [],
    correct_answer: null,
    rubric:
      during === null
        ? null
        : {
            style: "analytic",
            criteria: [
              {
                id: "c1",
                name: "Thesis",
                levels: [
                  { id: "l1", label: "Weak", points: 0 },
                  {
                    id: "l2",
                    label: "Strong",
                    points: 2,
                    descriptor: "Clear, arguable thesis",
                  },
                ],
              },
            ],
            student_visibility: { during_test: during, with_feedback: false },
          },
  });

  test("renders the rubric when during_test is true", () => {
    const out = renderAssessmentHtml(assessment, [essayWithRubric(true)]);
    expect(out).toContain('class="rubric"');
    expect(out).toContain("Scoring rubric");
    expect(out).toContain("Thesis");
    expect(out).toContain("Clear, arguable thesis");
    expect(out).not.toContain("<script");
  });

  test("hides the rubric when during_test is false", () => {
    const out = renderAssessmentHtml(assessment, [essayWithRubric(false)]);
    // The .rubric CSS rule always ships; only the rendered element is gated.
    expect(out).not.toContain('class="rubric"');
    expect(out).not.toContain("Scoring rubric");
  });

  test("hides the rubric when the essay has no rubric", () => {
    const out = renderAssessmentHtml(assessment, [essayWithRubric(null)]);
    expect(out).not.toContain('class="rubric"');
  });
});

describe("renderAssessmentHtml — print mode (slice 34)", () => {
  const printAssessment = {
    ...assessment,
    allowed_accommodations: ["highlighter"], // a T1 entry → toolbar on screen
  };

  test("drops the preview banner and Tier-1 toolbar on paper", () => {
    const screen = renderAssessmentHtml(printAssessment, items);
    expect(screen).toContain("preview-banner");
    expect(screen).toContain('class="accommodations-toolbar"');

    const print = renderAssessmentHtml(printAssessment, items, new Map(), {
      printMode: true,
    });
    expect(print).not.toContain("students do not see this banner");
    expect(print).not.toContain('class="accommodations-toolbar"');
  });

  test("renders MC choices as blank mark boxes with letters", () => {
    const print = renderAssessmentHtml(printAssessment, items, new Map(), {
      printMode: true,
    });
    // single-select → round mark; multi-select → square mark
    expect(print).toContain('<span class="mark mark-radio"');
    expect(print).toContain('<span class="mark mark-check"');
    expect(print).toContain('<span class="choice-letter">A.</span>');
    // no disabled inputs in print mode
    expect(print).not.toContain('type="radio"');
    expect(print).not.toContain('type="checkbox"');
  });

  test("short_text becomes a blank write line; essay a write area", () => {
    const print = renderAssessmentHtml(printAssessment, items, new Map(), {
      printMode: true,
    });
    expect(print).toContain('class="write-line"');
    expect(print).not.toContain('class="short-text"');
  });

  test("essay renders a write area in print mode", () => {
    const print = renderAssessmentHtml(
      printAssessment,
      [
        {
          id: "e",
          position: 0,
          type: "essay",
          stem: "Write.",
          choices: [],
          correct_choice_ids: [],
          correct_answer: null,
          max_word_count: 200,
        },
      ],
      new Map(),
      { printMode: true },
    );
    expect(print).toContain('class="write-area"');
    expect(print).not.toContain("<textarea");
    // metadata hint still useful on paper
    expect(print).toContain("Limit: 200 words");
  });

  test("print mode carries @media print rules and stays script-free", () => {
    const print = renderAssessmentHtml(printAssessment, items, new Map(), {
      printMode: true,
    });
    expect(print).toContain("@media print");
    expect(print).toContain("break-inside: avoid");
    expect(print).not.toContain("<script");
    // title drops the "— preview" suffix so the PDF filename is clean
    expect(print).not.toContain("— preview</title>");
  });

  test("default (no options) is unchanged screen behavior", () => {
    const screen = renderAssessmentHtml(printAssessment, items);
    expect(screen).toContain("preview-banner");
    expect(screen).toContain("— preview</title>");
  });
});

describe("renderAssessmentHtml — KaTeX integration (slice 11)", () => {
  test("$...$ in a stem renders as KaTeX HTML", () => {
    const out = renderAssessmentHtml(assessment, [
      {
        id: "m1",
        position: 0,
        type: "short_text",
        stem: "Compute $x^2 + 1$ for $x = 3$.",
        choices: [],
        correct_choice_ids: [],
        correct_answer: "10",
      },
    ]);
    expect(out).toContain("class=\"katex\"");
  });

  test("inlines KaTeX stylesheet into the <style> block", () => {
    const out = renderAssessmentHtml(assessment, []);
    // Look for a KaTeX-specific class definition; the minified CSS
    // declares .katex with a font-family rule.
    expect(out).toMatch(/\.katex\s*\{/);
  });

  test("broken LaTeX renders inline-red via KaTeX errorColor", () => {
    const out = renderAssessmentHtml(assessment, [
      {
        id: "bad",
        position: 0,
        type: "multiple_choice_single",
        stem: "Bad math: $\\frac{1$",
        choices: [
          { id: "a", text: "x" },
          { id: "b", text: "y" },
        ],
        correct_choice_ids: ["a"],
        correct_answer: null,
      },
    ]);
    expect(out).toContain("#cc0000");
  });
});

describe("renderAssessmentHtml — Tier-1 accommodations toolbar (slice 22)", () => {
  function withAccoms(allowed: string[]): string {
    return renderAssessmentHtml(
      { ...assessment, allowed_accommodations: allowed },
      items,
    );
  }

  test("empty allowed_accommodations → no toolbar div in output", () => {
    const out = withAccoms([]);
    // CSS for .accommodations-toolbar still ships in the inline <style>
    // block; only the body-level <div> with that class is conditional.
    expect(out).not.toContain('class="accommodations-toolbar"');
  });

  test("Tier-1 entry in allowed_accommodations → toolbar contains its label", () => {
    // `highlighter` is universal/T1 per catalog.ts.
    const out = withAccoms(["highlighter"]);
    expect(out).toContain('class="accommodations-toolbar"');
    expect(out).toContain("Highlighter");
  });

  test("toolbar uses aria-disabled spans (not <button disabled>)", () => {
    const out = withAccoms(["highlighter"]);
    expect(out).toMatch(
      /<span class="tool-btn" role="button" aria-disabled="true">/,
    );
    // Defense-in-depth: make sure we didn't accidentally emit a real button.
    expect(out).not.toMatch(/<button[^>]*class="tool-btn"/);
  });

  test("Tier-2 entry in allowed_accommodations → NO toolbar entry", () => {
    // `tts_test_content` is designated/T2 per catalog.ts.
    const out = withAccoms(["tts_test_content"]);
    expect(out).not.toContain('class="accommodations-toolbar"');
    expect(out).not.toContain("Text-to-Speech (Test Content)");
  });

  test("Tier-3 / Tier-4 / OOB entries do not appear in toolbar", () => {
    // english_glossary=T3, translated_test_directions=T4, scratch_paper=oob
    const out = withAccoms([
      "english_glossary",
      "translated_test_directions",
      "scratch_paper",
    ]);
    expect(out).not.toContain('class="accommodations-toolbar"');
  });

  test("mixed selection emits only the T1 subset, preserves catalog order", () => {
    // T1 universal entries in catalog order: expandable_items,
    // expandable_stimuli, highlighter, line_reader, mark_for_review,
    // optional_font, strikethrough, zoom. Plus T1 designated:
    // color_contrast, hybrid_masking_tool, masking,
    // streamlined_interface_mode.
    const out = withAccoms([
      "tts_test_content", // T2 — drop
      "color_contrast", // T1 — keep
      "highlighter", // T1 — keep
      "english_glossary", // T3 — drop
    ]);
    const hi = out.indexOf("Highlighter");
    const cc = out.indexOf("Color Contrast");
    // highlighter is universal/T1 and appears before designated/T1 color_contrast
    // in the catalog, so it must render first.
    expect(hi).toBeGreaterThan(-1);
    expect(cc).toBeGreaterThan(-1);
    expect(hi).toBeLessThan(cc);
    expect(out).not.toContain("Text-to-Speech (Test Content)");
    expect(out).not.toContain("English Glossary");
  });

  test("unknown catalog ids in allowed are silently ignored (toolbar still renders other T1s)", () => {
    const out = withAccoms(["highlighter", "not_a_real_tool"]);
    expect(out).toContain("Highlighter");
    expect(out).not.toContain("not_a_real_tool");
  });

  test("toolbar inserts between preview-banner and h1", () => {
    const out = withAccoms(["highlighter"]);
    // Match body-level div tags, not CSS class definitions in <style>.
    const banner = out.indexOf('<div class="preview-banner">');
    const toolbar = out.indexOf('<div class="accommodations-toolbar"');
    const h1 = out.indexOf("<h1>");
    expect(banner).toBeGreaterThan(-1);
    expect(toolbar).toBeGreaterThan(-1);
    expect(h1).toBeGreaterThan(-1);
    expect(banner).toBeLessThan(toolbar);
    expect(toolbar).toBeLessThan(h1);
  });

  test("CSP unchanged (no script-src added by the toolbar)", () => {
    const out = withAccoms(["highlighter"]);
    expect(out).toContain(
      `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; font-src 'self'">`,
    );
    expect(out).not.toContain("<script");
  });
});

// Slice 47: match items — static two-column layout, rights sorted.
describe("renderAssessmentHtml — match items (slice 47)", () => {
  const matchItem: PreviewItem = {
    id: "m-1",
    position: 0,
    type: "match",
    stem: "Match each animal to its sound",
    choices: [],
    correct_choice_ids: [],
    correct_answer: null,
    pairs: [
      { id: "p1", left: "Dog", right: "Woof" },
      { id: "p2", left: "Cat", right: "Meow" },
      { id: "p3", left: "Cow", right: "Moo" },
    ],
  };
  const assessment = { id: "a-1", name: "Match preview", allowed_accommodations: [] };

  test("renders both columns with rights sorted, not authored order", () => {
    const html = renderAssessmentHtml(assessment, [matchItem]);
    expect(html).toContain("Column A");
    expect(html).toContain("Column B");
    expect(html).toContain("1. Dog");
    expect(html).toContain("2. Cat");
    // Authored right order is Woof, Meow, Moo; sorted display must be
    // Meow, Moo, Woof — the authored order IS the answer key.
    expect(html.indexOf("Meow")).toBeLessThan(html.indexOf("Moo"));
    expect(html.indexOf("Moo")).toBeLessThan(html.indexOf("Woof"));
    expect(html).toContain("Write the letter");
  });

  test("print mode renders the same static table", () => {
    const html = renderAssessmentHtml(assessment, [matchItem], new Map(), {
      printMode: true,
    });
    expect(html).toContain("match-table");
    expect(html).toContain("1. Dog");
  });

  test("pair text is HTML-escaped", () => {
    const html = renderAssessmentHtml(assessment, [
      {
        ...matchItem,
        pairs: [
          { id: "p1", left: "<b>bold</b>", right: "R1" },
          { id: "p2", left: "L2", right: "R2" },
        ],
      },
    ]);
    expect(html).not.toContain("<b>bold</b>");
    expect(html).toContain("&lt;b&gt;bold&lt;/b&gt;");
  });
});

// Slice 48: order items — deterministic shuffled display + numbered slots.
describe("renderAssessmentHtml — order items (slice 48)", () => {
  const orderItem: PreviewItem = {
    id: "o-1",
    position: 0,
    type: "order",
    stem: "Put the morning routine in order",
    choices: [],
    correct_choice_ids: [],
    correct_answer: null,
    sequence: [
      { id: "s1", label: "Wake up" },
      { id: "s2", label: "Eat breakfast" },
      { id: "s3", label: "Go to school" },
    ],
  };
  const assessment = { id: "a-2", name: "Order preview", allowed_accommodations: [] };

  test("displays entries in a deterministic order that is not the authored key", () => {
    const html = renderAssessmentHtml(assessment, [orderItem]);
    // FNV-1a("o-1"+id) display order for s1/s2/s3 is: Wake up, Go to
    // school, Eat breakfast — differing from the authored (correct) order.
    expect(html.indexOf("Go to school")).toBeLessThan(html.indexOf("Eat breakfast"));
    expect(html).toContain("A.");
    expect(html).toContain("Write the letters in the correct order");
    // Stable across renders — the preview must not shimmer.
    expect(renderAssessmentHtml(assessment, [orderItem])).toBe(html);
  });

  test("print mode renders the same static list and slots", () => {
    const html = renderAssessmentHtml(assessment, [orderItem], new Map(), {
      printMode: true,
    });
    expect(html).toContain("order-list");
    expect(html).toContain("order-slots");
  });

  test("labels are HTML-escaped", () => {
    const html = renderAssessmentHtml(assessment, [
      {
        ...orderItem,
        sequence: [
          { id: "s1", label: "<i>first</i>" },
          { id: "s2", label: "second" },
        ],
      },
    ]);
    expect(html).not.toContain("<i>first</i>");
    expect(html).toContain("&lt;i&gt;first&lt;/i&gt;");
  });
});

// Slice 49: hotspot items — image + numbered static overlays; the answer
// key never reaches the renderer.
describe("renderAssessmentHtml — hotspot items (slice 49)", () => {
  const IMAGE_ID = "55555555-5555-5555-5555-555555555555";
  const hotspotItem: PreviewItem = {
    id: "h-1",
    position: 0,
    type: "hotspot",
    stem: "Mark the capital",
    choices: [],
    correct_choice_ids: [],
    correct_answer: null,
    image_asset_id: IMAGE_ID,
    regions: [
      { id: "r1", x: 0.1, y: 0.2, w: 0.25, h: 0.3 },
      { id: "r2", x: 0.6, y: 0.5, w: 0.2, h: 0.2 },
    ],
  };
  const assessment = { id: "a-3", name: "Hotspot preview", allowed_accommodations: [] };
  const resolved = new Map([
    [IMAGE_ID, { id: IMAGE_ID, content_type: "image/png" }],
  ]);

  test("renders the image with percent-positioned numbered overlays", () => {
    const html = renderAssessmentHtml(assessment, [hotspotItem], resolved);
    expect(html).toContain(`/api/assets/${IMAGE_ID}`);
    expect(html).toContain("hotspot-region");
    expect(html).toContain("left:10.00%");
    expect(html).toContain("width:25.00%");
    expect(html).toContain(`<span class="hotspot-num">1</span>`);
    expect(html).toContain(`<span class="hotspot-num">2</span>`);
  });

  test("unresolved image renders the missing placeholder, no overlays", () => {
    const html = renderAssessmentHtml(assessment, [hotspotItem], new Map());
    expect(html).toContain("image not selected or not found");
    // The stylesheet always carries .hotspot-region — assert no overlay
    // MARKUP was emitted.
    expect(html).not.toContain('class="hotspot-region"');
    expect(html).not.toContain(`/api/assets/${IMAGE_ID}`);
  });

  test("print mode renders the same static overlays", () => {
    const html = renderAssessmentHtml(assessment, [hotspotItem], resolved, {
      printMode: true,
    });
    expect(html).toContain("hotspot-region");
  });
});

// Slice 50: drawing/upload items — blank drawing area + optional reference.
describe("renderAssessmentHtml — drawing_upload items (slice 50)", () => {
  const REF_ID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
  const drawingItem: PreviewItem = {
    id: "d-1",
    position: 0,
    type: "drawing_upload",
    stem: "Draw the water cycle",
    choices: [],
    correct_choice_ids: [],
    correct_answer: null,
    prompt_asset_id: REF_ID,
    canvas: { width: 800, height: 600 },
  };
  const assessment = { id: "a-4", name: "Drawing preview", allowed_accommodations: [] };

  test("renders the reference image, blank area, and canvas hint", () => {
    const html = renderAssessmentHtml(
      assessment,
      [drawingItem],
      new Map([[REF_ID, { id: REF_ID, content_type: "image/png" }]]),
    );
    expect(html).toContain(`/api/assets/${REF_ID}`);
    expect(html).toContain("write-area");
    expect(html).toContain("800 × 600px");
  });

  test("unresolved reference renders a placeholder; none renders nothing", () => {
    const withMissing = renderAssessmentHtml(assessment, [drawingItem], new Map());
    expect(withMissing).toContain("reference image not found");
    const bare = renderAssessmentHtml(
      assessment,
      [{ ...drawingItem, prompt_asset_id: null, canvas: null }],
      new Map(),
    );
    expect(bare).toContain("write-area");
    expect(bare).not.toContain("reference image not found");
  });

  // Drawing background (docs/drawing-background-design.md): named in the hint,
  // drawn as CSS graph paper. Axes are not drawn on paper — documented limit.
  test("the hint names the background and the box gets the graph-paper class", () => {
    const grid = renderAssessmentHtml(
      assessment,
      [{ ...drawingItem, canvas: { width: 800, height: 600, background: "grid" } }],
      new Map(),
      { printMode: true },
    );
    expect(grid).toContain("800 × 600px · grid");
    expect(grid).toContain('class="write-area write-area--grid"');
    expect(grid).toContain(".write-area--grid");

    const axes = renderAssessmentHtml(
      assessment,
      [{ ...drawingItem, canvas: { width: 800, height: 600, background: "axes" } }],
      new Map(),
      { printMode: true },
    );
    expect(axes).toContain("800 × 600px · grid with axes");
    expect(axes).toContain('class="write-area write-area--grid"');
  });

  test("no background: the hint and the box are exactly as before", () => {
    const html = renderAssessmentHtml(assessment, [drawingItem], new Map(), {
      printMode: true,
    });
    expect(html).toContain("800 × 600px</p>");
    expect(html).toContain('class="write-area"');
    expect(html).not.toContain("write-area write-area--grid");
  });
});

// E5 slice 1: a set's stimulus renders once, above its first item, labelled
// with the question range; own_page carries the print page-break class.
describe("item sets in the preview (E5 slice 1)", () => {
  const sets = [
    { id: "s1", stimulus: "Read the passage about $E=mc^2$.", layout: "inline" as const, item_ids: ["i2", "i3"] },
  ];

  test("renders the stimulus once before the first item of the set with the range", () => {
    const html = renderAssessmentHtml(assessment, items, new Map(), { itemSets: sets });
    expect(html.match(/class="stimulus stimulus-inline"/g)).toHaveLength(1);
    expect(html).toContain("Questions 2–3");
    // Before question 2's stem, after question 1's.
    const q1 = html.indexOf("<strong>1.</strong>");
    const stim = html.indexOf('class="stimulus ');
    const q2 = html.indexOf("<strong>2.</strong>");
    expect(q1).toBeLessThan(stim);
    expect(stim).toBeLessThan(q2);
    // KaTeX rendered, not raw.
    expect(html).toContain("katex");
    expect(html).not.toContain("$E=mc^2$");
  });

  test("a set of one says Question N; own_page gets the page-break class; empty text is flagged", () => {
    const html = renderAssessmentHtml(assessment, items, new Map(), {
      itemSets: [{ id: "s2", stimulus: "", layout: "own_page", item_ids: ["i1"] }],
    });
    expect(html).toContain('class="stimulus stimulus-own_page"');
    expect(html).toContain("Question 1</p>");
    expect(html).toContain("no stimulus text yet");
    expect(html).toContain(".stimulus-own_page { break-before: page;");
  });

  // Multi-source stimulus slice 1 (2026-09-09): authored line breaks survive in
  // stems and stimulus bodies (a poem stayed a poem only in the PDF before).
  test("stem and stimulus bodies keep authored line breaks (white-space: pre-line)", () => {
    const html = renderAssessmentHtml(assessment, items, new Map(), {
      itemSets: [{ id: "s3", stimulus: "Two roads diverged\nAnd sorry I could not travel both", layout: "inline", item_ids: ["i1"] }],
    });
    expect(html).toContain(".stem { margin: 0 0 8px; white-space: pre-line; }");
    expect(html).toContain(".stimulus-body { margin: 0; white-space: pre-line; }");
    // The newline reaches the markup as a newline, not a space or a <br>.
    expect(html).toContain("Two roads diverged\nAnd sorry");
  });

  test("no sets → no stimulus markup (byte-stable for existing previews)", () => {
    const html = renderAssessmentHtml(assessment, items, new Map(), {});
    expect(html).not.toContain('class="stimulus ');
  });
});

// E6 / E7(a) (2026-09-02): match pair sides and order steps render through
// the shared renderer like stems — emphasis and KaTeX, still escaped.
describe("preview — emphasis and math in match pairs and order steps", () => {
  test("pair sides and order labels carry <strong>/<em> and KaTeX, and escape markup", () => {
    const out = renderAssessmentHtml(assessment, [
      {
        ...items[0]!,
        id: "m1",
        position: 1,
        type: "match",
        stem: "Match.",
        choices: [],
        correct_choice_ids: [],
        correct_answer: null,
        pairs: [{ id: "p1", left: "_Dog_ <b>", right: "**Puppy** $x^2$" }, { id: "p2", left: "Cow", right: "Calf" }],
      },
      {
        ...items[0]!,
        id: "o1",
        position: 2,
        type: "order",
        stem: "Order.",
        choices: [],
        correct_choice_ids: [],
        correct_answer: null,
        sequence: [{ id: "s1", label: "**First** $a_1$" }, { id: "s2", label: "second" }],
      },
    ] as never);
    expect(out).toContain("<em>Dog</em> &lt;b&gt;");
    expect(out).toContain("<strong>Puppy</strong>");
    expect(out).toContain("<strong>First</strong>");
    expect(out).not.toContain("_Dog_");
    expect(out).not.toContain("**Puppy**");
    expect((out.match(/class="katex"/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });
});

// E12 slice 4: a source-backed set shows a placeholder where each student's
// own answer will go; the lead-in stays above it.
describe("preview — source-backed stimulus placeholder (E12)", () => {
  test("renders the lead-in and the placeholder naming the source question", () => {
    const out = renderAssessmentHtml(assessment, items, new Map(), {
      itemSets: [
        { id: "s1", stimulus: "Your outline:", layout: "inline", item_ids: [items[0]!.id], source: { stem: "Outline your argument <b>", assessment_name: "Outline" } },
      ],
    });
    expect(out).toContain("Your outline:");
    expect(out).toContain('class="stimulus-source"');
    expect(out).toContain("Outline your argument &lt;b&gt;");
    expect(out).toContain("(Outline) appears here");
    expect(out).not.toContain("(no stimulus text yet)");
  });
});

// E3 slice 1: the table renders as a grid of blank cells; the key never
// reaches the renderer (PreviewItem has no field for it).
describe("renderAssessmentHtml: table (E3)", () => {
  const table: PreviewItem = {
    id: "t1",
    position: 0,
    type: "table",
    stem: "Enter the values.",
    choices: [],
    correct_choice_ids: [],
    correct_answer: null,
    columns: [{ id: "c1", label: "Observed (o)" }, { id: "c2", label: "$(o-e)^2$" }],
    rows: [{ id: "r1", label: "Middle" }, { id: "r2", label: "**Total**" }],
    corner: "Chamber",
  };

  test("renders headers, row labels, the corner, and one blank cell per row × column", () => {
    const html = renderAssessmentHtml(assessment, [table]);
    expect(html).toContain('<table class="fill-table"');
    expect(html).toContain('<th scope="col" class="table-corner">Chamber</th>');
    expect(html).toContain('<th scope="col">Observed (o)</th>');
    expect(html).toContain('<th scope="row">Middle</th>');
    // E6 emphasis and KaTeX go through the same renderer as stems.
    expect(html).toContain("<strong>Total</strong>");
    expect(html).toContain('class="katex"');
    expect(html.match(/<td class="table-cell" aria-hidden="true"><\/td>/g)?.length).toBe(4);
  });

  test("hides the label column when every row label is blank (D-5)", () => {
    const html = renderAssessmentHtml(assessment, [
      { ...table, rows: [{ id: "r1", label: "" }, { id: "r2", label: " " }], corner: "ignored" },
    ]);
    // (the class name still appears in the stylesheet; the element must not)
    expect(html).not.toContain('class="table-corner"');
    expect(html).not.toContain('<th scope="row">');
    expect(html).not.toContain("ignored");
  });

  test("print mode uses the taller cells", () => {
    const html = renderAssessmentHtml(assessment, [table], undefined, { printMode: true });
    expect(html).toContain('class="fill-table fill-table-print"');
  });
});
