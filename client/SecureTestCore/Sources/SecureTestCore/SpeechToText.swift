import Foundation

/// Speech-to-text slice 3 (`docs/speech-tools-design.md`, D-2 = B, D-3): the
/// decisions behind the page's "Speak my answer" control — who gets it, what
/// the pre-flight's result means, how the recognizer's results become text in
/// a field, and when listening stops on its own. The app target owns only the
/// microphone and the `SpeechAnalyzer`; everything here runs under
/// `swift test`.
///
/// The constraint that shapes all of it is PoC-A RESULTS finding #16: a first
/// microphone request made INSIDE an `AEAssessmentSession` is hidden behind
/// the lockout and hangs. So permission, recognition authorization and the
/// transcriber's assets are all settled after the bundle arrives and BEFORE
/// `begin()` — only for a student the bundle grants `speech_to_text` — and
/// inside the session the engine runs only if all of that came back ready.
public enum SpeechToText {
    static let tool = "speech_to_text"

    /// The bundle grants it: `speech_to_text` present with an enabled value
    /// (TIDE's Off / On; the same off-value rule as every other tool).
    /// `speech_to_text_language` is not read — Spanish is held (D-6).
    public static func isGranted(_ accommodations: [String: String]) -> Bool {
        accommodations[tool].flatMap(PageAccommodations.enabledValue) != nil
    }

    /// The pre-flight's whole budget, asset download included. Past it the
    /// test starts without speech-to-text rather than waiting.
    public static let preflightBudget: TimeInterval = 20
    /// Listening stops on its own after this long, however much is heard.
    public static let maxListen: TimeInterval = 60
    /// … and after this long with nothing heard.
    public static let silenceLimit: TimeInterval = 10
}

/// What the page is told, as the `STT_STATE` constant beside `TTS_SCOPE`.
public enum SpeechToTextAvailability: String, Equatable, Sendable {
    /// Not granted: no control, no notice, and no prompt was ever shown.
    case off
    /// Granted and everything settled before lockdown: the control is drawn.
    case ready
    /// Granted, but the pre-flight could not finish (denied, no transcriber,
    /// no assets, an error, out of time): no control, and a notice telling the
    /// student to tell their teacher.
    case unavailable

    public var pageScript: String { "const STT_STATE = '\(rawValue)';" }
}

/// The pre-flight, as the app saw it. Each field is what the corresponding
/// system call answered (or nil when it never got that far).
public struct SpeechToTextPreflight: Equatable, Sendable {
    public enum Authorization: String, Equatable, Sendable {
        case authorized, denied, restricted, notDetermined
    }

    public var microphone: Authorization?
    public var recognition: Authorization?
    /// `SpeechTranscriber.isAvailable` and en-US in its supported locales.
    public var transcriberAvailable: Bool?
    /// The transcriber's assets are on this Mac (installed now or already).
    public var assetsInstalled: Bool?
    /// The budget ran out before the steps above finished.
    public var timedOut: Bool
    /// A thrown error, as a short token for the log (never content).
    public var failure: String?

    public init(
        microphone: Authorization? = nil,
        recognition: Authorization? = nil,
        transcriberAvailable: Bool? = nil,
        assetsInstalled: Bool? = nil,
        timedOut: Bool = false,
        failure: String? = nil
    ) {
        self.microphone = microphone
        self.recognition = recognition
        self.transcriberAvailable = transcriberAvailable
        self.assetsInstalled = assetsInstalled
        self.timedOut = timedOut
        self.failure = failure
    }

    /// Ready only when every step answered yes and nothing went wrong.
    /// Anything else — including a step that never answered — is unavailable:
    /// the engine must never be started inside a session on a guess.
    public var availability: SpeechToTextAvailability {
        guard !timedOut, failure == nil,
              microphone == .authorized, recognition == .authorized,
              transcriberAvailable == true, assetsInstalled == true
        else { return .unavailable }
        return .ready
    }

    /// One auditable line for the host log.
    public var logDescription: String {
        "mic=\(microphone?.rawValue ?? "-") recognition=\(recognition?.rawValue ?? "-")"
            + " transcriber=\(transcriberAvailable.map { "\($0)" } ?? "-")"
            + " assets=\(assetsInstalled.map { "\($0)" } ?? "-")"
            + (timedOut ? " TIMED OUT" : "")
            + (failure.map { " error=\($0)" } ?? "")
            + " → \(availability.rawValue)"
    }
}

/// The recognizer's results, turned into what the page shows and inserts.
///
/// `SpeechTranscriber` with `.volatileResults` reports a phrase several times
/// as it firms up (volatile), then once more as final. Volatile text is only
/// ever SHOWN ("Hearing: …"); final text is inserted, once, and the volatile
/// line clears.
public struct DictationTranscript: Equatable, Sendable {
    public enum Event: Equatable, Sendable {
        case hearing(String)
        case insert(String)
    }

    /// Text before the caret when listening started, extended by every
    /// insertion since — what the next insertion's spacing is decided against.
    public private(set) var before: String
    /// The character after the caret (or empty), for a trailing space.
    public let after: String
    /// A single-line field: newlines become spaces.
    public let singleLine: Bool

    public init(before: String, after: String, singleLine: Bool) {
        self.before = before
        self.after = after
        self.singleLine = singleLine
    }

    public mutating func apply(text: String, isFinal: Bool) -> Event? {
        var cleaned = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if singleLine {
            cleaned = cleaned.components(separatedBy: .newlines).joined(separator: " ")
        }
        guard isFinal else { return .hearing(cleaned) }
        guard !cleaned.isEmpty else { return .hearing("") }
        let insertion = Self.insertion(cleaned, before: before, after: after)
        before += insertion
        return .insert(insertion)
    }

    /// The string to put at the caret for one final phrase:
    ///
    /// - a leading space when the text before ends in a word or punctuation
    ///   and the phrase does not itself start with punctuation;
    /// - a capital first letter when the phrase starts a sentence (nothing
    ///   before, or the text before ends in `.` `!` `?` or a newline); mid
    ///   sentence the recognizer's own case is kept — it capitalizes proper
    ///   nouns and "I", and lower-casing would undo that;
    /// - a trailing space when a word follows the caret.
    public static func insertion(_ phrase: String, before: String, after: String) -> String {
        guard !phrase.isEmpty else { return "" }
        var out = phrase
        let trimmedBefore = before.trimmingCharacters(in: .whitespaces)
        let startsSentence = trimmedBefore.isEmpty
            || trimmedBefore.last.map { ".!?\n".contains($0) } == true
            || before.hasSuffix("\n")
        if startsSentence, let first = out.first, first.isLowercase {
            out = first.uppercased() + out.dropFirst()
        }
        if let last = before.last, !last.isWhitespace, !"([{\"'“‘".contains(last),
           let first = out.first, !",.;:!?)]}".contains(first) {
            out = " " + out
        }
        if let next = after.first, next.isLetter || next.isNumber {
            out += " "
        }
        return out
    }
}

/// When listening stops without the student pressing anything.
public enum DictationTimeout: Equatable, Sendable {
    case maxListen
    case silence

    /// `startedAt` is when the microphone opened; `lastHeardAt` the last
    /// result of any kind (or nil when nothing has been heard yet — the
    /// silence clock then runs from the start).
    public static func check(startedAt: Date, lastHeardAt: Date?, now: Date) -> DictationTimeout? {
        if now.timeIntervalSince(startedAt) >= SpeechToText.maxListen { return .maxListen }
        if now.timeIntervalSince(lastHeardAt ?? startedAt) >= SpeechToText.silenceLimit { return .silence }
        return nil
    }
}

/// One message on the page's `stt` channel, validated at the boundary.
public enum DictationCommand: Equatable, Sendable {
    /// `before` is the text before the caret (the page sends at most the last
    /// few characters — spacing needs no more), `after` the next character.
    case listen(id: String, before: String, after: String, singleLine: Bool)
    case stop

    public enum DecodeError: Error, Equatable {
        case unknownAction(String)
        case missingField(String)
    }

    private struct Wire: Decodable {
        let action: String
        let id: String?
        let before: String?
        let after: String?
        let singleLine: Bool?

        enum CodingKeys: String, CodingKey {
            case action, id, before, after
            case singleLine = "single_line"
        }
    }

    public static func decode(fromMessageBody body: Any) throws -> DictationCommand {
        let data = try JSONSerialization.data(withJSONObject: body)
        let wire = try JSONDecoder().decode(Wire.self, from: data)
        switch wire.action {
        case "stop":
            return .stop
        case "listen":
            guard let id = wire.id, !id.isEmpty else { throw DecodeError.missingField("id") }
            return .listen(
                id: id,
                before: String((wire.before ?? "").suffix(16)),
                after: String((wire.after ?? "").prefix(1)),
                singleLine: wire.singleLine ?? false)
        default:
            throw DecodeError.unknownAction(wire.action)
        }
    }
}

/// Host → page, through the renderer's `window.__secureTestDictation`.
public enum DictationCallback {
    public static func started(id: String) -> String { call("started", id) }

    public static func hearing(id: String, text: String) -> String { call("hearing", id, text) }

    public static func insert(id: String, text: String) -> String { call("insert", id, text) }

    /// `reason` is a short token: "pressed", "max", "silence", "error", …
    public static func stopped(id: String, reason: String) -> String { call("stopped", id, reason) }

    private static func call(_ name: String, _ args: String...) -> String {
        let quoted = args.map(quote).joined(separator: ", ")
        return "window.__secureTestDictation && window.__secureTestDictation.\(name)(\(quoted));"
    }

    private static func quote(_ s: String) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: [s]),
              let array = String(data: data, encoding: .utf8)
        else { return "\"\"" }
        // `["…"]` → `"…"`. U+2028 / U+2029 are legal in JSON but closed a
        // JavaScript string literal before ES2019; escaped regardless.
        return String(array.dropFirst().dropLast())
            .replacingOccurrences(of: "\u{2028}", with: "\\u2028")
            .replacingOccurrences(of: "\u{2029}", with: "\\u2029")
    }
}
