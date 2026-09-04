import XCTest
@testable import SecureTestCore

final class JSONEmbeddingTests: XCTestCase {
    // The reason this type exists: PoC-B's `const items = <json>;` would have
    // let a stem close the script element and inject executable markup.
    func testClosingScriptTagCannotSurviveEmbedding() {
        let json = #"{"stem":"</script><script>alert(1)</script>"}"#
        let escaped = JSONEmbedding.escapeForScriptElement(json)
        XCTAssertFalse(escaped.contains("</script>"))
        XCTAssertFalse(escaped.contains("<"))
        XCTAssertTrue(escaped.contains("\\u003c"))
    }

    func testEscapesAngleBracketsAndAmpersand() {
        let escaped = JSONEmbedding.escapeForScriptElement("a<b>c&d")
        XCTAssertEqual(escaped, "a\\u003cb\\u003ec\\u0026d")
    }

    func testEscapesJavaScriptLineTerminators() {
        let escaped = JSONEmbedding.escapeForScriptElement("a\u{2028}b\u{2029}c")
        XCTAssertEqual(escaped, "a\\u2028b\\u2029c")
    }

    func testLeavesOrdinaryTextAlone() {
        let input = #"{"stem":"What is 2 + 2?","id":"i1"}"#
        XCTAssertEqual(JSONEmbedding.escapeForScriptElement(input), input)
    }

    // The escaped form is still valid JSON — \uXXXX is a legal string escape —
    // so the page's JSON.parse / literal evaluation sees the original text back.
    func testEscapedFormRoundTripsThroughAJSONParser() throws {
        struct Payload: Codable, Equatable { let stem: String }
        let original = Payload(stem: "</script> & <b>bold</b>")
        let embedded = JSONEmbedding.embeddable(original)
        let decoded = try JSONDecoder().decode(
            Payload.self,
            from: Data(embedded.utf8)
        )
        XCTAssertEqual(decoded, original)
    }

    func testEmbeddableSortsKeysForStableOutput() {
        struct Two: Encodable { let zebra: Int; let apple: Int }
        let out = JSONEmbedding.embeddable(Two(zebra: 1, apple: 2))
        XCTAssertEqual(out, #"{"apple":2,"zebra":1}"#)
    }

    func testEmbeddableFallsBackRatherThanEmittingBrokenJS() {
        struct Unencodable: Encodable {
            func encode(to encoder: Encoder) throws {
                throw NSError(domain: "test", code: 1)
            }
        }
        XCTAssertEqual(JSONEmbedding.embeddable(Unencodable()), "null")
        XCTAssertEqual(
            JSONEmbedding.embeddable(Unencodable(), fallback: "[]"),
            "[]"
        )
    }
}
