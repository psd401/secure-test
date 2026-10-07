// RT slice 1 (docs/rich-text-essay-design.md): the sanitiser, the text
// derivation (D-7) and the ingest rule — pure, no database.
import { describe, expect, test } from "bun:test";
import {
  essayResponseForStorage,
  essayTextFromHtml,
  sanitizeEssayHtml,
} from "../lib/richText/essayHtml";

describe("sanitizeEssayHtml", () => {
  const cases: [string, string, string][] = [
    // [name, input, output]
    ["the allowed subset passes unchanged", "<p>a <strong>b</strong> <em>c</em> <u>d</u><br>e</p>", "<p>a <strong>b</strong> <em>c</em> <u>d</u><br>e</p>"],
    ["first-line indent is kept (D-4)", '<p data-indent="first">Para</p>', '<p data-indent="first">Para</p>'],
    ["lists one level (D-9)", "<ul><li>a</li></ul><ol><li>b</li></ol>", "<ul><li>a</li></ul><ol><li>b</li></ol>"],
    ["<b> / <i> map to strong / em", "<p><b>x</b><i>y</i></p>", "<p><strong>x</strong><em>y</em></p>"],
    ["<div> maps to <p>, keeping the indent", '<div data-indent="first">One</div><div>Two</div>', '<p data-indent="first">One</p><p>Two</p>'],
    ["headings and other blocks become paragraphs", "<h1>T</h1><blockquote>Q</blockquote>", "<p>T</p><p>Q</p>"],
    [
      "styled spans become marks",
      '<p><span style="font-weight: 700">B</span><span style="font-style:italic">I</span><span style="text-decoration: underline">U</span><span style="color:red">plain</span></p>',
      "<p><strong>B</strong><em>I</em><u>U</u>plain</p>",
    ],
    [
      "every attribute but data-indent=first is removed",
      '<p class="x" style="color:red" onclick="evil()" data-indent="block"><strong title="t">x</strong></p>',
      "<p><strong>x</strong></p>",
    ],
    ["data-indent on a non-block is not kept", '<strong data-indent="first">x</strong>', "<p><strong>x</strong></p>"],
    ["script and style are dropped with their content", "<p>a<script>alert(1)</script>b<style>p{color:red}</style>c</p>", "<p>abc</p>"],
    ["an unterminated script drops the rest", "<p>keep<script>alert(", "<p>keep</p>"],
    ["iframe / svg / img / input dropped", '<p>a<iframe src="x">t</iframe><svg><text>s</text></svg><img src=x onerror=alert(1)><input value="v">b</p>', "<p>ab</p>"],
    ["a script end tag in another case still ends it", "<p>a<SCRIPT>x</ScRiPt>b</p>", "<p>ab</p>"],
    ["links and unknown elements are unwrapped", '<p><a href="javascript:x">link</a> <mark>m</mark></p>', "<p>link m</p>"],
    ["comments, doctype and processing instructions vanish", "<!doctype html><!-- c --><?xml x?><p>x</p>", "<p>x</p>"],
    ["text outside a block goes in a paragraph", "hello <b>world</b><p>next</p>tail", "<p>hello <strong>world</strong></p><p>next</p><p>tail</p>"],
    ["a nested list is flattened into its parent's items", "<ul><li>a<ul><li>b</li><li>c</li></ul>d</li><li>e</li></ul>", "<ul><li>a</li><li>b</li><li>c</li><li>d</li><li>e</li></ul>"],
    ["an ol nested in a ul joins the ul", "<ul><li>a<ol><li>b</li></ol></li></ul>", "<ul><li>a</li><li>b</li></ul>"],
    ["a block inside a list item is a line break", "<ul><li><p>a</p><p>b</p></li></ul>", "<ul><li>a<br>b</li></ul>"],
    ["an <li> outside a list is a paragraph", "<li>stray</li>", "<p>stray</p>"],
    ["empty list items and lists are dropped", "<ul><li> </li></ul><ol><li>x</li><li></li></ol>", "<ol><li>x</li></ol>"],
    ["pretty-printed whitespace between blocks is ignored", "<ol>\n  <li>one</li>\n  <li>two</li>\n</ol>\n<p>x</p>\n", "<ol><li>one</li><li>two</li></ol><p>x</p>"],
    ["an inner blank paragraph is kept as an empty line", "<div>One</div><div><br></div><div>Two</div>", "<p>One</p><p><br></p><p>Two</p>"],
    ["leading / trailing blank paragraphs are dropped", "<p><br></p><p>x</p><p></p><p>  </p>", "<p>x</p>"],
    ["entities: escaped ones stay escaped, others decode", "<p>3 &lt; 4 &amp;&amp; 5 &gt; 2 &#169; &#x41; &quot;q&quot; &apos;</p>", "<p>3 &lt; 4 &amp;&amp; 5 &gt; 2 © A \"q\" '</p>"],
    ["an unknown named entity stays literal text", "<p>&copy;</p>", "<p>&amp;copy;</p>"],
    ["a bare < is text", "<p>3 < 4</p>", "<p>3 &lt; 4</p>"],
    ["&nbsp; becomes a no-break space character", "<p>a&nbsp;&nbsp;b</p>", "<p>a  b</p>"],
    ["marks nest canonically and merge", "<b><i>x</i></b><i><b>y</b></i>", "<p><strong><em>xy</em></strong></p>"],
    ["marks carry across a block inside them", "<b><p>x</p></b>", "<p><strong>x</strong></p>"],
    ["unclosed paragraphs close each other", "<p>a<p>b", "<p>a</p><p>b</p>"],
    ["an attribute with > inside quotes does not end the tag", '<p title="a>b">x</p>', "<p>x</p>"],
    ["empty input", "", ""],
    ["only dropped content", "<script>x</script><img src=x>", ""],
  ];
  for (const [name, input, output] of cases) {
    test(name, () => {
      expect(sanitizeEssayHtml(input)).toBe(output);
    });
  }

  test("idempotent on every case", () => {
    for (const [, input] of cases) {
      const once = sanitizeEssayHtml(input);
      expect(sanitizeEssayHtml(once)).toBe(once);
    }
  });

  test("pathological nesting neither throws nor loses the text", () => {
    const deep = "<b>".repeat(5000) + "deep" + "</b>".repeat(5000);
    expect(sanitizeEssayHtml(deep)).toBe("<p><strong>deep</strong></p>");
  });
});

describe("essayTextFromHtml (D-7)", () => {
  const cases: [string, string, string][] = [
    ["one line per paragraph, joined by a single newline", "<p>One</p><p>Two</p>", "One\nTwo"],
    ["a blank paragraph is an empty line", "<p>One</p><p><br></p><p>Two</p>", "One\n\nTwo"],
    ["<br> is a newline; a trailing placeholder <br> is not", "<p>a<br>b<br></p><p>c<br><br></p>", "a\nb\nc"],
    ["formatting adds nothing", "<p><strong>Bold</strong> <em>it</em> <u>u</u></p>", "Bold it u"],
    ["the first-line indent adds nothing (D-4)", '<p data-indent="first">Indented</p>', "Indented"],
    ["bulleted items read \"• \" (D-9)", "<ul><li>apple</li><li>pear</li></ul>", "• apple\n• pear"],
    ["numbered items count within their list (D-9)", "<ol><li>a</li><li>b</li></ol><p>x</p><ol><li>c</li></ol>", "1. a\n2. b\nx\n1. c"],
    ["a line break inside an item", "<ul><li>a<br>b</li></ul>", "• a\nb"],
    ["entities decode", "<p>3 &lt; 4 &amp; R&amp;D &#169;</p>", "3 < 4 & R&D ©"],
    ["no-break spaces read as spaces", "<p>a&nbsp;&nbsp;b</p>", "a  b"],
    ["source whitespace collapses as it renders", "<p>  a \n  b  </p>", "a b"],
    ["empty", "", ""],
  ];
  for (const [name, html, text] of cases) {
    test(name, () => {
      expect(essayTextFromHtml(sanitizeEssayHtml(html))).toBe(text);
    });
  }

  test("word count reads the same words as the formatted essay", () => {
    const html = sanitizeEssayHtml("<p><b>Four</b> <i>words</i> are <u>here</u></p><ul><li>and two</li></ul>");
    expect(essayTextFromHtml(html).split(/\s+/).filter((w) => /\w/.test(w)).length).toBe(6);
  });
});

describe("essayResponseForStorage (ingest)", () => {
  // The wire type: html is optional, as in EssayResponseSchema.
  type Essay = { type: string; text: string; html?: string };
  const essay = (r: Essay): Essay => r;
  const rich = { type: "essay", config: { rich_text: true } };
  const plain = { type: "essay", config: {} };

  test("rich_text on: html cleaned, text derived and overwriting the client's", () => {
    expect(
      essayResponseForStorage(rich, essay({ type: "essay", text: "wrong", html: "<b>Hi</b><script>x</script>" })),
    ).toEqual({ type: "essay", text: "Hi", html: "<p><strong>Hi</strong></p>" });
  });

  test("rich_text on, html cleans to nothing: empty text, no html", () => {
    expect(essayResponseForStorage(rich, essay({ type: "essay", text: "x", html: "<p></p>" }))).toEqual({
      type: "essay",
      text: "",
    });
  });

  test("rich_text on, no html: unchanged", () => {
    const r = { type: "essay", text: "plain" };
    expect(essayResponseForStorage(rich, r)).toBe(r);
  });

  test("rich_text off (or no config): html dropped, text kept", () => {
    expect(essayResponseForStorage(plain, essay({ type: "essay", text: "t", html: "<p>x</p>" }))).toEqual({
      type: "essay",
      text: "t",
    });
    expect(
      essayResponseForStorage({ type: "essay", config: null }, essay({ type: "essay", text: "t", html: "<p>x</p>" })),
    ).toEqual({ type: "essay", text: "t" });
  });

  test("other item types pass through untouched", () => {
    const r = { type: "short_text", text: "x" };
    expect(essayResponseForStorage({ type: "short_text", config: { rich_text: true } }, r)).toBe(r);
  });
});
