import XCTest
@testable import SecureTestCore

/// v1.5.0 smoke test (2026-10-05): "Back to your tests" pressed while the
/// session was still ending dropped the instant feedback page.
final class BackToTestsTests: XCTestCase {
    func testWaitsForTheResultsPageWhileTheSessionIsStillUp() {
        XCTAssertEqual(BackToTests.decide(feedbackPending: true, sessionActive: true, handedIn: true), .waitForSessionEnd)
        XCTAssertEqual(BackToTests.decide(feedbackPending: true, sessionActive: false, handedIn: true), .leave)
        XCTAssertEqual(BackToTests.decide(feedbackPending: false, sessionActive: false, handedIn: true), .leave)
    }

    /// Ending-session race (James's real-session hand-run, 2026-10-24): with
    /// no feedback the press left at once, before `DID END`; the student
    /// joined another test whose `begin()` was a no-op against this session,
    /// and this session's `DID END` threw them out of it. It waits now, and
    /// leaves at `DID END` on the press already made.
    func testWithNoFeedbackStillWaitsForTheSessionToEndThenLeaves() {
        XCTAssertEqual(BackToTests.decide(feedbackPending: false, sessionActive: true, handedIn: true), .leaveAtSessionEnd)
    }

    /// Bridge audit H-1 (2026-10-08, B-1): the page cannot take a student
    /// home from a live, un-handed-in session.
    func testRefusesALiveSessionThatIsNotHandedIn() {
        XCTAssertEqual(BackToTests.decide(feedbackPending: false, sessionActive: true, handedIn: false), .refuse)
        XCTAssertEqual(BackToTests.decide(feedbackPending: true, sessionActive: true, handedIn: false), .refuse)
    }

    /// Notice pages after a session end, and the offline path, have no live
    /// session: going home stays allowed.
    func testLeavesWhenNoSessionIsActive() {
        XCTAssertEqual(BackToTests.decide(feedbackPending: false, sessionActive: false, handedIn: false), .leave)
    }
}
