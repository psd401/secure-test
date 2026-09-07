import XCTest
@testable import SecureTestCore

/// Observability slice 4: the drain after sign-in.
///
/// The rule under test is the one that decides whether an error is ever seen
/// again: a line leaves the file only once the server has said it took it.
final class ClientErrorDrainTests: XCTestCase {
    private var directory: URL!

    override func setUp() {
        super.setUp()
        directory = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("client-error-drain-\(UUID().uuidString)", isDirectory: true)
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: directory)
        super.tearDown()
    }

    private func makeLog() throws -> ClientErrorLog {
        try ClientErrorLog(
            fileURL: directory.appendingPathComponent("errors.log"),
            stamp: AppBuildStamp(version: "1.0.0", commit: "abc1234")
        )
    }

    /// The network, swapped out. `failFrom` makes the Nth batch throw.
    private final class StubUploader: ClientErrorUploading, @unchecked Sendable {
        private let lock = NSLock()
        private var _batches: [[ClientErrorEntry]] = []
        let failFrom: Int?

        init(failFrom: Int? = nil) { self.failFrom = failFrom }

        var batches: [[ClientErrorEntry]] {
            lock.lock()
            defer { lock.unlock() }
            return _batches
        }

        func postClientErrors(_ entries: [ClientErrorEntry]) async throws -> Int {
            lock.lock()
            let index = _batches.count
            lock.unlock()
            if let failFrom, index >= failFrom {
                throw APIError.refused(status: 500, code: nil)
            }
            lock.lock()
            _batches.append(entries)
            lock.unlock()
            return entries.count
        }
    }

    func testEmptyFileSendsNothing() async throws {
        let log = try makeLog()
        let api = StubUploader()
        let sent = await ClientErrorDrain.drain(log: log, api: api)

        XCTAssertEqual(sent, 0)
        XCTAssertEqual(api.batches.count, 0)
    }

    func testSendsOneBatchAndEmptiesTheFile() async throws {
        let log = try makeLog()
        log.record(kind: "join_failed", message: "one")
        log.record(kind: "join_failed", message: "two")

        let api = StubUploader()
        let sent = await ClientErrorDrain.drain(log: log, api: api)

        XCTAssertEqual(sent, 2)
        XCTAssertEqual(api.batches.count, 1)
        XCTAssertEqual(api.batches[0].map(\.message), ["one", "two"])
        XCTAssertEqual(log.readEntries(), [], "accepted lines leave the file")
    }

    func testMoreThanFiftyLoopsInBatches() async throws {
        let log = try makeLog()
        for index in 0..<120 { log.record(kind: "spool_failed", message: "line \(index)") }

        let api = StubUploader()
        let sent = await ClientErrorDrain.drain(log: log, api: api)

        XCTAssertEqual(sent, 120)
        XCTAssertEqual(api.batches.map(\.count), [50, 50, 20])
        XCTAssertEqual(api.batches[0][0].message, "line 0")
        XCTAssertEqual(api.batches[2][19].message, "line 119")
        XCTAssertEqual(log.readEntries(), [])
    }

    func testAFailureKeepsTheFile() async throws {
        let log = try makeLog()
        log.record(kind: "join_failed", message: "one")

        let api = StubUploader(failFrom: 0)
        let sent = await ClientErrorDrain.drain(log: log, api: api)

        XCTAssertEqual(sent, 0)
        XCTAssertEqual(log.readEntries().map(\.message), ["one"], "nothing accepted, nothing lost")
    }

    func testAMidwayFailureKeepsOnlyWhatWasNotAccepted() async throws {
        let log = try makeLog()
        for index in 0..<120 { log.record(kind: "spool_failed", message: "line \(index)") }

        let api = StubUploader(failFrom: 1)  // first batch lands, second throws
        let sent = await ClientErrorDrain.drain(log: log, api: api)

        XCTAssertEqual(sent, 50)
        let kept = log.readEntries()
        XCTAssertEqual(kept.count, 70)
        XCTAssertEqual(kept.first?.message, "line 50")
        XCTAssertEqual(kept.last?.message, "line 119")
    }

    /// A line written while a POST was in flight has never been sent
    /// anywhere, so the drain must not take it away with the accepted ones.
    func testALineAppendedDuringTheDrainSurvives() async throws {
        let log = try makeLog()
        log.record(kind: "join_failed", message: "one")

        final class Appender: ClientErrorUploading, @unchecked Sendable {
            let log: ClientErrorLog
            init(log: ClientErrorLog) { self.log = log }
            func postClientErrors(_ entries: [ClientErrorEntry]) async throws -> Int {
                log.record(kind: "spool_failed", message: "arrived mid-flight")
                return entries.count
            }
        }

        let sent = await ClientErrorDrain.drain(log: log, api: Appender(log: log))
        XCTAssertEqual(sent, 1)
        XCTAssertEqual(log.readEntries().map(\.message), ["arrived mid-flight"])
    }

    /// The crash line has no `occurred_at` — nothing in a signal handler may
    /// read a clock — so the POST body gets the drain's own time rather than
    /// dropping the line.
    func testAnEntryWithoutATimeIsStampedAtDrainTime() {
        let entry = ClientErrorEntry(
            occurredAt: nil,
            kind: CrashReporter.crashKind,
            message: "fatal signal SIGSEGV",
            appVersion: "1.0.0",
            appCommit: "abc1234",
            attemptID: "attempt-7"
        )
        let object = entry.jsonObject(occurredAtFallback: "2026-09-07T12:00:00Z")

        XCTAssertEqual(object["occurred_at"] as? String, "2026-09-07T12:00:00Z")
        XCTAssertEqual((object["context"] as? [String: String])?["attempt_id"], "attempt-7")
        XCTAssertEqual(object["app_commit"] as? String, "abc1234")
    }
}
