import Foundation

/// Assembles the HTML document the client loads into its WKWebView.
///
/// The document is loaded with `loadHTMLString(_:baseURL: nil)`, which produces
/// a no-origin document. That is load-bearing, not incidental: PoC-B measured
/// that a no-origin document is denied `localStorage` and `document.cookie` by
/// WebKit outright, so a test page cannot persist anything across items or
/// across a relaunch (poc-b-test-loop/RESULTS.md, auto-probe table).
///
/// Item content is never interpolated into this markup. The page receives it as
/// a JSON payload and builds DOM with `createElement` / `textContent`, so a stem
/// that looks like markup renders as the text it is. The only Swift-side
/// interpolation is the title, which goes through HTMLEscape.
public enum PageShell {
    /// `default-src 'none'` is the whole posture: no network of any kind, and
    /// every capability re-granted explicitly.
    ///
    /// - `script-src 'unsafe-inline'` — the renderer and KaTeX are inlined.
    ///   There is no external script and no `eval` (no `'unsafe-eval'`).
    /// - `style-src 'unsafe-inline'` — same, for KaTeX's stylesheet.
    /// - `font-src data:` — KaTeX woff2 faces are inlined as data URIs.
    /// - `img-src data:` — bundled assets arrive base64 in the payload.
    ///   PoC-B also allowed `'self'`, which is meaningless for a no-origin
    ///   document; dropped rather than carried forward as noise.
    /// - `connect-src` is absent, so it falls back to `default-src 'none'`:
    ///   fetch / XHR / WebSocket from the page are blocked. Responses leave via
    ///   the named WKScriptMessage handler, which CSP does not govern — that is
    ///   the only channel out, by design.
    public static let contentSecurityPolicy = [
        "default-src 'none'",
        "style-src 'unsafe-inline'",
        "script-src 'unsafe-inline'",
        "font-src data:",
        "img-src data:",
    ].joined(separator: "; ")

    /// Base typography and layout. Kept deliberately plain — a test page should
    /// not be visually louder than the item it is presenting.
    public static let baseStyles = """
    :root { color-scheme: light dark; }
    body {
      font: 16px -apple-system, system-ui, sans-serif;
      margin: 0;
      padding: 32px 40px 96px;
      color: #1c1c1e;
      background: #fff;
      -webkit-user-select: none;
      user-select: none;
    }
    h1 { font-size: 20px; font-weight: 600; margin: 0 0 24px; }
    .item { padding: 20px 0; border-bottom: 1px solid #e5e5ea; }
    .item:last-child { border-bottom: none; }
    .stem { margin: 0 0 12px; line-height: 1.5; }
    /* Anything the student is meant to type into re-enables selection. */
    input, textarea { -webkit-user-select: text; user-select: text; }
    """

    /// - Parameters:
    ///   - title: shown as the page heading and `<title>`; HTML-escaped.
    ///   - styles: additional stylesheets, inlined in order after `baseStyles`.
    ///   - scripts: inlined in order. Callers are responsible for having run any
    ///     embedded JSON through `JSONEmbedding`.
    ///   - body: markup for `<body>`, assembled by the caller.
    public static func document(
        title: String,
        styles: [String] = [],
        scripts: [String] = [],
        body: String
    ) -> String {
        let safeTitle = HTMLEscape.text(title)
        let styleBlocks = ([baseStyles] + styles)
            .filter { !$0.isEmpty }
            .map { "<style>\($0)</style>" }
            .joined(separator: "\n")
        let scriptBlocks = scripts
            .filter { !$0.isEmpty }
            .map { "<script>\($0)</script>" }
            .joined(separator: "\n")
        return """
        <!doctype html>
        <html lang="en"><head>
        <meta charset="utf-8">
        <meta http-equiv="Content-Security-Policy" content="\(contentSecurityPolicy)">
        <title>\(safeTitle)</title>
        \(styleBlocks)
        </head><body>
        \(body)
        \(scriptBlocks)
        </body></html>
        """
    }
}
