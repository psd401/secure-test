import Foundation

/// The attempt's clock, as a pure model
/// (`docs/time-limit-and-unfinished-attempts-design.md`, D-2 / D-3).
///
/// Everything the time limit does — the banner text, the two notices, the
/// danger flag, the end of the session at zero — is decided here and reported
/// through callbacks, so the whole of it is exercised by `swift test` with a
/// `ManualLockdownScheduler`. The AppKit side owns only the presentation: it
/// pushes the text into the page, shows a notice strip, and ends the lockdown.
/// That is the same seam the lockdown controller uses, and for the same reason
/// (ADR 0013 — anything only verifiable by driving a UI cannot be verified in
/// this environment at all).
///
/// The deadline is a `Date` and every tick READS the clock rather than
/// decrementing a counter: a Mac that sleeps for ten minutes mid-test must come
/// back with ten fewer minutes, not with the ten it was not awake for.
public final class TimeLimitCountdown {
    /// The two unobtrusive warnings (D-3). Each fires at most once per
    /// countdown, including the late-start case where the app opens with less
    /// than five (or one) minute left and both are already due.
    public enum Notice: String, Equatable, Sendable, CaseIterable {
        case fiveMinutes
        case oneMinute

        /// Seconds remaining at or below which the notice is due.
        public var threshold: TimeInterval {
            switch self {
            case .fiveMinutes: return 300
            case .oneMinute: return 60
            }
        }

        /// What the strip reads. Wording is the design page's.
        public var text: String {
            switch self {
            case .fiveMinutes: return "5 minutes left"
            case .oneMinute: return "1 minute left"
            }
        }
    }

    /// Under a minute the banner turns Clay.
    public static let dangerThreshold: TimeInterval = 60

    /// The banner's text and whether it should be in the danger colour.
    /// Suppressed once the student has dismissed the banner — and only that.
    public var onTick: ((String, Bool) -> Void)?
    /// A notice became due. Never fires twice for the same notice.
    public var onNotice: ((Notice) -> Void)?
    /// Zero. Fires exactly once, after which the countdown has stopped.
    public var onExpired: (() -> Void)?

    private let deadline: Date
    private let now: () -> Date
    private let scheduler: LockdownScheduler
    private var timer: LockdownTimer?
    private var delivered: Set<Notice> = []
    private var expired = false

    /// The student pressed the banner's ×. Hides the banner for the rest of the
    /// attempt; the notices and the expiry are NOT the student's to switch off.
    public private(set) var isDismissed = false

    public init(
        deadline: Date,
        now: @escaping () -> Date = { Date() },
        scheduler: LockdownScheduler
    ) {
        self.deadline = deadline
        self.now = now
        self.scheduler = scheduler
    }

    /// Seconds left, floored at zero.
    public var remaining: TimeInterval {
        max(0, deadline.timeIntervalSince(now()))
    }

    /// Emits the first tick immediately — so the banner never shows a blank
    /// minute — and then once a second.
    public func start() {
        guard timer == nil, !expired else { return }
        timer = scheduler.schedule(after: 1, repeats: true) { [weak self] in
            self?.tick()
        }
        tick()
    }

    public func stop() {
        timer?.cancel()
        timer = nil
    }

    public func dismiss() {
        isDismissed = true
    }

    private func tick() {
        let left = remaining
        if !isDismissed {
            onTick?(Self.text(for: left), left < Self.dangerThreshold)
        }
        guard left > 0 else {
            guard !expired else { return }
            expired = true
            // Disarmed BEFORE the callback: ending the session is not
            // instantaneous, and a repeating timer that keeps firing through it
            // would end it again every second.
            stop()
            onExpired?()
            return
        }
        for notice in Notice.allCases where left <= notice.threshold && !delivered.contains(notice) {
            delivered.insert(notice)
            onNotice?(notice)
        }
    }

    /// EX-1: the deadline this clock counts down to.
    public var currentDeadline: Date { deadline }

    /// EX-1: has the server's deadline moved enough to restart the clock?
    ///
    /// The poll's deadline is rebuilt from `ends_at − server_now` at receipt,
    /// so the same server deadline arrives a little different on every poll
    /// (network time). `tolerance` swallows that jitter; a teacher's change is
    /// minutes, not seconds. No running clock (an untimed attempt that just
    /// got an override) is always a change.
    public static func deadlineChanged(
        from current: Date?,
        to new: Date,
        tolerance: TimeInterval = 3
    ) -> Bool {
        guard let current else { return true }
        return abs(new.timeIntervalSince(current)) > tolerance
    }

    /// EX-1: what the student reads when the teacher moves their deadline.
    public static func changedNoticeText(
        deadline: Date,
        timeZone: TimeZone = .current,
        locale: Locale = .current
    ) -> String {
        let formatter = DateFormatter()
        formatter.dateStyle = .none
        formatter.timeStyle = .short
        formatter.timeZone = timeZone
        formatter.locale = locale
        return "Your teacher changed your time. The test now ends at \(formatter.string(from: deadline))."
    }

    /// `mm:ss`, and `h:mm:ss` past an hour. Rounded UP, so a limit of exactly
    /// five minutes reads "5:00" at the first tick and "0:00" only at zero.
    public static func text(for remaining: TimeInterval) -> String {
        let total = Int(ceil(max(0, remaining)))
        let seconds = total % 60
        let minutes = (total / 60) % 60
        let hours = total / 3600
        if hours > 0 {
            return String(format: "%d:%02d:%02d", hours, minutes, seconds)
        }
        return String(format: "%d:%02d", minutes, seconds)
    }
}
