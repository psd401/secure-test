import XCTest
@testable import SecureTestCore

final class JoinOutcomeTests: XCTestCase {
    private func started(_ status: String, resumed: Bool = true) throws -> StartedAttempt {
        let json = #"{"attempt":{"id":"at-1","status":"\#(status)"},"resumed":\#(resumed)}"#
        return try JSONDecoder().decode(StartedAttempt.self, from: Data(json.utf8))
    }

    func testASubmittedAttemptIsAlreadyHandedIn() throws {
        XCTAssertEqual(JoinOutcome(try started("submitted")), .alreadyHandedIn(attemptID: "at-1"))
    }

    func testANewOrInProgressAttemptOpens() throws {
        XCTAssertEqual(JoinOutcome(try started("in_progress", resumed: false)), .open(attemptID: "at-1"))
        XCTAssertEqual(JoinOutcome(try started("in_progress")), .open(attemptID: "at-1"))
    }

    func testAnUnknownStatusOpensSoTheServerStaysTheJudge() throws {
        XCTAssertEqual(JoinOutcome(try started("paused")), .open(attemptID: "at-1"))
    }

    func testTheMessageNamesWhatHappened() {
        XCTAssertEqual(JoinOutcome.handedInMessage, "You already handed this test in. Ask your teacher if you need it reopened.")
    }
}
