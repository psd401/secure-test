import XCTest
@testable import SecureTestCore

/// E3 slice 3: the table response on the wire — `cells`, row id → column id →
/// text — the same shape the design tool's TableResponseSchema accepts.
final class ItemResponseTableTests: XCTestCase {
    func testDecodesAPageMessageAndEncodesTheSameShape() throws {
        let body: [String: Any] = [
            "item_id": "i9",
            "response": ["type": "table", "cells": ["r1": ["c1": "12", "c2": ""], "r2": ["c1": "1.5"]]],
        ]
        let message = try ItemResponseMessage.decode(fromMessageBody: body)
        XCTAssertEqual(message.itemID, "i9")
        XCTAssertEqual(
            message.response,
            .table(cells: ["r1": ["c1": "12", "c2": ""], "r2": ["c1": "1.5"]])
        )
        XCTAssertEqual(message.response.typeName, "table")

        let data = try JSONEncoder().encode(message.response)
        let json = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        XCTAssertEqual(json?["type"] as? String, "table")
        XCTAssertEqual(json?["cells"] as? [String: [String: String]], ["r1": ["c1": "12", "c2": ""], "r2": ["c1": "1.5"]])
        XCTAssertEqual(try JSONDecoder().decode(ItemResponse.self, from: data), message.response)
    }

    func testAMissingCellsFieldIsRejectedAtTheBoundary() {
        XCTAssertThrowsError(
            try ItemResponseMessage.decode(fromMessageBody: ["item_id": "i9", "response": ["type": "table"]])
        )
    }
}
