import Foundation

struct Choice: Codable {
    let id: String
    let text: String
}

// Three wire-format item types. The `type` field is optional in the JSON
// for backwards compatibility with pre-slice-8 fixtures (which omit it and
// are implicitly multiple_choice_single). New fixtures should set it
// explicitly. See @secure-test/schema for the source-of-truth Zod schema.
enum ItemType: String, Codable {
    case multipleChoiceSingle = "multiple_choice_single"
    case multipleChoiceMulti = "multiple_choice_multi"
    case shortText = "short_text"
}

struct Item: Codable {
    let id: String
    let type: ItemType
    let stem: String
    let choices: [Choice]
    let correctChoiceId: String?
    let correctChoiceIds: [String]?
    let correctAnswer: String?

    enum CodingKeys: String, CodingKey {
        case id, type, stem, choices
        case correctChoiceId = "correct_choice_id"
        case correctChoiceIds = "correct_choice_ids"
        case correctAnswer = "correct_answer"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.id = try c.decode(String.self, forKey: .id)
        self.type = try c.decodeIfPresent(ItemType.self, forKey: .type) ?? .multipleChoiceSingle
        self.stem = try c.decode(String.self, forKey: .stem)
        self.choices = try c.decodeIfPresent([Choice].self, forKey: .choices) ?? []
        self.correctChoiceId = try c.decodeIfPresent(String.self, forKey: .correctChoiceId)
        self.correctChoiceIds = try c.decodeIfPresent([String].self, forKey: .correctChoiceIds)
        self.correctAnswer = try c.decodeIfPresent(String.self, forKey: .correctAnswer)
    }
}

// Slice 15: bundles MAY ship binary asset blobs alongside the items so
// stems with `![alt](asset:<uuid>)` refs render in offline / PoC-B
// consumers that can't dereference asset: through an HTTP session. The
// shape mirrors @secure-test/schema's BundleAssetSchema — key is the
// uuid as a lowercase string, value carries the content_type plus the
// base64-encoded bytes (no `data:` prefix).
struct BundleAsset: Codable {
    let contentType: String
    let base64: String

    enum CodingKeys: String, CodingKey {
        case contentType = "content_type"
        case base64
    }
}

struct ItemBundle: Codable {
    let testId: String
    let title: String
    let items: [Item]
    let assets: [String: BundleAsset]?

    enum CodingKeys: String, CodingKey {
        case testId = "test_id"
        case title, items, assets
    }
}

// Response carries a student's answer for one item. The on-wire shape is
// type-discriminated by `item_type` (slice 9, matching the slice-8
// schema): single-select MC posts `choice_id`; multi-select MC posts
// `choice_ids` (array); short-text posts `answer` (string). Only the
// field matching the item's type is non-nil for a given response. The
// stub Lambda at infra/lambda/response-intake.ts logs whatever shape it
// receives and dispatches structured output based on item_type.
struct Response: Codable {
    let testId: String
    let itemId: String
    let itemType: ItemType
    let choiceId: String?
    let choiceIds: [String]?
    let answer: String?
    let answeredAt: Date

    enum CodingKeys: String, CodingKey {
        case testId = "test_id"
        case itemId = "item_id"
        case itemType = "item_type"
        case choiceId = "choice_id"
        case choiceIds = "choice_ids"
        case answer
        case answeredAt = "answered_at"
    }

    // Convenience constructors so callers don't have to spell out every nil.
    static func singleChoice(testId: String, itemId: String, choiceId: String, at date: Date = Date()) -> Response {
        Response(testId: testId, itemId: itemId, itemType: .multipleChoiceSingle,
                 choiceId: choiceId, choiceIds: nil, answer: nil, answeredAt: date)
    }

    static func multipleChoices(testId: String, itemId: String, choiceIds: [String], at date: Date = Date()) -> Response {
        Response(testId: testId, itemId: itemId, itemType: .multipleChoiceMulti,
                 choiceId: nil, choiceIds: choiceIds, answer: nil, answeredAt: date)
    }

    static func text(testId: String, itemId: String, answer: String, at date: Date = Date()) -> Response {
        Response(testId: testId, itemId: itemId, itemType: .shortText,
                 choiceId: nil, choiceIds: nil, answer: answer, answeredAt: date)
    }
}

enum ItemLoader {
    static func loadBundledItems() -> ItemBundle? {
        guard let url = Bundle.module.url(forResource: "items", withExtension: "json"),
              let data = try? Data(contentsOf: url) else {
            return nil
        }
        let decoder = JSONDecoder()
        return try? decoder.decode(ItemBundle.self, from: data)
    }
}
