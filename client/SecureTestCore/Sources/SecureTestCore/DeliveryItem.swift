import Foundation

// Slice 53: the Swift mirror of @secure-test/schema's DeliveryItemSchema.
//
// PoC-B modelled items as ONE struct with an optional field per type
// (poc-b-test-loop/.../ItemModel.swift). At three types that was merely untidy;
// at eight it would be roughly fifteen optionals with no compiler guarantee that
// a renderer handled the type it was given, and no way to express "a short_text
// item has no choices" other than by convention.
//
// An enum with associated values gives back what the TypeScript side gets from
// its discriminated union: a `switch` with no default is exhaustive, so adding a
// ninth type breaks the build at every place that must learn about it. That is
// the Swift equivalent of the assertNever guard the export and delivery routes
// rely on.
//
// Note what has no representation here: there is no case, and no field on any
// payload, that can hold an answer key. The wire type cannot express one
// (packages/schema/src/delivery.ts), and neither can this.

public struct Choice: Decodable, Equatable, Sendable {
    public let id: String
    public let text: String

    public init(id: String, text: String) {
        self.id = id
        self.text = text
    }
}

public struct SequenceEntry: Decodable, Equatable, Sendable {
    public let id: String
    public let label: String

    public init(id: String, label: String) {
        self.id = id
        self.label = label
    }
}

/// Normalised 0–1 of the image's own box, so the client scales regions with
/// whatever size it renders the image at.
public struct HotspotRegion: Decodable, Equatable, Sendable {
    public let id: String
    public let x: Double
    public let y: Double
    public let w: Double
    public let h: Double
}

public struct DrawingCanvas: Decodable, Equatable, Sendable {
    public let width: Int
    public let height: Int
    /// The paper painted under the student's strokes: `"grid"` or `"axes"`
    /// (docs/drawing-background-design.md). Absent means blank — today's
    /// transparent canvas. Deliberately a plain `String?` rather than an enum:
    /// a value a newer design tool starts sending must not fail the decode and
    /// cost the student the whole test, so the model only carries the string
    /// and the page decides what it means (an unknown value renders blank).
    public let background: String?
}

public struct MultipleChoiceItem: Decodable, Equatable, Sendable {
    public let id: String
    public let stem: String
    public let choices: [Choice]
}

public struct ShortTextItem: Decodable, Equatable, Sendable {
    public let id: String
    public let stem: String
}

public struct EssayItem: Decodable, Equatable, Sendable {
    public let id: String
    public let stem: String
    /// Enforced by the client; the design-tool preview is no-script (ADR 0009)
    /// and cannot demonstrate a live word cap.
    public let maxWordCount: Int?
    public let placeholder: String?
    /// Present only when the teacher marked the rubric visible during the test.
    /// The delivery route drops the rest server-side, so absence here means
    /// "hidden", never "not authored".
    public let rubric: Rubric?
    /// RT slice 3 (docs/rich-text-essay-design.md, D-1): the teacher let
    /// students format this answer. Absent on every essay where it is off, so
    /// it decodes as false.
    public let richText: Bool
    /// U-22 (beta teachers, 2026-10-13): show a running word count with no
    /// maximum. Absent when off, so it decodes as false; a maximum always
    /// shows its count whatever this says.
    public let showWordCount: Bool

    private enum CodingKeys: String, CodingKey {
        case id, stem, placeholder, rubric
        case maxWordCount = "max_word_count"
        case richText = "rich_text"
        case showWordCount = "show_word_count"
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        stem = try c.decode(String.self, forKey: .stem)
        maxWordCount = try c.decodeIfPresent(Int.self, forKey: .maxWordCount)
        placeholder = try c.decodeIfPresent(String.self, forKey: .placeholder)
        rubric = try c.decodeIfPresent(Rubric.self, forKey: .rubric)
        richText = try c.decodeIfPresent(Bool.self, forKey: .richText) ?? false
        showWordCount = try c.decodeIfPresent(Bool.self, forKey: .showWordCount) ?? false
    }
}

/// `lefts` and `rights` arrive as independent arrays — the delivery format has
/// no field pairing one to the other, because the pairing IS the answer.
/// `rights` arrives pre-shuffled by the server.
public struct MatchItem: Decodable, Equatable, Sendable {
    public let id: String
    public let stem: String
    public let lefts: [Choice]
    public let rights: [Choice]
}

/// `entries` arrives pre-shuffled. The authoring format's `sequence` field —
/// which is the answer, being stored in correct order — has no counterpart here.
public struct OrderItem: Decodable, Equatable, Sendable {
    public let id: String
    public let stem: String
    public let entries: [SequenceEntry]
}

public struct HotspotItem: Decodable, Equatable, Sendable {
    public let id: String
    public let stem: String
    /// Absent on a draft hotspot the teacher has not attached an image to.
    public let imageAssetId: String?
    public let regions: [HotspotRegion]

    private enum CodingKeys: String, CodingKey {
        case id, stem, regions
        case imageAssetId = "image_asset_id"
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        stem = try c.decode(String.self, forKey: .stem)
        imageAssetId = try c.decodeIfPresent(String.self, forKey: .imageAssetId)
        // Schema defaults this to [], so it is always emitted — decoded
        // defensively anyway rather than trusting a producer we don't control.
        regions = try c.decodeIfPresent([HotspotRegion].self, forKey: .regions) ?? []
    }
}

public struct DrawingUploadItem: Decodable, Equatable, Sendable {
    public let id: String
    public let stem: String
    public let promptAssetId: String?
    public let canvas: DrawingCanvas?

    private enum CodingKeys: String, CodingKey {
        case id, stem, canvas
        case promptAssetId = "prompt_asset_id"
    }
}

/// E3 slice 3: the grid the student fills in. `columns` heads the grid,
/// `rows` labels the first column (a label may be blank — the renderer hides
/// the label column when every one is), `corner` captions the label column.
/// The authoring format's `cell_keys` — the expected text per cell, which IS
/// the answer — has no counterpart here.
public struct TableColumn: Decodable, Equatable, Sendable {
    public let id: String
    public let label: String

    public init(id: String, label: String) {
        self.id = id
        self.label = label
    }
}

public struct TableRow: Decodable, Equatable, Sendable {
    public let id: String
    public let label: String

    public init(id: String, label: String) {
        self.id = id
        self.label = label
    }
}

public struct TableItem: Decodable, Equatable, Sendable {
    public let id: String
    public let stem: String
    public let columns: [TableColumn]
    public let rows: [TableRow]
    public let corner: String?
}

/// FB slice 5 (docs/fill-in-blank-design.md): one gap in a fill-in-the-blank
/// sentence. The stem carries `[[<id>]]` where it sits. A dropdown carries its
/// options in the teacher's order (D-6); a typed blank carries nothing but its
/// id. The authoring format's `correct_option_id` and `keys` — the answer —
/// have no counterpart here.
public enum FillBlankBlank: Decodable, Equatable, Sendable {
    case dropdown(id: String, options: [Choice])
    case text(id: String)
    /// Slice 4d (D-5): a blank kind this shell does not know. The shell reads
    /// nothing of a blank but its id; the page (the served renderer) decides
    /// how to show it, and its answer is still a string in the item's
    /// `answers` map, so the fill_blank caps still apply.
    case other(id: String, kind: String)

    private enum CodingKeys: String, CodingKey {
        case id, kind, options
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let id = try c.decode(String.self, forKey: .id)
        let kind = try c.decode(String.self, forKey: .kind)
        switch kind {
        case "dropdown":
            self = .dropdown(id: id, options: try c.decode([Choice].self, forKey: .options))
        case "text":
            self = .text(id: id)
        default:
            // Slice 4d: no longer version skew — the served renderer owns
            // blank kinds. Carried opaquely; the item stays a fill_blank.
            self = .other(id: id, kind: kind)
        }
    }

    public var id: String {
        switch self {
        case .dropdown(let id, _), .text(let id), .other(let id, _): return id
        }
    }
}

public struct FillBlankItem: Decodable, Equatable, Sendable {
    public let id: String
    public let stem: String
    public let blanks: [FillBlankBlank]
}

/// Slice 4d (docs/server-delivered-renderer-design.md D-5): an item of a type
/// this shell does not know. The shell needs only its id and type (the bridge
/// checks answers against them); the page receives the bundle verbatim and
/// the served renderer draws it. `stem` is read when it is a string, else "".
public struct OtherItem: Decodable, Equatable, Sendable {
    public let id: String
    public let type: String
    public let stem: String

    private enum CodingKeys: String, CodingKey { case id, type, stem }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        type = try c.decode(String.self, forKey: .type)
        stem = (try? c.decodeIfPresent(String.self, forKey: .stem)) ?? ""
    }
}

public enum DeliveryItem: Decodable, Equatable, Sendable {
    case multipleChoiceSingle(MultipleChoiceItem)
    case multipleChoiceMulti(MultipleChoiceItem)
    case shortText(ShortTextItem)
    case essay(EssayItem)
    case match(MatchItem)
    case order(OrderItem)
    case hotspot(HotspotItem)
    case drawingUpload(DrawingUploadItem)
    case table(TableItem)
    case fillBlank(FillBlankItem)
    /// Slice 4d: a type this shell does not know (D-5).
    case other(OtherItem)

    /// Wire discriminants, matching ITEM_TYPES in the design-tool schema.
    public enum Kind: String, Decodable, CaseIterable, Sendable {
        case multipleChoiceSingle = "multiple_choice_single"
        case multipleChoiceMulti = "multiple_choice_multi"
        case shortText = "short_text"
        case essay
        case match
        case order
        case hotspot
        case drawingUpload = "drawing_upload"
        case table
        case fillBlank = "fill_blank"
    }

    private enum DiscriminatorKey: String, CodingKey {
        case type
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: DiscriminatorKey.self)
        let raw = try container.decode(String.self, forKey: .type)
        guard let kind = Kind(rawValue: raw) else {
            // Slice 4d (D-5): the served renderer owns item types, so a type
            // this shell does not know passes through as `.other` — the page
            // draws it. Which shells may receive a new type is the server's
            // call (lib/items/clientSupport.ts). A KNOWN type still decodes
            // strictly below: malformed structure fails the bundle.
            self = .other(try OtherItem(from: decoder))
            return
        }
        switch kind {
        case .multipleChoiceSingle:
            self = .multipleChoiceSingle(try MultipleChoiceItem(from: decoder))
        case .multipleChoiceMulti:
            self = .multipleChoiceMulti(try MultipleChoiceItem(from: decoder))
        case .shortText:
            self = .shortText(try ShortTextItem(from: decoder))
        case .essay:
            self = .essay(try EssayItem(from: decoder))
        case .match:
            self = .match(try MatchItem(from: decoder))
        case .order:
            self = .order(try OrderItem(from: decoder))
        case .hotspot:
            self = .hotspot(try HotspotItem(from: decoder))
        case .drawingUpload:
            self = .drawingUpload(try DrawingUploadItem(from: decoder))
        case .table:
            self = .table(try TableItem(from: decoder))
        case .fillBlank:
            self = .fillBlank(try FillBlankItem(from: decoder))
        }
    }

    /// Nil for a type this shell does not know; `typeName` always answers.
    public var kind: Kind? {
        switch self {
        case .multipleChoiceSingle: return .multipleChoiceSingle
        case .multipleChoiceMulti: return .multipleChoiceMulti
        case .shortText: return .shortText
        case .essay: return .essay
        case .match: return .match
        case .order: return .order
        case .hotspot: return .hotspot
        case .drawingUpload: return .drawingUpload
        case .table: return .table
        case .fillBlank: return .fillBlank
        case .other: return nil
        }
    }

    /// The wire `type` — a `Kind`'s raw value, or the unknown type's own name.
    public var typeName: String {
        if case .other(let i) = self { return i.type }
        return kind?.rawValue ?? ""
    }

    public var id: String {
        switch self {
        case .multipleChoiceSingle(let i), .multipleChoiceMulti(let i): return i.id
        case .shortText(let i): return i.id
        case .essay(let i): return i.id
        case .match(let i): return i.id
        case .order(let i): return i.id
        case .hotspot(let i): return i.id
        case .drawingUpload(let i): return i.id
        case .table(let i): return i.id
        case .fillBlank(let i): return i.id
        case .other(let i): return i.id
        }
    }

    public var stem: String {
        switch self {
        case .multipleChoiceSingle(let i), .multipleChoiceMulti(let i): return i.stem
        case .shortText(let i): return i.stem
        case .essay(let i): return i.stem
        case .match(let i): return i.stem
        case .order(let i): return i.stem
        case .hotspot(let i): return i.stem
        case .drawingUpload(let i): return i.stem
        case .table(let i): return i.stem
        case .fillBlank(let i): return i.stem
        case .other(let i): return i.stem
        }
    }
}
