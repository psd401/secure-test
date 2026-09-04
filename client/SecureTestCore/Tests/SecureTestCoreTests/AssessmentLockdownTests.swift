import XCTest
@testable import SecureTestCore

/// The exit path from lockdown.
///
/// The property under test throughout is that a student can always get their
/// Mac back. AAC suppresses app switching, so once a session is up nothing
/// outside the process can rescue it — if every path in here fails, the only
/// remedy is holding the power button, mid-assessment, on a student's machine.
/// PoC-A reached exactly that state on 2026-08-26.
///
/// These run without the AAC entitlement, which is the point: the entitlement
/// needs a device registered to the PSD team, so a test that required it could
/// never run in CI or on a developer's machine. Every failure mode is produced
/// on demand through `SimulatedLockdownSession` and the clock is advanced by
/// hand, so nothing here sleeps and nothing flakes.
final class AssessmentLockdownTests: XCTestCase {
    private var clock: ManualLockdownScheduler!
    private var backstopClock: ManualLockdownScheduler!

    override func setUp() {
        super.setUp()
        clock = ManualLockdownScheduler()
        backstopClock = ManualLockdownScheduler()
    }

    private func lockdown(
        _ behaviour: SimulatedLockdownSession.Behaviour = .cooperative,
        watchdog: TimeInterval = 30,
        grace: TimeInterval = 5
    ) -> (AssessmentLockdown, SimulatedLockdownSession) {
        let session = SimulatedLockdownSession(behaviour: behaviour)
        let subject = AssessmentLockdown(
            timings: .init(watchdog: watchdog, grace: grace),
            scheduler: clock,
            backstopScheduler: backstopClock,
            makeSession: { session }
        )
        return (subject, session)
    }

    // MARK: The ordinary path

    func testBeginningReportsActiveAndEndingReturnsToIdle() {
        let (subject, session) = lockdown()
        XCTAssertEqual(subject.state, .idle)

        subject.begin()
        XCTAssertEqual(subject.state, .active)
        XCTAssertEqual(session.beginCount, 1)

        subject.end()
        XCTAssertEqual(subject.state, .idle)
        XCTAssertEqual(session.endCount, 1)
    }

    /// A second `begin()` must not strand the first session with nothing
    /// watching it.
    func testBeginningTwiceIsRefused() {
        let (subject, session) = lockdown()
        subject.begin()
        subject.begin()
        XCTAssertEqual(session.beginCount, 1)
    }

    func testFailingToBeginReturnsToIdleRatherThanLeavingAGhostSession() {
        let (subject, _) = lockdown(.refusesToBegin("entitlement missing"))
        subject.begin()
        XCTAssertEqual(subject.state, .idle)
        XCTAssertFalse(subject.isActive)
    }

    /// The framework can drop a session on its own. If that left our state
    /// `.active`, the UI would keep offering an exit from something already
    /// gone, and the watchdog would keep counting toward a pointless `end()`.
    func testAnInterruptedSessionClearsState() {
        let (subject, _) = lockdown(.interruptsAfterBegin("display reconfigured"))
        subject.begin()
        XCTAssertEqual(subject.state, .idle)
        XCTAssertEqual(clock.pendingCount, 0, "the watchdog should not outlive the session")
    }

    // MARK: The watchdog

    func testWatchdogEndsAnUnattendedSession() {
        let (subject, session) = lockdown(watchdog: 30)
        subject.begin()

        clock.advance(by: 29)
        XCTAssertEqual(subject.state, .active, "must not end early")

        clock.advance(by: 1)
        XCTAssertEqual(subject.state, .idle)
        XCTAssertEqual(session.endCount, 1)
    }

    /// The floor is what stops a caller from configuring the safety net away by
    /// passing something trivially small — or zero.
    func testWatchdogIsClampedToItsFloor() {
        let session = SimulatedLockdownSession()
        let subject = AssessmentLockdown(
            timings: .init(watchdog: 0, floor: 10, grace: 5),
            scheduler: clock,
            backstopScheduler: backstopClock,
            makeSession: { session }
        )
        subject.begin()

        clock.advance(by: 9)
        XCTAssertEqual(subject.state, .active)

        clock.advance(by: 1)
        XCTAssertEqual(subject.state, .idle)
    }

    func testCountdownReportsSecondsRemaining() {
        let (subject, _) = lockdown(watchdog: 30)
        var seen: [TimeInterval] = []
        subject.onCountdown = { seen.append($0) }
        subject.begin()

        clock.advance(by: 3)
        XCTAssertEqual(seen, [29, 28, 27])
    }

    /// Once the watchdog has fired it must stop, or it re-issues `end()` every
    /// second while the first one is still in flight.
    func testWatchdogDoesNotKeepFiringWhileEndIsInFlight() {
        let (subject, session) = lockdown(.hangsOnEnd, watchdog: 10)
        subject.begin()

        clock.advance(by: 10)
        XCTAssertEqual(session.endCount, 1)

        clock.advance(by: 30)
        XCTAssertEqual(session.endCount, 1, "end() should be attempted once, not once per tick")
    }

    // MARK: When the session will not end

    /// The case with no natural recovery: `end()` is accepted and never
    /// answered. Nothing in the app can fix that, so the app has to go.
    func testEscalatesWhenTheSessionIgnoresEnd() {
        let (subject, _) = lockdown(.hangsOnEnd, watchdog: 10, grace: 5)
        var unrecoverable = 0
        subject.onUnrecoverable = { unrecoverable += 1 }

        subject.begin()
        clock.advance(by: 10)
        XCTAssertEqual(unrecoverable, 0, "grace has not elapsed yet")

        backstopClock.advance(by: 5)
        XCTAssertEqual(unrecoverable, 1)
    }

    /// The escalation timer must live on the backstop scheduler, not the one
    /// driving the UI. PoC-A put it on the main queue and AppKit's terminate
    /// wait starved it at exactly the moment it was needed — the app hung with
    /// the session live (RESULTS finding #11). Advancing only the UI clock here
    /// proves the escalation does not depend on it.
    func testEscalationDoesNotDependOnTheUIScheduler() {
        let (subject, _) = lockdown(.hangsOnEnd, watchdog: 10, grace: 5)
        var unrecoverable = 0
        subject.onUnrecoverable = { unrecoverable += 1 }

        subject.begin()
        clock.advance(by: 10)
        clock.advance(by: 600)
        XCTAssertEqual(unrecoverable, 0, "UI clock alone must not drive the backstop")

        backstopClock.advance(by: 5)
        XCTAssertEqual(unrecoverable, 1, "backstop fires on its own scheduler")
    }

    // MARK: Teardown

    func testTeardownWaitsForConfirmationThenCompletes() {
        let (subject, session) = lockdown()
        subject.begin()

        var completed = 0
        subject.endBeforeTeardown { completed += 1 }

        XCTAssertEqual(completed, 1, "a cooperative session confirms synchronously")
        XCTAssertEqual(session.endCount, 1)
        XCTAssertEqual(subject.state, .idle)
    }

    func testTeardownCompletesImmediatelyWhenNothingIsActive() {
        let (subject, _) = lockdown()
        var completed = 0
        subject.endBeforeTeardown { completed += 1 }
        XCTAssertEqual(completed, 1)
    }

    /// A quit must never hang. If the session will not confirm, the completion
    /// still runs — bounded by grace — and the caller is told the state is
    /// unrecoverable so it can exit the process.
    func testTeardownCompletesEvenWhenTheSessionNeverConfirms() {
        let (subject, _) = lockdown(.hangsOnEnd, watchdog: 300, grace: 5)
        var completed = 0
        var unrecoverable = 0
        subject.onUnrecoverable = { unrecoverable += 1 }

        subject.begin()
        subject.endBeforeTeardown { completed += 1 }
        XCTAssertEqual(completed, 0, "not yet — the session has not answered")

        backstopClock.advance(by: 5)
        XCTAssertEqual(completed, 1, "the quit must not hang forever")
        XCTAssertEqual(unrecoverable, 1)
    }

    /// Exactly once, whichever way it resolves — a completion that ran twice
    /// would re-issue a quit that is already underway.
    func testTeardownCompletionRunsExactlyOnce() {
        let (subject, _) = lockdown()
        subject.begin()

        var completed = 0
        subject.endBeforeTeardown { completed += 1 }
        backstopClock.advance(by: 60)
        clock.advance(by: 60)
        XCTAssertEqual(completed, 1)
    }

    func testRepeatedTeardownRequestsDoNotStackTimers() {
        let (subject, session) = lockdown(.hangsOnEnd, watchdog: 300, grace: 5)
        subject.begin()

        subject.endBeforeTeardown {}
        subject.endBeforeTeardown {}
        XCTAssertEqual(session.endCount, 1, "the second request joins the first")
    }

    // MARK: Cleanup

    /// A timer that outlives its session fires against nothing and, in the
    /// escalation's case, would quit the app long after the student handed in.
    func testNoTimersSurviveTheSession() {
        let (subject, _) = lockdown(watchdog: 30)
        subject.begin()
        XCTAssertGreaterThan(clock.pendingCount, 0)

        subject.end()
        XCTAssertEqual(clock.pendingCount, 0)
        XCTAssertEqual(backstopClock.pendingCount, 0)
    }

    // MARK: Observation (slice 92)

    /// The passthrough is observation only: every lifecycle event reaches the
    /// observer, in order, and the state machine behaves exactly as before.
    func testSessionEventsAreForwardedInOrder() {
        let (subject, _) = lockdown()
        var seen: [AssessmentLockdown.SessionEvent] = []
        subject.onSessionEvent = { seen.append($0) }

        subject.begin()
        subject.end()
        XCTAssertEqual(seen, [.didBegin, .didEnd])
        XCTAssertEqual(subject.state, .idle)
    }

    func testInterruptionAndRefusalAreForwardedWithTheirReasons() {
        let (interrupted, _) = lockdown(.interruptsAfterBegin("network fell over"))
        var seen: [AssessmentLockdown.SessionEvent] = []
        interrupted.onSessionEvent = { seen.append($0) }
        interrupted.begin()
        XCTAssertEqual(seen, [.didBegin, .interrupted("network fell over")])

        let (refused, _) = lockdown(.refusesToBegin("entitlement missing"))
        seen = []
        refused.onSessionEvent = { seen.append($0) }
        refused.begin()
        XCTAssertEqual(seen, [.failedToBegin("entitlement missing")])
    }

    /// The watchdog callback fires exactly at expiry, before the end it
    /// forces — "ended by the watchdog" and "ended on purpose" must be
    /// distinguishable to an observer.
    func testWatchdogExpiryFiresTheCallbackOnceBeforeTheForcedEnd() {
        let (subject, session) = lockdown(watchdog: 30)
        var expiries = 0
        var eventsAtExpiry: [AssessmentLockdown.SessionEvent] = []
        var seen: [AssessmentLockdown.SessionEvent] = []
        subject.onSessionEvent = { seen.append($0) }
        subject.onWatchdogExpired = {
            expiries += 1
            eventsAtExpiry = seen
        }

        subject.begin()
        clock.advance(by: 29)
        XCTAssertEqual(expiries, 0)
        clock.advance(by: 1)
        XCTAssertEqual(expiries, 1)
        XCTAssertEqual(session.endCount, 1)
        // At the moment of expiry the end had not happened yet.
        XCTAssertEqual(eventsAtExpiry, [.didBegin])
        XCTAssertEqual(seen, [.didBegin, .didEnd])

        // Long since idle — nothing further fires.
        clock.advance(by: 120)
        XCTAssertEqual(expiries, 1)
    }

    /// An end on purpose never trips the watchdog callback.
    func testDeliberateEndDoesNotFireTheWatchdogCallback() {
        let (subject, _) = lockdown(watchdog: 30)
        var expiries = 0
        subject.onWatchdogExpired = { expiries += 1 }

        subject.begin()
        clock.advance(by: 10)
        subject.end()
        clock.advance(by: 120)
        XCTAssertEqual(expiries, 0)
    }

    // MARK: End requested while starting (finding 8.3)

    /// The shipping client, inside a REAL session (2026-08-28): an `end()`
    /// issued between `begin()` and `didBegin` is dropped by the framework —
    /// `didEnd` never arrives, grace expires, the backstop exits with 70. The
    /// simulated sessions all answer `begin()` synchronously and so never
    /// produced that shape; `HeldBeginSession` answers only when the test
    /// says so.
    private func heldLockdown(
        watchdog: TimeInterval = 30,
        grace: TimeInterval = 5
    ) -> (AssessmentLockdown, HeldBeginSession) {
        let session = HeldBeginSession()
        let subject = AssessmentLockdown(
            timings: .init(watchdog: watchdog, grace: grace),
            scheduler: clock,
            backstopScheduler: backstopClock,
            makeSession: { session }
        )
        return (subject, session)
    }

    func testEndRequestedWhileStartingIsDeferredUntilDidBegin() {
        let (subject, session) = heldLockdown()
        var logs: [String] = []
        subject.onLog = { logs.append($0) }
        var seen: [AssessmentLockdown.SessionEvent] = []
        subject.onSessionEvent = { seen.append($0) }

        subject.begin()
        XCTAssertEqual(subject.state, .starting)

        subject.end()
        XCTAssertEqual(session.endCount, 0, "the framework would drop this end() — it must not be issued yet")
        XCTAssertEqual(subject.state, .starting)
        XCTAssertTrue(logs.contains { $0.contains("deferred until DID BEGIN") }, "the deferral must be visible on stderr")

        session.deliver(.didBegin)
        XCTAssertEqual(session.endCount, 1, "exactly one physical end(), issued on didBegin")
        XCTAssertTrue(logs.contains { $0.contains("issuing the physical end() now") })
        XCTAssertEqual(seen, [.didBegin, .didEnd])
        XCTAssertEqual(subject.state, .idle)
        XCTAssertEqual(clock.pendingCount, 0)
        XCTAssertEqual(backstopClock.pendingCount, 0)
    }

    func testRepeatedEndsWhileStartingIssueOnePhysicalEnd() {
        let (subject, session) = heldLockdown()
        subject.begin()
        subject.end()
        subject.end()
        session.deliver(.didBegin)
        XCTAssertEqual(session.endCount, 1)
        XCTAssertEqual(subject.state, .idle)
    }

    /// The exact hand-run shape: a quit while starting. The teardown waits,
    /// the end is paid on didBegin, the session confirms, the quit completes
    /// — and the backstop that used to fire is cancelled because it was not
    /// needed.
    func testTeardownRequestedWhileStartingCompletesOnceDidBeginArrives() {
        let (subject, session) = heldLockdown(grace: 5)
        var completed = 0
        var unrecoverable = 0
        subject.onUnrecoverable = { unrecoverable += 1 }

        subject.begin()
        subject.endBeforeTeardown { completed += 1 }
        XCTAssertEqual(session.endCount, 0)
        XCTAssertEqual(completed, 0, "not yet — nothing has begun, so nothing has ended")

        session.deliver(.didBegin)
        XCTAssertEqual(session.endCount, 1)
        XCTAssertEqual(completed, 1)
        XCTAssertEqual(subject.state, .idle)

        backstopClock.advance(by: 60)
        XCTAssertEqual(completed, 1, "exactly once")
        XCTAssertEqual(unrecoverable, 0, "the backstop was not needed and must not fire late")
    }

    /// The session never begins, and an end is owed: there is nothing to end.
    /// The pending exit resolves without a physical `end()`.
    func testFailureToBeginWithADeferredEndResolvesWithoutCallingEnd() {
        let (subject, session) = heldLockdown()
        var completed = 0
        var unrecoverable = 0
        subject.onUnrecoverable = { unrecoverable += 1 }

        subject.begin()
        subject.endBeforeTeardown { completed += 1 }
        session.deliver(.failedToBegin("entitlement missing"))

        XCTAssertEqual(session.endCount, 0, "never end() a session that did not begin")
        XCTAssertEqual(completed, 1)
        XCTAssertEqual(subject.state, .idle)
        XCTAssertEqual(clock.pendingCount, 0)
        XCTAssertEqual(backstopClock.pendingCount, 0)

        backstopClock.advance(by: 60)
        XCTAssertEqual(unrecoverable, 0)
    }

    /// A deferred end must not leak into the next session: after a failed
    /// begin, a fresh begin that succeeds is not ended by the old request.
    func testADeferredEndDoesNotOutliveAFailedBegin() {
        let (subject, session) = heldLockdown()
        subject.begin()
        subject.end()
        session.deliver(.failedToBegin("first attempt"))
        XCTAssertEqual(subject.state, .idle)

        subject.begin()
        session.deliver(.didBegin)
        XCTAssertEqual(subject.state, .active, "the earlier deferred end belonged to the earlier session")
        XCTAssertEqual(session.endCount, 0)
    }

    /// Unchanged: once didBegin has arrived, end() is immediate.
    func testEndAfterDidBeginIsIssuedImmediately() {
        let (subject, session) = heldLockdown()
        subject.begin()
        session.deliver(.didBegin)
        XCTAssertEqual(subject.state, .active)

        subject.end()
        XCTAssertEqual(session.endCount, 1)
        XCTAssertEqual(subject.state, .idle)
    }

    /// Unchanged: if didBegin never comes, the watchdog still expires, still
    /// escalates on the backstop scheduler, and still reaches the forced
    /// exit. The deferral only moves the physical end(); it removes nothing.
    func testWatchdogStillEscalatesWhenDidBeginNeverComes() {
        let (subject, session) = heldLockdown(watchdog: 10, grace: 5)
        var expiries = 0
        var unrecoverable = 0
        subject.onWatchdogExpired = { expiries += 1 }
        subject.onUnrecoverable = { unrecoverable += 1 }

        subject.begin()
        clock.advance(by: 10)
        XCTAssertEqual(expiries, 1)
        XCTAssertEqual(session.endCount, 0, "deferred — the framework would drop it anyway")
        XCTAssertEqual(unrecoverable, 0, "grace has not elapsed yet")

        backstopClock.advance(by: 5)
        XCTAssertEqual(unrecoverable, 1, "the escalation is armed before end() and is not disturbed by the deferral")
    }

    /// Unchanged: a quit while starting whose didBegin never comes still
    /// completes within grace and still reports unrecoverable.
    func testTeardownBackstopStillFiresWhenDidBeginNeverComes() {
        let (subject, session) = heldLockdown(watchdog: 300, grace: 5)
        var completed = 0
        var unrecoverable = 0
        subject.onUnrecoverable = { unrecoverable += 1 }

        subject.begin()
        subject.endBeforeTeardown { completed += 1 }
        XCTAssertEqual(completed, 0)

        backstopClock.advance(by: 5)
        XCTAssertEqual(completed, 1, "the quit must not hang forever")
        XCTAssertEqual(unrecoverable, 1)
        XCTAssertEqual(session.endCount, 0)
    }
}

/// A `Session` that answers `begin()` only when the test delivers the
/// framework's reply — the asynchronous shape of a real `AEAssessmentSession`
/// that `SimulatedLockdownSession` (which answers synchronously) cannot
/// produce. `end()` confirms synchronously, like a cooperative session.
private final class HeldBeginSession: AssessmentLockdown.Session {
    var onEvent: ((AssessmentLockdown.SessionEvent) -> Void)?
    private(set) var beginCount = 0
    private(set) var endCount = 0

    func begin() {
        beginCount += 1
    }

    func end() {
        endCount += 1
        onEvent?(.didEnd)
    }

    func deliver(_ event: AssessmentLockdown.SessionEvent) {
        onEvent?(event)
    }
}

/// AAC-1: how the app resolves its lockdown configuration from the
/// environment — a short testing-posture watchdog by default, and the
/// simulated session's rehearsable failure modes.
final class LockdownEnvironmentTests: XCTestCase {
    func testWatchdogDefaultsShortForTheTestingPosture() {
        let timings = AssessmentLockdown.Timings.fromEnvironment([:])
        XCTAssertEqual(timings.watchdog, 600)
        XCTAssertEqual(timings.floor, 10)
        XCTAssertEqual(timings.grace, 5)
    }

    func testWatchdogOverrideParsesAndBadValuesKeepTheDefault() {
        XCTAssertEqual(
            AssessmentLockdown.Timings.fromEnvironment(["SECURE_TEST_WATCHDOG_SECONDS": "3600"]).watchdog,
            3600
        )
        XCTAssertEqual(
            AssessmentLockdown.Timings.fromEnvironment(["SECURE_TEST_WATCHDOG_SECONDS": "banana"]).watchdog,
            600
        )
        XCTAssertEqual(
            AssessmentLockdown.Timings.fromEnvironment(["SECURE_TEST_WATCHDOG_SECONDS": "0"]).watchdog,
            600
        )
        // The floor still applies to a legal-but-tiny override.
        XCTAssertEqual(
            AssessmentLockdown.Timings.fromEnvironment(["SECURE_TEST_WATCHDOG_SECONDS": "3"]).effectiveWatchdog,
            10
        )
    }

    func testSimulatedBehaviourSelection() {
        XCTAssertEqual(SimulatedLockdownSession.behaviourFromEnvironment([:]), .cooperative)
        XCTAssertEqual(
            SimulatedLockdownSession.behaviourFromEnvironment(["SECURE_TEST_SIMULATE_LOCKDOWN": "hangs"]),
            .hangsOnEnd
        )
        if case .refusesToBegin = SimulatedLockdownSession.behaviourFromEnvironment(["SECURE_TEST_SIMULATE_LOCKDOWN": "refuses"]) {} else {
            XCTFail("refuses should map to refusesToBegin")
        }
        if case .interruptsAfterBegin = SimulatedLockdownSession.behaviourFromEnvironment(["SECURE_TEST_SIMULATE_LOCKDOWN": "interrupts"]) {} else {
            XCTFail("interrupts should map to interruptsAfterBegin")
        }
        XCTAssertEqual(
            SimulatedLockdownSession.behaviourFromEnvironment(["SECURE_TEST_SIMULATE_LOCKDOWN": "nonsense"]),
            .cooperative
        )
    }
}
