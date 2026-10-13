import XCTest
@testable import SecureTestCore

/// Renderer slice 4c: the page built from a served renderer, and the
/// load-or-refuse decision the app makes before begin().
final class RendererStartTests: XCTestCase {
    // MARK: - Helpers

    private let sha = String(repeating: "ab", count: 32)

    private func manifest(version: Int = 7) throws -> RendererManifest {
        let json = """
        {"format":1,"version":\(version),"commit":"\(String(repeating: "c", count: 40))",\
        "issued_at":"2026-10-13T00:00:00.000Z","not_after":"2026-12-13T00:00:00.000Z",\
        "requires":["response"],"files":{"renderer.js":{"sha256":"\(String(repeating: "0", count: 64))","bytes":1}}}
        """
        return try RendererManifest.decode(Data(json.utf8)).get()
    }

    private func loaded(script: String, styles: String, fromCache: Bool = false) throws -> LoadedRenderer {
        LoadedRenderer(
            manifest: try manifest(), script: script, styles: styles,
            ref: RendererRef(version: 7, sha256: sha), fromCache: fromCache)
    }

    /// The bundled page as `html()` built it before slice 4c — reconstructed
    /// from the same parts, so a change to the nil path shows up here.
    private func preSliceBundledPage(title: String, json: String) -> String {
        let katex = KatexBundle.shared
        let accommodations = AssessmentPage.accommodationsIn(json)
        return PageShell.document(
            title: title,
            styles: [katex.css, AssessmentPage.itemStyles, AssessmentPage.richTextStyles],
            scripts: [
                katex.js,
                "const BUNDLE = \(JSONEmbedding.escapeForScriptElement(json));",
                "const OFFLINE = false;",
                TextToSpeechScope(accommodations: accommodations).pageScript,
                SpeechToTextAvailability.off.pageScript,
                KatexBundle.macrosScript,
                AssessmentPage.rendererScript,
            ],
            body: """
            <h1>\(HTMLEscape.text(title))</h1>
            <div id="items"></div>
            """,
            accommodations: accommodations
        )
    }

    private func styleElementCount(_ html: String) -> Int {
        html.components(separatedBy: "<style>").count - 1
    }

    // MARK: - html(renderer:)

    func testNoRendererIsTheBundledPageByteForByte() throws {
        let json = try RendererHarness.fixtureJSON()
        let page = AssessmentPage.html(title: "Quiz", bundleJSON: json, renderer: nil)
        XCTAssertEqual(page, AssessmentPage.html(title: "Quiz", bundleJSON: json))
        XCTAssertEqual(page, preSliceBundledPage(title: "Quiz", json: json))
    }

    func testServedRendererReplacesTheScriptAndBothStyleElements() throws {
        let json = try RendererHarness.fixtureJSON()
        let served = try loaded(script: "/* served renderer */ window.SERVED = 1;",
                                styles: ".served-rule { color: red; }")
        let page = AssessmentPage.html(title: "Quiz", bundleJSON: json, renderer: served)
        let bundled = AssessmentPage.html(title: "Quiz", bundleJSON: json)

        XCTAssertTrue(page.contains("<script>/* served renderer */ window.SERVED = 1;</script>"))
        XCTAssertFalse(page.contains(AssessmentPage.rendererScript))
        XCTAssertTrue(page.contains("<style>.served-rule { color: red; }</style>"))
        XCTAssertFalse(page.contains(AssessmentPage.itemStyles))
        XCTAssertFalse(page.contains(AssessmentPage.richTextStyles))
        // One style element fewer than the bundled page: two became one.
        XCTAssertEqual(styleElementCount(page), styleElementCount(bundled) - 1)

        // Everything the shell keeps is still there.
        for kept in [
            KatexBundle.shared.js, KatexBundle.shared.css, KatexBundle.macrosScript,
            "const BUNDLE = ", "const OFFLINE = false;", "const TTS_SCOPE", "const STT_STATE",
            PageShell.contentSecurityPolicy, PageShell.baseStyles, PageShell.accommodationStyles,
            "<h1>Quiz</h1>", "<div id=\"items\"></div>",
        ] {
            XCTAssertTrue(page.contains(kept), "missing: \(kept.prefix(40))")
        }
        // The served script is still the last one, after the macros.
        let macros = try XCTUnwrap(page.range(of: KatexBundle.macrosScript))
        let script = try XCTUnwrap(page.range(of: "window.SERVED = 1;"))
        XCTAssertLessThan(macros.lowerBound, script.lowerBound)
    }

    /// Bridge mode (D-9): served js == rendererScript and served css ==
    /// itemStyles + "\n" + richTextStyles. The page must then differ from the
    /// bundled one ONLY at the boundary between the two style elements.
    func testBridgeModePageDiffersOnlyAtTheStyleBoundary() throws {
        let json = try RendererHarness.fixtureJSON()
        let bridge = try loaded(
            script: AssessmentPage.rendererScript,
            styles: AssessmentPage.itemStyles + "\n" + AssessmentPage.richTextStyles)
        let served = AssessmentPage.html(title: "Quiz", bundleJSON: json, renderer: bridge)
        let bundled = AssessmentPage.html(title: "Quiz", bundleJSON: json)

        let boundary = AssessmentPage.itemStyles + "</style>\n<style>" + AssessmentPage.richTextStyles
        let joined = AssessmentPage.itemStyles + "\n" + AssessmentPage.richTextStyles
        XCTAssertEqual(bundled.components(separatedBy: boundary).count, 2, "boundary occurs exactly once")
        XCTAssertEqual(bundled.replacingOccurrences(of: boundary, with: joined), served)
        XCTAssertEqual(served.count, bundled.count - "</style>\n<style>".count + "\n".count)
    }

    func testOfflineFlagAndSpeechStateStillApplyWithAServedRenderer() throws {
        let json = try RendererHarness.fixtureJSON()
        let served = try loaded(script: "window.X = 1;", styles: ".x{}")
        let page = AssessmentPage.html(title: "Quiz", bundleJSON: json, offline: true, renderer: served)
        XCTAssertTrue(page.contains("const OFFLINE = true;"))
    }

    // MARK: - Plan

    func testPlanLoadsWhenTheBundleNamesARenderer() {
        let ref = RendererRef(version: 3, sha256: sha)
        XCTAssertEqual(RendererStart.plan(for: ref, allowsBundledFallback: false), .load(ref))
        XCTAssertEqual(RendererStart.plan(for: ref, allowsBundledFallback: true), .load(ref))
    }

    func testPlanWithoutTheFieldRefusesInReleaseAndFallsBackInDebug() {
        XCTAssertEqual(RendererStart.plan(for: nil, allowsBundledFallback: false), .refuseMissing)
        XCTAssertEqual(RendererStart.plan(for: nil, allowsBundledFallback: true), .bundledFallback)
    }

    func testTrustedKeysAddTheDevKeyOnlyWhenAsked() {
        XCTAssertEqual(RendererStart.trustedKeys(includeDevKey: false), RendererKeys.releaseKeys)
        XCTAssertFalse(RendererStart.trustedKeys(includeDevKey: false).contains(RendererKeys.devKey))
        XCTAssertEqual(RendererStart.trustedKeys(includeDevKey: true), RendererKeys.releaseKeys + [RendererKeys.devKey])
    }

    // MARK: - Resolve

    func testResolveServesWhatTheLoaderReturns() async throws {
        let ok = try loaded(script: "s", styles: "c")
        let outcome = await RendererStart.resolve(
            ref: ok.ref, allowsBundledFallback: false, load: { _ in .success(ok) })
        XCTAssertEqual(outcome, .served(ok))
    }

    func testResolveNeverCallsTheLoaderWithoutAField() async {
        var called = false
        let release = await RendererStart.resolve(ref: nil, allowsBundledFallback: false) { _ in
            called = true; return .failure(.unavailable("x"))
        }
        let debug = await RendererStart.resolve(ref: nil, allowsBundledFallback: true) { _ in
            called = true; return .failure(.unavailable("x"))
        }
        XCTAssertEqual(release, .refused(.missing))
        XCTAssertEqual(debug, .bundled)
        XCTAssertFalse(called)
    }

    /// A load failure refuses in Debug too — the fallback is for a missing
    /// field only, never for a renderer that failed its checks.
    func testResolveRefusesALoadFailureEvenInDebug() async {
        let ref = RendererRef(version: 3, sha256: sha)
        let outcome = await RendererStart.resolve(ref: ref, allowsBundledFallback: true) { _ in
            .failure(.integrity("renderer.js does not match the manifest"))
        }
        XCTAssertEqual(outcome, .refused(.failed(.integrity("renderer.js does not match the manifest"))))
    }

    // MARK: - Refusal copy

    func testMissingCapabilityReadsTheUpdateLine() {
        let refusal = RendererStart.Refusal.failed(.refused(.missingCapabilities(["future"])))
        XCTAssertTrue(refusal.needsUpdate)
        XCTAssertEqual(refusal.sheetMessage, "Your test couldn't load.")
        XCTAssertEqual(refusal.sheetInformative, JoinErrorCopy.message(forCode: "client_update_required"))
        XCTAssertTrue(refusal.sheetInformative.contains("Self Service"))
        XCTAssertEqual(refusal.reason, "update_needed")
    }

    func testEveryOtherRefusalReadsTryAgain() {
        let tryAgain: [RendererStart.Refusal] = [
            .missing,
            .failed(.unavailable("offline")),
            .failed(.integrity("hash")),
            .failed(.refused(.badSignature)),
            .failed(.refused(.expired)),
            .failed(.refused(.belowMinimumVersion(have: 1, need: 2))),
        ]
        for refusal in tryAgain {
            XCTAssertFalse(refusal.needsUpdate, "\(refusal)")
            XCTAssertEqual(refusal.sheetMessage, "Your test couldn't load.")
            XCTAssertEqual(
                refusal.sheetInformative,
                "Check your connection, then open it again from Your tests. If it still won't open, ask your teacher.")
        }
        XCTAssertEqual(RendererStart.Refusal.missing.reason, "missing")
        XCTAssertEqual(RendererStart.Refusal.failed(.unavailable("x")).reason, "unavailable")
        XCTAssertEqual(RendererStart.Refusal.failed(.integrity("x")).reason, "integrity")
        XCTAssertEqual(RendererStart.Refusal.failed(.refused(.expired)).reason, "refused")
    }

    func testRefusalLogLineIsTheLoadersLine() {
        let failure = RendererLoadFailure.unavailable("server down")
        XCTAssertEqual(RendererStart.Refusal.failed(failure).logLine, failure.logLine)
        XCTAssertTrue(RendererStart.Refusal.missing.logLine.hasPrefix("renderer missing"))
    }

    // MARK: - Log line

    func testOneLogLinePerStart() throws {
        XCTAssertEqual(RendererStart.logLine(for: nil), "renderer: bundled (Debug fallback)")
        XCTAssertEqual(
            RendererStart.logLine(for: try loaded(script: "s", styles: "c")),
            "renderer: served v7 abababababab")
        XCTAssertEqual(
            RendererStart.logLine(for: try loaded(script: "s", styles: "c", fromCache: true)),
            "renderer: from cache v7 abababababab")
    }
}
