import Foundation

/// The lockdown lifecycle, with the `AEAssessmentSession` held at arm's length.
///
/// Everything here is deliberately framework-free. `AutomaticAssessmentConfiguration`
/// can only be linked by a target signed with the restricted entitlement, which
/// needs a provisioning profile from the PSD team, which needs the device
/// registered to it — so anything written directly against it is untestable on
/// any machine but a district-provisioned Mac. That is a bad place to keep the
/// code deciding whether a student can leave a locked screen.
///
/// So the framework sits behind `Session` and the app target adapts to it. The
/// state machine, the watchdog, the escalation and the teardown handshake all
/// live here, in the package `swift test` can drive.
///
/// PoC-A is the empirical record this is ported from
/// (`poc-a-aac-capture/RESULTS.md` findings #10 and #11). Two of its three
/// attempts at an exit path were wrong, and the second was worse than the first
/// — it hung the app with the session live. Both were found by simulating the
/// session rather than by locking a Mac.
///
/// ## The rules this encodes
///
/// 1. **Arm before you begin.** The watchdog goes up before `begin()`, never
///    after. Any window in which a session is live and nothing is watching it
///    is the original bug in miniature.
/// 2. **The timeout cannot be switched off.** It can be lengthened for a long
///    assessment; it cannot be removed, and it has a floor.
/// 3. **The last-resort backstop runs on its own scheduler**, never the one
///    driving the UI. See `DispatchLockdownScheduler`.
/// 4. **Confirmation, not hope.** Tearing down waits for the session to report
///    that it ended, bounded — it does not call `end()` and exit into the race.
/// 5. **Never `end()` a session that has not begun.** (Finding 8.3, hand-run
///    2026-08-28 on the shipping client.) An `end()` issued between `begin()`
///    and `didBegin` is DROPPED by the real framework: `didEnd` never comes,
///    the teardown grace expires and the backstop has to exit the process.
///    So an exit requested while `.starting` is recorded and the physical
///    `end()` is issued the moment `didBegin` arrives. Only the WHEN moves —
///    the watchdog, escalation and backstop are armed exactly as before, so
///    a `didBegin` that never comes still ends in the same forced exit.
public final class AssessmentLockdown {

    // MARK: Collaborators

    public enum SessionEvent: Equatable, Sendable {
        case didBegin
        case didEnd
        case failedToBegin(String)
        case interrupted(String)
    }

    /// What the app target adapts a real `AEAssessmentSession` to. One session
    /// object per attempt; `begin()` and `end()` are each called at most once.
    public protocol Session: AnyObject {
        var onEvent: ((SessionEvent) -> Void)? { get set }
        func begin()
        func end()
    }

    public enum State: Equatable, Sendable {
        case idle
        /// `begin()` called, no answer yet. The exit is offered from here,
        /// because a session that is starting traps a student just as well as
        /// one that has started.
        case starting
        case active
    }

    public struct Timings {
        /// Auto-end after this long. Clamped up to `floor`.
        public var watchdog: TimeInterval
        /// Shortest watchdog we will honour.
        public var floor: TimeInterval
        /// How long `end()` gets to report back before we stop being polite.
        public var grace: TimeInterval

        public init(watchdog: TimeInterval, floor: TimeInterval = 10, grace: TimeInterval = 5) {
            self.watchdog = watchdog
            self.floor = floor
            self.grace = grace
        }

        public var effectiveWatchdog: TimeInterval { max(watchdog, floor) }

        /// AAC-1: the watchdog default is deliberately SHORT (ten minutes) —
        /// the testing posture James chose 2026-08-27 — so a session left
        /// behind during development ends itself while someone is still in the
        /// room. `SECURE_TEST_WATCHDOG_SECONDS` overrides it for a longer
        /// hand-run; anything unparseable or non-positive keeps the default,
        /// and the floor still applies either way.
        public static func fromEnvironment(_ environment: [String: String]) -> Timings {
            let raw = environment["SECURE_TEST_WATCHDOG_SECONDS"].flatMap(TimeInterval.init)
            let watchdog = (raw.map { $0 > 0 } ?? false) ? raw! : 600
            return Timings(watchdog: watchdog)
        }
    }

    // MARK: Callbacks

    public var onState: ((State) -> Void)?
    public var onLog: ((String) -> Void)?
    /// Slice 92: every session lifecycle event, forwarded verbatim before the
    /// state machine acts on it. Observation only — the teacher-monitor
    /// reporting hangs off this without the state machine knowing.
    public var onSessionEvent: ((SessionEvent) -> Void)?
    /// Slice 92: the watchdog expired and is about to force the end. Distinct
    /// from the `didEnd` that follows, because "ended by the watchdog" and
    /// "ended on purpose" read very differently on a teacher's monitor.
    public var onWatchdogExpired: (() -> Void)?
    /// Seconds left before the watchdog ends the session, once per second.
    public var onCountdown: ((TimeInterval) -> Void)?
    /// The session would not end within `grace`. Fires on the BACKSTOP
    /// scheduler, so it must assume the main thread is not coming back — the
    /// only safe thing to reach for there is process exit.
    public var onUnrecoverable: (() -> Void)?

    // MARK: State

    public private(set) var state: State = .idle {
        didSet {
            guard state != oldValue else { return }
            onState?(state)
        }
    }

    public var isActive: Bool { state != .idle }

    private let makeSession: () -> Session
    private let scheduler: LockdownScheduler
    private let backstopScheduler: LockdownScheduler
    private let timings: Timings

    private var session: Session?
    private var watchdog: LockdownTimer?
    private var escalation: LockdownTimer?
    private var backstop: LockdownTimer?
    private var remaining: TimeInterval = 0
    private var teardownCompletion: (() -> Void)?
    /// Finding 8.3: an end was requested while `.starting`; the physical
    /// `end()` is owed as soon as `didBegin` arrives.
    private var endDeferred = false

    public init(
        timings: Timings,
        scheduler: LockdownScheduler,
        backstopScheduler: LockdownScheduler,
        makeSession: @escaping () -> Session
    ) {
        self.timings = timings
        self.scheduler = scheduler
        self.backstopScheduler = backstopScheduler
        self.makeSession = makeSession
    }

    // MARK: Entering

    public func begin() {
        guard state == .idle else {
            onLog?("lockdown already up — end it before beginning another")
            return
        }

        let session = makeSession()
        session.onEvent = { [weak self] event in self?.handle(event) }
        self.session = session

        // Rule 1. Arm first.
        state = .starting
        armWatchdog()
        session.begin()
        onLog?("lockdown begin() called; watchdog set to \(Int(timings.effectiveWatchdog))s")
    }

    // MARK: Leaving

    public func end() {
        guard state != .idle else {
            onLog?("no lockdown to end")
            return
        }
        onLog?("lockdown end() called")
        // Rule 5. The framework drops an end() that lands before didBegin.
        // Record it and issue it from the didBegin handler instead. Every
        // timer the caller armed (watchdog escalation, teardown backstop)
        // stays armed, so a session that never begins still exits on time.
        guard state != .starting else {
            if endDeferred {
                onLog?("lockdown end() requested while STARTING — already deferred")
            } else {
                endDeferred = true
                onLog?("lockdown end() requested while STARTING — deferred until DID BEGIN (finding 8.3)")
            }
            return
        }
        session?.end()
    }

    /// Ends the session and calls back once it is CONFIRMED gone, or once
    /// `grace` expires — exactly once, whichever happens first.
    ///
    /// The caller must not block waiting for this. In an AppKit app that means
    /// cancelling the quit and re-issuing it from the completion: returning
    /// `.terminateLater` and waiting puts AppKit in a nested run loop that does
    /// not drain the main queue, which starves both this completion and any
    /// main-queue timer meant to catch it (RESULTS finding #11).
    public func endBeforeTeardown(completion: @escaping () -> Void) {
        guard state != .idle else {
            completion()
            return
        }
        guard teardownCompletion == nil else { return }
        teardownCompletion = completion
        onLog?("tearing down with lockdown active — ending it and waiting for confirmation")

        backstop = backstopScheduler.schedule(after: timings.grace, repeats: false) { [weak self] in
            guard let self else { return }
            self.onLog?("lockdown did not confirm within \(Int(self.timings.grace))s — unrecoverable")
            self.finishTeardown()
            self.onUnrecoverable?()
        }

        end()
    }

    private func finishTeardown() {
        backstop?.cancel()
        backstop = nil
        let completion = teardownCompletion
        teardownCompletion = nil
        completion?()
    }

    // MARK: Watchdog

    private func armWatchdog() {
        watchdog?.cancel()
        remaining = timings.effectiveWatchdog
        watchdog = scheduler.schedule(after: 1, repeats: true) { [weak self] in
            self?.tick()
        }
    }

    private func tick() {
        remaining -= 1
        guard remaining <= 0 else {
            onCountdown?(remaining)
            return
        }
        // Disarm before ending, or this fires again every second while end() is
        // in flight.
        watchdog?.cancel()
        watchdog = nil
        onLog?("WATCHDOG: \(Int(timings.effectiveWatchdog))s elapsed — ending lockdown")
        onWatchdogExpired?()
        armEscalation()
        end()
    }

    /// A watchdog end that is itself ignored is the case nothing else catches,
    /// so it gets its own timer on the backstop scheduler.
    private func armEscalation() {
        escalation?.cancel()
        escalation = backstopScheduler.schedule(after: timings.grace, repeats: false) { [weak self] in
            guard let self else { return }
            self.onLog?("WATCHDOG: end() did not confirm within \(Int(self.timings.grace))s — unrecoverable")
            self.onUnrecoverable?()
        }
    }

    // MARK: Events

    private func handle(_ event: SessionEvent) {
        onSessionEvent?(event)
        switch event {
        case .didBegin:
            onLog?("lockdown DID BEGIN")
            state = .active
            // Rule 5. Pay the deferred end now that the framework will honour
            // it. State is `.active` first so the didEnd this produces (a
            // cooperative session answers synchronously) clears normally.
            if endDeferred {
                endDeferred = false
                onLog?("lockdown DID BEGIN with an end deferred — issuing the physical end() now (finding 8.3)")
                session?.end()
            }
        case .didEnd:
            onLog?("lockdown DID END")
            clear()
        case .failedToBegin(let reason):
            onLog?("lockdown FAILED TO BEGIN — \(reason)")
            if endDeferred {
                onLog?("lockdown FAILED TO BEGIN with an end deferred — nothing to end, resolving the pending exit (finding 8.3)")
            }
            clear()
        case .interrupted(let reason):
            onLog?("lockdown INTERRUPTED — \(reason)")
            clear()
        }
    }

    private func clear() {
        watchdog?.cancel()
        watchdog = nil
        escalation?.cancel()
        escalation = nil
        session = nil
        state = .idle
        remaining = 0
        endDeferred = false
        // Release anything holding a teardown open: the session is confirmed
        // gone, which is what it was waiting for.
        finishTeardown()
    }
}

// MARK: - Simulated session

/// A `Session` with no `AEAssessmentSession` behind it. Nothing locks.
///
/// This is the seam's payload. It exists so the exit path can be exercised on
/// any Mac — including in CI, which will never have the entitlement — and so
/// the failure modes that matter can be produced on demand rather than waited
/// for. `.hangsOnEnd` in particular has no natural way to occur in a test: it
/// is the case where the framework accepts `end()` and never answers, which is
/// precisely the case a student cannot recover from.
public final class SimulatedLockdownSession: AssessmentLockdown.Session {
    public enum Behaviour: Equatable, Sendable {
        /// Begins, and ends when asked.
        case cooperative
        /// Refuses to begin — what a missing entitlement looks like.
        case refusesToBegin(String)
        /// Begins, then ignores `end()` forever.
        case hangsOnEnd
        /// Begins, then drops on its own without being asked.
        case interruptsAfterBegin(String)
        /// Begins only after `delay`, on the main queue — the real framework's
        /// shape. Finding 8.3 (2026-08-28): a real `AEAssessmentSession`
        /// DROPS an `end()` issued before `didBegin`, and so does this; the
        /// machine's deferral is what makes the exit survive. The one
        /// behaviour here that is not synchronous, so the rehearsal needs a
        /// window server's run loop (the app), not just `swift test`.
        case slowToBegin(delay: TimeInterval)
    }

    public var onEvent: ((AssessmentLockdown.SessionEvent) -> Void)?
    private let behaviour: Behaviour
    public private(set) var beginCount = 0
    public private(set) var endCount = 0
    /// Whether `didBegin` has been delivered — `slowToBegin` drops an `end()`
    /// that arrives before it, as the real framework does.
    public private(set) var hasBegun = false

    public init(behaviour: Behaviour = .cooperative) {
        self.behaviour = behaviour
    }

    /// AAC-1: the app falls back to a simulated session whenever the real
    /// entitlement is absent, and `SECURE_TEST_SIMULATE_LOCKDOWN` picks which
    /// failure to rehearse — `cooperative` (default), `refuses`, `hangs`,
    /// `interrupts`, `slow` (finding 8.3: `didBegin` two seconds late, an
    /// `end()` before it dropped). That is what moves the quit-path
    /// MANUAL-CHECKS rows onto any Mac: the failure modes are produced on
    /// demand instead of waited for.
    public static func behaviourFromEnvironment(_ environment: [String: String]) -> Behaviour {
        switch environment["SECURE_TEST_SIMULATE_LOCKDOWN"] {
        case "refuses": return .refusesToBegin("simulated refusal (SECURE_TEST_SIMULATE_LOCKDOWN=refuses)")
        case "hangs": return .hangsOnEnd
        case "interrupts": return .interruptsAfterBegin("simulated interruption (SECURE_TEST_SIMULATE_LOCKDOWN=interrupts)")
        case "slow": return .slowToBegin(delay: 2)
        default: return .cooperative
        }
    }

    public func begin() {
        beginCount += 1
        switch behaviour {
        case .cooperative, .hangsOnEnd:
            hasBegun = true
            onEvent?(.didBegin)
        case .refusesToBegin(let reason):
            onEvent?(.failedToBegin(reason))
        case .interruptsAfterBegin(let reason):
            hasBegun = true
            onEvent?(.didBegin)
            onEvent?(.interrupted(reason))
        case .slowToBegin(let delay):
            DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
                guard let self else { return }
                self.hasBegun = true
                self.onEvent?(.didBegin)
            }
        }
    }

    public func end() {
        endCount += 1
        switch behaviour {
        case .cooperative, .interruptsAfterBegin:
            onEvent?(.didEnd)
        case .slowToBegin:
            // The real framework's drop: an end() before didBegin is lost —
            // no didEnd, ever. After didBegin it behaves cooperatively.
            if hasBegun { onEvent?(.didEnd) }
        case .hangsOnEnd, .refusesToBegin:
            break
        }
    }
}
