import XCTest
@testable import SecureTestCore

/// Slice 67: the offline spool.
///
/// The property under test throughout is that a student's work survives things
/// the student cannot see going wrong — a dropped network, a crash, a lid
/// closed between rooms. Losing an answer is invisible to them and only
/// surfaces at scoring time, which is far too late to fix.
final class ResponseSpoolTests: XCTestCase {
    private var path = ""

    override func setUp() {
        super.setUp()
        path = NSTemporaryDirectory() + "spool-\(UUID().uuidString).sqlite"
    }

    override func tearDown() {
        for suffix in ["", "-wal", "-shm"] {
            try? FileManager.default.removeItem(atPath: path + suffix)
        }
        super.tearDown()
    }

    private func spool() async throws -> ResponseSpool {
        try ResponseSpool(path: path)
    }

    private let pick = #"{"type":"multiple_choice_single","choice_id":"c1"}"#

    func testQueuesAnAnswer() async throws {
        let spool = try await self.spool()
        try await spool.enqueue(attemptID: "at1", itemID: "i1", responseJSON: pick)

        let pending = try await spool.pending()
        XCTAssertEqual(pending.count, 1)
        XCTAssertEqual(pending[0].attemptID, "at1")
        XCTAssertEqual(pending[0].responseJSON, pick)
    }

    /// Only the student's latest intent is worth sending. A row per keystroke
    /// would replay their whole edit history at the server, and a retry could
    /// land an earlier answer after a later one.
    func testAnswersReplaceRatherThanAccumulate() async throws {
        let spool = try await self.spool()
        try await spool.enqueue(attemptID: "at1", itemID: "i1", responseJSON: pick)
        let second = #"{"type":"multiple_choice_single","choice_id":"c2"}"#
        try await spool.enqueue(attemptID: "at1", itemID: "i1", responseJSON: second)

        let pending = try await spool.pending()
        XCTAssertEqual(pending.count, 1)
        XCTAssertEqual(pending[0].responseJSON, second)
    }

    func testDifferentItemsQueueSeparately() async throws {
        let spool = try await self.spool()
        try await spool.enqueue(attemptID: "at1", itemID: "i1", responseJSON: pick)
        try await spool.enqueue(attemptID: "at1", itemID: "i2", responseJSON: pick)
        let queued = try await spool.count()
        XCTAssertEqual(queued, 2)
    }

    /// A student who answers then clears has, on balance, not answered.
    func testAWithdrawalReplacesAnUnsentAnswer() async throws {
        let spool = try await self.spool()
        try await spool.enqueue(attemptID: "at1", itemID: "i1", responseJSON: pick)
        try await spool.enqueueWithdrawal(attemptID: "at1", itemID: "i1")

        let pending = try await spool.pending()
        XCTAssertEqual(pending.count, 1)
        XCTAssertNil(pending[0].responseJSON)
    }

    /// The whole point: the queue is on disk, so the app dying does not take
    /// the student's answers with it.
    func testTheQueueSurvivesTheProcessForgettingAboutIt() async throws {
        do {
            let spool = try await self.spool()
            try await spool.enqueue(attemptID: "at1", itemID: "i1", responseJSON: pick)
        }
        let reopened = try await self.spool()
        let pending = try await reopened.pending()
        XCTAssertEqual(pending.count, 1)
        XCTAssertEqual(pending[0].responseJSON, pick)
    }

    func testAnswersFlushInTheOrderTheyWereGiven() async throws {
        let spool = try await self.spool()
        for index in 1...3 {
            try await spool.enqueue(attemptID: "at1", itemID: "i\(index)", responseJSON: pick)
        }
        let ids = try await spool.pending().map(\.itemID)
        XCTAssertEqual(ids, ["i1", "i2", "i3"])
    }
}

final class ResponseSpoolFlushTests: XCTestCase {
    private var path = ""

    override func setUp() {
        super.setUp()
        path = NSTemporaryDirectory() + "flush-\(UUID().uuidString).sqlite"
    }

    override func tearDown() {
        for suffix in ["", "-wal", "-shm"] {
            try? FileManager.default.removeItem(atPath: path + suffix)
        }
        super.tearDown()
    }

    private let pick = #"{"type":"multiple_choice_single","choice_id":"c1"}"#

    private func client(_ transport: RecordingTransport) -> APIClient {
        APIClient(
            baseURL: URL(string: "https://design.example")!,
            transport: transport,
            tokens: InMemoryTokenStore(token: "tok"),
        )
    }

    func testASuccessfulFlushClearsTheQueue() async throws {
        let spool = try ResponseSpool(path: path)
        try await spool.enqueue(attemptID: "at1", itemID: "i1", responseJSON: pick)
        try await spool.enqueue(attemptID: "at1", itemID: "i2", responseJSON: pick)

        let transport = RecordingTransport(replies: [
            .init(status: 200, body: "{}"), .init(status: 200, body: "{}"),
        ])
        let result = await spool.flush(using: client(transport))

        XCTAssertEqual(result, ResponseSpool.FlushResult(sent: 2, remaining: 0))
        XCTAssertEqual(transport.sent.map(\.httpMethod), ["PUT", "PUT"])
        XCTAssertEqual(transport.sent[0].url?.path, "/api/attempts/at1/responses/i1")
    }

    func testTheResponseIsWrappedTheWayTheServerExpects() async throws {
        let spool = try ResponseSpool(path: path)
        try await spool.enqueue(attemptID: "at1", itemID: "i1", responseJSON: pick)
        let transport = RecordingTransport(status: 200, body: "{}")
        _ = await spool.flush(using: client(transport))

        let body = String(data: transport.sent[0].httpBody ?? Data(), encoding: .utf8)
        XCTAssertEqual(body, #"{"response":{"type":"multiple_choice_single","choice_id":"c1"}}"#)
    }

    func testAWithdrawalFlushesAsADelete() async throws {
        let spool = try ResponseSpool(path: path)
        try await spool.enqueueWithdrawal(attemptID: "at1", itemID: "i1")
        let transport = RecordingTransport(status: 200, body: "{}")
        let result = await spool.flush(using: client(transport))

        XCTAssertEqual(transport.sent[0].httpMethod, "DELETE")
        XCTAssertNil(transport.sent[0].httpBody)
        XCTAssertEqual(result.remaining, 0)
    }

    /// A network failure must leave the work queued. This is the case the spool
    /// exists for.
    func testWorkStaysQueuedWhenTheServerCannotBeReached() async throws {
        let spool = try ResponseSpool(path: path)
        try await spool.enqueue(attemptID: "at1", itemID: "i1", responseJSON: pick)

        let transport = RecordingTransport(status: 503, body: "{}")
        let result = await spool.flush(using: client(transport))

        XCTAssertEqual(result, ResponseSpool.FlushResult(sent: 0, remaining: 1))
        let remaining = try await spool.count()
        XCTAssertEqual(remaining, 1)
    }

    /// Stops at the first failure rather than pressing on: the rest will fail
    /// too, and continuing would deliver later answers before earlier ones.
    func testAFailureStopsTheFlushInsteadOfReorderingAnswers() async throws {
        let spool = try ResponseSpool(path: path)
        try await spool.enqueue(attemptID: "at1", itemID: "i1", responseJSON: pick)
        try await spool.enqueue(attemptID: "at1", itemID: "i2", responseJSON: pick)

        let transport = RecordingTransport(replies: [
            .init(status: 503, body: "{}"), .init(status: 200, body: "{}"),
        ])
        let result = await spool.flush(using: client(transport))

        XCTAssertEqual(result.sent, 0)
        XCTAssertEqual(transport.sent.count, 1, "must not have tried the second")
        let stillQueued = try await spool.count()
        XCTAssertEqual(stillQueued, 2)
    }

    /// A permanently-rejected entry at the head of the queue would otherwise
    /// block every answer behind it, forever.
    func testAnEntryTheServerWillNeverAcceptIsDropped() async throws {
        let spool = try ResponseSpool(path: path)
        try await spool.enqueue(attemptID: "at1", itemID: "i1", responseJSON: pick)
        try await spool.enqueue(attemptID: "at1", itemID: "i2", responseJSON: pick)

        let transport = RecordingTransport(replies: [
            .init(status: 400, body: #"{"error":"response_type_mismatch"}"#),
            .init(status: 200, body: "{}"),
        ])
        let result = await spool.flush(using: client(transport))

        XCTAssertEqual(result.sent, 1, "the second entry still went")
        XCTAssertEqual(result.remaining, 0, "the rejected one was not left to block the queue")
        XCTAssertEqual(result.dropped, 1, "finding 10.1: the drop is counted so the host can say so")
    }

    func testRetryableStatusesAreNotDropped() async throws {
        for status in [408, 429] {
            let spoolPath = NSTemporaryDirectory() + "retry-\(status)-\(UUID().uuidString).sqlite"
            defer { try? FileManager.default.removeItem(atPath: spoolPath) }

            let spool = try ResponseSpool(path: spoolPath)
            try await spool.enqueue(attemptID: "at1", itemID: "i1", responseJSON: pick)
            let result = await spool.flush(using: client(RecordingTransport(status: status, body: "{}")))
            // The server explicitly asked for a retry, so the answer is kept.
            XCTAssertEqual(result.remaining, 1, "status \(status) must be retried")
            XCTAssertEqual(result.dropped, 0)
        }
    }

    func testPermanenceRule() {
        XCTAssertTrue(ResponseSpool.isPermanent(400))
        XCTAssertTrue(ResponseSpool.isPermanent(404))
        XCTAssertTrue(ResponseSpool.isPermanent(409))
        XCTAssertFalse(ResponseSpool.isPermanent(408))
        XCTAssertFalse(ResponseSpool.isPermanent(429))
        XCTAssertFalse(ResponseSpool.isPermanent(500))
        XCTAssertFalse(ResponseSpool.isPermanent(503))
    }
}

/// Slice 73: clearing an attempt's queue once the server has the answers.
final class ResponseSpoolClearTests: XCTestCase {
    private var path = ""

    override func setUp() {
        super.setUp()
        path = NSTemporaryDirectory() + "clear-\(UUID().uuidString).sqlite"
    }

    override func tearDown() {
        for suffix in ["", "-wal", "-shm"] {
            try? FileManager.default.removeItem(atPath: path + suffix)
        }
        super.tearDown()
    }

    private let pick = #"{"type":"multiple_choice_single","choice_id":"c1"}"#

    func testClearingRemovesOnlyThatAttemptsWork() async throws {
        let spool = try ResponseSpool(path: path)
        try await spool.enqueue(attemptID: "at1", itemID: "i1", responseJSON: pick)
        try await spool.enqueue(attemptID: "at1", itemID: "i2", responseJSON: pick)
        try await spool.enqueue(attemptID: "at2", itemID: "i1", responseJSON: pick)

        try await spool.clear(attemptID: "at1")

        let remaining = try await spool.pending()
        XCTAssertEqual(remaining.count, 1)
        XCTAssertEqual(remaining[0].attemptID, "at2")
    }

    func testClearingAnAttemptWithNothingQueuedIsFine() async throws {
        let spool = try ResponseSpool(path: path)
        try await spool.clear(attemptID: "never-seen")
        let count = try await spool.count()
        XCTAssertEqual(count, 0)
    }

    /// The residue this removes is only residue once the server HAS the work.
    /// A student who never gets back online must keep theirs — clearing on any
    /// other path would destroy the only copy.
    func testClearingIsNotWiredToFailure() async throws {
        let spool = try ResponseSpool(path: path)
        try await spool.enqueue(attemptID: "at1", itemID: "i1", responseJSON: pick)

        let transport = RecordingTransport(status: 503, body: "{}")
        let client = APIClient(
            baseURL: URL(string: "https://design.example")!,
            transport: transport,
            tokens: InMemoryTokenStore(token: "tok"),
        )
        _ = await spool.flush(using: client)

        let survived = try await spool.count()
        XCTAssertEqual(survived, 1, "a failed flush must never clear the queue")
    }
}
