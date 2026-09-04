import Foundation
import JavaScriptCore
import XCTest
@testable import SecureTestCore

/// ADR 0009 in the shipping client: the vendored KaTeX loads from the
/// package's resource bundle, the CSS is self-contained (fonts inlined, no
/// fallback URLs), and the library itself renders — including the K12
/// macros — under JavaScriptCore, which needs no DOM for renderToString.
final class KatexBundleTests: XCTestCase {
    func testAssetsLoadCompleteFromTheResourceBundle() {
        let k = KatexBundle.shared
        XCTAssertEqual(k.missing, [])
        XCTAssertTrue(k.isComplete)
        XCTAssertTrue(k.js.contains("katex"))
        XCTAssertTrue(k.autoRender.contains("renderMathInElement"))
        XCTAssertGreaterThan(k.css.count, 100_000, "fonts should be inlined into the CSS")
    }

    func testCSSIsSelfContainedForANoOriginDocument() {
        let css = KatexBundle.shared.css
        XCTAssertTrue(css.contains("data:font/woff2;base64,"))
        XCTAssertFalse(css.contains("url(fonts/"), "every fonts/ URL must have become a data URI")
        XCTAssertFalse(css.contains(".woff) format"), "woff fallbacks are stripped")
        XCTAssertFalse(css.contains(".ttf) format"), "ttf fallbacks are stripped")
    }

    func testVendoredVersionMatchesTheGeneratedConstant() throws {
        let url = try XCTUnwrap(Bundle.module.url(forResource: "VERSION", withExtension: nil, subdirectory: "katex"))
        let onDisk = try String(contentsOf: url, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines)
        XCTAssertEqual(onDisk, GeneratedKatexMacros.katexVersion)
    }

    func testStripFallbackFontsLeavesOnlyWoff2() {
        let css = #"src:url(fonts/KaTeX_Main-Regular.woff2) format("woff2"),url(fonts/KaTeX_Main-Regular.woff) format("woff"),url(fonts/KaTeX_Main-Regular.ttf) format("truetype")"#
        XCTAssertEqual(
            KatexBundle.stripFallbackFonts(from: css),
            #"src:url(fonts/KaTeX_Main-Regular.woff2) format("woff2")"#
        )
    }

    /// Neither the library nor the macro constant carries the one sequence that
    /// could end the inline script element early.
    func testNothingInlinedCanCloseTheScriptElement() {
        XCTAssertFalse(KatexBundle.shared.js.contains("</script"))
        XCTAssertFalse(KatexBundle.shared.autoRender.contains("</script"))
        XCTAssertFalse(KatexBundle.macrosScript.contains("</"))
    }

    private func katexContext() throws -> JSContext {
        let context = try XCTUnwrap(JSContext())
        var thrown: String?
        context.exceptionHandler = { _, exception in thrown = exception?.toString() }
        context.evaluateScript(KatexBundle.shared.js)
        context.evaluateScript(KatexBundle.macrosScript)
        if let thrown { XCTFail("katex failed to load: \(thrown)") }
        return context
    }

    func testRendersAnExpressionWithAK12Macro() throws {
        let context = try katexContext()
        let html = context.evaluateScript(
            #"katex.renderToString('\\half + x^2 = \\degree', { macros: KATEX_MACROS, throwOnError: false, strict: 'ignore', trust: false })"#
        )?.toString() ?? ""
        XCTAssertTrue(html.contains("class=\"katex\""), "expected KaTeX markup, got: \(html.prefix(120))")
        XCTAssertTrue(html.contains("mfrac"), "\\half should expand to a fraction")
        XCTAssertTrue(html.contains("∘") || html.contains("circ"), "\\degree should expand to a ring")
    }

    func testABrokenExpressionRendersRedInsteadOfThrowing() throws {
        let context = try katexContext()
        let html = context.evaluateScript(
            #"katex.renderToString('\\frac{1}{', { macros: KATEX_MACROS, throwOnError: false, errorColor: '#cc0000' })"#
        )?.toString() ?? ""
        XCTAssertTrue(html.contains("katex-error"))
        XCTAssertTrue(html.contains("#cc0000"))
    }
}
