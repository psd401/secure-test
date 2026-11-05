import XCTest
@testable import SecureTestCore

/// Answer writes give up after `APIClient.answerWriteTimeout` rather than the
/// system's 60 s, because flushes run one at a time and hand-in waits on the
/// flush: one write stuck on a dead connection would otherwise hold hand-in
/// for a minute. A write that times out stays spooled for the next flush.
final class AnswerWriteTimeoutTests: XCTestCase {
    private func client(_ transport: HTTPTransport) -> APIClient {
        APIClient(
            baseURL: URL(string: "https://design.example")!,
            transport: transport,
            tokens: InMemoryTokenStore(token: "tok"),
        )
    }

    func testTheTimeoutMatchesHandInsDrawingBound() {
        XCTAssertEqual(APIClient.answerWriteTimeout, 20)
    }

    func testAnAnswerPutCarriesTheShorterTimeout() async throws {
        let transport = RecordingTransport(status: 200, body: "{}")
        try await client(transport).putResponse(attemptID: "at1", itemID: "i1", responseJSON: "{}")
        XCTAssertEqual(transport.sent[0].timeoutInterval, APIClient.answerWriteTimeout)
    }

    func testAWithdrawalDeleteCarriesTheShorterTimeout() async throws {
        let transport = RecordingTransport(status: 200, body: "{}")
        try await client(transport).deleteResponse(attemptID: "at1", itemID: "i1")
        XCTAssertEqual(transport.sent[0].timeoutInterval, APIClient.answerWriteTimeout)
    }

    /// Only answer writes are shortened; everything else keeps the default.
    func testOtherRequestsKeepTheSystemDefault() async throws {
        let transport = RecordingTransport(
            body: #"{"test_session_id":"s1","assessment_id":"a1","student_id":"st1"}"#
        )
        _ = try await client(transport).redeem(code: "ABC234")
        XCTAssertEqual(transport.sent[0].timeoutInterval, URLRequest(url: URL(string: "https://x")!).timeoutInterval)
    }

    func testATimedOutWriteStaysQueued() async throws {
        let path = NSTemporaryDirectory() + "timeout-\(UUID().uuidString).sqlite"
        defer {
            for suffix in ["", "-wal", "-shm"] { try? FileManager.default.removeItem(atPath: path + suffix) }
        }
        let spool = try ResponseSpool(path: path)
        try await spool.enqueue(attemptID: "at1", itemID: "i1", responseJSON: #"{"type":"short_text","text":"a"}"#)

        let result = await spool.flush(using: client(TimingOutTransport()))

        XCTAssertEqual(result.sent, 0)
        XCTAssertEqual(result.remaining, 1, "a timed-out write must stay spooled for the next flush")
    }
}

/// Every request fails the way URLSession reports an expired timeout.
private struct TimingOutTransport: HTTPTransport {
    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        throw URLError(.timedOut)
    }
}
