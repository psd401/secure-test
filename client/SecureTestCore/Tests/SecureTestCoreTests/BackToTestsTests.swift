import XCTest
@testable import SecureTestCore

/// v1.5.0 smoke test (2026-10-05): "Back to your tests" pressed while the
/// session was still ending dropped the instant feedback page.
final class BackToTestsTests: XCTestCase {
    func testWaitsOnlyWhileFeedbackIsPendingAndTheSessionIsStillUp() {
        XCTAssertEqual(BackToTests.decide(feedbackPending: true, sessionActive: true), .waitForSessionEnd)
        XCTAssertEqual(BackToTests.decide(feedbackPending: true, sessionActive: false), .leave)
        XCTAssertEqual(BackToTests.decide(feedbackPending: false, sessionActive: true), .leave)
        XCTAssertEqual(BackToTests.decide(feedbackPending: false, sessionActive: false), .leave)
    }
}
