// RT slice 2 (docs/rich-text-essay-design.md, "Teacher side"): the one
// renderer every teacher surface uses for an essay answer, and the
// Docs-friendly mapping of the same cleaned html (D-10 double spacing) —
// pure, no database.
import { describe, expect, test } from "bun:test";
import {
  essayRichHtml,
  renderEssayAnswerHtml,
} from "../lib/richText/renderEssayAnswer";
import { revisionText } from "../lib/reporting/answerHistoryView";
import {
  DOUBLE_SPACING,
  PARAGRAPH_OPEN,
  buildDocHtml,
  docRichAnswerHtml,
} from "../lib/googleDocs/content";

describe("renderEssayAnswerHtml", () => {
  test("a formatted essay renders its html inside the essay-rich wrapper", () => {
    const html = '<p data-indent="first"><strong>Bold</strong> and <em>it</em> <u>u</u></p><ul><li>one</li></ul><ol><li>two</li></ol>';
    expect(renderEssayAnswerHtml({ type: "essay", text: "ignored", html })).toBe(
      `<div class="essay-rich">${html}</div>`,
    );
  });

  test("a plain essay is its escaped text, line breaks left for the container", () => {
    expect(renderEssayAnswerHtml({ type: "essay", text: "1 < 2 & <b>x</b>\nline two" })).toBe(
      "1 &lt; 2 &amp; &lt;b&gt;x&lt;/b&gt;\nline two",
    );
    // No text at all reads as empty, never "undefined".
    expect(renderEssayAnswerHtml({ type: "essay" })).toBe("");
    expect(renderEssayAnswerHtml(null)).toBe("");
  });

  test("stored html is re-cleaned at render — markup that predates a sanitiser fix never reaches the page", () => {
    const stored = {
      type: "essay",
      text: "Hi",
      html: '<p onclick="evil()">Hi<script>alert(1)</script><img src=x onerror=alert(2)><a href="javascript:x">link</a></p>',
    };
    const out = renderEssayAnswerHtml(stored);
    expect(out).toBe('<div class="essay-rich"><p>Hilink</p></div>');
    for (const bad of ["script", "onclick", "onerror", "<img", "javascript:", "<a"]) {
      expect(out).not.toContain(bad);
    }
  });

  test("html that cleans to nothing falls back to the plain text", () => {
    const r = { type: "essay", text: "plain words", html: "<script>x</script>" };
    expect(essayRichHtml(r)).toBeNull();
    expect(renderEssayAnswerHtml(r)).toBe("plain words");
  });

  test("essayRichHtml: only an essay with html is formatted (a revision row's response too)", () => {
    expect(essayRichHtml({ type: "essay", text: "a" })).toBeNull();
    expect(essayRichHtml({ type: "essay", text: "a", html: "" })).toBeNull();
    expect(essayRichHtml({ type: "short_text", text: "a", html: "<p>a</p>" })).toBeNull();
    expect(essayRichHtml({ type: "essay", text: "a", html: "<b>a</b>" })).toBe("<p><strong>a</strong></p>");
    expect(essayRichHtml("not an object")).toBeNull();
  });
});

describe("docRichAnswerHtml (Google Docs, D-10)", () => {
  const clean =
    '<p data-indent="first"><strong>B</strong> <em>I</em> <u>U</u> 1 &lt; 2</p><p><br></p><ul><li>a</li></ul><ol><li>b</li></ol>';

  test("single spacing: Docs tags, the indent as half an inch, no paragraph margin", () => {
    const out = docRichAnswerHtml(clean, false);
    expect(out).toBe(
      '<p style="margin:0;text-indent:36pt"><b>B</b> <i>I</i> <u>U</u> 1 &lt; 2</p><p style="margin:0"><br></p><ul><li>a</li></ul><ol><li>b</li></ol>',
    );
    expect(out).not.toContain("line-height");
  });

  test("double spacing puts line-height:2.0 on every paragraph and list item", () => {
    const out = docRichAnswerHtml(clean, true);
    expect(out).toContain(`<p style="margin:0;text-indent:36pt;${DOUBLE_SPACING}">`);
    expect(out).toContain(`<p style="margin:0;${DOUBLE_SPACING}"><br></p>`);
    expect(out).toContain(`<li style="${DOUBLE_SPACING}">a</li>`);
    expect(out).toContain(`<li style="${DOUBLE_SPACING}">b</li>`);
    // Escaped text stays escaped.
    expect(out).toContain("1 &lt; 2");
  });
});

describe("buildDocHtml with formatting and spacing", () => {
  const base = {
    studentName: "S",
    assessmentName: "T",
    draftAsOf: null,
    contents: { prompt: true, sources: false, score: false, teacher_feedback: true, ai_feedback: false },
  };
  const plain = {
    number: 1,
    stem: "Prompt words.",
    stimulus: null,
    sources: [],
    answer: "Para one.\n\nPara two.",
    score: {
      points: 1,
      max_points: 2,
      teacher_note: "Note words.",
      criteria: [],
      ai_overall: null,
      from_ai: false,
    },
  };

  test("a formatted essay goes in formatted; its plain answer is not printed beside it", () => {
    const html = buildDocHtml({
      ...base,
      essays: [{ ...plain, answer: "• a", answer_html: "<ul><li><strong>a</strong></li></ul>" }],
    });
    expect(html).toContain("<ul><li><b>a</b></li></ul>");
    expect(html).not.toContain("• a");
  });

  test("double spacing reaches the essay only — prompt and feedback keep normal spacing", () => {
    const html = buildDocHtml({ ...base, essays: [plain], doubleSpace: true });
    expect(html).toContain(`<p style="margin:0 0 10pt 0;${DOUBLE_SPACING}">Para one.</p>`);
    expect(html).toContain(`<p style="margin:0 0 10pt 0;${DOUBLE_SPACING}">Para two.</p>`);
    expect(html).toContain(`${PARAGRAPH_OPEN}Prompt words.</p>`);
    expect(html).toContain(`${PARAGRAPH_OPEN}Note words.</p>`);
  });

  test("off by default: no line-height anywhere", () => {
    const html = buildDocHtml({ ...base, essays: [plain] });
    expect(html).not.toContain("line-height");
    expect(html).toContain(`${PARAGRAPH_OPEN}Para one.</p>`);
  });
});

describe("answer history Copy (D-7)", () => {
  test("a formatted version copies its plain text, never the markup", () => {
    expect(
      revisionText({ type: "essay", text: "Bold\n• item", html: "<p><strong>Bold</strong></p><ul><li>item</li></ul>" }),
    ).toBe("Bold\n• item");
  });
});
