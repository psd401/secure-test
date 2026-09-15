import Foundation

/// Holds the assessment page's build until the lockdown session is ACTIVE —
/// and refuses it outright if the session never gets there.
///
/// Two jobs, in the order they were learned.
///
/// The first is finding C-1 (`docs/multi-source-stimulus-design.md` §Progress
/// "Findings"). The renderer reads the viewport width ONCE, at build time, to
/// decide whether a `side_by_side` set gets two columns (multi-source slice 4,
/// D-6). In the 2026-09-09 real session the page built while the AAC `begin()`
/// transition was still resizing the window, so that read saw a transient
/// narrow width and the set took the own_page fallback — the simulated session
/// on the same Mac, with no transition, built wide. The ordering is what makes
/// it possible: `onBundleLoaded` (which begins lockdown) fires BEFORE the host
/// page loads.
///
/// The second is the 2026-09-15 end-state audit. The original gate opened on
/// every settled state, `.idle` included, so a `begin()` that FAILED delivered
/// the whole test to an unlocked Mac — and the 5 s backstop built the page
/// anyway when a session hung. So settling is no longer one thing: `open()` is
/// the session reaching `.active`, `refuse()` is it falling back to `.idle`
/// without ever getting there, and the backstop is a third outcome. Only
/// `.opened` may build the page; the other two are the host's cue to end
/// whatever is up, go home and say so.
///
/// Modelled on `UploadGate`: resumed from `open()` / `refuse()` rather than
/// polled, and it lives here rather than in the app target because the waiting
/// is the part with rules and the app target cannot be exercised headlessly
/// (ADR 0013).
public actor PageLoadGate {
    /// How a wait ended. `opened` is the ONLY value that may build the test.
    public enum Outcome: Equatable, Sendable {
        /// The session reached `.active`.
        case opened
        /// The session went back to `.idle` without ever becoming active — a
        /// failed `begin()`, or an interruption before it.
        case refused
        /// Neither answer arrived inside the backstop.
        case timedOut
    }

    /// nil while the session is still starting; set once and never changed.
    private var settled: Outcome?
    private var waiters: [UUID: CheckedContinuation<Outcome, Never>] = [:]

    public init() {}

    /// The session is active. Idempotent, and a later `refuse()` cannot undo
    /// it: the page is already legitimately on screen by then, and the `.idle`
    /// that ends every session would otherwise look like a failure to start.
    public func open() {
        settle(.opened)
    }

    /// The session ended up idle without ever being active. A no-op after
    /// `open()` — see above — and idempotent like it.
    public func refuse() {
        settle(.refused)
    }

    private func settle(_ outcome: Outcome) {
        guard settled == nil else { return }
        settled = outcome
        guard !waiters.isEmpty else { return }
        let pending = waiters
        waiters.removeAll()
        for (_, continuation) in pending { continuation.resume(returning: outcome) }
    }

    /// What the gate has settled on, or nil while it is still shut.
    public var outcome: Outcome? { settled }

    public var opened: Bool { settled == .opened }

    /// Waits until the gate settles or `timeout` elapses. Returns the outcome
    /// (including for a wait that starts after it settled), or `.timedOut` if
    /// the backstop ran out first.
    public func wait(timeout: Duration) async -> Outcome {
        if let settled { return settled }
        let id = UUID()
        let timekeeper = Task { [weak self] in
            try? await Task.sleep(for: timeout)
            await self?.giveUp(on: id)
        }
        let outcome = await withCheckedContinuation { (continuation: CheckedContinuation<Outcome, Never>) in
            // No suspension point between the check above and this line, so a
            // waiter can never miss the `open()` that would have woken it.
            waiters[id] = continuation
        }
        timekeeper.cancel()
        return outcome
    }

    private func giveUp(on id: UUID) {
        guard let continuation = waiters.removeValue(forKey: id) else { return }
        continuation.resume(returning: .timedOut)
    }
}
