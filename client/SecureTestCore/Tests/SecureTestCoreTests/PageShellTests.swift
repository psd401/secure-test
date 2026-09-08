import Foundation
import XCTest
@testable import SecureTestCore

final class PageShellTests: XCTestCase {
    func testCSPDeniesEverythingByDefault() {
        XCTAssertTrue(PageShell.contentSecurityPolicy.contains("default-src 'none'"))
    }

    // connect-src is deliberately absent so it inherits default-src 'none'.
    // The page must not be able to reach the network on its own; the only
    // channel out is the named WKScriptMessage handler.
    func testCSPGrantsNoNetworkCapability() {
        let csp = PageShell.contentSecurityPolicy
        XCTAssertFalse(csp.contains("connect-src"))
        XCTAssertFalse(csp.contains("http:"))
        XCTAssertFalse(csp.contains("https:"))
        XCTAssertFalse(csp.contains("*"))
    }

    // Inline script is required (the renderer and KaTeX are inlined) but eval
    // is not, and granting it would re-open a class of injection.
    func testCSPAllowsInlineScriptButNotEval() {
        XCTAssertTrue(PageShell.contentSecurityPolicy.contains("script-src 'unsafe-inline'"))
        XCTAssertFalse(PageShell.contentSecurityPolicy.contains("unsafe-eval"))
    }

    func testCSPLimitsImagesAndFontsToDataURIs() {
        let csp = PageShell.contentSecurityPolicy
        XCTAssertTrue(csp.contains("img-src data:"))
        XCTAssertTrue(csp.contains("font-src data:"))
        // PoC-B carried 'self', which is meaningless for a no-origin document.
        XCTAssertFalse(csp.contains("'self'"))
    }

    func testDocumentCarriesTheCSPMetaTag() {
        let html = PageShell.document(title: "Quiz", body: "<p>hi</p>")
        XCTAssertTrue(html.contains(#"<meta http-equiv="Content-Security-Policy""#))
        XCTAssertTrue(html.contains(PageShell.contentSecurityPolicy))
    }

    func testTitleIsEscapedRatherThanInterpolatedRaw() {
        let html = PageShell.document(
            title: "</title><script>alert(1)</script>",
            body: ""
        )
        XCTAssertFalse(html.contains("<script>alert(1)</script>"))
        XCTAssertTrue(html.contains("&lt;/title&gt;"))
    }

    func testStylesAndScriptsAreInlinedInOrder() {
        let html = PageShell.document(
            title: "T",
            styles: ["/*first*/", "/*second*/"],
            scripts: ["/*a*/", "/*b*/"],
            body: "<div id=\"items\"></div>"
        )
        guard let firstStyle = html.range(of: "/*first*/"),
              let secondStyle = html.range(of: "/*second*/"),
              let aScript = html.range(of: "/*a*/"),
              let bScript = html.range(of: "/*b*/") else {
            return XCTFail("expected all inlined blocks to be present")
        }
        XCTAssertTrue(firstStyle.lowerBound < secondStyle.lowerBound)
        XCTAssertTrue(aScript.lowerBound < bScript.lowerBound)
        // Base styles always come first so callers can override them.
        XCTAssertTrue(html.range(of: PageShell.baseStyles)!.lowerBound < firstStyle.lowerBound)
    }

    func testEmptyStyleAndScriptEntriesProduceNoEmptyTags() {
        let html = PageShell.document(title: "T", styles: [""], scripts: [""], body: "")
        XCTAssertFalse(html.contains("<script></script>"))
        XCTAssertFalse(html.contains("<style></style>"))
    }

    func testBodyContentIsPlacedVerbatim() {
        let html = PageShell.document(title: "T", body: "<div id=\"items\"></div>")
        XCTAssertTrue(html.contains("<div id=\"items\"></div>"))
    }

    // MARK: - Client UI pass, slice A (docs/client-ui-pass-design.md §A)

    /// Every token the page and slice B depend on is declared once, on :root.
    /// Slice B swaps these values per student (the eight contrast pairs, the
    /// optional font, the nine zoom levels); a missing name would be a rule
    /// silently falling back instead.
    func testRootDeclaresEveryDesignToken() {
        let css = PageShell.baseStyles
        XCTAssertTrue(css.contains(":root {"))
        for token in [
            "--paper:", "--ink:", "--ink-soft:", "--line:", "--line-strong:",
            "--panel:", "--panel-line:", "--accent:", "--accent-ink:",
            "--ok:", "--warn:", "--danger:", "--font-body:", "--font-heading:",
            "--zoom:",
        ] {
            XCTAssertTrue(css.contains(token), "missing token \(token)")
        }
    }

    /// D-A2: light only. `light dark` declared a dark mode with no tokens
    /// behind it — how the design tool once shipped an accidental dark theme.
    func testColorSchemeIsLightOnly() {
        XCTAssertTrue(PageShell.baseStyles.contains("color-scheme: light;"))
        XCTAssertFalse(PageShell.baseStyles.contains("light dark"))
    }

    /// The root font size is the single lever zoom pulls in slice B.
    func testRootFontSizeIsDrivenByTheZoomToken() {
        XCTAssertTrue(PageShell.baseStyles.contains("html { font-size: calc(16px * var(--zoom)); }"))
        XCTAssertTrue(PageShell.baseStyles.contains("--zoom: 1;"))
    }

    /// The palette that was hard-coded through both stylesheets before slice A,
    /// collected by grepping the two strings at the time. A hex reappearing
    /// here is a rule slice B's contrast pairs could not reach.
    static let retiredColours = [
        "#0b5cd6", "#1c1c1e", "#1d1d1f", "#2e7d32", "#3a4a6a", "#555",
        "#6b4a00", "#6b6b70", "#b7791f", "#c00", "#c7c7cc", "#c9d1e0",
        "#d6dce8", "#e5e5ea", "#e6c46a", "#f5f7fb", "#fff4d6",
        "rgba(11, 92, 214",
    ]

    func testNeitherStylesheetCarriesARetiredLiteralColour() {
        for (name, sheet) in [("baseStyles", PageShell.baseStyles),
                              ("itemStyles", AssessmentPage.itemStyles)] {
            for colour in PageShellTests.retiredColours {
                XCTAssertFalse(sheet.contains(colour), "\(colour) is still in \(name)")
            }
        }
    }

    /// Stronger than the list above: colour lives ONLY in the token block. No
    /// rule outside `:root { … }` carries a hex at all, in either stylesheet.
    func testColourLiteralsAppearOnlyInTheTokenBlock() {
        let hex = try! NSRegularExpression(pattern: "#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3})?\\b")
        func hexes(in css: String) -> [String] {
            hex.matches(in: css, range: NSRange(css.startIndex..., in: css))
                .compactMap { Range($0.range, in: css).map { String(css[$0]) } }
        }
        guard let close = PageShell.baseStyles.range(of: "\n}\n") else {
            return XCTFail("expected the :root block to close")
        }
        XCTAssertEqual(hexes(in: String(PageShell.baseStyles[close.upperBound...])), [])
        XCTAssertEqual(hexes(in: AssessmentPage.itemStyles), [])
        // And the token block itself does carry them — otherwise the two
        // assertions above would pass on an empty stylesheet.
        // Twelve slice-B tokens plus `--canvas-paper`, the drawing canvas's
        // on-screen ground, which is declared here but deliberately NOT one of
        // the twelve a contrast set swaps (drawing tools D-6).
        XCTAssertEqual(hexes(in: String(PageShell.baseStyles[..<close.lowerBound])).count, 13)
    }

    /// The hand-in block had no CSS at all before slice A (design page,
    /// §"What exists"), so the primary action on the page rendered as a
    /// default WebKit button. Its TEXT is the hand-in copy contract, untouched.
    func testTheFinishBlockHasRules() {
        let css = AssessmentPage.itemStyles
        XCTAssertTrue(css.contains(".finish {"))
        XCTAssertTrue(css.contains(".finish-status {"))
        let button = css.range(of: ".finish button {").map { css[$0.upperBound...] }
        XCTAssertTrue(button?.contains("background: var(--accent);") == true)
        XCTAssertTrue(button?.contains("color: var(--accent-ink);") == true)
    }

    /// WCAG 1.4.1: a partly-answered pip carries a glyph as well as a colour
    /// (a fully-answered one already carries a check mark in its own text, and
    /// every pip carries its state in `aria-label`).
    func testAPartlyAnsweredPipCarriesAGlyphAndNotColourAlone() {
        XCTAssertTrue(AssessmentPage.itemStyles.contains(".pager-strip button.partial::after"))
    }

    /// §D's focus item, taken here: focus moves to the page heading on every
    /// page change and used to be invisible because the rule said
    /// `outline: none`.
    func testThePageHeadingShowsItsFocusRing() {
        let css = AssessmentPage.itemStyles
        XCTAssertFalse(css.contains("outline: none"))
        let rule = css.range(of: ".page-label:focus, .page-label:focus-visible {")
            .map { css[$0.upperBound...] }
        XCTAssertTrue(rule?.contains("outline: 2px solid var(--accent);") == true)
    }

    /// The brand faces ride every document the shell builds, ahead of the
    /// tokens that name them.
    func testDocumentInlinesTheBrandFacesBeforeTheTokens() {
        let html = PageShell.document(title: "T", body: "")
        guard let face = html.range(of: "@font-face"),
              let root = html.range(of: ":root {") else {
            return XCTFail("expected both the faces and the token block")
        }
        XCTAssertTrue(face.lowerBound < root.lowerBound)
    }

    /// A build with no vendored faces still renders — every rule falls through
    /// to the system stack inside `--font-body` / `--font-heading`.
    func testDocumentWithoutFontsEmitsNoEmptyStyleTag() {
        let html = PageShell.document(
            title: "T",
            body: "",
            fonts: PageFonts.Assets(css: "", missing: ["fonts/inter-latin-var.woff2"]))
        XCTAssertFalse(html.contains("<style></style>"))
        XCTAssertFalse(html.contains("@font-face"))
    }
}
