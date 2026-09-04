import Foundation

// Slice 53: the Swift mirror of @secure-test/schema's ItemResponseSchema — what
// a student's answer looks like on the wire, discriminated by the same `type`
// literals as the item it answers.
//
// Nine cases as of E3 slice 3 (eight as of slice 68). `drawing_upload` was absent until the server had
// somewhere to put a file (slice 65): the response references an upload SLOT the
// server minted, never the bytes, which is why it could not exist before the
// attempt did.
public enum ItemResponse: Codable, Equatable, Sendable {
    case multipleChoiceSingle(choiceID: String)
    case multipleChoiceMulti(choiceIDs: [String])
    case shortText(text: String)
    case essay(text: String)
    /// Keys are the item's left ids; values are the id of the right the student
    /// attached to it. A fully correct response maps every id to itself — which
    /// is exactly why the delivery bundle must not ship the pairing.
    case match(matches: [String: String])
    case order(orderedIDs: [String])
    case hotspot(regionIDs: [String])
    /// Slice 68: a reference to an uploaded file, never the bytes.
    case drawingUpload(uploadID: String)
    /// E3 slice 3: the cells the student filled — row id → column id → text.
    /// An all-blank grid is the absence of a response, so the page never
    /// posts an empty map; a present cell may still be "".
    case table(cells: [String: [String: String]])

    private enum CodingKeys: String, CodingKey {
        case type
        case choiceID = "choice_id"
        case choiceIDs = "choice_ids"
        case text
        case matches
        case orderedIDs = "ordered_ids"
        case regionIDs = "region_ids"
        case uploadID = "upload_id"
        case cells
    }

    public var typeName: String {
        switch self {
        case .multipleChoiceSingle: return "multiple_choice_single"
        case .multipleChoiceMulti: return "multiple_choice_multi"
        case .shortText: return "short_text"
        case .essay: return "essay"
        case .match: return "match"
        case .order: return "order"
        case .hotspot: return "hotspot"
        case .drawingUpload: return "drawing_upload"
        case .table: return "table"
        }
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let type = try c.decode(String.self, forKey: .type)
        switch type {
        case "multiple_choice_single":
            self = .multipleChoiceSingle(choiceID: try c.decode(String.self, forKey: .choiceID))
        case "multiple_choice_multi":
            self = .multipleChoiceMulti(choiceIDs: try c.decode([String].self, forKey: .choiceIDs))
        case "short_text":
            self = .shortText(text: try c.decode(String.self, forKey: .text))
        case "essay":
            self = .essay(text: try c.decode(String.self, forKey: .text))
        case "match":
            self = .match(matches: try c.decode([String: String].self, forKey: .matches))
        case "order":
            self = .order(orderedIDs: try c.decode([String].self, forKey: .orderedIDs))
        case "hotspot":
            self = .hotspot(regionIDs: try c.decode([String].self, forKey: .regionIDs))
        case "drawing_upload":
            self = .drawingUpload(uploadID: try c.decode(String.self, forKey: .uploadID))
        case "table":
            self = .table(cells: try c.decode([String: [String: String]].self, forKey: .cells))
        default:
            throw DecodingError.dataCorruptedError(
                forKey: .type,
                in: c,
                debugDescription: "unknown response type \"\(type)\""
            )
        }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(typeName, forKey: .type)
        switch self {
        case .multipleChoiceSingle(let id): try c.encode(id, forKey: .choiceID)
        case .multipleChoiceMulti(let ids): try c.encode(ids, forKey: .choiceIDs)
        case .shortText(let text), .essay(let text): try c.encode(text, forKey: .text)
        case .match(let matches): try c.encode(matches, forKey: .matches)
        case .order(let ids): try c.encode(ids, forKey: .orderedIDs)
        case .hotspot(let ids): try c.encode(ids, forKey: .regionIDs)
        case .drawingUpload(let id): try c.encode(id, forKey: .uploadID)
        case .table(let cells): try c.encode(cells, forKey: .cells)
        }
    }
}

/// One message from the page: which item, and the answer.
public struct ItemResponseMessage: Codable, Equatable, Sendable {
    public let itemID: String
    public let response: ItemResponse

    private enum CodingKeys: String, CodingKey {
        case itemID = "item_id"
        case response
    }

    public init(itemID: String, response: ItemResponse) {
        self.itemID = itemID
        self.response = response
    }

    /// Decodes a `WKScriptMessage.body`, which arrives as a Foundation object
    /// graph rather than JSON. Anything the page can put on the channel goes
    /// through here, so a malformed or unexpected payload is rejected at the
    /// boundary rather than part-way through the host.
    public static func decode(fromMessageBody body: Any) throws -> ItemResponseMessage {
        let data = try JSONSerialization.data(withJSONObject: body)
        return try JSONDecoder().decode(ItemResponseMessage.self, from: data)
    }
}
