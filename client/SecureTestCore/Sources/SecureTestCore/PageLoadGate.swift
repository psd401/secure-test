import Foundation

/// Holds the assessment page's build until the lockdown session has settled
/// (finding C-1, `docs/multi-source-stimulus-design.md` §Progress "Findings").
///
/// The renderer reads the viewport width ONCE, at build time, to decide whether
/// a `side_by_side` set gets two columns (multi-source slice 4, D-6). In the
/// 2026-09-09 real session the page built while the AAC `begin()` transition
/// was still resizing the window, so that read saw a transient narrow width and
/// the set took the own_page fallback — the simulated session on the same Mac,
/// with no transition, built wide. The ordering is what makes it possible:
/// `onBundleLoaded` (which begins lockdown) fires BEFORE the host page loads.
///
/// So the host opens the gate when the session reaches a settled state — active,
/// or back to idle because the begin failed or ended — and the page build waits
/// on it, with a backstop so a session that never answers delays the test rather
/// than swallowing it. Modelled on `UploadGate`: resumed from `open()` rather
/// than polled, and it lives here rather than in the app target because the
/// waiting is the part with rules and the app target cannot be exercised
/// headlessly (ADR 0013).
public actor PageLoadGate {
    private var isOpen = false
    private var waiters: [UUID: CheckedContinuation<Bool, Never>] = [:]

    public init() {}

    /// The session settled. Idempotent: a second call after the first is a
    /// no-op, so a `.active` followed by an `.idle` cannot double-resume.
    public func open() {
        guard !isOpen else { return }
        isOpen = true
        guard !waiters.isEmpty else { return }
        let pending = waiters
        waiters.removeAll()
        for (_, continuation) in pending { continuation.resume(returning: true) }
    }

    public var opened: Bool { isOpen }

    /// Waits until the gate opens or `timeout` elapses. Returns true if it
    /// opened (including a wait that starts after `open()`), false if the
    /// backstop ran out first.
    public func wait(timeout: Duration) async -> Bool {
        if isOpen { return true }
        let id = UUID()
        let timekeeper = Task { [weak self] in
            try? await Task.sleep(for: timeout)
            await self?.giveUp(on: id)
        }
        let opened = await withCheckedContinuation { (continuation: CheckedContinuation<Bool, Never>) in
            // No suspension point between the check above and this line, so a
            // waiter can never miss the `open()` that would have woken it.
            waiters[id] = continuation
        }
        timekeeper.cancel()
        return opened
    }

    private func giveUp(on id: UUID) {
        guard let continuation = waiters.removeValue(forKey: id) else { return }
        continuation.resume(returning: false)
    }
}
