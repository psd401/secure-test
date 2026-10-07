import XCTest
@testable import SecureTestCore

/// FB slice 5: the fill-in-the-blank response on the wire — `answers`, blank id
/// → the picked option's id or the typed text — the shape the design tool's
/// FillBlankResponseSchema accepts.
final class ItemResponseFillBlankTests: XCTestCase {
    func testDecodesAPageMessageAndEncodesTheSameShape() throws {
        let body: [String: Any] = [
            "item_id": "i10",
            "response": ["type": "fill_blank", "answers": ["b1": "o2", "b2": "rain shadow"]],
        ]
        let message = try ItemResponseMessage.decode(fromMessageBody: body)
        XCTAssertEqual(message.itemID, "i10")
        XCTAssertEqual(message.response, .fillBlank(answers: ["b1": "o2", "b2": "rain shadow"]))
        XCTAssertEqual(message.response.typeName, "fill_blank")

        let data = try JSONEncoder().encode(message.response)
        let json = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        XCTAssertEqual(json?["type"] as? String, "fill_blank")
        XCTAssertEqual(json?["answers"] as? [String: String], ["b1": "o2", "b2": "rain shadow"])
        XCTAssertEqual(try JSONDecoder().decode(ItemResponse.self, from: data), message.response)
    }

    func testAMissingAnswersFieldIsRejectedAtTheBoundary() {
        XCTAssertThrowsError(
            try ItemResponseMessage.decode(fromMessageBody: ["item_id": "i10", "response": ["type": "fill_blank"]])
        )
    }

    /// A blank kind this build cannot render is version skew: the decode
    /// fails, as an unknown item type does.
    func testAnUnknownBlankKindFailsTheItemDecode() {
        let json = #"{"type":"fill_blank","id":"f","stem":"A [[b1]]","blanks":[{"id":"b1","kind":"slider"}]}"#
        XCTAssertThrowsError(try JSONDecoder().decode(DeliveryItem.self, from: Data(json.utf8)))
    }
}
