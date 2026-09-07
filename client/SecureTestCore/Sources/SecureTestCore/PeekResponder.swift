import Foundation

/// On-demand peek, the client's half (docs/on-demand-peek-design.md P2).
///
/// Polls "does my teacher want a look?" every `interval` seconds while a
/// server-delivered attempt is on screen, and surfaces each pending request
/// exactly once through `onPeekRequested`. The app answers by showing the
/// student the banner, rendering itself (`NSView.cacheDisplay` — PoC-A
/// finding #14's mechanism, the part of this feature that cannot live in
/// this package), and handing the encoded image back through `deliver`.
///
/// The reporter's rule applies verbatim: nothing here blocks anything. The
/// poll skips a tick rather than stack requests, an upload failure is logged
/// and dropped (the teacher's monitor reads "unavailable" and they click
/// again), and `stop()` is synchronous. Poll failures log on TRANSITION
/// only — a dead network at a 5 s cadence must not write a log line per
/// tick for the length of an assessment.
public final class PeekResponder: @unchecked Sendable {
    public typealias FetchPending = @Sendable () async throws -> PendingPeek?
    public typealias Upload = @Sendable (_ peekID: String, _ imageBase64: String) async throws -> Void

    /// The 6.1 cadence. A constant here rather than an env knob: the server's
    /// 30 s pending TTL is sized to it.
    public static let defaultInterval: TimeInterval = 5

    private let interval: TimeInterval
    private let scheduler: LockdownScheduler
    private let fetchPending: FetchPending
    private let upload: Upload
    private let log: @Sendable (String) -> Void

    /// Fired at most once per peek id, from the scheduler's context — the app
    /// hops to the main actor itself.
    public var onPeekRequested: ((PendingPeek) -> Void)?

    private var timer: LockdownTimer?
    /// Read by tests (9.2) to wait for the in-flight poll deterministically
    /// instead of yielding a guessed number of times.
    internal private(set) var pollInFlight = false
    private var lastSeenID: String?
    private var pollWasFailing = false

    public convenience init(
        api: APIClient,
        attemptID: String,
        scheduler: LockdownScheduler,
        log: @escaping @Sendable (String) -> Void
    ) {
        self.init(
            interval: Self.defaultInterval,
            scheduler: scheduler,
            log: log,
            fetchPending: { try await api.fetchPendingPeek(attemptID: attemptID) },
            upload: { peekID, imageBase64 in
                try await api.uploadPeekImage(
                    attemptID: attemptID,
                    peekID: peekID,
                    imageBase64: imageBase64
                )
            }
        )
    }

    /// The seam the tests use: same responder, network and clock swapped out.
    public init(
        interval: TimeInterval = PeekResponder.defaultInterval,
        scheduler: LockdownScheduler,
        log: @escaping @Sendable (String) -> Void,
        fetchPending: @escaping FetchPending,
        upload: @escaping Upload
    ) {
        self.interval = interval
        self.scheduler = scheduler
        self.log = log
        self.fetchPending = fetchPending
        self.upload = upload
    }

    /// Idempotent; the first call arms the poll.
    public func start() {
        guard timer == nil else { return }
        timer = scheduler.schedule(after: interval, repeats: true) { [weak self] in
            self?.tick()
        }
    }

    /// Synchronous, and the callback never fires after it. A poll already in
    /// flight is abandoned by the guard, not awaited.
    public func stop() {
        timer?.cancel()
        timer = nil
    }

    private func tick() {
        // One poll at a time: a slow server must not stack requests behind
        // itself. The next tick asks again.
        guard !pollInFlight else { return }
        pollInFlight = true
        Task { [weak self] in
            guard let self else { return }
            do {
                let pending = try await self.fetchPending()
                if self.pollWasFailing {
                    self.pollWasFailing = false
                    self.log("peek poll recovered")
                }
                self.handle(pending)
            } catch {
                if !self.pollWasFailing {
                    self.pollWasFailing = true
                    self.log("peek poll failing (logged once until it recovers): \(error)")
                }
            }
            self.pollInFlight = false
        }
    }

    private func handle(_ pending: PendingPeek?) {
        guard let pending, timer != nil else { return }
        // The server replaces rather than stacks, so one id is one ask; the
        // 30 s pending TTL means a dropped upload resolves server-side.
        guard pending.id != lastSeenID else { return }
        lastSeenID = pending.id
        log("peek requested by teacher (\(pending.id)) — notifying student and rendering")
        onPeekRequested?(pending)
    }

    /// Hand the rendered frame back. Fire-and-forget, the reporter's contract:
    /// returns the task for tests, production ignores it.
    @discardableResult
    public func deliver(peekID: String, imageBase64: String) -> Task<Void, Never> {
        let upload = self.upload
        let log = self.log
        return Task {
            do {
                try await upload(peekID, imageBase64)
                log("peek image delivered (\(peekID))")
            } catch {
                // Dropped by design: the monitor reads "unavailable" and the
                // teacher clicks again.
                log("peek image not delivered (\(peekID)): \(error)")
                // Observability slice 4: a teacher who asked for a look and
                // got nothing has no way to tell a refusal from a stalled
                // student without this.
                ClientErrorLog.shared?.record(
                    kind: "peek_upload_failed",
                    message: "\(error)",
                    context: ["peek_id": peekID]
                )
            }
        }
    }
}
