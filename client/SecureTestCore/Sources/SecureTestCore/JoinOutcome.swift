import Foundation

/// Finding 10.1 (hand-run 2026-08-29): what the entry screen does with the
/// attempt a join returned.
///
/// `POST /api/attempts` hands back the student's ONE attempt at the sitting's
/// assessment whatever its state — a submitted one comes back unmoved
/// (`resumed: true`) and the server then refuses every save with 409. The
/// client used to open it anyway: render, begin a real assessment session,
/// spool answers the server would never take, and say nothing. Only
/// `"submitted"` is treated as handed in; any other status (including one
/// this build does not know) is the server's to police, and opening it keeps
/// today's behaviour.
public enum JoinOutcome: Equatable, Sendable {
    /// Render it: new or resumable.
    case open(attemptID: String)
    /// Stay on the entry screen and say so; there is nothing to answer.
    case alreadyHandedIn(attemptID: String)

    public init(_ started: StartedAttempt) {
        self = started.attempt.status == "submitted"
            ? .alreadyHandedIn(attemptID: started.attempt.id)
            : .open(attemptID: started.attempt.id)
    }

    /// The words the student reads. The list row reads "Done ✓" beside it
    /// once the server resolves Done by assessment (finding 10.2).
    // UX pass 2 slice 6 (P2-6 pilot copy): one attempt per assessment is
    // the shipped rule, so tell the student the next step instead of leaving
    // the sentence to imply retrying might work.
    public static let handedInMessage = "You already handed this test in. Ask your teacher if you need it reopened."
}
