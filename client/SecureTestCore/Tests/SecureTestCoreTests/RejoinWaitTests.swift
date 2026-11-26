import XCTest
@testable import SecureTestCore

/// Working-time clock slice 4: the attempt screen waits for "Let back in"
/// and asks again on its own, rather than sending the student home.
@MainActor
final class RejoinWaitTests: XCTestCase {
    private let refusal = APIError.refused(status: 409, code: "rejoin_needs_approval")

    func testTheWindowIsTenMinutesAtTenSeconds() {
        // The first fetch, then one every 10 s for the 600 s approval window.
        XCTAssertEqual(RejoinWait.maxAttempts(), 61)
        XCTAssertEqual(RejoinWait.maxAttempts(interval: .seconds(10), window: .seconds(5)), 1)
    }

    func testAnAdmittedJoinReturnsWithoutWaiting() async throws {
        var waited = 0, sleeps = 0
        let value = try await RejoinWait.run(
            sleep: { _ in sleeps += 1 },
            onWaiting: { waited += 1 }
        ) { 7 }
        XCTAssertEqual(value, 7)
        XCTAssertEqual(waited, 0)
        XCTAssertEqual(sleeps, 0)
    }

    func testOpensOnItsOwnOnceTheTeacherLetsThemBackIn() async throws {
        var calls = 0, waited = 0
        var slept: [Duration] = []
        let value = try await RejoinWait.run(
            sleep: { slept.append($0) },
            onWaiting: { waited += 1 }
        ) { () async throws -> String in
            calls += 1
            if calls < 4 { throw self.refusal }
            return "bundle"
        }
        XCTAssertEqual(value, "bundle")
        XCTAssertEqual(calls, 4)
        XCTAssertEqual(waited, 1, "the waiting notice is shown once, not per retry")
        XCTAssertEqual(slept, [.seconds(10), .seconds(10), .seconds(10)])
    }

    func testStopsAskingAtTheEndOfTheWindow() async {
        var calls = 0
        do {
            _ = try await RejoinWait.run(maxAttempts: 3, sleep: { _ in }) { () async throws -> Int in
                calls += 1
                throw self.refusal
            }
            XCTFail("expected the last refusal to be thrown")
        } catch let error as APIError {
            XCTAssertTrue(error.isRejoinNeedsApproval)
        } catch {
            XCTFail("unexpected \(error)")
        }
        XCTAssertEqual(calls, 3)
    }

    func testOtherRefusalsAreNotRetried() async {
        // A teacher closing the sitting or handing the test in while the
        // student waits ends the wait with that answer.
        var calls = 0
        do {
            _ = try await RejoinWait.run(sleep: { _ in }) { () async throws -> Int in
                calls += 1
                if calls == 1 { throw self.refusal }
                throw APIError.refused(status: 409, code: "sitting_closed")
            }
            XCTFail("expected sitting_closed")
        } catch let error as APIError {
            XCTAssertTrue(error.isSittingClosed)
        } catch {
            XCTFail("unexpected \(error)")
        }
        XCTAssertEqual(calls, 2)
    }

    func testStopsWhenTheScreenGoesAway() async {
        var calls = 0
        var alive = true
        do {
            _ = try await RejoinWait.run(
                sleep: { _ in alive = false },
                shouldContinue: { alive }
            ) { () async throws -> Int in
                calls += 1
                throw self.refusal
            }
            XCTFail("expected the refusal")
        } catch {}
        XCTAssertEqual(calls, 1, "no fetch after the attempt screen is retired")
    }

    func testCopy() {
        XCTAssertEqual(JoinErrorCopy.rejoinWaitingMessage, "Your teacher needs to let you back in.")
        XCTAssertEqual(JoinErrorCopy.rejoinWaitingInformative, "Ask them, then this will open on its own.")
        XCTAssertTrue(JoinErrorCopy.message(forCode: "rejoin_needs_approval").contains("let you back in"))
        XCTAssertTrue(refusal.isRejoinNeedsApproval)
        XCTAssertFalse(APIError.refused(status: 409, code: "time_expired").isRejoinNeedsApproval)
    }
}
