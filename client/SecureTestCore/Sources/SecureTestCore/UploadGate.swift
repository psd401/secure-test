import Foundation

/// Counts drawing uploads in flight so a hand-in never races one
/// (`docs/drawing-tools-design.md` §Auto-save, slice 2).
///
/// A drawing upload runs in its own Task and the response only reaches the
/// spool after the PUT returns, so a hand-in pressed while an upload is out can
/// submit before that drawing's response exists — and the server stops
/// accepting writes the moment an attempt is submitted. Before auto-save that
/// window needed a student to press Save and Finish within a second of each
/// other; the flush-on-Finish opens it on purpose, so the submit path now waits
/// for the count to reach zero.
///
/// It lives here rather than in the view controller because the app target
/// cannot be exercised headlessly (ADR 0013): the counting and the waiting are
/// the part with rules, and they are testable in this package.
public actor UploadGate {
    private var count = 0
    private var waiters: [UUID: CheckedContinuation<Void, Never>] = [:]

    public init() {}

    /// An upload started.
    public func begin() {
        count += 1
    }

    /// It finished, ok or not. A failed upload is no longer in flight, so the
    /// gate must not be held open by one.
    public func end() {
        if count > 0 { count -= 1 }
        guard count == 0, !waiters.isEmpty else { return }
        let pending = waiters
        waiters.removeAll()
        for (_, continuation) in pending { continuation.resume() }
    }

    public var inFlight: Int { count }

    /// Waits until no upload is in flight or `timeout` elapses; returns the
    /// count still in flight (0 = idle).
    ///
    /// Resumed from `end()` rather than polled: the submit path should proceed
    /// the instant the last upload lands, not on the next tick of a poll, and a
    /// bounded wait means a wedged upload delays the hand-in rather than
    /// blocking it forever.
    public func waitForIdle(timeout: Duration) async -> Int {
        if count == 0 { return 0 }
        let id = UUID()
        let timekeeper = Task { [weak self] in
            try? await Task.sleep(for: timeout)
            await self?.giveUp(on: id)
        }
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            // No suspension point between the check above and this line, so a
            // waiter can never miss the `end()` that would have woken it.
            waiters[id] = continuation
        }
        timekeeper.cancel()
        return count
    }

    private func giveUp(on id: UUID) {
        guard let continuation = waiters.removeValue(forKey: id) else { return }
        continuation.resume()
    }
}
