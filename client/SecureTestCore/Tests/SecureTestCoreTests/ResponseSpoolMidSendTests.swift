import XCTest
@testable import SecureTestCore

/// An answer changed while the previous version of it is still on the wire.
///
/// `ResponseSpool` is an actor, and an actor is re-entrant at `await`: while a
/// flush waits on the network for one item, the student can keep typing (an
/// autosave enqueues the new version) and another flush can start. Both tests
/// hold the first PUT open with `GatedTransport`, make the change, then let it
/// finish. The property under test is the spool's own promise — the student's
/// LATEST answer is the one that reaches the server.
final class ResponseSpoolMidSendTests: XCTestCase {
    private var path = ""

    override func setUp() {
        super.setUp()
        path = NSTemporaryDirectory() + "midsend-\(UUID().uuidString).sqlite"
    }

    override func tearDown() {
        for suffix in ["", "-wal", "-shm"] {
            try? FileManager.default.removeItem(atPath: path + suffix)
        }
        super.tearDown()
    }

    private let first = #"{"type":"short_text","text":"first"}"#
    private let second = #"{"type":"short_text","text":"second"}"#

    private func client(_ transport: GatedTransport) -> APIClient {
        APIClient(
            baseURL: URL(string: "https://design.example")!,
            transport: transport,
            tokens: InMemoryTokenStore(token: "tok"),
        )
    }

    /// The newer answer, queued while the older one was being sent, must not
    /// be cleared by the older one's success: it was never sent.
    func testAnAnswerChangedMidSendStaysQueued() async throws {
        let spool = try ResponseSpool(path: path)
        let transport = GatedTransport()
        let api = client(transport)
        try await spool.enqueue(attemptID: "at1", itemID: "i1", responseJSON: first)

        let flush = Task { await spool.flush(using: api) }
        await transport.waitForRequests(1)
        try await spool.enqueue(attemptID: "at1", itemID: "i1", responseJSON: second)
        transport.releaseFirst()
        _ = await flush.value

        let pending = try await spool.pending()
        XCTAssertEqual(pending.map(\.responseJSON), [second], "the unsent newer answer was deleted")
    }

    /// A second flush started while the first is on the wire must not let the
    /// older answer land after the newer one.
    func testAnOverlappingFlushCannotLeaveTheOlderAnswerOnTheServer() async throws {
        let spool = try ResponseSpool(path: path)
        let transport = GatedTransport()
        let api = client(transport)
        try await spool.enqueue(attemptID: "at1", itemID: "i1", responseJSON: first)

        let flushA = Task { await spool.flush(using: api) }
        await transport.waitForRequests(1)
        try await spool.enqueue(attemptID: "at1", itemID: "i1", responseJSON: second)
        let flushB = Task { await spool.flush(using: api) }
        // Unserialized, flush B sends the newer answer while A is still held.
        // Serialized, B waits for A and this times out — both are fine here;
        // what matters is the order the server sees.
        await transport.waitForRequests(2, timeout: 0.5)
        transport.releaseFirst()
        _ = await flushA.value
        _ = await flushB.value

        XCTAssertEqual(transport.applied.last?.contains("second"), true,
                       "the server's last write was the older answer: \(transport.applied)")
        let left = try await spool.count()
        XCTAssertEqual(left, 0)
    }
}

/// Holds the FIRST request open until the test releases it; every later one
/// returns 200 at once. Records each body in arrival order (`bodies`) and in
/// the order the server finished with it (`applied`) — the latter is what
/// decides which answer the server ends up holding.
final class GatedTransport: HTTPTransport, @unchecked Sendable {
    private let lock = NSLock()
    private var _bodies: [String] = []
    private var _applied: [String] = []
    private var gate: CheckedContinuation<Void, Never>?
    private var released = false

    var bodies: [String] { lock.withLock { _bodies } }
    var applied: [String] { lock.withLock { _applied } }

    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let body = String(data: request.httpBody ?? Data(), encoding: .utf8) ?? ""
        let isFirst = lock.withLock { () -> Bool in
            _bodies.append(body)
            return _bodies.count == 1
        }
        if isFirst {
            await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
                let resumeNow = lock.withLock { () -> Bool in
                    if released { return true }
                    gate = continuation
                    return false
                }
                if resumeNow { continuation.resume() }
            }
        }
        lock.withLock { _applied.append(body) }
        let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!
        return (Data("{}".utf8), response)
    }

    func releaseFirst() {
        let continuation = lock.withLock { () -> CheckedContinuation<Void, Never>? in
            released = true
            defer { gate = nil }
            return gate
        }
        continuation?.resume()
    }

    /// Polls until `count` requests have arrived or `timeout` passes.
    func waitForRequests(_ count: Int, timeout: TimeInterval = 5) async {
        let deadline = Date().addingTimeInterval(timeout)
        while lock.withLock({ _bodies.count }) < count, Date() < deadline {
            try? await Task.sleep(nanoseconds: 10_000_000)
        }
    }
}
