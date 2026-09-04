import Foundation

/// Timers for the lockdown controller, injected rather than reached for.
///
/// PoC-A verified the same logic by running it and waiting: twenty seconds of
/// wall clock per case, on a machine, by hand. That is why it took two attempts
/// to get right. Injecting the scheduler makes the identical behaviour a
/// deterministic unit test that finishes instantly and cannot flake — which is
/// the whole reason for building the seam before the session code rather than
/// after it (ADR 0013: anything only verifiable by driving a UI effectively
/// cannot be verified in this environment at all).
public protocol LockdownTimer: AnyObject {
    func cancel()
}

public protocol LockdownScheduler: AnyObject {
    /// `repeats: false` fires once. The returned handle must be retained by the
    /// caller; dropping it does not cancel.
    func schedule(after seconds: TimeInterval, repeats: Bool, _ body: @escaping () -> Void) -> LockdownTimer
}

// MARK: - Production

/// Dispatch-backed scheduler. `queue` matters more than it looks.
///
/// The controller takes TWO of these: one for ordinary work and one for the
/// last-resort backstop, and they must not be the same queue. PoC-A shipped a
/// backstop on the main queue and it was starved at exactly the moment it was
/// needed — AppKit's terminate wait does not drain `DispatchQueue.main`, so the
/// timer that existed to catch a hung teardown never fired and the app hung
/// with the session live (poc-a-aac-capture/RESULTS.md finding #11). A watchdog
/// that shares a thread with the thing it is watching is not a watchdog.
public final class DispatchLockdownScheduler: LockdownScheduler {
    private final class Handle: LockdownTimer {
        private var timer: DispatchSourceTimer?
        init(_ timer: DispatchSourceTimer) { self.timer = timer }
        func cancel() {
            timer?.cancel()
            timer = nil
        }
    }

    private let queue: DispatchQueue

    public init(queue: DispatchQueue) {
        self.queue = queue
    }

    /// The queue AppKit work belongs on.
    public static var main: DispatchLockdownScheduler { .init(queue: .main) }

    /// A private serial queue for the backstop. Never `.main`.
    public static var backstop: DispatchLockdownScheduler {
        .init(queue: DispatchQueue(label: "net.psd401.securetest.lockdown-backstop"))
    }

    public func schedule(after seconds: TimeInterval, repeats: Bool, _ body: @escaping () -> Void) -> LockdownTimer {
        let timer = DispatchSource.makeTimerSource(queue: queue)
        if repeats {
            timer.schedule(deadline: .now() + seconds, repeating: seconds)
        } else {
            timer.schedule(deadline: .now() + seconds)
        }
        timer.setEventHandler(handler: body)
        timer.resume()
        return Handle(timer)
    }
}

// MARK: - Tests

/// Advances only when a test says so, so every timing assertion is exact.
public final class ManualLockdownScheduler: LockdownScheduler {
    private final class Handle: LockdownTimer {
        weak var owner: ManualLockdownScheduler?
        let id: Int
        init(owner: ManualLockdownScheduler, id: Int) {
            self.owner = owner
            self.id = id
        }
        func cancel() { owner?.cancel(id) }
    }

    private struct Scheduled {
        let id: Int
        let interval: TimeInterval
        var fireAt: TimeInterval
        let repeats: Bool
        let body: () -> Void
    }

    private var scheduled: [Scheduled] = []
    private var nextID = 0
    public private(set) var now: TimeInterval = 0

    public init() {}

    public func schedule(after seconds: TimeInterval, repeats: Bool, _ body: @escaping () -> Void) -> LockdownTimer {
        nextID += 1
        scheduled.append(
            Scheduled(id: nextID, interval: seconds, fireAt: now + seconds, repeats: repeats, body: body)
        )
        return Handle(owner: self, id: nextID)
    }

    private func cancel(_ id: Int) {
        scheduled.removeAll { $0.id == id }
    }

    /// Moves the clock forward, firing everything due along the way in order.
    ///
    /// Fires one timer at a time and re-reads the list between fires, because a
    /// handler routinely cancels or schedules other timers — the escalation path
    /// does exactly that — and a snapshot taken up front would run timers that
    /// were cancelled microseconds earlier.
    public func advance(by seconds: TimeInterval) {
        let target = now + seconds
        while true {
            guard let next = scheduled.filter({ $0.fireAt <= target }).min(by: { $0.fireAt < $1.fireAt }) else {
                break
            }
            now = next.fireAt
            if next.repeats {
                if let index = scheduled.firstIndex(where: { $0.id == next.id }) {
                    scheduled[index].fireAt = now + next.interval
                }
            } else {
                cancel(next.id)
            }
            next.body()
        }
        now = target
    }

    public var pendingCount: Int { scheduled.count }
}
