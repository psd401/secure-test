import Foundation

/// The in-page "Back to your tests" after a hand-in (v1.5.0 smoke test,
/// 2026-10-05). The hand-in ends the secure session, and in a real session
/// `DID END` arrives a few seconds later; instant feedback waits for it (IF
/// slice 3, D-2). A student who pressed the button inside those seconds used
/// to leave the attempt screen at once, and the results page — which needs
/// that screen — was dropped. Now the press waits: the results page shows at
/// `DID END`, and its Done goes home.
public enum BackToTests {
    public enum Decision: Equatable, Sendable {
        /// Go home now.
        case leave
        /// Stay; the results page appears when the session has ended.
        case waitForSessionEnd
        /// Bridge audit H-1 (2026-10-08, B-1): the page asked to go home in
        /// the middle of a live, un-handed-in session. Going home there tore
        /// the attempt screen down WITHOUT ending lockdown; the page has no
        /// business asking, so the host refuses and logs it.
        case refuse
    }

    public static func decide(feedbackPending: Bool, sessionActive: Bool, handedIn: Bool) -> Decision {
        if sessionActive && !handedIn { return .refuse }
        return feedbackPending && sessionActive ? .waitForSessionEnd : .leave
    }
}
