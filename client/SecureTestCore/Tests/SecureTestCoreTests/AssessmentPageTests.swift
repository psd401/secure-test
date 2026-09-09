import XCTest
@testable import SecureTestCore

final class AssessmentPageTests: XCTestCase {
    func testPageCarriesTheShellAndItsCSP() throws {
        let html = AssessmentPage.html(title: "Quiz", bundleJSON: try RendererHarness.fixtureJSON())
        XCTAssertTrue(html.hasPrefix("<!doctype html>"))
        XCTAssertTrue(html.contains(PageShell.contentSecurityPolicy))
        XCTAssertTrue(html.contains(#"<div id="items"></div>"#))
    }

    /// The fixture contains a stem with a literal `</script>` in it. If the
    /// payload were interpolated raw, that stem would close the script element
    /// and the rest would parse as markup — which `script-src 'unsafe-inline'`
    /// would then execute.
    func testMarkupShapedStemCannotCloseTheScriptElement() throws {
        let html = AssessmentPage.html(title: "Quiz", bundleJSON: try RendererHarness.fixtureJSON())
        let scriptCloseCount = html.components(separatedBy: "</script>").count - 1
        let scriptOpenCount = html.components(separatedBy: "<script>").count - 1
        XCTAssertEqual(
            scriptOpenCount,
            scriptCloseCount,
            "every script element must close exactly once — a payload-borne </script> would unbalance this"
        )
        XCTAssertTrue(html.contains("\\u003c/script\\u003e"))
    }

    func testTitleIsEscapedInBothTheHeadAndTheHeading() {
        let html = AssessmentPage.html(
            title: "<img src=x onerror=alert(1)>",
            bundleJSON: #"{"test_id":"t","title":"t","items":[]}"#
        )
        XCTAssertFalse(html.contains("<img src=x"))
        XCTAssertTrue(html.contains("&lt;img src=x"))
    }

    func testRendererNeverAssignsAuthoredContentToInnerHTML() {
        // The whole XSS posture rests on textContent / createTextNode. If a
        // future edit reaches for innerHTML, that posture is gone.
        XCTAssertFalse(AssessmentPage.rendererScript.contains("innerHTML"))
        XCTAssertFalse(AssessmentPage.rendererScript.contains("outerHTML"))
        XCTAssertFalse(AssessmentPage.rendererScript.contains("insertAdjacentHTML"))
        XCTAssertFalse(AssessmentPage.rendererScript.contains("document.write"))
    }

    func testRendererScriptCannotCloseItsOwnElement() {
        XCTAssertFalse(AssessmentPage.rendererScript.contains("</"))
    }

    func testRendererUsesNoEvalGivenCSPForbidsIt() {
        XCTAssertFalse(AssessmentPage.rendererScript.contains("eval("))
        XCTAssertFalse(AssessmentPage.rendererScript.contains("new Function"))
    }

    func testTypesRenderedInThisSliceAreWiredToTheResponseChannel() {
        let script = AssessmentPage.rendererScript
        XCTAssertTrue(script.contains("multiple_choice_single"))
        XCTAssertTrue(script.contains("multiple_choice_multi"))
        XCTAssertTrue(script.contains("short_text"))
        XCTAssertTrue(script.contains("messageHandlers.response"))
    }

    func testUnrenderedTypesDegradeToANoticeRatherThanAnEmptyItem() {
        // Until slices 54-57 land, the five remaining types must say so rather
        // than presenting a student a stem with no way to answer it.
        XCTAssertTrue(AssessmentPage.rendererScript.contains("is not available yet"))
    }

    // MARK: finding 8.5 — the offline flag

    /// The server path never names the flag, so its document must be the
    /// `offline: false` document, and that document must say so: the renderer
    /// treats anything but an explicit true as the server path.
    func testTheServerPageIsTheDefaultAndDeclaresItselfOnline() throws {
        let json = try RendererHarness.fixtureJSON()
        let byDefault = AssessmentPage.html(title: "Quiz", bundleJSON: json)
        XCTAssertEqual(byDefault, AssessmentPage.html(title: "Quiz", bundleJSON: json, offline: false))
        XCTAssertTrue(byDefault.contains("<script>const OFFLINE = false;</script>"))
        XCTAssertFalse(byDefault.contains("const OFFLINE = true;"))
    }

    /// The offline document differs from the server one in exactly that
    /// constant — nothing else about what the student is handed changes.
    func testTheOfflinePageDiffersOnlyInTheFlag() throws {
        let json = try RendererHarness.fixtureJSON()
        let offline = AssessmentPage.html(title: "Quiz", bundleJSON: json, offline: true)
        XCTAssertTrue(offline.contains("<script>const OFFLINE = true;</script>"))
        XCTAssertEqual(
            offline.replacingOccurrences(of: "const OFFLINE = true;", with: "const OFFLINE = false;"),
            AssessmentPage.html(title: "Quiz", bundleJSON: json)
        )
    }

    /// The renderer reads the flag it is handed, rather than some other
    /// signal, and still has no way to close its own element.
    func testTheRendererReadsTheOfflineFlag() {
        XCTAssertTrue(AssessmentPage.rendererScript.contains("OFFLINE === true"))
        XCTAssertFalse(AssessmentPage.rendererScript.contains("</"))
    }

    // ADR 0009 in the shipping client (2026-09-01): KaTeX + auto-render are
    // inlined ahead of the renderer, the macro constant beside BUNDLE, and the
    // renderer closes by rendering math in the tree it built.
    func testPageInlinesKatexAndRendersMathAfterBuildingTheTree() throws {
        let html = AssessmentPage.html(title: "T", bundleJSON: "{}")
        XCTAssertTrue(html.contains("data:font/woff2;base64,"), "KaTeX CSS with inlined fonts")
        XCTAssertTrue(html.contains("const KATEX_MACROS = {"))
        XCTAssertTrue(html.contains("renderMathInElement(root, {"))
        let katexAt = try XCTUnwrap(html.range(of: "renderMathInElement=")?.lowerBound
            ?? html.range(of: "renderMathInElement")?.lowerBound)
        let rendererAt = try XCTUnwrap(html.range(of: "const BUNDLE = ")?.lowerBound)
        XCTAssertLessThan(katexAt, rendererAt, "the library must be inlined before the renderer")
    }

    // Multi-source stimulus slice 1 (2026-09-09): authored line breaks in a
    // stem or a stimulus survive — a poem or a paragraphed passage collapsed
    // into one run of prose before (docs/multi-source-stimulus-design.md).
    func testStemAndStimulusBodiesKeepAuthoredLineBreaks() {
        let html = AssessmentPage.html(title: "T", bundleJSON: "{}")
        XCTAssertTrue(html.contains(".stem { white-space: pre-line; }"))
        XCTAssertTrue(html.contains(".stimulus-body { margin: 0; line-height: 1.5; white-space: pre-line; }"))
    }

    func testPageWithoutKatexStillRendersAndCarriesNoMathHooksButTheGuardedCall() {
        let bare = KatexBundle.Assets(css: "", js: "", autoRender: "", missing: ["katex.min.js"])
        let html = AssessmentPage.html(title: "T", bundleJSON: "{}", katex: bare)
        // No KaTeX face is inlined. The page's own two brand faces (client UI
        // pass slice A) are a separate stylesheet and still are, so this asks
        // about KaTeX's families rather than about data: fonts in general.
        XCTAssertFalse(html.contains("KaTeX_Main"))
        XCTAssertFalse(html.contains("font-family:KaTeX"))
        XCTAssertTrue(html.contains("font-family: 'Inter';"))
        // The guarded call is part of the renderer and stays; without the
        // library it is a no-op, which is the whole point of the guard.
        XCTAssertTrue(html.contains("typeof renderMathInElement === 'function'"))
    }
}

final class ItemResponseTests: XCTestCase {
    private func roundTrip(_ response: ItemResponse) throws -> ItemResponse {
        let data = try JSONEncoder().encode(response)
        return try JSONDecoder().decode(ItemResponse.self, from: data)
    }

    func testEveryResponseCaseRoundTrips() throws {
        let cases: [ItemResponse] = [
            .multipleChoiceSingle(choiceID: "c1"),
            .multipleChoiceMulti(choiceIDs: ["c1", "c3"]),
            .shortText(text: "photosynthesis"),
            .essay(text: "The author builds their argument by…"),
            .match(matches: ["p1": "p2", "p2": "p1"]),
            .order(orderedIDs: ["e2", "e1", "e3"]),
            .hotspot(regionIDs: ["r2"]),
            .drawingUpload(uploadID: "11111111-1111-4111-8111-111111111111"),
        ]
        for value in cases {
            XCTAssertEqual(try roundTrip(value), value)
        }
        // Eight as of slice 68 — drawing_upload joined once uploads existed.
        XCTAssertEqual(cases.count, 8)
    }

    func testEncodesTheSnakeCaseWireKeys() throws {
        let data = try JSONEncoder().encode(ItemResponse.multipleChoiceMulti(choiceIDs: ["c1"]))
        let json = String(data: data, encoding: .utf8) ?? ""
        XCTAssertTrue(json.contains("\"choice_ids\""))
        XCTAssertTrue(json.contains("\"type\":\"multiple_choice_multi\""))
    }

    func testDecodesAMessageBodyAsThePageWouldSendIt() throws {
        let body: [String: Any] = [
            "item_id": "i1",
            "response": ["type": "short_text", "text": "answer"],
        ]
        let message = try ItemResponseMessage.decode(fromMessageBody: body)
        XCTAssertEqual(message.itemID, "i1")
        XCTAssertEqual(message.response, .shortText(text: "answer"))
    }

    func testRejectsAnUnknownResponseTypeAtTheBoundary() {
        let body: [String: Any] = [
            "item_id": "i1",
            "response": ["type": "telepathy", "text": "x"],
        ]
        XCTAssertThrowsError(try ItemResponseMessage.decode(fromMessageBody: body))
    }

    func testRejectsAMessageMissingItsItemID() {
        let body: [String: Any] = ["response": ["type": "short_text", "text": "x"]]
        XCTAssertThrowsError(try ItemResponseMessage.decode(fromMessageBody: body))
    }

    func testRejectsAResponseMissingItsPayloadField() {
        let body: [String: Any] = ["item_id": "i1", "response": ["type": "short_text"]]
        XCTAssertThrowsError(try ItemResponseMessage.decode(fromMessageBody: body))
    }
}
