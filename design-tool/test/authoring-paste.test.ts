// R-4 clean paste (docs/editor-redesign-design.md, Phase 3 slice B): HTML
// from Word and Google Docs keeps only text, bold, italic and line breaks.
// The fixtures are HAND-BUILT in the shape each app puts on the clipboard
// (Word: Office namespaces, <style> in <head>, MsoNormal paragraphs, mso-
// styles, conditional comments around list bullets; Google Docs: the
// `<b style="font-weight:normal" id="docs-internal-guid-…">` wrapper, styled
// spans) — no real teacher content.

import { describe, expect, test } from "bun:test";
import { getSchema } from "@tiptap/core";
import { docToMarkup } from "@/lib/authoring/markupDoc";
import { markupExtensions } from "@/lib/authoring/markupExtensions";
import { Fragment, Slice } from "@tiptap/pm/model";
import {
  cleanForeignSlice,
  joinLines,
  plainTextToContent,
  rememberCopied,
  runsToContent,
  runsToHtml,
  sanitizePastedHtml,
} from "@/lib/authoring/pasteSanitize";

const schema = getSchema(markupExtensions());

/** Paste into an empty field, then save: the markup a teacher's paste becomes. */
function pastedMarkup(html: string): string {
  const { runs } = sanitizePastedHtml(html);
  const content = runsToContent(runs);
  const doc = schema.nodeFromJSON({ type: "doc", content: [content.length ? { type: "paragraph", content } : { type: "paragraph" }] });
  return docToMarkup(doc.toJSON()).markup;
}

const WORD = `<html xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">
<head><meta http-equiv=Content-Type content="text/html; charset=utf-8"><meta name=Generator content="Microsoft Word 15">
<style><!-- /* Font Definitions */ p.MsoNormal {margin:0in; font-size:12.0pt; font-family:"Calibri",sans-serif;} --></style>
<!--[if gte mso 9]><xml><o:OfficeDocumentSettings><o:AllowPNG/></o:OfficeDocumentSettings></xml><![endif]-->
</head>
<body lang=EN-US style='tab-interval:.5in'>
<!--StartFragment-->
<p class=MsoNormal><span style='font-size:14.0pt;mso-bidi-font-size:12.0pt;color:#C00000'>Which of these is an <b>abiotic</b>
factor in a <i>pond</i> ecosystem?<o:p></o:p></span></p>
<p class=MsoNormal><o:p>&nbsp;</o:p></p>
<p class=MsoListParagraphCxSpFirst style='text-indent:-.25in;mso-list:l0 level1 lfo1'><![if !supportLists]><span style='mso-list:Ignore'>1.<span style='font:7.0pt "Times New Roman"'>&nbsp;&nbsp;&nbsp; </span></span><![endif]><u>Sunlight</u> &amp; water</p>
<p class=MsoNormal><img width=120 height=80 src="file:///C:/Users/x/AppData/Local/Temp/msohtmlclip1/01/clip_image002.png" v:shapes="Picture_x0020_1"></p>
<!--EndFragment-->
</body></html>`;

const DOCS = `<meta charset="utf-8"><b style="font-weight:normal;" id="docs-internal-guid-0a1b2c3d-7fff-1234-5678-9abcdef01234"><p dir="ltr" style="line-height:1.38;margin-top:0pt;margin-bottom:0pt;"><span style="font-size:11pt;font-family:Arial,sans-serif;color:#000000;background-color:transparent;font-weight:400;font-style:normal;font-variant:normal;text-decoration:none;vertical-align:baseline;white-space:pre;white-space:pre-wrap;">Solve for </span><span style="font-size:11pt;font-family:Arial,sans-serif;color:#000000;background-color:transparent;font-weight:700;font-style:italic;font-variant:normal;text-decoration:none;vertical-align:baseline;white-space:pre;white-space:pre-wrap;">x</span><span style="font-size:11pt;font-family:Arial,sans-serif;color:#000000;font-weight:400;font-style:normal;">: it costs $5 &lt; $7.</span></p><br><p dir="ltr" style="line-height:1.38;"><span style="font-size:11pt;font-weight:400;font-style:italic;text-decoration:underline;"><a href="https://example.com/x">Show work</a></span></p></b><br class="Apple-interchange-newline">`;

describe("Word", () => {
  const out = sanitizePastedHtml(WORD);

  test("keeps bold and italic, drops fonts, colours, underline and Office XML", () => {
    expect(out.runs).toEqual([
      { text: "Which of these is an ", bold: false, italic: false },
      { text: "abiotic", bold: true, italic: false },
      { text: " factor in a ", bold: false, italic: false },
      { text: "pond", bold: false, italic: true },
      { text: " ecosystem?", bold: false, italic: false },
      { break: true },
      { text: "1. Sunlight & water", bold: false, italic: false },
    ]);
  });

  test("a pasted picture is counted and left out", () => {
    expect(out.droppedImages).toBe(1);
  });

  test("saves as plain markup", () => {
    expect(pastedMarkup(WORD)).toBe("Which of these is an **abiotic** factor in a _pond_ ecosystem?\n1. Sunlight & water");
  });
});

describe("Google Docs", () => {
  test("the font-weight:normal wrapper is not bold; styled spans are", () => {
    const { runs } = sanitizePastedHtml(DOCS);
    expect(runs).toEqual([
      { text: "Solve for ", bold: false, italic: false },
      { text: "x", bold: true, italic: true },
      { text: ": it costs $5 < $7.", bold: false, italic: false },
      { break: true },
      { text: "Show work", bold: false, italic: true },
    ]);
  });

  test("saves as plain markup; the link and underline are gone, the text stays", () => {
    expect(pastedMarkup(DOCS)).toBe("Solve for **_x_**: it costs $5 < $7.\n_Show work_");
  });
});

describe("the clean HTML handed to the editor", () => {
  test("holds only <p>, <strong>, <em>, <br> and escaped text", () => {
    for (const html of [WORD, DOCS, `<script>alert(1)</script><p onclick="x()">a<img src=x onerror=alert(1)> &lt;b&gt;</p>`]) {
      const clean = runsToHtml(sanitizePastedHtml(html).runs);
      const tags = [...clean.matchAll(/<\/?([a-z]+)/g)].map((m) => m[1]);
      expect(tags.every((t) => ["p", "strong", "em", "br"].includes(t!))).toBe(true);
      expect(clean).not.toContain("alert");
      expect(clean).not.toContain("onclick");
    }
  });

  test("text that looks like a tag stays text", () => {
    expect(runsToHtml(sanitizePastedHtml("<p>a &lt;b&gt; c</p>").runs)).toBe("<p>a &lt;b&gt; c</p>");
  });
});

describe("edge cases", () => {
  test("whitespace collapses across tags; entities decode", () => {
    expect(sanitizePastedHtml("<p>  one  <b> two </b>\n three&nbsp;&mdash;&#x3c0;</p>").runs).toEqual([
      { text: "one ", bold: false, italic: false },
      { text: "two ", bold: true, italic: false },
      { text: "three —π", bold: false, italic: false },
    ]);
  });

  test("table cells are spaced, rows are lines", () => {
    const { runs } = sanitizePastedHtml("<table><tr><td>a</td><td>b</td></tr><tr><td>c</td></tr></table>");
    expect(runs).toEqual([
      { text: "a b", bold: false, italic: false },
      { break: true },
      { text: "c", bold: false, italic: false },
    ]);
  });

  test("font-weight 600 counts as bold, 500 does not", () => {
    const { runs } = sanitizePastedHtml(`<span style="font-weight:600">a</span><span style="font-weight:500">b</span>`);
    expect(runs).toEqual([
      { text: "a", bold: true, italic: false },
      { text: "b", bold: false, italic: false },
    ]);
  });

  test("a choice field joins lines with spaces", () => {
    const { runs } = sanitizePastedHtml("<p>one</p><p>two</p>");
    expect(runsToContent(joinLines(runs))).toEqual([{ type: "text", text: "one" }, { type: "text", text: " " }, { type: "text", text: "two" }]);
  });

  test("plain text: lines become breaks, or spaces in a one-line field", () => {
    expect(plainTextToContent("a\r\nb")).toEqual([{ type: "text", text: "a" }, { type: "hardBreak" }, { type: "text", text: "b" }]);
    expect(plainTextToContent("a\nb", true)).toEqual([{ type: "text", text: "a" }, { type: "text", text: " " }, { type: "text", text: "b" }]);
  });

  test("an empty or tag-only paste is nothing", () => {
    expect(sanitizePastedHtml("<p><o:p></o:p></p><br>").runs).toEqual([]);
  });

  test("a script or comment re-formed by stripping is stripped too (CodeQL js/incomplete-multi-character-sanitization)", () => {
    expect(sanitizePastedHtml("a<scr<script></script>ipt>secret()</script>b").runs).toEqual([{ text: "ab", bold: false, italic: false }]);
    expect(sanitizePastedHtml("a<!<!-- x -->-- hidden -->b").runs).toEqual([{ text: "ab", bold: false, italic: false }]);
  });
});

// A paste carrying ProseMirror's slice marker (review of #119): only this
// tab's own copy out of a field keeps its parse; any other page's marked
// HTML is cleaned, so its pictures and formulas do not become nodes.
describe("ProseMirror's slice marker", () => {
  const ASSET = "11111111-1111-1111-1111-111111111111";
  const sliceOf = (s: typeof schema, content: object[]) => new Slice(Fragment.fromJSON(s, content), 0, 0);
  const rich = [
    { type: "text", text: "Solve " },
    { type: "math", attrs: { tex: "x^2", display: false } },
    { type: "image", attrs: { alt: "p", id: ASSET, scheme: null } },
    { type: "blank", attrs: { id: "b1" } },
  ];
  const FOREIGN = `<p data-pm-slice="0 0 []">Solve <span data-math data-tex="x^2"></span><img data-asset-id="${ASSET}" alt="p"></p>`;

  test("this tab's own copy keeps its formula, picture and blank, even into another field's schema", () => {
    rememberCopied(sliceOf(schema, rich));
    const other = getSchema(markupExtensions({ singleLine: true }));
    expect(cleanForeignSlice(sliceOf(other, rich), FOREIGN, other, true)).toBeNull();
  });

  test("a marked paste that is not the last copy is cleaned: text kept, picture counted, formula and picture dropped", () => {
    rememberCopied(sliceOf(schema, [{ type: "text", text: "something else" }]));
    const cleaned = cleanForeignSlice(sliceOf(schema, rich), FOREIGN, schema, false);
    expect(cleaned).not.toBeNull();
    const types = (cleaned!.slice.content.toJSON() as { type: string }[]).map((n) => n.type);
    expect(types).toEqual(["text"]);
    expect(cleaned!.droppedImages).toBe(1);
  });
});
