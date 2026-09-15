import XCTest
@testable import SecureTestCore

/// Observability slice 4: the on-disk error sink.
///
/// The properties worth pinning are the ones a drain and a human both depend
/// on: one JSON object per line, the version stamp on every one of them, the
/// message capped, appends surviving each other, and lines leaving the file
/// only from the front.
final class ClientErrorLogTests: XCTestCase {
    private var directory: URL!

    override func setUp() {
        super.setUp()
        directory = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("client-error-log-\(UUID().uuidString)", isDirectory: true)
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: directory)
        super.tearDown()
    }

    private func makeLog(now: @escaping @Sendable () -> Date = { Date(timeIntervalSince1970: 0) })
        throws -> ClientErrorLog
    {
        try ClientErrorLog(
            fileURL: directory.appendingPathComponent("errors.log"),
            stamp: AppBuildStamp(version: "1.0.0", commit: "abc1234"),
            now: now
        )
    }

    private func lines(_ log: ClientErrorLog) throws -> [[String: Any]] {
        let text = try String(contentsOf: log.fileURL, encoding: .utf8)
        return text.split(separator: "\n").compactMap {
            try? JSONSerialization.jsonObject(with: Data($0.utf8)) as? [String: Any]
        }
    }

    func testWritesOneJSONLineCarryingTheStamp() throws {
        let log = try makeLog()
        log.record(kind: "join_failed", message: "refused 403", context: ["code": "not_on_roster"])

        let written = try lines(log)
        XCTAssertEqual(written.count, 1)
        XCTAssertEqual(written[0]["kind"] as? String, "join_failed")
        XCTAssertEqual(written[0]["message"] as? String, "refused 403")
        XCTAssertEqual(written[0]["app_version"] as? String, "1.0.0")
        XCTAssertEqual(written[0]["app_commit"] as? String, "abc1234")
        XCTAssertEqual(written[0]["occurred_at"] as? String, "1970-01-01T00:00:00Z")
        XCTAssertEqual(
            (written[0]["context"] as? [String: String])?["code"], "not_on_roster"
        )
        XCTAssertNil(written[0]["attempt_id"], "no attempt was open")
    }

    func testStampsTheAttemptWhenOneIsOpen() throws {
        let log = try makeLog()
        log.attemptID = "attempt-7"
        log.record(kind: "submit_failed", message: "network down")

        XCTAssertEqual(try lines(log)[0]["attempt_id"] as? String, "attempt-7")
    }

    func testTruncatesALongMessage() throws {
        let log = try makeLog()
        log.record(kind: "spool_failed", message: String(repeating: "x", count: 5000))

        let message = try lines(log)[0]["message"] as? String
        XCTAssertEqual(message?.count, ClientErrorLog.maxMessageLength)
    }

    func testAppendsRatherThanOverwriting() throws {
        let log = try makeLog()
        log.record(kind: "a", message: "one")
        log.record(kind: "b", message: "two")
        log.record(kind: "c", message: "three")

        XCTAssertEqual(try lines(log).compactMap { $0["kind"] as? String }, ["a", "b", "c"])
        XCTAssertEqual(log.readEntries().map(\.kind), ["a", "b", "c"])
    }

    func testASecondLogAppendsToTheSameFile() throws {
        let first = try makeLog()
        first.record(kind: "a", message: "one")
        let second = try makeLog()
        second.record(kind: "b", message: "two")

        XCTAssertEqual(second.readEntries().map(\.kind), ["a", "b"])
    }

    func testRemoveFirstLinesKeepsTheRest() throws {
        let log = try makeLog()
        log.record(kind: "a", message: "one")
        log.record(kind: "b", message: "two")
        log.record(kind: "c", message: "three")

        log.removeFirstLines(2)
        XCTAssertEqual(log.readEntries().map(\.kind), ["c"])

        // And the descriptor still works after the rewrite.
        log.record(kind: "d", message: "four")
        XCTAssertEqual(log.readEntries().map(\.kind), ["c", "d"])
    }

    func testTruncateEmptiesTheFile() throws {
        let log = try makeLog()
        log.record(kind: "a", message: "one")
        log.truncate()

        XCTAssertEqual(log.readEntries(), [])
        log.record(kind: "b", message: "two")
        XCTAssertEqual(log.readEntries().map(\.kind), ["b"])
    }

    func testUnreadableLinesAreSkippedRatherThanFatal() throws {
        let log = try makeLog()
        log.record(kind: "a", message: "one")
        // A crash mid-write leaves a partial line; it should cost that line
        // and nothing else.
        let handle = try FileHandle(forWritingTo: log.fileURL)
        handle.seekToEndOfFile()
        handle.write(Data("{\"kind\":\"tru".utf8))
        try handle.close()

        XCTAssertEqual(log.readEntries().map(\.kind), ["a"])
    }

    func testOnRecordAndEchoFire() throws {
        let log = try makeLog()
        let box = Box()
        log.echo = { [box] in box.append("echo:\($0)") }
        log.onRecord = { [box] in box.append("record:\($0.kind)") }
        log.record(kind: "join_failed", message: "nope")

        XCTAssertEqual(box.values, ["echo:join_failed: nope", "record:join_failed"])
    }

    /// D-4: the wire name for the in-attempt copy, and the round trip the
    /// server's closed set depends on.
    func testClientErrorEventKindRoundTrip() {
        XCTAssertEqual(AttemptEventKind.clientError.rawValue, "client_error")
        XCTAssertEqual(AttemptEventKind(rawValue: "client_error"), .clientError)
        XCTAssertTrue(AttemptEventKind.allCases.contains(.clientError))
        XCTAssertTrue(AttemptEventReporter.retriedKinds.contains(.clientError))
    }

    private final class Box: @unchecked Sendable {
        private let lock = NSLock()
        private var storage: [String] = []
        var values: [String] {
            lock.lock()
            defer { lock.unlock() }
            return storage
        }
        func append(_ value: String) {
            lock.lock()
            storage.append(value)
            lock.unlock()
        }
    }
}

/// Client hygiene (2026-09-15, audit #18): before the cap the only thing that
/// ever shortened `errors.log` was a successful drain, so a Mac that never
/// signs in — an unconfigured one, or one whose server is unreachable — grew
/// the file forever, and a crash loop grew it fast.
extension ClientErrorLogTests {
    private func cappedLog(maxLines: Int, maxBytes: Int = 512 * 1024) throws -> ClientErrorLog {
        try ClientErrorLog(
            fileURL: directory.appendingPathComponent("errors.log"),
            stamp: AppBuildStamp(version: "1.0.0", commit: "abc1234"),
            now: { Date(timeIntervalSince1970: 0) },
            maxLines: maxLines,
            maxBytes: maxBytes
        )
    }

    func testTheFileIsCappedByLineCount() throws {
        let log = try cappedLog(maxLines: 5)
        for index in 0..<20 {
            log.record(kind: "loop", message: "line \(index)")
        }

        let entries = log.readEntries()
        XCTAssertEqual(entries.count, 5)
        XCTAssertEqual(
            entries.map(\.message),
            ["line 15", "line 16", "line 17", "line 18", "line 19"],
            "the NEWEST lines are what a human and the drain both want kept"
        )
    }

    func testTheFileIsCappedByBytes() throws {
        let log = try cappedLog(maxLines: 100, maxBytes: 1024)
        for index in 0..<200 {
            log.record(kind: "loop", message: String(repeating: "x", count: 200))
        }

        let size = try Data(contentsOf: log.fileURL).count
        XCTAssertLessThan(size, 100 * 1024, "the byte bound trims long before the line bound")
        XCTAssertFalse(log.readEntries().isEmpty, "trimming keeps the newest lines, not none")
    }

    /// A file a previous launch left over the cap is trimmed on the first
    /// write of this one, not on the five-hundredth.
    func testAnOversizeFileFromAnEarlierLaunchIsTrimmedAtOnce() throws {
        let first = try cappedLog(maxLines: 5)
        for index in 0..<5 {
            first.record(kind: "old", message: "old \(index)")
        }
        XCTAssertEqual(first.readEntries().count, 5)

        let second = try cappedLog(maxLines: 5)
        second.record(kind: "new", message: "fresh")

        let entries = second.readEntries()
        XCTAssertEqual(entries.count, 5)
        XCTAssertEqual(entries.last?.message, "fresh")
        XCTAssertEqual(entries.first?.message, "old 1", "the oldest line went, not the newest")
    }

    /// The drain still owns the front of the file — the cap must not have
    /// broken `removeFirstLines`, which is the path that sends and prunes.
    func testTheDrainStillPrunesFromTheFront() throws {
        let log = try cappedLog(maxLines: 50)
        for index in 0..<6 {
            log.record(kind: "k", message: "m\(index)")
        }
        log.removeFirstLines(2)

        XCTAssertEqual(log.readEntries().map(\.message), ["m2", "m3", "m4", "m5"])

        log.record(kind: "k", message: "m6")
        XCTAssertEqual(log.readEntries().count, 5, "the counters survived the rewrite")
    }
}
