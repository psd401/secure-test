import Foundation

/// The student's peek notice, as state (hand-run finding 8.1, 2026-08-28).
///
/// The design's contract (docs/on-demand-peek-design.md, "Student
/// notification" + decision 6.6) is that every peek is visibly disclosed:
/// "Your teacher is viewing your screen" at request time, "viewed at H:MM"
/// once the frame has gone. As first built the second form was pinned for
/// the rest of the attempt; 8.1 lets the student close it. The rule this
/// type holds is the whole of the follow-up: `show` ALWAYS shows — a
/// dismissal never outlives the next peek, so each one is disclosed afresh —
/// and `dismiss` hides only what is currently on screen.
///
/// The AppKit strip (`AssessmentViewController`) mirrors this value; the
/// wording stays with the app, which owns the clock the time comes from.
public struct PeekNotice: Equatable, Sendable {
    /// What the strip reads, or nil while nothing is shown.
    public private(set) var text: String?

    public init() {}

    public var isShown: Bool { text != nil }

    /// A peek (or the "viewed at" flip of one) happened: show it, whether or
    /// not the student closed an earlier notice.
    public mutating func show(_ text: String) {
        self.text = text
    }

    /// The student's close control. Idempotent; a later `show` reopens.
    public mutating func dismiss() {
        text = nil
    }
}
