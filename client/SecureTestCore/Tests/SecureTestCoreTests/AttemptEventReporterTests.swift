import XCTest
@testable import SecureTestCore

/// Slice 92: fire-and-forget event reporting.
///
/// The property under test is the reporter's one rule — a failed post is
/// logged and dropped, never rethrown, never retried, never awaited by the
/// caller. The `report` methods return their `Task` purely so these tests can
/// await completion deterministically; production callers discard it.
final class AttemptEventReporterTests: XCTestCase {

    private final class Recorder: @unchecked Sendable {
        private let lock = NSLock()
        private var _posts: [(AttemptEventKind, [String: String]?)] = []
        private var _logs: [String] = []
        var posts: [(AttemptEventKind, [String: String]?)] {
            lock.lock()
            defer { lock.unlock() }
            return _posts
        }
        var logs: [String] {
            lock.lock()
            defer { lock.unlock() }
            return _logs
        }
        func post(_ kind: AttemptEventKind, _ detail: [String: String]?) {
            lock.lock()
            defer { lock.unlock() }
            _posts.append((kind, detail))
        }
        func log(_ message: String) {
            lock.lock()
            defer { lock.unlock() }
            _logs.append(message)
        }
    }

    func testReportPostsKindAndDetail() async {
        let recorder = Recorder()
        let reporter = AttemptEventReporter(
            log: { recorder.log($0) },
            post: { kind, detail in recorder.post(kind, detail) }
        )

        await reporter.report(.emergencyExit, detail: ["via": "button"]).value

        XCTAssertEqual(recorder.posts.count, 1)
        XCTAssertEqual(recorder.posts[0].0, .emergencyExit)
        XCTAssertEqual(recorder.posts[0].1, ["via": "button"])
        XCTAssertTrue(recorder.logs.isEmpty)
    }

    func testFailedPostIsLoggedAndSwallowed() async {
        let recorder = Recorder()
        let reporter = AttemptEventReporter(
            log: { recorder.log($0) },
            post: { _, _ in throw APIError.refused(status: 400, code: "invalid_body") }
        )

        await reporter.report(.quit).value

        XCTAssertTrue(recorder.posts.isEmpty)
        XCTAssertEqual(recorder.logs.count, 1)
        XCTAssertTrue(recorder.logs[0].contains("quit"), "log should name the lost event")
    }

    /// The lockdown lifecycle maps onto the wire kinds the server accepts,
    /// reasons carried as detail.
    func testSessionEventsMapToWireKinds() async {
        let recorder = Recorder()
        let reporter = AttemptEventReporter(
            log: { recorder.log($0) },
            post: { kind, detail in recorder.post(kind, detail) }
        )

        await reporter.report(AssessmentLockdown.SessionEvent.didBegin).value
        await reporter.report(AssessmentLockdown.SessionEvent.didEnd).value
        await reporter.report(AssessmentLockdown.SessionEvent.failedToBegin("no entitlement")).value
        await reporter.report(AssessmentLockdown.SessionEvent.interrupted("dropped")).value

        XCTAssertEqual(recorder.posts.map(\.0), [
            .lockdownBegin, .lockdownEnd, .lockdownFailed, .lockdownInterrupted,
        ])
        XCTAssertEqual(recorder.posts[0].1, nil)
        XCTAssertEqual(recorder.posts[2].1, ["reason": "no entitlement"])
        XCTAssertEqual(recorder.posts[3].1, ["reason": "dropped"])
    }

    /// Every case the client can send is one the server's contract names —
    /// the two enums were written from the same table and must stay that way.
    func testLifecycleKindRetriesUntilDelivered() async {
        let recorder = Recorder()
        let counter = Counter()
        let reporter = AttemptEventReporter(
            log: { recorder.log($0) },
            retryDelay: { _ in 0 }
        ) { kind, detail in
            if counter.next() < 3 { throw URLError(.notConnectedToInternet) }
            recorder.post(kind, detail)
        }
        await reporter.report(.lockdownBegin).value
        XCTAssertEqual(recorder.posts.count, 1)
        XCTAssertEqual(recorder.posts.first?.0, .lockdownBegin)
        XCTAssertTrue(recorder.logs.contains { $0.contains("delivered on attempt 3") })
    }

    func testLifecycleKindGivesUpAfterTheBudget() async {
        let recorder = Recorder()
        let counter = Counter()
        let reporter = AttemptEventReporter(
            log: { recorder.log($0) },
            retryDelay: { _ in 0 }
        ) { _, _ in
            _ = counter.next()
            throw URLError(.timedOut)
        }
        await reporter.report(.lockdownEnd).value
        XCTAssertEqual(counter.value, 4)
        XCTAssertTrue(recorder.logs.contains { $0.contains("not delivered") })
    }

    func testFocusAndQuitStaySingleShot() async {
        let recorder = Recorder()
        let counter = Counter()
        let reporter = AttemptEventReporter(
            log: { recorder.log($0) },
            retryDelay: { _ in 0 }
        ) { _, _ in
            _ = counter.next()
            throw URLError(.timedOut)
        }
        await reporter.report(.focusLoss).value
        await reporter.report(.quit).value
        XCTAssertEqual(counter.value, 2)
    }

    private final class Counter: @unchecked Sendable {
        private let lock = NSLock()
        private var n = 0
        var value: Int {
            lock.lock()
            defer { lock.unlock() }
            return n
        }
        func next() -> Int {
            lock.lock()
            defer { lock.unlock() }
            n += 1
            return n
        }
    }

    func testWireNamesMatchTheServerContract() {
        XCTAssertEqual(
            Set(AttemptEventKind.allCases.map(\.rawValue)),
            [
                "quit", "emergency_exit", "focus_loss", "focus_regained",
                "lockdown_begin", "lockdown_end", "lockdown_failed", "lockdown_interrupted",
            ]
        )
    }
}
