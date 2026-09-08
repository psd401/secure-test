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
    /// - `font-src data:` — KaTeX's woff2 faces and the two PSD brand faces
    ///   (`PageFonts`) are inlined as data URIs.
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

    /// The page's design tokens and its base typography and layout — client UI
    /// pass slice A (`docs/client-ui-pass-design.md` §A, decisions D-A1 / D-A2).
    ///
    /// Every rule in this page and in `AssessmentPage.itemStyles` reads a token
    /// from the block below; no rule carries a literal colour. That is what
    /// makes slice B possible at all: the eight `color_contrast` pairs, the
    /// optional font and the nine zoom levels become variable sets swapped on
    /// the root element, and nothing downstream has to know.
    ///
    /// The palette is PSD's (the `psd-branding` skill, mapped in
    /// `design-tool/app/globals.css`; ratios there are computed WCAG 2.x):
    ///
    /// - `--paper` is WHITE, not the design tool's Mist ground (D-A1): a test
    ///   page is read for long stretches and the paper should be the quietest
    ///   thing on it.
    /// - `--ink` Pacific — 10.70:1 on white.
    /// - `--ink-soft` the design tool's derived Pacific-grey helper ink
    ///   (`--muted-foreground`), 5.30:1 on white; replaces the old eyebrow
    ///   `#3a4a6a` and the assorted greys.
    /// - `--accent` Whulge, replacing `#0b5cd6` everywhere it appeared
    ///   (stimulus rule, passage link, current pip, focus rings). `--accent-ink`
    ///   is Skylight — 5.97:1 on Whulge, so the filled button and the current
    ///   pip carry text at AA.
    /// - `--ok` Cedar (answered), `--warn` Ochre (partial, and the offline
    ///   notice's amber), `--danger` Clay.
    /// - `--line` is decorative hairline; `--line-strong` is the field boundary
    ///   the design tool sizes to ≥3:1 on every surface (WCAG 1.4.11), so it is
    ///   what every input and button border uses.
    /// - `--zoom` multiplies the root font size. Slice B drives it from the
    ///   student's `zoom` accommodation; here it is 1 and every type size is
    ///   expressed in `rem` so that driving it is a one-value change.
    ///
    /// Light only (D-A2), like the design tool: `color-scheme: light` rather
    /// than the old `light dark`, which declared a dark mode that had no tokens
    /// behind it.
    public static let baseStyles = """
    :root {
      color-scheme: light;
      --paper: #ffffff;
      --ink: #25424c;
      --ink-soft: #5a6c73;
      --line: #cddadf;
      --line-strong: #7d888d;
      --panel: #eeebe4;
      --panel-line: #d7cdbe;
      --accent: #346780;
      --accent-ink: #fffaec;
      --ok: #466857;
      --warn: #8d5d1c;
      --danger: #a04034;
      --font-body: 'Inter', -apple-system, system-ui, sans-serif;
      --font-heading: 'Josefin Sans', 'Inter', -apple-system, system-ui, sans-serif;
      --zoom: 1;
    }
    html { font-size: calc(16px * var(--zoom)); }
    body {
      font: 1rem var(--font-body);
      margin: 0;
      padding: 32px 40px 96px;
      color: var(--ink);
      background: var(--paper);
      -webkit-user-select: none;
      user-select: none;
    }
    h1 { font-family: var(--font-heading); font-size: 1.25rem; font-weight: 600; margin: 0 0 24px; }
    .item { padding: 20px 0; border-bottom: 1px solid var(--line); }
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
    ///   - fonts: the `@font-face` rules inlined ahead of everything else, so
    ///     `--font-body` / `--font-heading` resolve to the PSD faces. The
    ///     default is the vendored pair; a caller (or a test) can pass an empty
    ///     set to see the page on the system stack.
    public static func document(
        title: String,
        styles: [String] = [],
        scripts: [String] = [],
        body: String,
        fonts: PageFonts.Assets = PageFonts.shared
    ) -> String {
        let safeTitle = HTMLEscape.text(title)
        let styleBlocks = ([fonts.css, baseStyles] + styles)
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
