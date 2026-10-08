import Foundation

/// Field report 2026-10-08 (6.2 a): 60 of 61 `lockdown_unrecoverable` exits in
/// 14 days followed a teacher's Close, from 19 s to ~1.8 h after it — yet the
/// grace backstop is 20 s. The backstop runs on the uptime clock, which stops
/// while the Mac sleeps, so the likely story is "Close at the end of class,
/// lid shut before `DID END`, backstop fires on wake". Nothing recorded sleep,
/// so this is the evidence: the exit report says how long the teardown really
/// took on the wall clock and whether the Mac slept during it.
///
/// Written from the main thread (notifications, teardown start), read from the
/// backstop's queue just before `exit(70)` — hence the lock.
public final class SleepWakeRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var teardownStartedAt: Date?
    private var sleepsDuringTeardown = 0
    private var lastWakeAt: Date?

    public init() {}

    public func markTeardownStarted(at date: Date = Date()) {
        lock.lock(); defer { lock.unlock() }
        teardownStartedAt = date
        sleepsDuringTeardown = 0
    }

    public func markSleep(at date: Date = Date()) {
        lock.lock(); defer { lock.unlock() }
        if teardownStartedAt != nil { sleepsDuringTeardown += 1 }
    }

    public func markWake(at date: Date = Date()) {
        lock.lock(); defer { lock.unlock() }
        lastWakeAt = date
    }

    /// Context for the exit-70 report: `slept_during_teardown` "true"/"false",
    /// `teardown_wall_s` (wall-clock seconds since the end was asked for — far
    /// above the 20 s grace means time passed that the uptime clock did not
    /// count), and `woke_s_ago` when the Mac woke during the teardown.
    /// Empty when no teardown was started.
    public func teardownContext(now: Date = Date()) -> [String: String] {
        lock.lock(); defer { lock.unlock() }
        guard let started = teardownStartedAt else { return [:] }
        var context = [
            "slept_during_teardown": sleepsDuringTeardown > 0 ? "true" : "false",
            "teardown_wall_s": String(Int(now.timeIntervalSince(started).rounded())),
        ]
        if let wake = lastWakeAt, wake >= started {
            context["woke_s_ago"] = String(Int(now.timeIntervalSince(wake).rounded()))
        }
        return context
    }
}
