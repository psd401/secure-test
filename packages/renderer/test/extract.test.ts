import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CLIENT_SOURCES,
  collectLiterals,
  extractRenderer,
  findStringLiterals,
  resolveLiteral,
} from "../scripts/extract-swift";
import { BRIDGE_REQUIRES, HOST_CALLBACKS } from "../src/requires";

// Expected values below were produced by `swift` itself (Swift 6, macOS) on
// the same snippets, 2026-10-13 — the TS extractor must agree byte for byte.

function value(swift: string, name: string): string {
  return resolveLiteral(name, collectLiterals([{ file: "t.swift", source: swift }]));
}

const lines = (...l: string[]) => l.join("\n");

describe("indentation", () => {
  test("strips the closing delimiter's indent; empty, exact-indent and deeper whitespace lines", () => {
    const swift = lines(
      "    static let a = \"\"\"",
      "        x",
      "",
      "        ",
      "          ",
      "          y  ",
      "        z",
      "        \"\"\"",
    );
    expect(value(swift, "a")).toBe("x\n\n\n  \n  y  \nz");
  });

  test("a blank line before the closing delimiter is a trailing newline", () => {
    const swift = lines('static let a = """', "  one", "", '  """');
    expect(value(swift, "a")).toBe("one\n");
  });

  test("no trailing newline otherwise", () => {
    expect(value(lines('static let a = """', "  one", '  """'), "a")).toBe("one");
  });

  test("an empty literal", () => {
    expect(value(lines('static let a = """', '"""'), "a")).toBe("");
  });

  test("insufficient indentation is refused, as Swift refuses it", () => {
    const swift = lines('static let a = """', "    x", "  ", '    """');
    expect(() => value(swift, "a")).toThrow(/insufficient indentation/);
  });

  test("tab indentation is refused", () => {
    expect(() => value(lines('static let a = """', "\tx", '\t"""'), "a")).toThrow(/tab/);
  });
});

describe("raw literals", () => {
  test("backslashes are literal; \\#(name) splices another literal verbatim", () => {
    const swift = lines(
      'static let a = """',
      "    x",
      "    y",
      '    """',
      'static let b = #"""',
      "    p\\#(a)q \\( \\n",
      '    """#',
    );
    expect(value(swift, "b")).toBe("px\nyq \\( \\n");
  });

  test("an interpolation on its own line keeps the surrounding newlines", () => {
    const swift = lines(
      'static let f = #"""',
      "  // f1",
      "  // f2",
      '"""#',
      'static let s = #"""',
      "    (function () {",
      "    \\#(f)",
      "    })();",
      '    """#',
    );
    expect(value(swift, "s")).toBe("(function () {\n  // f1\n  // f2\n})();");
  });

  test("two hashes: \\#( is literal, \\##( interpolates", () => {
    const swift = lines(
      'static let a = """',
      "  A",
      '  """',
      'static let b = ##"""',
      '  \\#(a) \\##(a) "#',
      '  """##',
    );
    expect(value(swift, "b")).toBe('\\#(a) A "#');
  });

  test("other \\# escapes are refused", () => {
    expect(() => value(lines('static let a = #"""', "  \\#n", '  """#'), "a")).toThrow(/not supported/);
  });

  test("an interpolation that is not a bare name is refused", () => {
    const swift = lines('static let a = #"""', "  \\#(Self.b)", '  """#');
    expect(() => value(swift, "a")).toThrow(/bare literal name/);
  });

  test("an interpolation of an unknown name is refused", () => {
    const swift = lines('static let a = #"""', "  \\#(missing)", '  """#');
    expect(() => value(swift, "a")).toThrow(/not an extracted multi-line literal/);
  });

  test("a cycle is refused", () => {
    const swift = lines(
      'static let a = #"""',
      "  \\#(b)",
      '  """#',
      'static let b = #"""',
      "  \\#(a)",
      '  """#',
    );
    expect(() => value(swift, "a")).toThrow(/cycle/);
  });

  test("a plain triple quote inside a raw literal is content", () => {
    expect(value(lines('static let a = #"""', '  say """hi"""', '  """#'), "a")).toBe('say """hi"""');
  });
});

describe("plain literals", () => {
  test("the escapes the literals use", () => {
    const swift = lines('static let c = """', '    a\\\\b \\"q\\" \\u{41}', "", '    """');
    expect(value(swift, "c")).toBe('a\\b "q" A\n');
  });

  test("CSS's own backslash escapes survive as one backslash", () => {
    const swift = lines('static let s = """', '  x::after { content: "\\\\25BE"; }', '  """');
    expect(value(swift, "s")).toBe('x::after { content: "\\25BE"; }');
  });

  test("\\( interpolation is refused", () => {
    expect(() => value(lines('static let a = """', "  \\(x)", '  """'), "a")).toThrow(/interpolation/);
  });

  test("a line continuation is refused", () => {
    const swift = lines('static let a = """', "  one \\", "  two", '  """');
    expect(() => value(swift, "a")).toThrow(/line continuation/);
  });

  test("an unknown escape is refused", () => {
    expect(() => value(lines('static let a = """', "  \\q", '  """'), "a")).toThrow(/not supported/);
  });
});

describe("refusals", () => {
  test("unterminated", () => {
    expect(() => findStringLiterals(lines('static let a = """', "  x"), "t.swift")).toThrow(/no closing/);
  });

  test("a closing delimiter inside the content", () => {
    const swift = lines('static let a = #"""', '  x """#', '  """#');
    expect(() => findStringLiterals(swift, "t.swift")).toThrow(/early close/);
  });

  test("CR characters", () => {
    expect(() => findStringLiterals('static let a = """\r\n  x\r\n  """', "t.swift")).toThrow(/CR/);
  });

  test("a name declared twice across files", () => {
    const one = lines('static let a = """', "  x", '  """');
    expect(() =>
      collectLiterals([
        { file: "a.swift", source: one },
        { file: "b.swift", source: one },
      ]),
    ).toThrow(/declared twice/);
  });

  test("an unknown top-level name", () => {
    expect(() => value(lines('static let a = """', "  x", '  """'), "b")).toThrow(/no multi-line/);
  });
});

// The real client sources. check-extraction.sh proves byte equality against
// Swift on macOS; these run everywhere (CI is ubuntu) and pin the shape.
describe("the client's renderer", () => {
  const repo = join(import.meta.dir, "..", "..", "..");
  const { js, css } = extractRenderer(
    CLIENT_SOURCES.map((file) => ({ file, source: readFileSync(join(repo, file), "utf8") })),
  );

  test("renderer.js is the whole IIFE with both spliced blocks and no interpolation left", () => {
    expect(js.startsWith("(function () {\n")).toBe(true);
    expect(js.endsWith("})();")).toBe(true);
    expect(js).not.toContain("\\#(");
    expect(js).toContain("function mathSegments(");
    expect(js).toContain("function richCaretContext(");
  });

  test("neither file contains </", () => {
    expect(js.includes("</")).toBe(false);
    expect(css.includes("</")).toBe(false);
  });

  test("renderer.css is itemStyles then richTextStyles", () => {
    expect(css.startsWith(".choice {")).toBe(true);
    expect(css).toContain("\n/* RT slice 3: the formatted essay box.");
    expect(css).toContain('content: "\\25BE"');
  });

  test("BRIDGE_REQUIRES = the handlers the page posts to + tts.word_ranges", () => {
    const handlers = new Set(
      [...js.matchAll(/messageHandlers\.([A-Za-z_]+)/g)].map((m) => m[1]!),
    );
    expect(js).toContain("window.__secureTestSpeech = {");
    expect(js).toMatch(/__secureTestSpeech = \{[\s\S]*?\bword: function/);
    expect<string[]>([...BRIDGE_REQUIRES].sort()).toEqual([...handlers, "tts.word_ranges"].sort());
  });

  test("the page defines every function the host calls, each under a term it requires", () => {
    for (const [name, term] of Object.entries(HOST_CALLBACKS)) {
      expect(js).toContain(`window.${name} =`);
      expect(BRIDGE_REQUIRES).toContain(term);
    }
  });
});
