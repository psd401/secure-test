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
    /// `earlierSittingID` is non-nil only when the submitted attempt belongs
    /// to a DIFFERENT sitting than the one being joined (finding H-1,
    /// 2026-09-17) — a student who handed the assessment in during an
    /// earlier session sees a different message when they try to join a new
    /// one for the same assessment.
    case alreadyHandedIn(attemptID: String, earlierSittingID: String?)

    /// `targetSittingID` is the sitting the student is trying to join. A
    /// missing `test_session_id` on the attempt (older server, or a build
    /// that predates the field) counts as "this sitting" so today's message
    /// keeps showing rather than guessing.
    public init(_ started: StartedAttempt, targetSittingID: String) {
        guard started.attempt.status == "submitted" else {
            self = .open(attemptID: started.attempt.id)
            return
        }
        let attemptSittingID = started.attempt.testSessionID
        let earlierSittingID = (attemptSittingID != nil && attemptSittingID != targetSittingID)
            ? attemptSittingID
            : nil
        self = .alreadyHandedIn(attemptID: started.attempt.id, earlierSittingID: earlierSittingID)
    }

    /// The words the student reads when the submitted attempt belongs to
    /// THIS sitting. The list row reads "Done ✓" beside it once the server
    /// resolves Done by assessment (finding 10.2).
    // UX pass 2 slice 6 (P2-6 pilot copy): one attempt per assessment is
    // the shipped rule, so tell the student the next step instead of leaving
    // the sentence to imply retrying might work.
    public static let handedInMessage = "You already handed this test in. Ask your teacher if you need it reopened."

    /// The words the student reads when the submitted attempt belongs to an
    /// EARLIER sitting (finding H-1, 2026-09-17) — today's message read as
    /// though the student had just handed in THIS sitting, which was wrong.
    public static let earlierSittingMessage = "You already handed this test in during an earlier session. Ask your teacher if you need to take it again."
}
