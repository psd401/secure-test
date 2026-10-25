import XCTest
@testable import SecureTestCore

/// Row DC slice 7 (docs/graphing-calculator-design.md D-9): a "graph it"
/// question needs no shell release — the item decodes as `.other` and its
/// answer rides the generic channel. Pinned here with the real wire shape.
final class GraphAnswerShellTests: XCTestCase {
    private let bundleJSON = #"""
    {"test_id":"t","title":"T","calculator":{"mode":"graphing","preset":"full"},"items":[
      {"type":"graph","id":"g1","stem":"Graph y = 2x + 1.",
       "board":{"x":[-10,10],"y":[-10,10],"grid":1,"snap":"1","tools":["point","line"],"max_objects":10}}
    ],
    "saved_responses":{"g1":{"type":"graph","objects":[{"tool":"line","points":[[0,1],[1,3]]}]}}}
    """#

    private func bundle() throws -> DeliveryBundle {
        try DeliveryBundle.decode(from: Data(bundleJSON.utf8))
    }

    func testTheGraphItemDecodesAndTheBridgeKnowsIt() throws {
        let b = try bundle()
        XCTAssertEqual(b.items.first?.typeName, "graph")
        let table = BridgeItemTable(bundle: b)
        XCTAssertNil(table.check(itemID: "g1"))
    }

    func testTheLargestGraphAnswerTheServerAcceptsFitsTheGenericCaps() throws {
        // Ten objects of two points: the server's GraphResponseSchema maximum.
        let objects = (0..<10).map { i in
            ["tool": "segment", "points": [[Double(i), -10.0], [Double(i), 10.0]]] as [String: Any]
        }
        let body: [String: Any] = ["item_id": "g1", "response": ["type": "graph", "objects": objects]]
        let message = try ItemResponseMessage.decode(fromMessageBody: body)
        XCTAssertEqual(message.response.typeName, "graph")
        XCTAssertNil(BridgeItemTable(bundle: try bundle()).check(message))
    }

    func testAnEmptyAnswerIsAcceptedToo() throws {
        let body: [String: Any] = ["item_id": "g1", "response": ["type": "graph", "objects": [Any]()]]
        let message = try ItemResponseMessage.decode(fromMessageBody: body)
        XCTAssertNil(BridgeItemTable(bundle: try bundle()).check(message))
    }

    // The board itself can't run in JavaScriptCore (RendererCalculatorTests),
    // so the page glue's handling of an emptied board is pinned on its source:
    // it withdraws the saved answer instead of posting `objects: []`, which the
    // server would store and count as answered.
    func testAnEmptiedBoardWithdrawsInsteadOfPostingAnEmptyList() {
        let glue = AssessmentPage.calculatorFunctions
            .split(whereSeparator: \.isWhitespace).joined(separator: " ")
        XCTAssertTrue(glue.contains("if (!objects.length) { withdraw(p.item.id); return; }"))
        XCTAssertTrue(glue.contains("post(p.item.id, { type: 'graph', objects: objects });"))
        XCTAssertFalse(glue.contains("objects.length > 0)"), "no post that can carry an empty list")
    }

    // D-5: the contrast tokens and the zoom-following font size reach the
    // boards drawn inside a question (`.graph-stimulus` holders and
    // `.graph-answer` fields), not only the calculator panel.
    func testTheTokenRuleCoversStimulusGraphsAndAnswerBoards() {
        XCTAssertTrue(AssessmentPage.calculatorFunctions.contains(
            "'.calc-body .gc-root, .graph-stimulus .gc-root, .graph-answer .gc-root { --gc-paper: var(--paper);"
        ))
        XCTAssertTrue(AssessmentPage.calculatorFunctions.contains("wrap.className = 'graph-answer';"))
        XCTAssertTrue(AssessmentPage.calculatorFunctions.contains("holder.className = 'graph-stimulus';"))
    }

    func testAGraphAnswerForAnotherTypeIsRefused() throws {
        let b = try DeliveryBundle.decode(from: Data(#"{"test_id":"t","title":"T","items":[{"type":"short_text","id":"s","stem":"?"}]}"#.utf8))
        let message = ItemResponseMessage(itemID: "s", response: .generic(type: "graph", fields: ["objects": .array([])]))
        XCTAssertNotNil(BridgeItemTable(bundle: b).check(message))
    }
}
