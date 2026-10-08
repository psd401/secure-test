import Foundation

/// Field report 2026-10-08: "End secure session" was pressed 409 times on 204
/// attempts in 14 days — 199 presses in a session's first 10 minutes, 148 of
/// them repeats, and 168 of those attempts later handed in normally. Students
/// were using the exit as "back". Decision (James): ask first, on the button,
/// Cmd-E and Cmd-Q alike.
///
/// The exit path stays (the project's hard rule — anything that calls
/// `begin()` ships an exit): this adds one confirming click, nothing else.
/// A quit the SYSTEM asks for (logout, restart, shutdown, an MDM-driven quit)
/// arrives with a quit Apple event and is never held up by a dialog.
public enum ExitConfirmation {
    public enum Kind: Sendable, Equatable {
        /// The titlebar button and Session → End Secure Session (Cmd-E).
        case endSession
        /// Secure Test → Quit (Cmd-Q) and the window's close button.
        case quit
    }

    /// Ask only while a test is actually open inside a live secure session and
    /// not yet handed in. Everywhere else (Your tests, after a hand-in, a
    /// system-initiated quit) the action happens at once, as before.
    public static func shouldConfirm(
        lockdownActive: Bool,
        onAttemptScreen: Bool,
        handedIn: Bool,
        systemInitiatedQuit: Bool = false
    ) -> Bool {
        lockdownActive && onAttemptScreen && !handedIn && !systemInitiatedQuit
    }

    public static func messageText(_ kind: Kind) -> String {
        switch kind {
        case .endSession: return "End the secure session?"
        case .quit: return "Quit Secure Test?"
        }
    }

    public static func informativeText(_ kind: Kind) -> String {
        switch kind {
        case .endSession:
            return "Your answers are saved. You can come back to this test from Your tests."
        case .quit:
            return "Your test is still open. Your answers are saved, and you can come back to it from Your tests."
        }
    }

    /// The default (Return) button — the safe choice, so a repeated press or a
    /// stray Return keeps the student in the test.
    public static let keepWorkingTitle = "Keep working"

    public static func confirmTitle(_ kind: Kind) -> String {
        switch kind {
        case .endSession: return "End session"
        case .quit: return "Quit"
        }
    }
}
