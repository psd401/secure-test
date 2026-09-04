import XCTest
@testable import SecureTestCore

/// `SECURE_TEST_SIMULATE_LOCKDOWN=slow` (James, 2026-08-28): the simulated
/// session that reproduces finding 8.3's shape on an unentitled Mac —
/// `didBegin` arrives late and an `end()` issued before it is dropped, as the
/// real `AEAssessmentSession` dropped it on 2026-08-28. With the machine's
/// deferral in front of it the exit survives; without it the backstop would
/// be the only way out. Short delays on the main run loop; nothing else here
/// sleeps.
final class SimulatedLockdownSlowTests: XCTestCase {
    func testTheEnvironmentKnobSelectsSlow() {
        XCTAssertEqual(
            SimulatedLockdownSession.behaviourFromEnvironment(["SECURE_TEST_SIMULATE_LOCKDOWN": "slow"]),
            .slowToBegin(delay: 2)
        )
    }

    func testAnEndBeforeDidBeginIsDroppedLikeTheRealFramework() {
        let session = SimulatedLockdownSession(behaviour: .slowToBegin(delay: 0.05))
        var events: [AssessmentLockdown.SessionEvent] = []
        session.onEvent = { events.append($0) }

        session.begin()
        XCTAssertTrue(events.isEmpty, "nothing is delivered synchronously")
        XCTAssertFalse(session.hasBegun)

        session.end()
        XCTAssertEqual(session.endCount, 1)
        XCTAssertTrue(events.isEmpty, "the end() is dropped: no didEnd, ever")

        let later = expectation(description: "didBegin arrives late")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { later.fulfill() }
        wait(for: [later], timeout: 2)
        XCTAssertEqual(events, [.didBegin])
        XCTAssertTrue(session.hasBegun)

        session.end()
        XCTAssertEqual(events, [.didBegin, .didEnd], "after didBegin it is cooperative")
    }

    /// The rehearsal end to end: the machine defers the physical end() until
    /// didBegin (finding 8.3), so an exit requested while `starting` is
    /// honoured instead of lost.
    func testTheMachineDeferralSurvivesTheSlowSession() {
        let session = SimulatedLockdownSession(behaviour: .slowToBegin(delay: 0.05))
        let subject = AssessmentLockdown(
            timings: .init(watchdog: 30, grace: 5),
            scheduler: ManualLockdownScheduler(),
            backstopScheduler: ManualLockdownScheduler(),
            makeSession: { session }
        )
        var seen: [AssessmentLockdown.SessionEvent] = []
        let ended = expectation(description: "didEnd")
        subject.onSessionEvent = { event in
            seen.append(event)
            if event == .didEnd { ended.fulfill() }
        }

        subject.begin()
        XCTAssertEqual(subject.state, .starting)
        subject.end()
        XCTAssertEqual(session.endCount, 0, "deferred — not issued while starting")

        wait(for: [ended], timeout: 2)
        XCTAssertEqual(session.endCount, 1, "exactly one physical end(), after didBegin")
        XCTAssertEqual(seen, [.didBegin, .didEnd])
        XCTAssertEqual(subject.state, .idle)
    }
}
