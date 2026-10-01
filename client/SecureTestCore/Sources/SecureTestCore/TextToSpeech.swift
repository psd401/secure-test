import Foundation

/// Text-to-speech slice 1 (`docs/speech-tools-design.md`, D-1 / D-5): which
/// blocks of the page carry a Speak control, resolved from the bundle's
/// effective accommodations map.
///
/// Two catalog ids feed it:
///
///   - `tts_test_content` — TIDE's "Text-to-Speech (Test Content)". Its values
///     are TIDE's own strings, verbatim (`design-tool/lib/accommodations/
///     tide-catalog.json`): "None (Default)", "Items", "Stimuli",
///     "Stimuli+Items". A teacher can also grant it by hand, and the editors
///     offer TIDE's values where TIDE has any, "On" / "Off" otherwise — so any
///     OTHER enabled value (a hand-typed "On") reads as both, the generous
///     direction for a support the student is entitled to.
///   - `tts_for_ela_reading` — no TIDE value at all, so a teacher's "On"; D-5
///     treats it as stimulus read-aloud, unioned with the above.
///   - `tts_student_responses` (slice 2) — TIDE's "Text-to-Speech (Student
///     Responses)", Off / On: a "Read my answer" control beside each field the
///     student types into. Independent of the two above.
///
/// Off-ish values ("Off", "None (Default)", …) are dropped by the server before
/// the bundle is built (`isEnabledValue` in `effective.ts`); the same check is
/// repeated here, as `PageAccommodations` does, so a row that slipped through
/// cannot switch the tool on.
public struct TextToSpeechScope: Equatable, Sendable {
    /// A Speak control on every question stem.
    public let items: Bool
    /// A Speak control on every stimulus / passage introduction and every
    /// labelled source.
    public let stimuli: Bool
    /// Slice 2: a "Read my answer" control beside every short-text, essay,
    /// outline and table field.
    public let responses: Bool

    static let testContentTool = "tts_test_content"
    static let elaReadingTool = "tts_for_ela_reading"
    static let responsesTool = "tts_student_responses"

    public static let off = TextToSpeechScope(items: false, stimuli: false)

    public init(items: Bool, stimuli: Bool, responses: Bool = false) {
        self.items = items
        self.stimuli = stimuli
        self.responses = responses
    }

    public init(accommodations: [String: String]) {
        var items = false
        var stimuli = false
        if let value = accommodations[Self.testContentTool].flatMap(PageAccommodations.enabledValue) {
            switch value.lowercased() {
            case "items":
                items = true
            case "stimuli":
                stimuli = true
            default:
                // "Stimuli+Items", and any other enabled value.
                items = true
                stimuli = true
            }
        }
        if accommodations[Self.elaReadingTool].flatMap(PageAccommodations.enabledValue) != nil {
            stimuli = true
        }
        let responses = accommodations[Self.responsesTool].flatMap(PageAccommodations.enabledValue) != nil
        self.init(items: items, stimuli: stimuli, responses: responses)
    }

    /// Any read-aloud at all — what the host checks before it speaks.
    public var isEnabled: Bool { items || stimuli || responses }

    /// The constant the renderer reads, emitted beside `BUNDLE` and `OFFLINE`.
    /// A page without it (the test harness, an older host) has no Speak
    /// controls at all.
    public var pageScript: String {
        "const TTS_SCOPE = { items: \(items), stimuli: \(stimuli), responses: \(responses) };"
    }

    /// One line for the host log.
    public var logDescription: String {
        "items=\(items) stimuli=\(stimuli) responses=\(responses)"
    }
}

/// The page's rate control. Three steps around the synthesizer's default
/// (`AVSpeechUtteranceDefaultSpeechRate` is 0.5 on a 0…1 scale); the scale is
/// not linear in words per minute, so the steps are kept modest.
public enum SpeechRate: String, Codable, Equatable, Sendable {
    case slow
    case normal
    case fast

    public var utteranceRate: Float {
        switch self {
        case .slow: return 0.4
        case .normal: return 0.5
        case .fast: return 0.6
        }
    }
}

/// What one Speak press reads, and the way back from the synthesizer's word
/// ranges to the page's own text.
///
/// The page sends the block as SEGMENTS — each of its text nodes verbatim, and
/// each rendered formula as its TeX source — never as HTML. This builds the one
/// string the synthesizer speaks (text as written, a formula as
/// `MathSpeech.words` padded with spaces) and remembers where each segment
/// landed in it, so `willSpeakRangeOfSpeechString` can be mapped back to "this
/// segment, from this offset, this long" for the highlight. Offsets are UTF-16
/// code units on both sides: `NSRange` is, and so is a JavaScript string index.
public struct SpeechScript: Equatable, Sendable {
    public enum Segment: Equatable, Sendable {
        case text(String)
        case math(tex: String)
    }

    /// Where a spoken word is on the page. For a text segment, `offset` /
    /// `length` are inside that segment's text; for a formula both are zero —
    /// the whole formula is the highlight.
    public struct Mark: Equatable, Sendable {
        public let segment: Int
        public let offset: Int
        public let length: Int
    }

    private struct Span: Equatable, Sendable {
        let start: Int
        let length: Int
        let segment: Int
        let isMath: Bool
    }

    /// What the synthesizer is handed.
    public let string: String
    private let spans: [Span]

    public init(segments: [Segment], mathWords: (String) -> String = MathSpeech.words) {
        var out = ""
        var spans: [Span] = []
        for (index, segment) in segments.enumerated() {
            switch segment {
            case .text(let text):
                let start = (out as NSString).length
                out += text
                spans.append(Span(start: start, length: (text as NSString).length, segment: index, isMath: false))
            case .math(let tex):
                // A formula is its own phrase: padded so it never fuses with
                // the word before or after it.
                let words = mathWords(tex)
                out += " "
                let start = (out as NSString).length
                out += words
                spans.append(Span(start: start, length: (words as NSString).length, segment: index, isMath: true))
                out += " "
            }
        }
        self.string = out
        self.spans = spans
    }

    /// True when there is nothing to say (an empty block, or only spaces).
    public var isEmpty: Bool {
        string.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// The segment a spoken range starts in, or nil for a range in the padding
    /// between segments (which a word never is).
    public func mark(for range: NSRange) -> Mark? {
        guard range.location != NSNotFound else { return nil }
        for span in spans where range.location >= span.start && range.location < span.start + span.length {
            if span.isMath { return Mark(segment: span.segment, offset: 0, length: 0) }
            let offset = range.location - span.start
            return Mark(segment: span.segment, offset: offset, length: min(range.length, span.length - offset))
        }
        return nil
    }
}

/// One message on the page's `tts` channel, validated at the boundary the same
/// way `ItemResponseMessage` is: the page is ours, but this is a way into the
/// host, so a payload of the wrong shape is refused rather than trusted.
public enum SpeechCommand: Equatable, Sendable {
    case speak(id: String, segments: [SpeechScript.Segment], rate: SpeechRate)
    case pause
    case resume
    case stop

    public enum DecodeError: Error, Equatable {
        case unknownAction(String)
        case unknownSegmentKind(String)
        case missingField(String)
    }

    private struct Wire: Decodable {
        struct WireSegment: Decodable {
            let kind: String
            let text: String?
            let tex: String?
        }
        let action: String
        let id: String?
        let rate: String?
        let segments: [WireSegment]?
    }

    public static func decode(fromMessageBody body: Any) throws -> SpeechCommand {
        let data = try JSONSerialization.data(withJSONObject: body)
        let wire = try JSONDecoder().decode(Wire.self, from: data)
        switch wire.action {
        case "pause": return .pause
        case "resume": return .resume
        case "stop": return .stop
        case "speak":
            guard let id = wire.id, !id.isEmpty else { throw DecodeError.missingField("id") }
            guard let raw = wire.segments else { throw DecodeError.missingField("segments") }
            let segments: [SpeechScript.Segment] = try raw.map { segment in
                switch segment.kind {
                case "text":
                    guard let text = segment.text else { throw DecodeError.missingField("text") }
                    return .text(text)
                case "math":
                    guard let tex = segment.tex else { throw DecodeError.missingField("tex") }
                    return .math(tex: tex)
                default:
                    throw DecodeError.unknownSegmentKind(segment.kind)
                }
            }
            // An unknown rate is the default rather than a refusal: the rate
            // is a preference, and the read-aloud is the support.
            let rate = wire.rate.flatMap(SpeechRate.init(rawValue:)) ?? .normal
            return .speak(id: id, segments: segments, rate: rate)
        default:
            throw DecodeError.unknownAction(wire.action)
        }
    }
}

/// The host → page half: one statement per synthesizer event, calling the
/// renderer's `window.__secureTestSpeech`. Built here so the id is always
/// JSON-escaped and the shape is pinned by a test, not by the app target.
public enum SpeechCallback {
    public enum Event: String, Sendable {
        case started, paused, resumed, finished, cancelled
    }

    public static func script(_ event: Event, id: String) -> String {
        "window.__secureTestSpeech && window.__secureTestSpeech.\(event.rawValue)(\(quoted(id)));"
    }

    public static func word(id: String, mark: SpeechScript.Mark) -> String {
        "window.__secureTestSpeech && window.__secureTestSpeech.word("
            + "\(quoted(id)), \(mark.segment), \(mark.offset), \(mark.length));"
    }

    private static func quoted(_ id: String) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: [id]),
              let array = String(data: data, encoding: .utf8)
        else { return "\"\"" }
        // `["…"]` → `"…"`.
        return String(array.dropFirst().dropLast())
    }
}
