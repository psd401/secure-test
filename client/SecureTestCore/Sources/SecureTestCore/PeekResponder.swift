import Foundation

/// Row CS (`docs/close-session-ends-attempts-design.md`, D-5): whether the
/// sitting this attempt belongs to is still open, as the peek poll reports it.
///
/// Decoded permissively on purpose — an unrecognised value (and an absent
/// field, which is every server older than the row-CS deploy) reads as OPEN.
/// The one thing this must never do is end a student's test because the server
/// said something the client did not recognise.
public enum SittingState: String, Sendable {
    case open
    case closed
}

/// The peek poll's whole answer. `pending` is the teacher's request for a look
/// (unchanged since P2); `sitting` is row CS's addition.
public struct PeekPoll: Decodable, Equatable, Sendable {
    public let pending: PendingPeek?
    /// nil = the server did not say, which means open (older server).
    public let sitting: SittingState?

    public init(pending: PendingPeek?, sitting: SittingState? = nil) {
        self.pending = pending
        self.sitting = sitting
    }

    /// The only question the client asks of it.
    public var sittingIsClosed: Bool { sitting == .closed }

    private enum CodingKeys: String, CodingKey {
        case pending
        case sitting
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        pending = try container.decodeIfPresent(PendingPeek.self, forKey: .pending)
        let raw = try container.decodeIfPresent(String.self, forKey: .sitting)
        // Unknown string → nil → open. See the enum's note.
        sitting = raw.flatMap(SittingState.init(rawValue:))
    }
}

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
    public typealias FetchPending = @Sendable () async throws -> PeekPoll
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

    /// Row CS (D-5): the sitting this attempt belongs to is closed or expired.
    /// Fired at most ONCE per responder — per attempt, because the responder is
    /// made and discarded with the attempt — and the poll stops with it: there
    /// is nothing further to ask, and the app is on its way home.
    public var onSittingClosed: (() -> Void)?

    private var timer: LockdownTimer?
    /// Read by tests (9.2) to wait for the in-flight poll deterministically
    /// instead of yielding a guessed number of times.
    internal private(set) var pollInFlight = false
    private var lastSeenID: String?
    private var pollWasFailing = false
    private var sittingClosedFired = false

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
                let poll = try await self.fetchPending()
                if self.pollWasFailing {
                    self.pollWasFailing = false
                    self.log("peek poll recovered")
                }
                self.handle(poll)
            } catch {
                if !self.pollWasFailing {
                    self.pollWasFailing = true
                    self.log("peek poll failing (logged once until it recovers): \(error)")
                }
            }
            self.pollInFlight = false
        }
    }

    private func handle(_ poll: PeekPoll) {
        guard timer != nil else { return }
        // Row CS: checked BEFORE the peek request. A closed sitting means this
        // attempt is over as far as the server is concerned; rendering a frame
        // for it would be the last thing this responder did anyway.
        if poll.sittingIsClosed {
            guard !sittingClosedFired else { return }
            sittingClosedFired = true
            log("sitting reported closed by the server — ending this attempt's session")
            stop()
            onSittingClosed?()
            return
        }
        guard let pending = poll.pending else { return }
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
