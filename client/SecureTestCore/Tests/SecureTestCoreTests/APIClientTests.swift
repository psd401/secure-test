import XCTest
@testable import SecureTestCore

/// A transport that records what it was asked to send and replays a scripted
/// reply. Lets every request this client builds be inspected with no network
/// and no server — which matters because server-driven verification is not
/// available in this environment (ADR 0013).
final class RecordingTransport: HTTPTransport, @unchecked Sendable {
    struct Reply {
        let status: Int
        let body: String
    }

    private(set) var sent: [URLRequest] = []
    private var replies: [Reply]

    init(replies: [Reply]) {
        self.replies = replies
    }

    convenience init(status: Int = 200, body: String = "{}") {
        self.init(replies: [Reply(status: status, body: body)])
    }

    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        sent.append(request)
        let reply = replies.isEmpty ? Reply(status: 200, body: "{}") : replies.removeFirst()
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: reply.status,
            httpVersion: nil,
            headerFields: nil,
        )!
        return (Data(reply.body.utf8), response)
    }

    var lastBody: [String: String]? {
        guard let data = sent.last?.httpBody else { return nil }
        return try? JSONDecoder().decode([String: String].self, from: data)
    }
}

final class APIClientTests: XCTestCase {
    private let base = URL(string: "https://design.example")!

    private func client(
        _ transport: RecordingTransport,
        token: String? = "tok-123",
    ) -> APIClient {
        APIClient(baseURL: base, transport: transport, tokens: InMemoryTokenStore(token: token))
    }

    func testRedeemPostsTheCodeToTheRedeemRoute() async throws {
        let transport = RecordingTransport(
            body: #"{"test_session_id":"s1","assessment_id":"a1","student_id":"st1"}"#
        )
        let result = try await client(transport).redeem(code: "ABC234")

        XCTAssertEqual(transport.sent.count, 1)
        XCTAssertEqual(transport.sent[0].httpMethod, "POST")
        XCTAssertEqual(transport.sent[0].url?.path, "/api/test-sessions/redeem")
        XCTAssertEqual(transport.lastBody, ["code": "ABC234"])
        XCTAssertEqual(
            result,
            RedeemedSession(testSessionID: "s1", assessmentID: "a1", studentID: "st1")
        )
    }

    /// Bearer rather than a cookie: a native app has no cookie jar worth
    /// emulating, and the server accepts either since slice 58.
    func testEveryRequestCarriesTheBearerToken() async throws {
        let transport = RecordingTransport(body: #"{"attempt":{"id":"at1","status":"in_progress"},"resumed":false}"#)
        _ = try await client(transport).startAttempt(testSessionID: "s1")
        XCTAssertEqual(
            transport.sent[0].value(forHTTPHeaderField: "Authorization"),
            "Bearer tok-123"
        )
        XCTAssertNil(transport.sent[0].value(forHTTPHeaderField: "Cookie"))
    }

    func testWithoutATokenNothingIsSentAtAll() async {
        let transport = RecordingTransport()
        do {
            _ = try await client(transport, token: nil).redeem(code: "ABC234")
            XCTFail("expected notAuthenticated")
        } catch {
            XCTAssertEqual(error as? APIError, .notAuthenticated)
            // The point: it fails before touching the network, so an
            // unauthenticated client cannot leak a code to the server.
            XCTAssertTrue(transport.sent.isEmpty)
        }
    }

    func testStartAttemptReportsWhetherItResumed() async throws {
        let transport = RecordingTransport(
            body: #"{"attempt":{"id":"at1","status":"in_progress"},"resumed":true}"#
        )
        let result = try await client(transport).startAttempt(testSessionID: "s1")
        XCTAssertEqual(transport.sent[0].url?.path, "/api/attempts")
        XCTAssertEqual(transport.lastBody, ["test_session_id": "s1"])
        XCTAssertTrue(result.resumed)
        XCTAssertEqual(result.attempt.id, "at1")
    }

    /// The renderer is handed the ORIGINAL bytes, so a field this build does
    /// not know about still reaches the student's page.
    func testFetchBundleReturnsBothTheModelAndTheRawBytes() async throws {
        let json = #"{"test_id":"t1","title":"Quiz","items":[{"type":"short_text","id":"i1","stem":"s"}],"future_field":42}"#
        let transport = RecordingTransport(body: json)
        let (bundle, raw) = try await client(transport).fetchBundle(assessmentID: "a1")

        XCTAssertEqual(transport.sent[0].httpMethod, "GET")
        XCTAssertEqual(transport.sent[0].url?.path, "/api/assessments/a1/delivery")
        XCTAssertEqual(bundle.title, "Quiz")
        XCTAssertEqual(bundle.items.count, 1)
        XCTAssertTrue(raw.contains("future_field"))
    }

    /// The server's own error string survives to the UI, because
    /// "session_unavailable" and "not_on_roster" mean very different things to
    /// the person holding the machine.
    func testARefusalCarriesTheServersErrorCode() async {
        let transport = RecordingTransport(status: 404, body: #"{"ok":false,"error":"not_on_roster"}"#)
        do {
            _ = try await client(transport).redeem(code: "ABC234")
            XCTFail("expected refusal")
        } catch {
            XCTAssertEqual(error as? APIError, .refused(status: 404, code: "not_on_roster"))
        }
    }

    func testARefusalWithNoParseableBodyStillReportsTheStatus() async {
        let transport = RecordingTransport(status: 500, body: "<html>oops")
        do {
            _ = try await client(transport).redeem(code: "ABC234")
            XCTFail("expected refusal")
        } catch {
            XCTAssertEqual(error as? APIError, .refused(status: 500, code: nil))
        }
    }

    func testAMalformedSuccessBodyIsADecodingFailureNotACrash() async {
        let transport = RecordingTransport(status: 200, body: #"{"unexpected":true}"#)
        do {
            _ = try await client(transport).redeem(code: "ABC234")
            XCTFail("expected decoding failure")
        } catch {
            guard case .decoding = (error as? APIError) else {
                return XCTFail("expected .decoding, got \(error)")
            }
        }
    }
}

final class TokenStoreTests: XCTestCase {
    func testInMemoryStoreRoundTrips() throws {
        let store = InMemoryTokenStore()
        XCTAssertNil(store.token())
        try store.store("abc")
        XCTAssertEqual(store.token(), "abc")
        try store.clear()
        XCTAssertNil(store.token())
    }
}

/// The student-facing wording for each server refusal. These are the words a
/// child reads when something goes wrong, and the codes behind them call for
/// completely different next steps despite sharing status codes — so the test
/// is that they do not read alike.
final class JoinErrorMessageTests: XCTestCase {
    private func message(_ code: String?) -> String {
        JoinErrorCopy.message(forCode: code)
    }

    func testEachRefusalTellsTheStudentSomethingDifferent() {
        let cases = [
            "malformed_code",
            "session_unavailable",
            "not_on_roster",
            "no_sourced_id",
            "identity_conflict",
        ]
        let messages = cases.map(message)
        XCTAssertEqual(Set(messages).count, cases.count, "refusals must not read alike")
        for text in messages {
            XCTAssertFalse(text.isEmpty)
        }
    }

    /// A mistyped code is the student's to fix; the rest are not.
    func testOnlyTheMistypedCodeAsksTheStudentToRetry() {
        XCTAssertTrue(message("malformed_code").lowercased().contains("try again"))
        for code in ["not_on_roster", "no_sourced_id", "identity_conflict"] {
            XCTAssertTrue(message(code).lowercased().contains("teacher"))
            XCTAssertFalse(message(code).lowercased().contains("try again"))
        }
    }

    func testAnUnrecognisedCodeStillProducesUsableWords() {
        XCTAssertFalse(message("something_new").isEmpty)
        XCTAssertFalse(message(nil).isEmpty)
    }
}

final class UploadClientTests: XCTestCase {
    private let base = URL(string: "https://design.example")!

    private func client(_ transport: RecordingTransport) -> APIClient {
        APIClient(baseURL: base, transport: transport, tokens: InMemoryTokenStore(token: "tok-123"))
    }

    private func target(direct: Bool, url: String, bytes: Int = 3) -> UploadTarget {
        let json = """
        {"upload_id":"u1","max_bytes":100,
         "upload":{"url":"\(url)",
                   "headers":{"content-type":"image/png","content-length":"\(bytes)"},
                   "direct":\(direct)}}
        """
        return try! JSONDecoder().decode(UploadTarget.self, from: Data(json.utf8))
    }

    func testRequestsAnUploadSlotForTheItem() async throws {
        let transport = RecordingTransport(
            body: #"{"upload_id":"u1","max_bytes":100,"upload":{"url":"/x","headers":{},"direct":false}}"#
        )
        let result = try await client(transport).requestUpload(
            attemptID: "at1", itemID: "i1", contentType: "image/png", contentLength: 42,
        )
        XCTAssertEqual(transport.sent[0].httpMethod, "POST")
        XCTAssertEqual(
            transport.sent[0].url?.path,
            "/api/attempts/at1/responses/i1/upload-url"
        )
        // The size is declared up front so the server can apply its cap before
        // signing — a presigned PUT cannot express a maximum.
        let body = try JSONSerialization.jsonObject(with: transport.sent[0].httpBody ?? Data())
        XCTAssertEqual((body as? [String: Any])?["content_type"] as? String, "image/png")
        XCTAssertEqual((body as? [String: Any])?["content_length"] as? Int, 42)
        XCTAssertEqual(result.uploadID, "u1")
    }

    /// Object storage is a different trust domain. The presigned signature is
    /// the credential; attaching our session token would leak it to a third
    /// party for no benefit.
    func testADirectUploadNeverCarriesTheSessionToken() async throws {
        let transport = RecordingTransport(status: 200, body: "")
        let destination = target(direct: true, url: "https://bucket.s3.example/key?sig=abc")
        try await client(transport).uploadBytes(Data([1, 2, 3]), to: destination)

        XCTAssertEqual(transport.sent[0].url?.host, "bucket.s3.example")
        // Content-Length is URLSession's to set from the body; overriding it
        // here would only ever disagree with what was signed.
        XCTAssertNil(transport.sent[0].value(forHTTPHeaderField: "content-length"))
        XCTAssertNil(transport.sent[0].value(forHTTPHeaderField: "Authorization"))
        XCTAssertEqual(transport.sent[0].value(forHTTPHeaderField: "content-type"), "image/png")
        XCTAssertEqual(transport.sent[0].httpBody, Data([1, 2, 3]))
    }

    /// The fallback target is this app, which authenticates normally.
    func testAnIndirectUploadGoesBackThroughTheAppWithTheToken() async throws {
        let transport = RecordingTransport(status: 200, body: "{}")
        let destination = target(
            direct: false,
            url: "/api/attempts/at1/responses/i1/upload?upload_id=u1",
            bytes: 1,
        )
        try await client(transport).uploadBytes(Data([9]), to: destination)

        XCTAssertEqual(transport.sent[0].url?.host, "design.example")
        XCTAssertEqual(
            transport.sent[0].value(forHTTPHeaderField: "Authorization"),
            "Bearer tok-123"
        )
    }

    /// Sending a different number of bytes than was signed produces an opaque
    /// SignatureDoesNotMatch from S3. Catching it here says what actually went
    /// wrong, and costs nothing.
    func testUploadingADifferentSizeThanWasSignedIsCaughtBeforeSending() async {
        let transport = RecordingTransport(status: 200, body: "")
        do {
            try await client(transport).uploadBytes(
                Data([1, 2, 3, 4, 5]),
                to: target(direct: true, url: "https://bucket.s3.example/key", bytes: 3),
            )
            XCTFail("expected a size mismatch")
        } catch {
            guard case .decoding = (error as? APIError) else {
                return XCTFail("expected .decoding, got \(error)")
            }
            XCTAssertTrue(transport.sent.isEmpty, "must not have sent anything")
        }
    }

    func testARejectedUploadSurfacesTheStatus() async {
        let transport = RecordingTransport(status: 413, body: #"{"error":"upload_too_large"}"#)
        do {
            try await client(transport).uploadBytes(
                Data([1]),
                to: target(direct: false, url: "/x", bytes: 1),
            )
            XCTFail("expected refusal")
        } catch {
            XCTAssertEqual(error as? APIError, .refused(status: 413, code: "upload_too_large"))
        }
    }

    // MARK: events (slice 92)

    func testPostEventSendsKindAndDetailWithTheBearerToken() async throws {
        let transport = RecordingTransport(status: 201, body: #"{"ok":true}"#)
        try await client(transport).postEvent(
            attemptID: "at1",
            kind: .emergencyExit,
            detail: ["via": "button"],
        )

        XCTAssertEqual(transport.sent.count, 1)
        let request = transport.sent[0]
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.url?.path, "/api/attempts/at1/events")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer tok-123")
        let body = try XCTUnwrap(request.httpBody)
        let json = try XCTUnwrap(try JSONSerialization.jsonObject(with: body) as? [String: Any])
        XCTAssertEqual(json["kind"] as? String, "emergency_exit")
        XCTAssertEqual(json["detail"] as? [String: String], ["via": "button"])
    }

    func testPostEventOmitsDetailWhenNoneGiven() async throws {
        let transport = RecordingTransport(status: 201, body: #"{"ok":true}"#)
        try await client(transport).postEvent(attemptID: "at1", kind: .focusLoss)

        let body = try XCTUnwrap(transport.sent[0].httpBody)
        let json = try XCTUnwrap(try JSONSerialization.jsonObject(with: body) as? [String: Any])
        XCTAssertEqual(json["kind"] as? String, "focus_loss")
        XCTAssertNil(json["detail"])
    }

    func testFetchPendingPeekDecodesARequestAndNull() async throws {
        let transport = RecordingTransport(
            body: #"{"ok":true,"pending":{"id":"pk1","requested_at":"2026-08-28T12:00:00Z"}}"#
        )
        let pending = try await client(transport).fetchPendingPeek(attemptID: "at1")
        XCTAssertEqual(pending, PendingPeek(id: "pk1"))
        XCTAssertEqual(transport.sent[0].httpMethod, "GET")
        XCTAssertEqual(transport.sent[0].url?.path, "/api/attempts/at1/peek/pending")
        XCTAssertEqual(transport.sent[0].value(forHTTPHeaderField: "Authorization"), "Bearer tok-123")

        let empty = RecordingTransport(body: #"{"ok":true,"pending":null}"#)
        let none = try await client(empty).fetchPendingPeek(attemptID: "at1")
        XCTAssertNil(none)
    }

    func testUploadPeekImagePostsTheFrame() async throws {
        let transport = RecordingTransport(status: 201, body: #"{"ok":true}"#)
        try await client(transport).uploadPeekImage(
            attemptID: "at1",
            peekID: "pk1",
            imageBase64: "aGVsbG8=",
        )

        let request = transport.sent[0]
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.url?.path, "/api/attempts/at1/peek/upload")
        let body = try XCTUnwrap(request.httpBody)
        let json = try XCTUnwrap(try JSONSerialization.jsonObject(with: body) as? [String: Any])
        XCTAssertEqual(json["peek_id"] as? String, "pk1")
        XCTAssertEqual(json["image_base64"] as? String, "aGVsbG8=")
    }

    func testPostEventSurfacesARefusal() async {
        let transport = RecordingTransport(status: 400, body: #"{"error":"invalid_body"}"#)
        do {
            try await client(transport).postEvent(attemptID: "at1", kind: .quit)
            XCTFail("expected refusal")
        } catch {
            XCTAssertEqual(error as? APIError, .refused(status: 400, code: "invalid_body"))
        }
    }
}
