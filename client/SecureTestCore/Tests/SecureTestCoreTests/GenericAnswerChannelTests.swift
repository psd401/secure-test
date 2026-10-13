import XCTest
@testable import SecureTestCore

/// Server-delivered renderer slice 4d (docs/server-delivered-renderer-design.md
/// D-5): a v2.0 shell accepts a NEW item type and its answers without a shell
/// release, while the ten known types keep their exact checks.
final class GenericAnswerChannelTests: XCTestCase {
    /// A bundle with one known item, one of a type no shell has heard of, and a
    /// saved answer for the unknown one.
    private let bundleJSON = #"""
    {"test_id":"t","title":"T","items":[
      {"type":"short_text","id":"i1","stem":"Name it."},
      {"type":"number_line","id":"i2","stem":"Place 3/4.","min":0,"max":1,"ticks":[0,0.25,0.5]}
    ],
    "item_sets":[{"id":"s1","stimulus":"Read.","layout":"carousel","item_ids":["i1","i2"]}],
    "answered_item_ids":["i2"],
    "saved_responses":{"i2":{"type":"number_line","point":0.75,"marks":[{"at":0.5,"label":"half"}]}}}
    """#

    private func bundle() throws -> DeliveryBundle {
        try DeliveryBundle.decode(from: Data(bundleJSON.utf8))
    }

    /// Encodes with sorted keys: a JSON object has no order, so this is the
    /// byte-for-byte form two encodings of the same value share.
    private func canonical(_ data: Data) throws -> Data {
        let object = try JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed])
        return try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys, .fragmentsAllowed])
    }

    // MARK: - Items

    func testAnUnknownItemTypeDecodesAsOther() throws {
        let b = try bundle()
        XCTAssertEqual(b.items.count, 2)
        guard case .other(let other) = b.items[1] else { return XCTFail("\(b.items[1])") }
        XCTAssertEqual(other.id, "i2")
        XCTAssertEqual(other.type, "number_line")
        XCTAssertEqual(b.items[1].id, "i2")
        XCTAssertEqual(b.items[1].stem, "Place 3/4.")
        XCTAssertNil(b.items[1].kind)
        XCTAssertEqual(b.items[1].typeName, "number_line")
        XCTAssertEqual(b.items[0].typeName, "short_text")
    }

    func testAnUnknownItemWithoutAStemStillDecodes() throws {
        let item = try JSONDecoder().decode(DeliveryItem.self, from: Data(#"{"type":"x","id":"a","stem":{"rich":true}}"#.utf8))
        XCTAssertEqual(item.stem, "")
        XCTAssertEqual(item.typeName, "x")
    }

    /// Only the vocabulary opened up: malformed structure still fails.
    func testMalformedStructureStillFails() {
        let decoder = JSONDecoder()
        // Unknown type without an id.
        XCTAssertThrowsError(try decoder.decode(DeliveryItem.self, from: Data(#"{"type":"x","stem":"s"}"#.utf8)))
        // An id of the wrong type.
        XCTAssertThrowsError(try decoder.decode(DeliveryItem.self, from: Data(#"{"type":"x","id":7}"#.utf8)))
        // No type at all.
        XCTAssertThrowsError(try decoder.decode(DeliveryItem.self, from: Data(#"{"id":"a","stem":"s"}"#.utf8)))
        // A KNOWN type missing a field it needs is not passed through as other.
        XCTAssertThrowsError(try decoder.decode(DeliveryItem.self, from: Data(#"{"type":"multiple_choice_single","id":"a","stem":"s"}"#.utf8)))
    }

    func testAnUnknownSetLayoutDoesNotFailTheBundle() throws {
        XCTAssertEqual(try bundle().itemSets.first?.layout, .inline)
    }

    func testTheBridgeTableKnowsTheUnknownItem() throws {
        let table = BridgeItemTable(bundle: try bundle())
        XCTAssertTrue(table.contains("i2"))
        XCTAssertNil(table.check(itemID: "i2"))
        XCTAssertEqual(
            table.check(itemID: "i2", expecting: .drawingUpload),
            .wrongResponseType(itemID: "i2", expected: "number_line", got: "drawing_upload")
        )
    }

    // MARK: - Answers

    func testAGenericAnswerDecodesFromAPageMessage() throws {
        let body: [String: Any] = [
            "item_id": "i2",
            "response": ["type": "number_line", "point": 0.75, "snapped": true, "note": NSNull()],
        ]
        let message = try ItemResponseMessage.decode(fromMessageBody: body)
        XCTAssertEqual(message.response.typeName, "number_line")
        XCTAssertEqual(
            message.response,
            .generic(type: "number_line", fields: ["point": .double(0.75), "snapped": .bool(true), "note": .null])
        )
    }

    /// The answer the page posted is the answer the spool stores and resends:
    /// page body → decode → encode (as `record` does) → spool → decode → encode.
    func testAGenericAnswerRoundTripsThroughTheSpoolUnchanged() async throws {
        let wire = #"{"type":"number_line","point":0.75,"count":3,"big":-9007199254740993,"neg":-2,"ok":false,"none":null,"label":"três ½ \"q\" \n","marks":[{"at":0.5,"tags":["a","b"]},[],{}]}"#
        let original = try JSONSerialization.jsonObject(with: Data(wire.utf8))
        let message = try ItemResponseMessage.decode(fromMessageBody: ["item_id": "i2", "response": original])

        let first = try JSONEncoder().encode(message.response)
        XCTAssertEqual(try canonical(first), try canonical(Data(wire.utf8)))

        let path = FileManager.default.temporaryDirectory
            .appendingPathComponent("generic-\(UUID().uuidString).sqlite").path
        defer { try? FileManager.default.removeItem(atPath: path) }
        let spool = try ResponseSpool(path: path)
        try await spool.enqueue(attemptID: "a1", itemID: "i2", responseJSON: String(decoding: first, as: UTF8.self))
        let pending = try await spool.pending()
        let stored = try XCTUnwrap(pending.first?.responseJSON)
        XCTAssertEqual(Data(stored.utf8), first)

        let again = try JSONDecoder().decode(ItemResponse.self, from: Data(stored.utf8))
        XCTAssertEqual(again, message.response)
        let second = try JSONEncoder().encode(again)
        XCTAssertEqual(try canonical(second), try canonical(Data(wire.utf8)))
        // Integers stay integers.
        XCTAssertTrue(String(decoding: second, as: UTF8.self).contains("\"count\":3"))
        XCTAssertFalse(String(decoding: second, as: UTF8.self).contains("3.0"))
    }

    func testAKnownTypeWithABadShapeStillFails() {
        for body: [String: Any] in [
            ["type": "short_text", "text": 3],
            ["type": "essay"],
            ["type": "match", "matches": ["a": 1]],
            ["type": "table", "cells": ["r": "not-a-row"]],
        ] {
            XCTAssertThrowsError(
                try ItemResponseMessage.decode(fromMessageBody: ["item_id": "i1", "response": body]),
                "\(body)"
            )
        }
    }

    func testAResponseThatIsNotAnObjectFails() {
        XCTAssertThrowsError(try ItemResponseMessage.decode(fromMessageBody: ["item_id": "i2", "response": "x"]))
        XCTAssertThrowsError(try ItemResponseMessage.decode(fromMessageBody: ["item_id": "i2", "response": ["point": 1]]))
    }

    func testSavedResponsesWithAnUnknownTypeDecode() throws {
        let saved = try XCTUnwrap(try bundle().savedResponses["i2"])
        XCTAssertEqual(saved.typeName, "number_line")
        XCTAssertEqual(
            saved,
            .generic(type: "number_line", fields: [
                "point": .double(0.75),
                "marks": .array([.object(["at": .double(0.5), "label": .string("half")])]),
            ])
        )
    }

    // MARK: - Bridge checks

    func testAGenericAnswerForItsOwnItemIsAccepted() throws {
        let table = BridgeItemTable(bundle: try bundle())
        let answer = ItemResponse.generic(type: "number_line", fields: ["point": .double(0.75)])
        XCTAssertNil(table.check(ItemResponseMessage(itemID: "i2", response: answer)))
    }

    func testTypeMismatchIsRefusedForUnknownAndKnownTypes() throws {
        let table = BridgeItemTable(bundle: try bundle())
        // An unknown type posted for a known item.
        XCTAssertEqual(
            table.check(ItemResponseMessage(itemID: "i1", response: .generic(type: "number_line", fields: [:]))),
            .wrongResponseType(itemID: "i1", expected: "short_text", got: "number_line")
        )
        // A known type posted for the unknown item.
        XCTAssertEqual(
            table.check(ItemResponseMessage(itemID: "i2", response: .shortText(text: "a"))),
            .wrongResponseType(itemID: "i2", expected: "number_line", got: "short_text")
        )
        // Another unknown type posted for the unknown item.
        XCTAssertEqual(
            table.check(ItemResponseMessage(itemID: "i2", response: .generic(type: "graph", fields: [:]))),
            .wrongResponseType(itemID: "i2", expected: "number_line", got: "graph")
        )
        // An unknown item id.
        XCTAssertEqual(
            table.check(ItemResponseMessage(itemID: "zz", response: .generic(type: "number_line", fields: [:]))),
            .unknownItem("zz")
        )
    }

    func testKnownTypesKeepTheirExactCaps() throws {
        let table = BridgeItemTable(bundle: try bundle())
        let over = String(repeating: "a", count: BridgeLimits.shortTextMaxLength + 1)
        XCTAssertEqual(
            table.check(ItemResponseMessage(itemID: "i1", response: .shortText(text: over))),
            .tooLong(field: "short text", length: over.utf16.count, max: BridgeLimits.shortTextMaxLength)
        )
    }

    func testAGenericStringOverTheEssayCapIsRefused() throws {
        let table = BridgeItemTable(bundle: try bundle())
        let at = String(repeating: "a", count: BridgeLimits.essayTextMaxLength)
        let over = at + "a"
        let ok = ItemResponse.generic(type: "number_line", fields: ["note": .string(at)])
        XCTAssertNil(table.check(ItemResponseMessage(itemID: "i2", response: ok)))
        // Deep inside an array, and as an object key.
        let nested = ItemResponse.generic(type: "number_line", fields: ["m": .array([.object(["t": .string(over)])])])
        XCTAssertEqual(
            table.check(ItemResponseMessage(itemID: "i2", response: nested)),
            .tooLong(field: "number_line answer string", length: over.utf16.count, max: BridgeLimits.essayTextMaxLength)
        )
        let key = ItemResponse.generic(type: "number_line", fields: [over: .bool(true)])
        XCTAssertNotNil(table.check(ItemResponseMessage(itemID: "i2", response: key)))
    }

    func testDeepNestingIsRefused() throws {
        let table = BridgeItemTable(bundle: try bundle())
        func nest(_ n: Int) -> JSONValue { n == 0 ? .int(1) : .array([nest(n - 1)]) }
        // The answer object is depth 1, so 7 arrays inside it is 8 — the limit.
        let atLimit = ItemResponse.generic(type: "number_line", fields: ["v": nest(7)])
        XCTAssertNil(table.check(ItemResponseMessage(itemID: "i2", response: atLimit)))
        let over = ItemResponse.generic(type: "number_line", fields: ["v": nest(8)])
        XCTAssertEqual(
            table.check(ItemResponseMessage(itemID: "i2", response: over)),
            .tooDeep(depth: 9, max: BridgeLimits.genericAnswerMaxDepth)
        )
        // The same through a real page message.
        var body: Any = 1
        for _ in 0..<8 { body = [body] }
        let message = try ItemResponseMessage.decode(
            fromMessageBody: ["item_id": "i2", "response": ["type": "number_line", "v": body]])
        XCTAssertEqual(table.check(message), .tooDeep(depth: 9, max: BridgeLimits.genericAnswerMaxDepth))
    }

    func testAnOversizedGenericAnswerIsRefused() throws {
        let table = BridgeItemTable(bundle: try bundle())
        // Each string within the essay cap, the whole over 256 KB.
        let chunk = JSONValue.string(String(repeating: "a", count: 60_000))
        let big = ItemResponse.generic(type: "number_line", fields: ["v": .array(Array(repeating: chunk, count: 5))])
        guard case .answerTooLarge(let bytes, let max)? = table.check(ItemResponseMessage(itemID: "i2", response: big)) else {
            return XCTFail("expected answerTooLarge")
        }
        XCTAssertGreaterThan(bytes, BridgeLimits.genericAnswerMaxBytes)
        XCTAssertEqual(max, 256 * 1024)
        let fits = ItemResponse.generic(type: "number_line", fields: ["v": .array(Array(repeating: chunk, count: 4))])
        XCTAssertNil(table.check(ItemResponseMessage(itemID: "i2", response: fits)))
    }

    func testRefusalDescriptionsCarryNoAnswerText() {
        XCTAssertEqual(BridgeRefusal.tooDeep(depth: 9, max: 8).description, "answer nests 9 deep (max 8)")
        XCTAssertEqual(BridgeRefusal.answerTooLarge(bytes: 300_000, max: 262_144).description,
                       "answer is 300000 bytes (max 262144)")
    }

    // MARK: - Capabilities

    func testTheShellAnswersForTheGenericChannel() {
        XCTAssertTrue(RendererCapabilities.supported.contains("response.generic"))
    }
}
