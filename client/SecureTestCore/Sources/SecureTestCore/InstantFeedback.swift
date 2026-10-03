import Foundation

/// Instant feedback at hand-in (`docs/instant-feedback-design.md`, roadmap row
/// IF, slice 3): the optional `feedback` object the submit route returns after
/// the student's OWN hand-in, when the teacher turned it on.
///
/// Decoding is deliberately forgiving in one direction only: anything this
/// build cannot read with certainty becomes "no feedback" (or "no such row"),
/// never a failed hand-in and never a claim it cannot word. The hand-in has
/// already succeeded by the time this is read; the feedback is a courtesy on
/// top of it.
///
/// - An unknown `level`, or a missing / non-numeric `earned`, `max_auto` or
///   `pending_count` → nil (the whole object is dropped; the student goes
///   straight to Your tests, exactly as before slice 3).
/// - An item with an unknown `result`, or without a usable `number` → that
///   row is dropped. A future server's new result word ("excused", say) must
///   not be shown as "Scored by your teacher", which would be a claim this
///   build cannot back. The score line is the server's own total and is
///   unaffected.
public struct InstantFeedback: Equatable, Sendable {
    public enum Level: String, Equatable, Sendable {
        case score
        case rightWrong = "right_wrong"
        case answers
    }

    public enum Result: String, Equatable, Sendable {
        case correct
        case partial
        case incorrect
        case pending
    }

    public struct Item: Equatable, Sendable {
        public let itemID: String
        public let number: Int
        public let result: Result
        /// Null on a pending item.
        public let earned: Double?
        public let max: Double?
        /// Plain text, lines joined by `\n`; nil = not answered.
        public let yourAnswer: String?
        /// Only on a missed item, only at `answers`, only once answers may show.
        public let correctAnswer: String?

        public init(
            itemID: String,
            number: Int,
            result: Result,
            earned: Double?,
            max: Double?,
            yourAnswer: String?,
            correctAnswer: String?
        ) {
            self.itemID = itemID
            self.number = number
            self.result = result
            self.earned = earned
            self.max = max
            self.yourAnswer = yourAnswer
            self.correctAnswer = correctAnswer
        }
    }

    public let level: Level
    public let earned: Double
    public let maxAuto: Double
    public let pendingCount: Int
    /// Absent at `score`; present at `right_wrong` / `answers`.
    public let items: [Item]?
    /// D-4: "Your teacher will go over the correct answers." at `answers`
    /// before the teacher's release.
    public let answersNote: String?

    public init(
        level: Level,
        earned: Double,
        maxAuto: Double,
        pendingCount: Int,
        items: [Item]?,
        answersNote: String?
    ) {
        self.level = level
        self.earned = earned
        self.maxAuto = maxAuto
        self.pendingCount = pendingCount
        self.items = items
        self.answersNote = answersNote
    }

    /// Reads the `feedback` value out of a parsed submit response body. Any
    /// surprise → nil, per the rules in the type doc.
    public init?(json value: Any?) {
        guard let object = value as? [String: Any],
              let levelRaw = object["level"] as? String,
              let level = Level(rawValue: levelRaw),
              let earned = Self.number(object["earned"]),
              let maxAuto = Self.number(object["max_auto"]),
              let pending = Self.number(object["pending_count"])
        else { return nil }
        self.level = level
        self.earned = earned
        self.maxAuto = maxAuto
        self.pendingCount = max(0, Int(pending))
        if let raw = object["items"] as? [Any] {
            self.items = raw.compactMap(Self.item)
        } else {
            self.items = nil
        }
        self.answersNote = Self.text(object["answers_note"])
    }

    /// The submit response body → its feedback, or nil. Never throws: a body
    /// that is not JSON at all (an older server answering `{ ok: true }` is
    /// fine JSON; an empty body is not) is simply "no feedback".
    public static func fromSubmitResponse(_ data: Data) -> InstantFeedback? {
        guard let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return nil
        }
        return InstantFeedback(json: root["feedback"])
    }

    private static func item(_ value: Any) -> Item? {
        guard let object = value as? [String: Any],
              let resultRaw = object["result"] as? String,
              let result = Result(rawValue: resultRaw),
              let number = number(object["number"]), number >= 1
        else { return nil }
        let isPending = result == .pending
        return Item(
            itemID: (object["item_id"] as? String) ?? "",
            number: Int(number),
            result: result,
            // A pending row never shows points, whatever the wire says.
            earned: isPending ? nil : Self.number(object["earned"]),
            max: isPending ? nil : Self.number(object["max"]),
            yourAnswer: text(object["your_answer"]),
            correctAnswer: isPending ? nil : text(object["correct_answer"])
        )
    }

    /// A JSON number (never a Bool, which `NSNumber` would also satisfy).
    private static func number(_ value: Any?) -> Double? {
        guard let n = value as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID() else { return nil }
        let d = n.doubleValue
        return d.isFinite ? d : nil
    }

    private static func text(_ value: Any?) -> String? {
        value as? String
    }
}

/// What the feedback page says, in order — pure, so every sentence the student
/// reads is pinned by a test rather than by a hand-run.
public struct InstantFeedbackPresentation: Equatable, Sendable {
    public struct Row: Equatable, Sendable {
        public let number: Int
        /// "Question 3 — Partly right (1 of 2)".
        public let heading: String
        /// The result word alone ("Right", "Partly right", …) — what the
        /// row's class / marker hangs off.
        public let result: InstantFeedback.Result
        /// The student's answer text, or nil → "(no answer)".
        public let yourAnswer: String?
        /// Only when the server sent one.
        public let correctAnswer: String?
    }

    public static let heading = "Your results"
    public static let noAnswer = "(no answer)"
    public static let yourAnswerLabel = "Your answer:"
    public static let correctAnswerLabel = "Correct answer:"
    public static let doneTitle = "Done"

    /// "You scored 14 of 18 on the questions scored right away." — nil when
    /// nothing on the test is scored right away (then only the pending line
    /// speaks).
    public let scoreLine: String
    /// "Your teacher will score 2 more questions." — nil when nothing is
    /// pending.
    public let pendingLine: String?
    public let answersNote: String?
    /// Empty at `score`.
    public let rows: [Row]

    public init(_ feedback: InstantFeedback) {
        let nothingAuto = feedback.maxAuto <= 0 && feedback.earned <= 0
        if nothingAuto {
            scoreLine = "None of the questions on this test are scored right away."
        } else {
            scoreLine = "You scored \(Self.points(feedback.earned)) of \(Self.points(feedback.maxAuto)) on the questions scored right away."
        }
        let n = feedback.pendingCount
        if n <= 0 {
            pendingLine = nil
        } else if nothingAuto {
            pendingLine = n == 1
                ? "Your teacher will score the question."
                : "Your teacher will score all \(n) questions."
        } else {
            pendingLine = n == 1
                ? "Your teacher will score 1 more question."
                : "Your teacher will score \(n) more questions."
        }
        answersNote = feedback.answersNote.flatMap { $0.isEmpty ? nil : $0 }
        rows = (feedback.items ?? [])
            .sorted { $0.number < $1.number }
            .map { item in
                Row(
                    number: item.number,
                    heading: "Question \(item.number) — \(Self.resultLabel(item))",
                    result: item.result,
                    yourAnswer: item.yourAnswer.flatMap { $0.isEmpty ? nil : $0 },
                    correctAnswer: item.correctAnswer.flatMap { $0.isEmpty ? nil : $0 }
                )
            }
    }

    /// "Right" / "Partly right (1 of 2)" / "Not right" / "Scored by your
    /// teacher". The points ride only on a partial: right and not right are
    /// complete statements, and a partial without them says nothing useful.
    public static func resultLabel(_ item: InstantFeedback.Item) -> String {
        switch item.result {
        case .correct: return "Right"
        case .incorrect: return "Not right"
        case .pending: return "Scored by your teacher"
        case .partial:
            if let earned = item.earned, let max = item.max {
                return "Partly right (\(points(earned)) of \(points(max)))"
            }
            return "Partly right"
        }
    }

    /// 14 → "14", 1.5 → "1.5", 0.333… → "0.33". Points are whole numbers on
    /// almost every item; partial credit can make halves and thirds.
    public static func points(_ value: Double) -> String {
        if value == value.rounded() { return String(Int(value)) }
        var text = String(format: "%.2f", value)
        while text.hasSuffix("0") { text.removeLast() }
        if text.hasSuffix(".") { text.removeLast() }
        return text
    }
}
