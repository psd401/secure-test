import Foundation

/// Mirrors @secure-test/schema's RubricSchema. Only reaches the client for
/// essay items the teacher marked visible during the test.
public struct Rubric: Decodable, Equatable, Sendable {
    public enum Style: String, Decodable, Sendable {
        case analytic
        case holistic
        case singlePoint = "single_point"
    }

    public struct Level: Decodable, Equatable, Sendable {
        public let id: String
        public let label: String
        public let points: Double
        public let descriptor: String?
    }

    public struct Criterion: Decodable, Equatable, Sendable {
        public let id: String
        public let name: String
        public let levels: [Level]
    }

    public struct Visibility: Decodable, Equatable, Sendable {
        public let duringTest: Bool?
        public let withFeedback: Bool?

        private enum CodingKeys: String, CodingKey {
            case duringTest = "during_test"
            case withFeedback = "with_feedback"
        }
    }

    public let style: Style
    public let criteria: [Criterion]
    public let studentVisibility: Visibility?

    private enum CodingKeys: String, CodingKey {
        case style, criteria
        case studentVisibility = "student_visibility"
    }
}

/// A binary blob carried inline so the client renders `asset:<uuid>` refs with
/// no network of its own — which is the whole point, since the page's CSP
/// forbids it from making a request at all.
public struct BundleAsset: Decodable, Equatable, Sendable {
    public let contentType: String
    public let base64: String

    private enum CodingKeys: String, CodingKey {
        case contentType = "content_type"
        case base64
    }

    /// Ready to drop into an `img.src`.
    public var dataURI: String {
        "data:\(contentType);base64,\(base64)"
    }
}

/// E5 slice 2: a stimulus — a passage, a figure, a data table — shared by the
/// contiguous items whose ids it lists. Mirrors @secure-test/schema's
/// ItemSetSchema. `stimulus` follows stem content rules (text with
/// `![alt](asset:uuid)` refs), so the page renders it through the same path.
public struct ItemSet: Decodable, Equatable, Sendable {
    /// `inline`: rendered once above its questions. `own_page`: the same on
    /// this one-scrolling-page client (James, 2026-09-01: one page is the MVP
    /// shape; per-question paging is on the roadmap) — the value survives so
    /// a paged client can honour it later.
    public enum Layout: String, Decodable, Sendable {
        case inline
        case ownPage = "own_page"
    }

    public let id: String
    public let stimulus: String
    public let layout: Layout
    public let itemIds: [String]
    /// E12 slice 3: a stimulus that should be this student's own earlier
    /// answer. `inlineItemId` is where the page posts the outline the
    /// student writes in place (the source question's id — an identifier,
    /// nothing else from that assessment rides); `inlineText` is what they
    /// have written there so far; `sourceMissing` says nothing exists yet.
    public let sourceMissing: Bool
    public let inlineItemId: String?
    public let inlineText: String?

    private enum CodingKeys: String, CodingKey {
        case id, stimulus, layout
        case itemIds = "item_ids"
        case sourceMissing = "source_missing"
        case inlineItemId = "inline_item_id"
        case inlineText = "inline_text"
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        stimulus = try c.decode(String.self, forKey: .stimulus)
        // A layout this client has not heard of renders inline rather than
        // failing the whole bundle — the stimulus still reaches the student.
        layout = Layout(rawValue: try c.decodeIfPresent(String.self, forKey: .layout) ?? "inline")
            ?? .inline
        itemIds = try c.decode([String].self, forKey: .itemIds)
        sourceMissing = try c.decodeIfPresent(Bool.self, forKey: .sourceMissing) ?? false
        inlineItemId = try c.decodeIfPresent(String.self, forKey: .inlineItemId)
        inlineText = try c.decodeIfPresent(String.self, forKey: .inlineText)
    }
}

/// The student-facing bundle — @secure-test/schema's DeliveryBundleSchema.
///
/// Deliberately NOT the same type as the teacher's ItemBundle: that one carries
/// the answer keys, because teacher-to-teacher share round-trips through the
/// import route and needs them. Nothing in this type can hold one.
public struct DeliveryBundle: Decodable, Equatable, Sendable {
    /// Client paging (docs/client-paging-design.md): how the student moves
    /// through the test. Absent — every bundle before the field — and any
    /// value this client has not heard of both read as `scroll`, the one
    /// page the client has always shown; only an explicit "paged" pages.
    public enum Layout: String, Decodable, Sendable {
        case scroll
        case paged
    }

    public let testId: String
    public let title: String
    public let items: [DeliveryItem]
    /// Keyed by the same lowercase uuid used in `asset:<uuid>` refs.
    public let assets: [String: BundleAsset]
    /// Slice 62: the EFFECTIVE accommodations for the student this bundle was
    /// built for — tool id → setting value — resolved server-side from the
    /// assessment's allowed list, the student's TIDE entitlements and any
    /// per-assessment override.
    ///
    /// A map rather than a set because the value carries the meaning: knowing
    /// `color_contrast` is on does not say whether to render Black on Rose or
    /// Black on White, and `optional_font` is useless without the font name.
    public let accommodations: [String: String]
    /// The subset of `accommodations` the assessment marks construct-altering.
    public let constructAltering: [String]
    /// Slice 69: may the student cut, copy or paste during this assessment?
    ///
    /// Defaults to FALSE when the field is absent. That direction is
    /// deliberate: a secure-testing browser that opens the clipboard because a
    /// bundle said nothing has its default backwards, and an older server that
    /// does not send the field must not accidentally unlock it.
    public let allowClipboard: Bool
    /// E5 slice 2: stimuli and which items share them. Empty when the server
    /// sent none (or predates the field).
    public let itemSets: [ItemSet]
    /// Client paging: `scroll` unless the bundle says "paged".
    public let layout: Layout
    /// Client paging follow-up: the questions this attempt has already
    /// answered, so the page can mark them honestly after a relaunch.
    /// Empty when the server sent none (a fresh attempt, or an older server).
    public let answeredItemIds: [String]
    /// P-1 (docs/resume-prefill-design.md): the answers behind those marks —
    /// THIS attempt's own saved responses, keyed by item id, so a student who
    /// relaunches finds the fields under the marks filled rather than blank.
    ///
    /// The values are `ItemResponse`, the same union the page POSTS, which is
    /// the point of reusing it: the field can hold nothing but a student's own
    /// answer, so it cannot become a second route for an answer key. Match and
    /// order values carry the SAME per-attempt sealed ids the item's own
    /// `lefts` / `rights` / `entries` carry, so the page can match them to what
    /// it shows. Empty when the server sent none (a fresh attempt, the offline
    /// bundle, or an older server).
    public let savedResponses: [String: ItemResponse]
    /// The drawing bytes those responses name, keyed by upload id — the same
    /// blob shape as `assets`, inlined for the same reason (the page cannot
    /// reach the network at all, so a second fetch is not available to it).
    ///
    /// Only a complete, PNG-or-JPEG, at-most-2 MB upload rides along (D-5);
    /// past that the response is still listed and the field says saved without
    /// the picture. Empty when the server sent none.
    public let savedUploads: [String: BundleAsset]

    private enum CodingKeys: String, CodingKey {
        case title, items, assets, accommodations, layout
        case testId = "test_id"
        case answeredItemIds = "answered_item_ids"
        case constructAltering = "construct_altering"
        case allowClipboard = "allow_clipboard"
        case itemSets = "item_sets"
        case savedResponses = "saved_responses"
        case savedUploads = "saved_uploads"
    }

    /// Convenience for the common "is this tool on" question.
    public func accommodation(_ toolID: String) -> String? {
        accommodations[toolID]
    }

    public func hasAccommodation(_ toolID: String) -> Bool {
        accommodations[toolID] != nil
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        testId = try c.decode(String.self, forKey: .testId)
        title = try c.decode(String.self, forKey: .title)
        items = try c.decode([DeliveryItem].self, forKey: .items)
        // The route omits these keys entirely when they would be empty, so
        // older/simpler bundles stay byte-stable. Normalised to empty here so
        // callers never branch on nil-vs-empty.
        assets = try c.decodeIfPresent([String: BundleAsset].self, forKey: .assets) ?? [:]
        accommodations =
            try c.decodeIfPresent([String: String].self, forKey: .accommodations) ?? [:]
        constructAltering =
            try c.decodeIfPresent([String].self, forKey: .constructAltering) ?? []
        allowClipboard = try c.decodeIfPresent(Bool.self, forKey: .allowClipboard) ?? false
        itemSets = try c.decodeIfPresent([ItemSet].self, forKey: .itemSets) ?? []
        layout = Layout(rawValue: try c.decodeIfPresent(String.self, forKey: .layout) ?? "scroll")
            ?? .scroll
        answeredItemIds = try c.decodeIfPresent([String].self, forKey: .answeredItemIds) ?? []
        savedResponses =
            try c.decodeIfPresent([String: ItemResponse].self, forKey: .savedResponses) ?? [:]
        savedUploads =
            try c.decodeIfPresent([String: BundleAsset].self, forKey: .savedUploads) ?? [:]
    }

    public static func decode(from data: Data) throws -> DeliveryBundle {
        try JSONDecoder().decode(DeliveryBundle.self, from: data)
    }
}
