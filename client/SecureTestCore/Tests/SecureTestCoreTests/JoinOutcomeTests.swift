import XCTest
@testable import SecureTestCore

final class JoinOutcomeTests: XCTestCase {
    private func started(_ status: String, resumed: Bool = true, testSessionID: String? = nil) throws -> StartedAttempt {
        let sittingField = testSessionID.map { #","test_session_id":"\#($0)""# } ?? ""
        let json = #"{"attempt":{"id":"at-1","status":"\#(status)"\#(sittingField)},"resumed":\#(resumed)}"#
        return try JSONDecoder().decode(StartedAttempt.self, from: Data(json.utf8))
    }

    func testASubmittedAttemptForThisSittingIsAlreadyHandedIn() throws {
        XCTAssertEqual(
            JoinOutcome(try started("submitted", testSessionID: "sit-today"), targetSittingID: "sit-today"),
            .alreadyHandedIn(attemptID: "at-1", earlierSittingID: nil)
        )
    }

    func testASubmittedAttemptForAnEarlierSittingIsFlagged() throws {
        XCTAssertEqual(
            JoinOutcome(try started("submitted", testSessionID: "sit-earlier"), targetSittingID: "sit-today"),
            .alreadyHandedIn(attemptID: "at-1", earlierSittingID: "sit-earlier")
        )
    }

    // Finding H-1: a missing test_session_id (older server, or a response
    // shaped before the field existed) counts as "this sitting" so today's
    // message keeps showing rather than guessing.
    func testASubmittedAttemptWithNoSittingIDKeepsTodaysMessage() throws {
        XCTAssertEqual(
            JoinOutcome(try started("submitted"), targetSittingID: "sit-today"),
            .alreadyHandedIn(attemptID: "at-1", earlierSittingID: nil)
        )
    }

    func testANewOrInProgressAttemptOpens() throws {
        XCTAssertEqual(JoinOutcome(try started("in_progress", resumed: false), targetSittingID: "sit-today"), .open(attemptID: "at-1"))
        XCTAssertEqual(JoinOutcome(try started("in_progress"), targetSittingID: "sit-today"), .open(attemptID: "at-1"))
    }

    func testAnUnknownStatusOpensSoTheServerStaysTheJudge() throws {
        XCTAssertEqual(JoinOutcome(try started("paused"), targetSittingID: "sit-today"), .open(attemptID: "at-1"))
    }

    func testTheMessageNamesWhatHappened() {
        XCTAssertEqual(JoinOutcome.handedInMessage, "You already handed this test in. Ask your teacher if you need it reopened.")
    }

    func testTheEarlierSittingMessageNamesWhatHappened() {
        XCTAssertEqual(JoinOutcome.earlierSittingMessage, "You already handed this test in during an earlier session. Ask your teacher if you need to take it again.")
    }
}
