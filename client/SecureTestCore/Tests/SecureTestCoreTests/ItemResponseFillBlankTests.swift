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

    /// Slice 4d (D-5): a blank kind this shell does not know no longer fails
    /// the bundle — the served renderer owns blank kinds. The blank is carried
    /// opaquely and the item stays a fill_blank, so its answers keep the
    /// fill_blank caps.
    func testAnUnknownBlankKindIsCarriedOpaquely() throws {
        let json = #"{"type":"fill_blank","id":"f","stem":"A [[b1]] [[b2]]","blanks":[{"id":"b1","kind":"slider","min":0},{"id":"b2","kind":"text"}]}"#
        let item = try JSONDecoder().decode(DeliveryItem.self, from: Data(json.utf8))
        guard case .fillBlank(let fb) = item else { return XCTFail("\(item)") }
        XCTAssertEqual(fb.blanks, [.other(id: "b1", kind: "slider"), .text(id: "b2")])
        XCTAssertEqual(fb.blanks.map(\.id), ["b1", "b2"])
        XCTAssertEqual(item.typeName, "fill_blank")
    }

    /// Only the vocabulary opened up: a blank with no id still fails.
    func testABlankWithoutAnIdStillFails() {
        let json = #"{"type":"fill_blank","id":"f","stem":"A","blanks":[{"kind":"slider"}]}"#
        XCTAssertThrowsError(try JSONDecoder().decode(DeliveryItem.self, from: Data(json.utf8)))
    }
}
