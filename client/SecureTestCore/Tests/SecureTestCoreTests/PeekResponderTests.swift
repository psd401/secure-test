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
        private var _fetchError: Error?
        private var _fetchCount = 0
        private var _uploads: [(peekID: String, imageBase64: String)] = []
        private var _uploadError: Error?
        private var _requested: [PendingPeek] = []
        private var _logs: [String] = []

        var pending: PendingPeek? {
            get { lock.withLock { _pending } }
            set { lock.withLock { _pending = newValue } }
        }
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
        var logs: [String] { lock.withLock { _logs } }

        func countFetch() { lock.withLock { _fetchCount += 1 } }
        func recordUpload(_ peekID: String, _ imageBase64: String) {
            lock.withLock { _uploads.append((peekID, imageBase64)) }
        }
        func recordRequest(_ pending: PendingPeek) { lock.withLock { _requested.append(pending) } }
        func log(_ line: String) { lock.withLock { _logs.append(line) } }
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
                return probe.pending
            },
            upload: { peekID, imageBase64 in
                if let error = probe.uploadError { throw error }
                probe.recordUpload(peekID, imageBase64)
            }
        )
        responder.onPeekRequested = { probe.recordRequest($0) }
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
