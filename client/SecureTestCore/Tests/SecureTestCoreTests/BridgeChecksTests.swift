import XCTest
@testable import SecureTestCore

/// Server-delivered renderer slice 1 (2026-10-08): the host's checks on page
/// payloads — bridge audit H-2, H-3, H-5, H-6 and B-7.
final class BridgeChecksTests: XCTestCase {
    private func fixtureBundle() throws -> DeliveryBundle {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .appendingPathComponent("Fixtures/delivery-bundle.json")
        return try DeliveryBundle.decode(from: try Data(contentsOf: url))
    }

    private func item(_ kind: DeliveryItem.Kind, in bundle: DeliveryBundle) throws -> String {
        try XCTUnwrap(bundle.items.first { $0.kind == kind }?.id)
    }

    // MARK: H-2 — item ids and response types

    func testAcceptsEachItemsOwnResponseType() throws {
        let bundle = try fixtureBundle()
        let table = BridgeItemTable(bundle: bundle)
        let shortText = try item(.shortText, in: bundle)
        let essay = try item(.essay, in: bundle)
        XCTAssertNil(table.check(ItemResponseMessage(itemID: shortText, response: .shortText(text: "x²"))))
        XCTAssertNil(table.check(ItemResponseMessage(itemID: essay, response: .essay(text: "An essay."))))
    }

    func testRefusesAnItemThatIsNotInTheBundle() throws {
        let table = BridgeItemTable(bundle: try fixtureBundle())
        XCTAssertEqual(
            table.check(ItemResponseMessage(itemID: "not-an-item", response: .shortText(text: "a"))),
            .unknownItem("not-an-item")
        )
        XCTAssertEqual(table.check(itemID: "not-an-item"), .unknownItem("not-an-item"))
    }

    func testRefusesAResponseOfAnotherItemsType() throws {
        let bundle = try fixtureBundle()
        let table = BridgeItemTable(bundle: bundle)
        let essay = try item(.essay, in: bundle)
        XCTAssertEqual(
            table.check(ItemResponseMessage(itemID: essay, response: .shortText(text: "a"))),
            .wrongResponseType(itemID: essay, expected: "essay", got: "short_text")
        )
    }

    func testADrawingMustNameADrawingItem() throws {
        let bundle = try fixtureBundle()
        let table = BridgeItemTable(bundle: bundle)
        XCTAssertNil(table.check(itemID: try item(.drawingUpload, in: bundle), expecting: .drawingUpload))
        let essay = try item(.essay, in: bundle)
        XCTAssertEqual(
            table.check(itemID: essay, expecting: .drawingUpload),
            .wrongResponseType(itemID: essay, expected: "essay", got: "drawing_upload")
        )
    }

    /// E12: the outline a student writes inline is posted as an essay under the
    /// set's `inline_item_id`, which is not one of the bundle's items.
    func testASetsInlineOutlineIdTakesAnEssay() throws {
        let json = """
        {
          "test_id": "t", "title": "T",
          "items": [{ "type": "short_text", "id": "q1", "stem": "Q" }],
          "item_sets": [{
            "id": "s1", "stimulus": "", "item_ids": ["q1"],
            "source_missing": true, "inline_item_id": "outline-1"
          }]
        }
        """
        let table = BridgeItemTable(bundle: try DeliveryBundle.decode(from: Data(json.utf8)))
        XCTAssertNil(table.check(ItemResponseMessage(itemID: "outline-1", response: .essay(text: "notes"))))
        XCTAssertEqual(
            table.check(ItemResponseMessage(itemID: "outline-1", response: .shortText(text: "a"))),
            .wrongResponseType(itemID: "outline-1", expected: "essay", got: "short_text")
        )
    }

    // MARK: B-7 / H-3 — length limits

    func testLengthLimitsMatchTheServersAndRefuseOneOver() throws {
        let bundle = try fixtureBundle()
        let table = BridgeItemTable(bundle: bundle)
        let essay = try item(.essay, in: bundle)
        let shortText = try item(.shortText, in: bundle)

        let longestEssay = String(repeating: "a", count: BridgeLimits.essayTextMaxLength)
        XCTAssertNil(table.check(ItemResponseMessage(itemID: essay, response: .essay(text: longestEssay))))
        XCTAssertEqual(
            table.check(ItemResponseMessage(itemID: essay, response: .essay(text: longestEssay + "a"))),
            .tooLong(field: "essay text", length: 100_001, max: 100_000)
        )
        XCTAssertEqual(
            table.check(ItemResponseMessage(
                itemID: essay,
                response: .essay(text: "a", html: String(repeating: "a", count: 200_001))
            )),
            .tooLong(field: "essay html", length: 200_001, max: 200_000)
        )
        XCTAssertEqual(
            table.check(ItemResponseMessage(
                itemID: shortText,
                response: .shortText(text: String(repeating: "a", count: 2_001))
            )),
            .tooLong(field: "short text", length: 2_001, max: 2_000)
        )
    }

    func testCellAndBlankLimits() {
        let cell = String(repeating: "a", count: 501)
        XCTAssertEqual(
            BridgeItemTable.lengthRefusal(.table(cells: ["r1": ["c1": cell]])),
            .tooLong(field: "table cell", length: 501, max: 500)
        )
        XCTAssertEqual(
            BridgeItemTable.lengthRefusal(.fillBlank(answers: ["b1": cell])),
            .tooLong(field: "blank", length: 501, max: 500)
        )
        XCTAssertNil(BridgeItemTable.lengthRefusal(.table(cells: ["r1": ["c1": String(cell.dropLast())]])))
    }

    // MARK: H-3 — drawings

    private let png = Data([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x01])

    func testAcceptsABase64PNG() {
        let url = "data:image/png;base64," + png.base64EncodedString()
        XCTAssertEqual(try DrawingPayload.pngBytes(fromDataURL: url).get(), png)
    }

    func testRefusesBytesWithoutThePNGSignature() {
        let url = "data:image/png;base64," + Data("GIF89a…".utf8).base64EncodedString()
        XCTAssertEqual(DrawingPayload.pngBytes(fromDataURL: url), .failure(.notPNG))
        XCTAssertEqual(DrawingPayload.pngBytes(fromDataURL: "data:image/jpeg;base64,AAAA"), .failure(.notPNG))
        XCTAssertEqual(DrawingPayload.pngBytes(fromDataURL: "data:image/png;base64,!!!"), .failure(.notPNG))
    }

    func testRefusesAnOversizedDrawingBeforeDecoding() {
        // 40 base64 characters carry 30 bytes; the limit is 16.
        let url = "data:image/png;base64," + String(repeating: "A", count: 40)
        XCTAssertEqual(
            DrawingPayload.pngBytes(fromDataURL: url, maxBytes: 16),
            .failure(.tooLarge(bytes: 30, max: 16))
        )
        let fits = "data:image/png;base64," + png.base64EncodedString()
        XCTAssertNoThrow(try DrawingPayload.pngBytes(fromDataURL: fits, maxBytes: png.count).get())
    }

    // MARK: H-5 — strings into the page

    func testQuotesStringsForJavaScript() {
        XCTAssertEqual(JavaScriptString.quoted("plain"), "\"plain\"")
        XCTAssertEqual(JavaScriptString.quoted("a\"b\\c\nd"), "\"a\\\"b\\\\c\\nd\"")
        XCTAssertEqual(JavaScriptString.quoted("x\u{2028}y"), "\"x\\u2028y\"")
    }

    // MARK: H-6 — read-aloud requests

    func testReadAloudRefusesOversizedRequests() throws {
        func speak(_ segments: [[String: String]]) -> [String: Any] {
            ["action": "speak", "id": "a", "segments": segments]
        }
        let text = String(repeating: "a", count: BridgeLimits.speechMaxCharacters)
        XCTAssertNoThrow(try SpeechCommand.decode(fromMessageBody: speak([["kind": "text", "text": text]])))
        XCTAssertThrowsError(try SpeechCommand.decode(
            fromMessageBody: speak([["kind": "text", "text": text], ["kind": "math", "tex": "x"]])
        )) { error in
            XCTAssertEqual(error as? SpeechCommand.DecodeError, .tooLarge("120001 characters"))
        }
        let many = Array(repeating: ["kind": "text", "text": "a"], count: BridgeLimits.speechMaxSegments + 1)
        XCTAssertThrowsError(try SpeechCommand.decode(fromMessageBody: speak(many))) { error in
            XCTAssertEqual(error as? SpeechCommand.DecodeError, .tooLarge("2001 segments"))
        }
    }
}
