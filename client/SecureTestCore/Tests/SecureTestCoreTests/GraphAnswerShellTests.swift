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

    func testAGraphAnswerForAnotherTypeIsRefused() throws {
        let b = try DeliveryBundle.decode(from: Data(#"{"test_id":"t","title":"T","items":[{"type":"short_text","id":"s","stem":"?"}]}"#.utf8))
        let message = ItemResponseMessage(itemID: "s", response: .generic(type: "graph", fields: ["objects": .array([])]))
        XCTAssertNotNil(BridgeItemTable(bundle: b).check(message))
    }
}
