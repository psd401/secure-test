import Foundation

// Server-delivered renderer slice 1 (2026-10-08,
// docs/server-delivered-renderer-design.md §Progress, B-1…B-7): the host's
// checks on what the page sends over the message channels. The page is ours
// today, but these channels are the only way the document reaches the host,
// and once the renderer is served they are the security boundary — so every
// payload is validated as untrusted input, here, where it can be tested
// without a window.

/// The limits the host enforces on page payloads. The answer-text limits
/// mirror `@secure-test/schema` (`ESSAY_TEXT_MAX_LENGTH`,
/// `SHORT_TEXT_MAX_LENGTH`, `ESSAY_HTML_MAX_LENGTH`,
/// `RESPONSE_CELL_MAX_LENGTH`) and the drawing limit mirrors the server's `UPLOAD_MAX_BYTES`; the
/// schema package's `bridge-limits` test fails if the two sides drift.
public enum BridgeLimits {
    /// B-7, measured 2026-10-08: the longest essay on record was 8,590
    /// characters and the longest kept revision 23,790.
    public static let essayTextMaxLength = 100_000
    public static let shortTextMaxLength = 2_000
    public static let essayHTMLMaxLength = 200_000
    public static let cellMaxLength = 500
    /// H-3: the server caps a drawing at 20 MB; the host refuses a larger one
    /// before decoding the base64 rather than after.
    public static let drawingMaxBytes = 20 * 1024 * 1024
    /// H-6: one read-aloud request. Above the essay limit so "Read my answer"
    /// works on the longest essay a student can save, with room for the stem.
    public static let speechMaxCharacters = 120_000
    public static let speechMaxSegments = 2_000
}

/// Why the host refused a page payload. The description is what the
/// `[security]` log line carries — ids and sizes, never answer text.
public enum BridgeRefusal: Error, Equatable, CustomStringConvertible, Sendable {
    case unknownItem(String)
    case wrongResponseType(itemID: String, expected: String, got: String)
    case tooLong(field: String, length: Int, max: Int)
    case notPNG
    case tooLarge(bytes: Int, max: Int)

    public var description: String {
        switch self {
        case .unknownItem(let id):
            return "item \(id) is not in this bundle"
        case .wrongResponseType(let id, let expected, let got):
            return "item \(id) expects \(expected), got \(got)"
        case .tooLong(let field, let length, let max):
            return "\(field) is \(length) characters (max \(max))"
        case .notPNG:
            return "drawing is not a base64 PNG"
        case .tooLarge(let bytes, let max):
            return "drawing is \(bytes) bytes (max \(max))"
        }
    }
}

/// H-2: what the page may answer, from the bundle the host fetched itself —
/// each item's id and type, plus every set's inline outline id, which the
/// page posts as an essay (E12) although it is not one of the items.
public struct BridgeItemTable: Equatable, Sendable {
    private let kinds: [String: DeliveryItem.Kind]

    public init(bundle: DeliveryBundle) {
        var kinds: [String: DeliveryItem.Kind] = [:]
        for item in bundle.items { kinds[item.id] = item.kind }
        for set in bundle.itemSets {
            if let inline = set.inlineItemId, !inline.isEmpty, kinds[inline] == nil {
                kinds[inline] = .essay
            }
        }
        self.kinds = kinds
    }

    public func contains(_ itemID: String) -> Bool { kinds[itemID] != nil }

    /// A response message the host may spool, or the reason it may not.
    public func check(_ message: ItemResponseMessage) -> BridgeRefusal? {
        guard let kind = kinds[message.itemID] else { return .unknownItem(message.itemID) }
        let got = message.response.typeName
        guard got == kind.rawValue else {
            return .wrongResponseType(itemID: message.itemID, expected: kind.rawValue, got: got)
        }
        return Self.lengthRefusal(message.response)
    }

    /// A withdrawal or a drawing names an item; it must be one of ours, and a
    /// drawing must name a drawing item.
    public func check(itemID: String, expecting kind: DeliveryItem.Kind? = nil) -> BridgeRefusal? {
        guard let actual = kinds[itemID] else { return .unknownItem(itemID) }
        if let kind, actual != kind {
            return .wrongResponseType(itemID: itemID, expected: actual.rawValue, got: kind.rawValue)
        }
        return nil
    }

    /// B-7 / H-3: the same limits the server's schema applies.
    static func lengthRefusal(_ response: ItemResponse) -> BridgeRefusal? {
        func over(_ field: String, _ text: String, _ max: Int) -> BridgeRefusal? {
            // UTF-16 code units, as zod measures them on the server — a
            // grapheme count would let an emoji-heavy answer past here and
            // into a server refusal.
            let length = text.utf16.count
            return length > max ? .tooLong(field: field, length: length, max: max) : nil
        }
        switch response {
        case .shortText(let text):
            return over("short text", text, BridgeLimits.shortTextMaxLength)
        case .essay(let text, let html):
            if let refusal = over("essay text", text, BridgeLimits.essayTextMaxLength) { return refusal }
            if let html { return over("essay html", html, BridgeLimits.essayHTMLMaxLength) }
            return nil
        case .table(let cells):
            for row in cells.values {
                for value in row.values {
                    if let refusal = over("table cell", value, BridgeLimits.cellMaxLength) { return refusal }
                }
            }
            return nil
        case .fillBlank(let answers):
            for value in answers.values {
                if let refusal = over("blank", value, BridgeLimits.cellMaxLength) { return refusal }
            }
            return nil
        case .multipleChoiceSingle, .multipleChoiceMulti, .match, .order, .hotspot, .drawingUpload:
            return nil
        }
    }
}

/// H-3: the drawing channel's payload, `data:image/png;base64,…`.
public enum DrawingPayload {
    static let prefix = "data:image/png;base64,"
    static let pngSignature: [UInt8] = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]

    /// The PNG bytes, refused BEFORE decoding when the base64 is longer than
    /// the limit allows and after decoding unless the bytes start with the
    /// PNG signature.
    public static func pngBytes(
        fromDataURL dataURL: String,
        maxBytes: Int = BridgeLimits.drawingMaxBytes
    ) -> Result<Data, BridgeRefusal> {
        guard dataURL.hasPrefix(prefix) else { return .failure(.notPNG) }
        let base64 = dataURL.utf8.dropFirst(prefix.utf8.count)
        // 4 base64 characters carry 3 bytes; this bound needs no decode.
        let decodedUpperBound = base64.count / 4 * 3
        guard decodedUpperBound <= maxBytes + 3 else {
            return .failure(.tooLarge(bytes: decodedUpperBound, max: maxBytes))
        }
        guard let data = Data(base64Encoded: String(decoding: base64, as: UTF8.self)) else {
            return .failure(.notPNG)
        }
        guard data.count <= maxBytes else { return .failure(.tooLarge(bytes: data.count, max: maxBytes)) }
        guard data.starts(with: pngSignature) else { return .failure(.notPNG) }
        return .success(data)
    }
}

/// H-5: a Swift string as a JavaScript string literal, for the scripts the
/// host runs in the page. JSON quoting, with U+2028 / U+2029 escaped (they
/// closed a JavaScript string literal before ES2019).
public enum JavaScriptString {
    public static func quoted(_ s: String) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: [s]),
              let array = String(data: data, encoding: .utf8)
        else { return "\"\"" }
        return String(array.dropFirst().dropLast())
            .replacingOccurrences(of: "\u{2028}", with: "\\u2028")
            .replacingOccurrences(of: "\u{2029}", with: "\\u2029")
    }
}
