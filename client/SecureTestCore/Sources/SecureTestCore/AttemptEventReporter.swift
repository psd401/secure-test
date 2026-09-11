import Foundation

/// Slice 92: the wire names for a client event on an attempt. Mirrors the
/// server's closed set exactly (docs/phase-7-slices.md, "Client contract for
/// slice 91"); the server answers 400 to anything else, so a new kind lands
/// on both sides in the same change or not at all.
public enum AttemptEventKind: String, CaseIterable, Sendable {
    case quit
    case emergencyExit = "emergency_exit"
    case focusLoss = "focus_loss"
    case focusRegained = "focus_regained"
    case lockdownBegin = "lockdown_begin"
    case lockdownEnd = "lockdown_end"
    case lockdownFailed = "lockdown_failed"
    case lockdownInterrupted = "lockdown_interrupted"
    /// Observability slice 4, D-4: an error the client hit WHILE an attempt
    /// was open. It lands in `errors.log` like every other error; this is the
    /// copy that reaches the teacher's monitor live, because `client_error`
    /// is in the server's ALERT_EVENT_KINDS and lights "Needs attention".
    /// Detail is `{ kind, message }`.
    case clientError = "client_error"
    /// Time limit slice 2 (D-2): this attempt's clock reached zero and the
    /// client ended the secure session. It does NOT hand in — the attempt stays
    /// in progress for the teacher to review or hand in themselves.
    case timeExpired = "time_expired"
}

/// Slice 92: fire-and-forget event reporting for the teacher monitor.
///
/// The one rule this type exists to encode: **a failed or slow post never
/// blocks anything, least of all an exit path.** `report` returns immediately;
/// the request runs in a detached task; a refusal or a dead network is logged
/// to the `[security]` channel and then dropped. The server's contract is the
/// same shape from the other side — events are telemetry, not answers, and
/// nothing downstream awaits them.
///
/// One reporter per server-delivered attempt, made where the attempt id is
/// known and discarded with it.
public final class AttemptEventReporter: @unchecked Sendable {
    public typealias Post = @Sendable (AttemptEventKind, [String: String]?) async throws -> Void

    /// UX pass 2 slice 7 (finding 10.8): the lifecycle kinds get a bounded
    /// retry INSIDE the same detached task — still fire-and-forget from the
    /// caller's side, still never awaited, but a server outage measured in
    /// seconds no longer erases lockdown_begin from the monitor's history
    /// (the Aurora run lost one to a 10.7 DNS window). Focus noise and quit
    /// stay single-shot: focus events are chatty and self-correcting, and a
    /// quit's task dies with the process anyway.
    public static let retriedKinds: Set<AttemptEventKind> = [
        .lockdownBegin, .lockdownEnd, .lockdownFailed, .lockdownInterrupted,
        .emergencyExit,
        // Slice 4: an error worth a teacher's attention gets the same retry
        // budget as the lifecycle — a network fault is exactly the condition
        // that produces one and would otherwise lose it.
        .clientError,
        // Time limit: the one event that explains why a student's session ended
        // and their attempt is unfinished. Losing it to a flaky network would
        // leave the teacher's timeline claiming nothing happened.
        .timeExpired,
    ]
    private static let maxAttempts = 4

    private let post: Post
    private let log: @Sendable (String) -> Void
    /// Nanoseconds to wait before retry N (1-based). Injectable so the tests
    /// run without wall-clock sleeps; default 2s, 4s, 8s.
    private let retryDelay: @Sendable (Int) -> UInt64

    public convenience init(
        api: APIClient,
        attemptID: String,
        log: @escaping @Sendable (String) -> Void
    ) {
        self.init(log: log) { kind, detail in
            try await api.postEvent(attemptID: attemptID, kind: kind, detail: detail)
        }
    }

    /// The seam the tests use: the same reporter with the network swapped out.
    public init(
        log: @escaping @Sendable (String) -> Void,
        retryDelay: @escaping @Sendable (Int) -> UInt64 = { UInt64(1 << $0) * 1_000_000_000 },
        post: @escaping Post
    ) {
        self.post = post
        self.log = log
        self.retryDelay = retryDelay
    }

    /// Returns the task so a test can await it; production callers ignore it.
    @discardableResult
    public func report(
        _ kind: AttemptEventKind,
        detail: [String: String]? = nil
    ) -> Task<Void, Never> {
        let post = self.post
        let log = self.log
        let retryDelay = self.retryDelay
        let attempts = Self.retriedKinds.contains(kind) ? Self.maxAttempts : 1
        return Task {
            for attempt in 1...attempts {
                do {
                    try await post(kind, detail)
                    if attempt > 1 { log("event \(kind.rawValue) delivered on attempt \(attempt)") }
                    return
                } catch {
                    if attempt < attempts {
                        log("event \(kind.rawValue) attempt \(attempt) failed — retrying: \(error)")
                        try? await Task.sleep(nanoseconds: retryDelay(attempt))
                    } else {
                        // Dropped after the budget. Events are telemetry, not
                        // answers; nothing blocks or queues past this point.
                        log("event \(kind.rawValue) not delivered: \(error)")
                        // Observability slice 4: the drop is itself a
                        // failure-shaped site. Guarded against the obvious
                        // loop — a client_error that cannot be posted must
                        // not manufacture another client_error.
                        if kind != .clientError {
                            ClientErrorLog.shared?.record(
                                kind: "event_not_delivered",
                                message: "\(error)",
                                context: ["event_kind": kind.rawValue]
                            )
                        }
                    }
                }
            }
        }
    }

    /// The lockdown lifecycle in wire terms, so the app target wires
    /// `onSessionEvent` straight through without owning the mapping.
    @discardableResult
    public func report(_ event: AssessmentLockdown.SessionEvent) -> Task<Void, Never> {
        switch event {
        case .didBegin:
            return report(.lockdownBegin)
        case .didEnd:
            return report(.lockdownEnd)
        case .failedToBegin(let reason):
            return report(.lockdownFailed, detail: ["reason": reason])
        case .interrupted(let reason):
            return report(.lockdownInterrupted, detail: ["reason": reason])
        }
    }
}
