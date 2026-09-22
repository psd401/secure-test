import XCTest
@testable import SecureTestCore

/// Observability slice 4, D-11: crash capture is best effort.
///
/// The signal path itself is hand-run (MANUAL-CHECKS, "Observability slice 4")
/// — a test that raises SIGSEGV kills the test runner. What IS verifiable here
/// is the half that decides whether the hand-run produces anything readable:
/// the line is built ahead of time, in ordinary code, and carries the signal
/// name, the build stamp and the attempt.
final class CrashReporterTests: XCTestCase {
    private let stamp = AppBuildStamp(version: "1.0.0", commit: "abc1234")

    func testEveryWatchedSignalHasAPreFormattedLine() throws {
        let lines = CrashReporter.lines(stamp: stamp, attemptID: "attempt-7")
        let bySignal = Dictionary(uniqueKeysWithValues: lines)

        for entry in CrashReporter.watchedSignals {
            let line = try XCTUnwrap(bySignal[entry.signal], "no line for \(entry.name)")
            XCTAssertTrue(line.hasSuffix("\n"), "\(entry.name) line must be one JSON line")
            let object = try XCTUnwrap(
                JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any]
            )
            XCTAssertEqual(object["kind"] as? String, CrashReporter.crashKind)
            XCTAssertEqual(object["message"] as? String, "fatal signal \(entry.name)")
            XCTAssertEqual(object["app_version"] as? String, "1.0.0")
            XCTAssertEqual(object["app_commit"] as? String, "abc1234")
            XCTAssertEqual(object["attempt_id"] as? String, "attempt-7")
            XCTAssertNil(
                object["occurred_at"],
                "a signal handler cannot read a clock; the drain stamps it"
            )
        }
    }

    func testTheSignalSetIsTheOneTheDesignPageNames() {
        XCTAssertEqual(
            CrashReporter.watchedSignals.map(\.name),
            ["SIGABRT", "SIGSEGV", "SIGBUS", "SIGILL", "SIGTRAP"]
        )
    }

    func testTheUnrecoverableLineIsPreparedToo() throws {
        let lines = CrashReporter.lines(stamp: stamp, attemptID: nil)
        let line = try XCTUnwrap(
            Dictionary(uniqueKeysWithValues: lines)[CrashReporter.unrecoverableSlot]
        )
        let object = try XCTUnwrap(
            JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any]
        )
        XCTAssertEqual(object["kind"] as? String, CrashReporter.unrecoverableKind)
        XCTAssertEqual(object["app_version"] as? String, "1.0.0")
        XCTAssertNil(object["attempt_id"], "no attempt open, no field")
    }

    /// The write itself, exercised without a signal: `prepare` parks the lines
    /// and `writeUnrecoverableLine` puts one on the descriptor the sink
    /// already holds open. That is exactly the mechanism `exit(70)` uses.
    func testWriteUnrecoverableLineLandsInTheLogFile() throws {
        let directory = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("crash-reporter-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }

        let log = try ClientErrorLog(
            fileURL: directory.appendingPathComponent("errors.log"),
            stamp: stamp
        )
        // Deliberately NOT install(): registering real signal handlers would
        // outlive this test inside the shared test runner.
        crashDescriptor = log.rawDescriptor
        CrashReporter.prepare(stamp: stamp, attemptID: "attempt-7")
        defer { crashDescriptor = -1 }

        CrashReporter.writeUnrecoverableLine()

        let entries = log.readEntries()
        XCTAssertEqual(entries.count, 1)
        XCTAssertEqual(entries[0].kind, CrashReporter.unrecoverableKind)
        XCTAssertEqual(entries[0].attemptID, "attempt-7")
        XCTAssertNil(entries[0].occurredAt)
    }

    func testPrepareRebindsTheAttempt() throws {
        CrashReporter.prepare(stamp: stamp, attemptID: nil)
        CrashReporter.prepare(stamp: stamp, attemptID: "attempt-9")
        defer { CrashReporter.prepare(stamp: .unknown, attemptID: nil) }

        let line = try XCTUnwrap(
            Dictionary(uniqueKeysWithValues: CrashReporter.lines(stamp: stamp, attemptID: "attempt-9"))[SIGABRT]
        )
        XCTAssertTrue(line.contains("attempt-9"))
        XCTAssertEqual(crashSlotCount, CrashReporter.watchedSignals.count + 1)
    }

    // MARK: D-2 — the timed unrecoverable line

    /// D-2 (`docs/client-v1-3-5-design.md`): unlike the signal handlers,
    /// `onUnrecoverable` fires on the backstop's own dispatch queue — an
    /// ordinary one, not a signal context — so this line is built fresh at
    /// the moment it fires rather than reused from the install-time buffer:
    /// `occurred_at` and `os_version` join the fields the buffer already had.
    func testTimedUnrecoverableLineCarriesOccurredAtAndOSVersion() throws {
        let when = Date(timeIntervalSince1970: 1_735_000_000)
        let line = CrashReporter.timedUnrecoverableLine(
            stamp: stamp,
            attemptID: "attempt-7",
            occurredAt: when,
            osVersion: "Version 26.4 (Build 25E214)"
        )
        XCTAssertTrue(line.hasSuffix("\n"))
        let object = try XCTUnwrap(
            JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any]
        )
        XCTAssertEqual(object["kind"] as? String, CrashReporter.unrecoverableKind)
        XCTAssertEqual(object["app_version"] as? String, "1.0.0")
        XCTAssertEqual(object["app_commit"] as? String, "abc1234")
        XCTAssertEqual(object["attempt_id"] as? String, "attempt-7")
        XCTAssertEqual(object["occurred_at"] as? String, "2024-12-24T00:26:40Z")
        let context = try XCTUnwrap(object["context"] as? [String: String])
        XCTAssertEqual(context["os_version"], "Version 26.4 (Build 25E214)")
    }

    func testTimedUnrecoverableLineOmitsAttemptIDWhenNoneIsOpen() throws {
        let line = CrashReporter.timedUnrecoverableLine(stamp: stamp, attemptID: nil)
        let object = try XCTUnwrap(
            JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any]
        )
        XCTAssertNil(object["attempt_id"])
    }

    /// The write side, exercised the same way `testWriteUnrecoverableLineLandsInTheLogFile`
    /// exercises the install-time buffer: a real descriptor, no signal involved.
    func testWriteTimedUnrecoverableLineLandsInTheLogFile() throws {
        let directory = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("crash-reporter-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }

        let log = try ClientErrorLog(
            fileURL: directory.appendingPathComponent("errors.log"),
            stamp: stamp
        )
        crashDescriptor = log.rawDescriptor
        defer { crashDescriptor = -1 }

        CrashReporter.writeTimedUnrecoverableLine(stamp: stamp, attemptID: "attempt-7")

        let entries = log.readEntries()
        XCTAssertEqual(entries.count, 1)
        XCTAssertEqual(entries[0].kind, CrashReporter.unrecoverableKind)
        XCTAssertEqual(entries[0].attemptID, "attempt-7")
        XCTAssertNotNil(entries[0].occurredAt, "built at write time, unlike the pre-formatted buffer")
        XCTAssertEqual(entries[0].context["os_version"], ProcessInfo.processInfo.operatingSystemVersionString)
    }

    /// No sink installed — `crashDescriptor` still at its default — must not
    /// crash the write path.
    func testWriteTimedUnrecoverableLineIsANoOpWithNoDescriptor() {
        crashDescriptor = -1
        CrashReporter.writeTimedUnrecoverableLine(stamp: stamp, attemptID: nil)
    }
}
