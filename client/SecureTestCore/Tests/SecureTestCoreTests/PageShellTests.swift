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
}
