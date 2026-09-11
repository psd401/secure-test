import XCTest
@testable import SecureTestCore

/// Time limit slice 2 (`docs/time-limit-and-unfinished-attempts-design.md`).
///
/// The whole clock, driven by `ManualLockdownScheduler` exactly as the lockdown
/// suites drive theirs: no wall clock, no sleeps, and every boundary — the
/// minute the notices fire on, the second the banner turns Clay, the instant
/// zero arrives — asserted rather than waited for.
final class TimeLimitCountdownTests: XCTestCase {
    /// A countdown whose "now" is the manual scheduler's own clock, so
    /// advancing the scheduler advances time itself.
    private func makeCountdown(
        secondsLeft: TimeInterval,
        scheduler: ManualLockdownScheduler
    ) -> TimeLimitCountdown {
        let base = Date(timeIntervalSince1970: 1_700_000_000)
        return TimeLimitCountdown(
            deadline: base.addingTimeInterval(secondsLeft),
            now: { base.addingTimeInterval(scheduler.now) },
            scheduler: scheduler
        )
    }

    // MARK: text

    func testFormatsMinutesAndSecondsAndHoursPastAnHour() {
        XCTAssertEqual(TimeLimitCountdown.text(for: 2537), "42:17")
        XCTAssertEqual(TimeLimitCountdown.text(for: 300), "5:00")
        XCTAssertEqual(TimeLimitCountdown.text(for: 59), "0:59")
        XCTAssertEqual(TimeLimitCountdown.text(for: 0), "0:00")
        XCTAssertEqual(TimeLimitCountdown.text(for: -5), "0:00")
        XCTAssertEqual(TimeLimitCountdown.text(for: 3909), "1:05:09")
        XCTAssertEqual(TimeLimitCountdown.text(for: 3600), "1:00:00")
        // Rounded UP, so a 45-minute limit reads 45:00 on the first tick rather
        // than 44:59 a fraction of a second in.
        XCTAssertEqual(TimeLimitCountdown.text(for: 2699.6), "45:00")
    }

    // MARK: ticking

    func testEmitsTheFirstTickImmediatelyThenOncePerSecond() {
        let scheduler = ManualLockdownScheduler()
        let clock = makeCountdown(secondsLeft: 120, scheduler: scheduler)
        var texts: [String] = []
        clock.onTick = { text, _ in texts.append(text) }
        clock.start()

        XCTAssertEqual(texts, ["2:00"], "the banner must never show a blank minute")
        scheduler.advance(by: 3)
        XCTAssertEqual(texts, ["2:00", "1:59", "1:58", "1:57"])
    }

    func testDangerOnlyUnderTheLastMinute() {
        let scheduler = ManualLockdownScheduler()
        let clock = makeCountdown(secondsLeft: 61, scheduler: scheduler)
        var danger: [Bool] = []
        clock.onTick = { _, isDanger in danger.append(isDanger) }
        clock.start()
        scheduler.advance(by: 2)
        // 61s, 60s, 59s: the flag turns on only once the last minute is running.
        XCTAssertEqual(danger, [false, false, true])
    }

    // MARK: notices

    func testFiresEachNoticeExactlyOnce() {
        let scheduler = ManualLockdownScheduler()
        let clock = makeCountdown(secondsLeft: 320, scheduler: scheduler)
        var notices: [TimeLimitCountdown.Notice] = []
        clock.onNotice = { notices.append($0) }
        clock.start()

        XCTAssertEqual(notices, [], "nothing is due with more than five minutes left")
        scheduler.advance(by: 20)
        XCTAssertEqual(notices, [.fiveMinutes])
        scheduler.advance(by: 60)
        XCTAssertEqual(notices, [.fiveMinutes], "the five-minute notice never repeats")
        scheduler.advance(by: 180)
        XCTAssertEqual(notices, [.fiveMinutes, .oneMinute])
        scheduler.advance(by: 30)
        XCTAssertEqual(notices, [.fiveMinutes, .oneMinute])
    }

    /// A student who relaunches with four minutes left has already missed the
    /// five-minute mark; the notice is still owed to them.
    func testLateStartFiresEveryDueNoticeOnceImmediately() {
        let scheduler = ManualLockdownScheduler()
        let clock = makeCountdown(secondsLeft: 40, scheduler: scheduler)
        var notices: [TimeLimitCountdown.Notice] = []
        clock.onNotice = { notices.append($0) }
        clock.start()

        XCTAssertEqual(notices, [.fiveMinutes, .oneMinute])
        scheduler.advance(by: 10)
        XCTAssertEqual(notices, [.fiveMinutes, .oneMinute], "still once each")
    }

    func testNoticeTextIsTheDesignPageWording() {
        XCTAssertEqual(TimeLimitCountdown.Notice.fiveMinutes.text, "5 minutes left")
        XCTAssertEqual(TimeLimitCountdown.Notice.oneMinute.text, "1 minute left")
    }

    // MARK: expiry

    func testExpiresExactlyOnceAndStopsTicking() {
        let scheduler = ManualLockdownScheduler()
        let clock = makeCountdown(secondsLeft: 3, scheduler: scheduler)
        var texts: [String] = []
        var expiries = 0
        clock.onTick = { text, _ in texts.append(text) }
        clock.onExpired = { expiries += 1 }
        clock.start()

        scheduler.advance(by: 2)
        XCTAssertEqual(expiries, 0)
        scheduler.advance(by: 1)
        XCTAssertEqual(expiries, 1)
        XCTAssertEqual(texts.last, "0:00")
        // The timer is disarmed before the callback: ending a session is not
        // instantaneous, and a timer still firing through it would end it again
        // every second.
        XCTAssertEqual(scheduler.pendingCount, 0)
        scheduler.advance(by: 30)
        XCTAssertEqual(expiries, 1)
        XCTAssertEqual(texts.last, "0:00")
    }

    func testStartingAfterTheDeadlineExpiresAtOnce() {
        let scheduler = ManualLockdownScheduler()
        let clock = makeCountdown(secondsLeft: -10, scheduler: scheduler)
        var expiries = 0
        clock.onExpired = { expiries += 1 }
        clock.start()
        XCTAssertEqual(expiries, 1)
        XCTAssertEqual(scheduler.pendingCount, 0)
    }

    // MARK: dismissal (D-3)

    func testDismissHidesTheBannerButSuppressesNeitherNoticesNorExpiry() {
        let scheduler = ManualLockdownScheduler()
        let clock = makeCountdown(secondsLeft: 65, scheduler: scheduler)
        var texts: [String] = []
        var notices: [TimeLimitCountdown.Notice] = []
        var expiries = 0
        clock.onTick = { text, _ in texts.append(text) }
        clock.onNotice = { notices.append($0) }
        clock.onExpired = { expiries += 1 }
        clock.start()

        XCTAssertEqual(texts, ["1:05"])
        XCTAssertEqual(notices, [.fiveMinutes])
        clock.dismiss()
        XCTAssertTrue(clock.isDismissed)

        scheduler.advance(by: 65)
        XCTAssertEqual(texts, ["1:05"], "no banner text once the student hid it")
        XCTAssertEqual(notices, [.fiveMinutes, .oneMinute], "the notices are not theirs to switch off")
        XCTAssertEqual(expiries, 1, "neither is the end of the session")
    }

    func testStopEndsTheCountdown() {
        let scheduler = ManualLockdownScheduler()
        let clock = makeCountdown(secondsLeft: 10, scheduler: scheduler)
        var expiries = 0
        clock.onExpired = { expiries += 1 }
        clock.start()
        clock.stop()
        scheduler.advance(by: 60)
        XCTAssertEqual(expiries, 0)
        XCTAssertEqual(scheduler.pendingCount, 0)
    }
}
