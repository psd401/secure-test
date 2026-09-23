import XCTest
@testable import SecureTestCore

/// On-demand peek P2: the poll/notify/deliver state machine, on the manual
/// scheduler so every timing assertion is exact.
final class PeekResponderTests: XCTestCase {

    /// 9.2: the responder's poll runs on a detached Task while the test
    /// reads these from its own executor, so every field goes through one
    /// lock — the 2026-08-28 flake was `logs.append` racing `logs.filter`
    /// (`Index out of range`, process-killing).
    private final class Probe: @unchecked Sendable {
        private let lock = NSLock()
        private var _pending: PendingPeek?
        private var _sitting: SittingState?
        private var _fetchError: Error?
        private var _fetchCount = 0
        private var _uploads: [(peekID: String, imageBase64: String)] = []
        private var _uploadError: Error?
        private var _requested: [PendingPeek] = []
        private var _logs: [String] = []
        private var _closedCount = 0
        private var _wireDeadline: (endsAt: String, serverNow: String)?
        private var _deadlines: [Date] = []

        var pending: PendingPeek? {
            get { lock.withLock { _pending } }
            set { lock.withLock { _pending = newValue } }
        }
        /// Row CS: what the poll says about the sitting. nil = the field was
        /// absent, which is every server older than row CS.
        var sitting: SittingState? {
            get { lock.withLock { _sitting } }
            set { lock.withLock { _sitting = newValue } }
        }
        /// EX-1: the poll's deadline pair, nil = absent (untimed / older server).
        var wireDeadline: (endsAt: String, serverNow: String)? {
            get { lock.withLock { _wireDeadline } }
            set { lock.withLock { _wireDeadline = newValue } }
        }
        var deadlines: [Date] { lock.withLock { _deadlines } }
        func recordDeadline(_ d: Date) { lock.withLock { _deadlines.append(d) } }
        var fetchError: Error? {
            get { lock.withLock { _fetchError } }
            set { lock.withLock { _fetchError = newValue } }
        }
        var fetchCount: Int { lock.withLock { _fetchCount } }
        var uploads: [(peekID: String, imageBase64: String)] { lock.withLock { _uploads } }
        var uploadError: Error? {
            get { lock.withLock { _uploadError } }
            set { lock.withLock { _uploadError = newValue } }
        }
        var requested: [PendingPeek] { lock.withLock { _requested } }
        var closedCount: Int { lock.withLock { _closedCount } }
        var logs: [String] { lock.withLock { _logs } }

        func countFetch() { lock.withLock { _fetchCount += 1 } }
        func recordUpload(_ peekID: String, _ imageBase64: String) {
            lock.withLock { _uploads.append((peekID, imageBase64)) }
        }
        func recordRequest(_ pending: PendingPeek) { lock.withLock { _requested.append(pending) } }
        func log(_ line: String) { lock.withLock { _logs.append(line) } }
        func countClosed() { lock.withLock { _closedCount += 1 } }
    }

    private struct StubError: Error {}

    private func makeResponder(
        _ probe: Probe,
        scheduler: ManualLockdownScheduler
    ) -> PeekResponder {
        let responder = PeekResponder(
            interval: 5,
            scheduler: scheduler,
            log: { probe.log($0) },
            fetchPending: {
                probe.countFetch()
                if let error = probe.fetchError { throw error }
                let wire = probe.wireDeadline
                return PeekPoll(
                    pending: probe.pending,
                    sitting: probe.sitting,
                    timeLimitEndsAt: wire?.endsAt,
                    serverNow: wire?.serverNow
                )
            },
            upload: { peekID, imageBase64 in
                if let error = probe.uploadError { throw error }
                probe.recordUpload(peekID, imageBase64)
            }
        )
        responder.onPeekRequested = { probe.recordRequest($0) }
        responder.onSittingClosed = { probe.countClosed() }
        responder.onDeadline = { probe.recordDeadline($0) }
        return responder
    }

    /// The poll's Task hops through the concurrency runtime; drain it before
    /// asserting. The manual scheduler fires synchronously, the fetch does
    /// not. 9.2: wait until the responder reports the poll finished rather
    /// than yielding a guessed number of times — bounded so a hung poll
    /// fails the test instead of hanging it.
    private func drain(_ responder: PeekResponder) async {
        var spins = 0
        while responder.pollInFlight && spins < 100_000 {
            await Task.yield()
            spins += 1
        }
        XCTAssertFalse(responder.pollInFlight, "poll never finished")
    }

    func testPollsOnTheIntervalAndSurfacesAPendingPeekOnce() async {
        let scheduler = ManualLockdownScheduler()
        let probe = Probe()
        let responder = makeResponder(probe, scheduler: scheduler)
        responder.start()

        scheduler.advance(by: 4.9)
        XCTAssertEqual(probe.fetchCount, 0)

        probe.pending = PendingPeek(id: "peek-1")
        scheduler.advance(by: 0.1)
        await drain(responder)
        XCTAssertEqual(probe.fetchCount, 1)
        XCTAssertEqual(probe.requested.map(\.id), ["peek-1"])

        // The same id on later polls is the same ask — once means once.
        scheduler.advance(by: 10)
        await drain(responder)
        XCTAssertEqual(probe.requested.map(\.id), ["peek-1"])
        responder.stop()
    }

    func testANewIdFiresAgainAndNilFiresNothing() async {
        let scheduler = ManualLockdownScheduler()
        let probe = Probe()
        let responder = makeResponder(probe, scheduler: scheduler)
        responder.start()

        scheduler.advance(by: 5)
        await drain(responder)
        XCTAssertEqual(probe.requested.count, 0)

        probe.pending = PendingPeek(id: "peek-1")
        scheduler.advance(by: 5)
        await drain(responder)
        probe.pending = PendingPeek(id: "peek-2")
        scheduler.advance(by: 5)
        await drain(responder)
        XCTAssertEqual(probe.requested.map(\.id), ["peek-1", "peek-2"])
        responder.stop()
    }

    func testStopCancelsThePollAndSilencesTheCallback() async {
        let scheduler = ManualLockdownScheduler()
        let probe = Probe()
        let responder = makeResponder(probe, scheduler: scheduler)
        responder.start()
        responder.stop()

        probe.pending = PendingPeek(id: "peek-1")
        scheduler.advance(by: 30)
        await drain(responder)
        XCTAssertEqual(probe.fetchCount, 0)
        XCTAssertEqual(probe.requested.count, 0)
        XCTAssertEqual(scheduler.pendingCount, 0)
    }

    func testStartIsIdempotent() {
        let scheduler = ManualLockdownScheduler()
        let probe = Probe()
        let responder = makeResponder(probe, scheduler: scheduler)
        responder.start()
        responder.start()
        XCTAssertEqual(scheduler.pendingCount, 1)
        responder.stop()
    }

    func testPollFailureLogsOnTransitionOnlyAndRecovers() async {
        let scheduler = ManualLockdownScheduler()
        let probe = Probe()
        let responder = makeResponder(probe, scheduler: scheduler)
        responder.start()

        probe.fetchError = StubError()
        scheduler.advance(by: 5)
        await drain(responder)
        scheduler.advance(by: 5)
        await drain(responder)
        XCTAssertEqual(probe.logs.filter { $0.contains("peek poll failing") }.count, 1)

        probe.fetchError = nil
        probe.pending = PendingPeek(id: "peek-1")
        scheduler.advance(by: 5)
        await drain(responder)
        XCTAssertEqual(probe.logs.filter { $0.contains("peek poll recovered") }.count, 1)
        XCTAssertEqual(probe.requested.map(\.id), ["peek-1"])
        responder.stop()
    }

    // MARK: row CS — the sitting

    /// D-5: a closed sitting reaches a working client through this poll, fires
    /// once, and stops the poll. Once, because the app's response is to end the
    /// secure session and send the student home — twice would stack sheets.
    func testAClosedSittingFiresOnceAndStopsThePoll() async {
        let scheduler = ManualLockdownScheduler()
        let probe = Probe()
        let responder = makeResponder(probe, scheduler: scheduler)
        responder.start()

        probe.sitting = .closed
        scheduler.advance(by: 5)
        await drain(responder)
        XCTAssertEqual(probe.closedCount, 1)
        XCTAssertEqual(scheduler.pendingCount, 0, "the poll stopped with it")

        // Nothing further is asked, so nothing further can fire.
        scheduler.advance(by: 30)
        await drain(responder)
        XCTAssertEqual(probe.closedCount, 1)
        XCTAssertEqual(probe.fetchCount, 1)
    }

    /// An absent field is every server older than row CS: open, forever.
    func testAnAbsentSittingFieldNeverFires() async {
        let scheduler = ManualLockdownScheduler()
        let probe = Probe()
        let responder = makeResponder(probe, scheduler: scheduler)
        responder.start()

        probe.sitting = nil
        probe.pending = PendingPeek(id: "peek-1")
        scheduler.advance(by: 15)
        await drain(responder)
        XCTAssertEqual(probe.closedCount, 0)
        XCTAssertEqual(probe.requested.map(\.id), ["peek-1"], "peek still works")
        responder.stop()
    }

    func testAnOpenSittingNeverFires() async {
        let scheduler = ManualLockdownScheduler()
        let probe = Probe()
        let responder = makeResponder(probe, scheduler: scheduler)
        responder.start()

        probe.sitting = .open
        // One tick per advance: a tick that lands while a poll is in flight
        // is skipped, so a single 20 s jump counts as one fetch.
        scheduler.advance(by: 5)
        await drain(responder)
        scheduler.advance(by: 5)
        await drain(responder)
        XCTAssertEqual(probe.closedCount, 0)
        XCTAssertEqual(probe.fetchCount, 2, "still polling")
        responder.stop()
    }

    /// A closed sitting takes precedence over a peek request arriving in the
    /// same answer: the attempt is over, and the render would be the last thing
    /// this responder ever did.
    func testAClosedSittingWinsOverAPendingPeekInTheSameAnswer() async {
        let scheduler = ManualLockdownScheduler()
        let probe = Probe()
        let responder = makeResponder(probe, scheduler: scheduler)
        responder.start()

        probe.sitting = .closed
        probe.pending = PendingPeek(id: "peek-1")
        scheduler.advance(by: 5)
        await drain(responder)
        XCTAssertEqual(probe.closedCount, 1)
        XCTAssertEqual(probe.requested.count, 0)
    }

    /// EX-1: a poll carrying the deadline reports it, as a DURATION from
    /// receipt (ends_at − server_now), on every poll; none when absent.
    func testAPollWithADeadlineReportsItEveryPoll() async {
        let scheduler = ManualLockdownScheduler()
        let probe = Probe()
        let responder = makeResponder(probe, scheduler: scheduler)
        responder.start()

        scheduler.advance(by: 5)
        await drain(responder)
        XCTAssertTrue(probe.deadlines.isEmpty, "untimed: nothing reported")

        probe.wireDeadline = ("2026-09-23T22:00:00.000Z", "2026-09-23T21:00:00.000Z")
        let before = Date()
        scheduler.advance(by: 5)
        await drain(responder)
        scheduler.advance(by: 5)
        await drain(responder)
        XCTAssertEqual(probe.deadlines.count, 2)
        let left = probe.deadlines[0].timeIntervalSince(before)
        XCTAssertEqual(left, 3600, accuracy: 5, "an hour from receipt, whatever this Mac's clock says")
        responder.stop()
    }

    /// A closed sitting stops the responder before the deadline is read.
    func testAClosedSittingReportsNoDeadline() async {
        let scheduler = ManualLockdownScheduler()
        let probe = Probe()
        let responder = makeResponder(probe, scheduler: scheduler)
        responder.start()
        probe.sitting = .closed
        probe.wireDeadline = ("2026-09-23T22:00:00.000Z", "2026-09-23T21:00:00.000Z")
        scheduler.advance(by: 5)
        await drain(responder)
        XCTAssertEqual(probe.closedCount, 1)
        XCTAssertTrue(probe.deadlines.isEmpty)
    }

    /// Both or neither; an unparseable or wrong-typed value costs the timer,
    /// never the poll (the sitting answer rides the same body).
    func testPeekPollDecodesTheDeadlinePermissively() throws {
        func poll(_ json: String) throws -> PeekPoll {
            try JSONDecoder().decode(PeekPoll.self, from: Data(json.utf8))
        }
        let both = try poll(#"{"pending":null,"sitting":"open","time_limit_ends_at":"2026-09-23T22:00:00.000Z","server_now":"2026-09-23T21:30:00.000Z"}"#)
        let at = Date(timeIntervalSince1970: 1_000_000)
        XCTAssertEqual(both.deadline(receivedAt: at), at.addingTimeInterval(1800))
        XCTAssertNil(try poll(#"{"pending":null,"time_limit_ends_at":"2026-09-23T22:00:00.000Z"}"#).deadline())
        XCTAssertNil(try poll(#"{"pending":null,"time_limit_ends_at":"soon","server_now":"now"}"#).deadline())
        let wrongType = try poll(#"{"pending":null,"sitting":"closed","time_limit_ends_at":5,"server_now":true}"#)
        XCTAssertNil(wrongType.deadline())
        XCTAssertTrue(wrongType.sittingIsClosed, "the rest of the poll still decodes")
        XCTAssertNil(try poll(#"{"pending":null}"#).deadline())
    }

    /// Unknown value → open. The client must never end a test because the
    /// server said something it did not recognise.
    func testPeekPollDecodesTheSittingFieldPermissively() throws {
        func poll(_ json: String) throws -> PeekPoll {
            try JSONDecoder().decode(PeekPoll.self, from: Data(json.utf8))
        }
        XCTAssertEqual(try poll(#"{"pending":null,"sitting":"closed"}"#).sitting, .closed)
        XCTAssertTrue(try poll(#"{"pending":null,"sitting":"closed"}"#).sittingIsClosed)
        XCTAssertEqual(try poll(#"{"pending":null,"sitting":"open"}"#).sitting, .open)
        XCTAssertFalse(try poll(#"{"pending":null,"sitting":"open"}"#).sittingIsClosed)
        XCTAssertNil(try poll(#"{"pending":null}"#).sitting)
        XCTAssertFalse(try poll(#"{"pending":null}"#).sittingIsClosed)
        XCTAssertNil(try poll(#"{"pending":null,"sitting":"something-new"}"#).sitting)
        XCTAssertFalse(try poll(#"{"pending":null,"sitting":"something-new"}"#).sittingIsClosed)
    }

    func testDeliverUploadsTheFrame() async {
        let scheduler = ManualLockdownScheduler()
        let probe = Probe()
        let responder = makeResponder(probe, scheduler: scheduler)

        await responder.deliver(peekID: "peek-1", imageBase64: "aGVsbG8=").value
        XCTAssertEqual(probe.uploads.count, 1)
        XCTAssertEqual(probe.uploads[0].peekID, "peek-1")
        XCTAssertEqual(probe.uploads[0].imageBase64, "aGVsbG8=")
    }

    func testDeliverFailureIsLoggedAndDropped() async {
        let scheduler = ManualLockdownScheduler()
        let probe = Probe()
        let responder = makeResponder(probe, scheduler: scheduler)
        probe.uploadError = StubError()

        await responder.deliver(peekID: "peek-1", imageBase64: "x").value
        XCTAssertEqual(probe.uploads.count, 0)
        XCTAssertEqual(probe.logs.filter { $0.contains("peek image not delivered") }.count, 1)
    }
}
