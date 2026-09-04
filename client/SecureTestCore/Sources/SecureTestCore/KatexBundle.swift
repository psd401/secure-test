import Foundation

/// KaTeX for the assessment page — ADR 0009, ported from PoC-B's slice 13
/// (poc-b-test-loop/client/Sources/PocBClient/TestRunner.swift) on
/// 2026-09-01, when it turned out the Phase 5 page had reserved the CSP for
/// KaTeX but never carried the library over: a stem with `$x^2$` reached the
/// student as source.
///
/// The assets are vendored by `client/scripts/vendor-katex.mjs` from the
/// design tool's own `katex` dependency, so the page renders math with the
/// same KaTeX version and the same K12 macro set as the teacher's preview.
/// The CSS gets two transforms before it is inlined: the woff/ttf fallback
/// URLs are stripped (only woff2 ships) and each `fonts/<face>.woff2` URL
/// becomes a `data:font/woff2;base64,…` URI, because the page is a
/// no-origin document whose CSP allows fonts from `data:` only.
public enum KatexBundle {
    public struct Assets: Sendable {
        public let css: String
        public let js: String
        public let autoRender: String
        /// Resource names that could not be read. Empty when everything loaded;
        /// the page still renders without math when it is not.
        public let missing: [String]

        public var isComplete: Bool { missing.isEmpty }
    }

    /// Loaded once per process; ~600 KB of text after font inlining.
    public static let shared: Assets = load()

    static func load(bundle: Bundle = .module) -> Assets {
        var missing: [String] = []
        func read(_ name: String, _ ext: String, subdirectory: String = "katex") -> String {
            guard let url = bundle.url(forResource: name, withExtension: ext, subdirectory: subdirectory),
                  let text = try? String(contentsOf: url, encoding: .utf8)
            else {
                missing.append("\(name).\(ext)")
                return ""
            }
            return text
        }

        var css = read("katex.min", "css")
        if !css.isEmpty {
            css = stripFallbackFonts(from: css)
            if let fontsDir = bundle.url(forResource: "fonts", withExtension: nil, subdirectory: "katex"),
               let files = try? FileManager.default.contentsOfDirectory(
                   at: fontsDir, includingPropertiesForKeys: nil)
            {
                for fontURL in files where fontURL.pathExtension == "woff2" {
                    guard let data = try? Data(contentsOf: fontURL) else {
                        missing.append("fonts/\(fontURL.lastPathComponent)")
                        continue
                    }
                    css = css.replacingOccurrences(
                        of: "fonts/\(fontURL.lastPathComponent)",
                        with: "data:font/woff2;base64,\(data.base64EncodedString())")
                }
            } else {
                missing.append("fonts/")
            }
        }
        let js = read("katex.min", "js")
        let autoRender = read("auto-render.min", "js")
        return Assets(css: css, js: js, autoRender: autoRender, missing: missing)
    }

    /// Drops `,url(fonts/X.woff) format("woff")` and the ttf twin so WebKit only
    /// ever asks for the woff2 that is inlined.
    static func stripFallbackFonts(from css: String) -> String {
        guard let regex = try? NSRegularExpression(
            pattern: #",url\(fonts/[^)]+\.(?:woff|ttf)\) format\("(?:woff|truetype)"\)"#)
        else { return css }
        return regex.stringByReplacingMatches(
            in: css, range: NSRange(css.startIndex..., in: css), withTemplate: "")
    }

    /// The macro set as the page's `KATEX_MACROS` constant — the same
    /// K12_MACROS the design tool's server-side renderer uses.
    static var macrosScript: String {
        "const KATEX_MACROS = \(GeneratedKatexMacros.json);"
    }
}
