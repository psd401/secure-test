import Foundation

/// Slice 66: the client's side of the student plane.
///
/// The transport is a protocol rather than URLSession directly, so every
/// request this builds and every response it decodes can be exercised with no
/// network and no server. That is not a preference here: browser- and
/// server-driven verification is unavailable in this environment (ADR 0013), so
/// an API client that could only be tested against a live server would in
/// practice be tested never.
public protocol HTTPTransport: Sendable {
    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse)
}

public struct URLSessionTransport: HTTPTransport {
    private let session: URLSession

    public init(session: URLSession = .shared) {
        self.session = session
    }

    public func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw APIError.notHTTP
        }
        return (data, http)
    }
}

/// Where the bearer token lives. The app backs this with the Keychain; tests
/// back it with memory. Nothing in this package should know which.
public protocol TokenStore: AnyObject {
    func token() -> String?
    func store(_ token: String) throws
    func clear() throws
}

public final class InMemoryTokenStore: TokenStore {
    private var value: String?
    public init(token: String? = nil) { self.value = token }
    public func token() -> String? { value }
    public func store(_ token: String) throws { value = token }
    public func clear() throws { value = nil }
}

public enum APIError: Error, Equatable {
    case notHTTP
    case notAuthenticated
    /// The server understood the request and refused it. `code` is the server's
    /// own error string, which the UI turns into something a student can act on
    /// — "session_unavailable" and "not_on_roster" mean very different things to
    /// the person holding the iPad.
    case refused(status: Int, code: String?)
    case decoding(String)
}

/// Server error bodies are `{ ok: false, error: "..." }` throughout the API.
private struct ErrorBody: Decodable {
    let error: String?
}

public struct RedeemedSession: Decodable, Equatable, Sendable {
    public let testSessionID: String
    public let assessmentID: String
    public let studentID: String

    private enum CodingKeys: String, CodingKey {
        case testSessionID = "test_session_id"
        case assessmentID = "assessment_id"
        case studentID = "student_id"
    }
}

/// Slice 80: what `/api/auth/exchange` returns for a verified id_token. The
/// token is also set as a cookie, which a native app has no jar for — hence
/// `session_token` in the body (slice 77).
public struct SignedInSession: Decodable, Equatable, Sendable {
    public let sub: String
    public let role: String
    public let email: String?
    public let sessionToken: String

    private enum CodingKeys: String, CodingKey {
        case sub, role, email
        case sessionToken = "session_token"
    }
}

public struct StartedAttempt: Decodable, Equatable, Sendable {
    public struct Attempt: Decodable, Equatable, Sendable {
        public let id: String
        public let status: String
    }
    public let attempt: Attempt
    public let resumed: Bool
}

/// Where a drawing's bytes go. `direct` says whether the URL is object storage
/// or a route back through this app — the two need different handling, and the
/// server says which rather than leaving the client to parse the URL.
/// On-demand peek: a teacher's open request for a look at this attempt's
/// screen. The id is all the client needs — the banner is stamped with the
/// student's own clock, and the server owns every window.
public struct PendingPeek: Decodable, Equatable, Sendable {
    public let id: String

    public init(id: String) {
        self.id = id
    }
}

struct PendingPeekEnvelope: Decodable {
    let pending: PendingPeek?
}

public struct UploadTarget: Decodable, Equatable, Sendable {
    public struct Target: Decodable, Equatable, Sendable {
        public let url: String
        public let headers: [String: String]
        public let direct: Bool
    }
    public let uploadID: String
    public let upload: Target
    public let maxBytes: Int

    /// The size the server signed, read back from the headers it returned. The
    /// upload must match it exactly or S3 rejects the signature.
    public var declaredBytes: Int {
        Int(upload.headers.first { $0.key.lowercased() == "content-length" }?.value ?? "") ?? -1
    }

    private enum CodingKeys: String, CodingKey {
        case upload
        case uploadID = "upload_id"
        case maxBytes = "max_bytes"
    }
}

public actor APIClient {
    private let baseURL: URL
    private let transport: HTTPTransport
    private let tokens: TokenStore

    public init(baseURL: URL, transport: HTTPTransport, tokens: TokenStore) {
        self.baseURL = baseURL
        self.transport = transport
        self.tokens = tokens
    }

    // MARK: sign-in (slice 80)

    /// Trade a Google id_token for a design-tool session. The ONE request
    /// that goes out without a bearer token — there is none yet. On success
    /// the session token is stored, so every later call carries it.
    public func exchangeIdToken(_ idToken: String) async throws -> SignedInSession {
        var request = URLRequest(url: baseURL.appendingPathComponent("/api/auth/exchange"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: ["id_token": idToken])

        let (data, response) = try await transport.send(request)
        guard (200..<300).contains(response.statusCode) else {
            let code = try? JSONDecoder().decode(ErrorBody.self, from: data).error
            throw APIError.refused(status: response.statusCode, code: code)
        }
        let session = try decode(SignedInSession.self, from: data)
        try tokens.store(session.sessionToken)
        return session
    }

    /// A token that has already expired reads as signed OUT: after a relaunch
    /// the next morning the old answer was "Signed in" followed by a 401 on
    /// Join, which is worse than the sign-in button. A token whose payload is
    /// not readable (an opaque `--token` dev credential) carries no `exp` and
    /// stays signed in, as before.
    public func isSignedIn(at now: Date = Date()) -> Bool {
        guard let token = tokens.token() else { return false }
        if let expiresAt = SessionTokenClaims.decodeUnverified(token)?.expiresAt {
            return expiresAt > now
        }
        return true
    }

    /// The email inside the stored session JWT, for the "Signed in as" label
    /// after a relaunch, when no exchange response is around to provide it.
    public func signedInEmail() -> String? {
        tokens.token().flatMap { SessionTokenClaims.decodeUnverified($0)?.email }
    }

    public func signOut() throws {
        try tokens.clear()
    }

    // MARK: requests

    /// Join a sitting. The server decides whether the code names an open
    /// sitting AND whether this student belongs in it; the client does not
    /// pre-judge either.
    public func redeem(code: String) async throws -> RedeemedSession {
        try await send(
            path: "/api/test-sessions/redeem",
            method: "POST",
            body: ["code": code],
        )
    }

    /// Slice 84: the signed-in student's pre-assigned sittings. Staff sessions
    /// are refused with a 403, which surfaces as `APIError.refused` like any
    /// other refusal.
    public func mySittings() async throws -> MySittings {
        try await send(path: "/api/me/sittings", method: "GET", body: nil)
    }

    public func startAttempt(testSessionID: String) async throws -> StartedAttempt {
        try await send(
            path: "/api/attempts",
            method: "POST",
            body: ["test_session_id": testSessionID],
        )
    }

    /// The bundle is returned as RAW BYTES as well as a decoded value. The
    /// renderer is handed the original bytes so a field this build does not yet
    /// know about still reaches the student's page (see AssessmentPage).
    public func fetchBundle(assessmentID: String) async throws -> (DeliveryBundle, String) {
        let data = try await sendRaw(
            path: "/api/assessments/\(assessmentID)/delivery",
            method: "GET",
            body: nil,
        )
        let bundle = try decode(DeliveryBundle.self, from: data)
        guard let json = String(data: data, encoding: .utf8) else {
            throw APIError.decoding("bundle was not valid UTF-8")
        }
        return (bundle, json)
    }

    /// Upsert an answer. PUT because answering the same item twice is normal,
    /// and the server's (attempt, item) unique constraint makes it idempotent —
    /// which is what lets a retry after a flaky network be safe rather than a
    /// double-record.
    public func putResponse(
        attemptID: String,
        itemID: String,
        responseJSON: String,
    ) async throws {
        _ = try await sendRaw(
            path: "/api/attempts/\(attemptID)/responses/\(itemID)",
            method: "PUT",
            rawBody: Data("{\"response\":\(responseJSON)}".utf8),
        )
    }

    /// Withdraw an answer. Needed because for multi-select, match and hotspot
    /// an unanswered item is the ABSENCE of a response, so clearing the last
    /// selection has nothing valid to send as a response.
    public func deleteResponse(attemptID: String, itemID: String) async throws {
        _ = try await sendRaw(
            path: "/api/attempts/\(attemptID)/responses/\(itemID)",
            method: "DELETE",
            rawBody: nil,
        )
    }

    public func submit(attemptID: String) async throws {
        _ = try await sendRaw(
            path: "/api/attempts/\(attemptID)/submit",
            method: "POST",
            rawBody: nil,
        )
    }

    /// Slice 92: report one client event (quit, emergency exit, focus change,
    /// lockdown lifecycle) for the teacher monitor. The response body is
    /// ignored — callers are fire-and-forget by contract, and the server
    /// stamps the event time itself.
    public func postEvent(
        attemptID: String,
        kind: AttemptEventKind,
        detail: [String: String]? = nil,
    ) async throws {
        var body: [String: Any] = ["kind": kind.rawValue]
        if let detail { body["detail"] = detail }
        _ = try await sendRaw(
            path: "/api/attempts/\(attemptID)/events",
            method: "POST",
            rawBody: try JSONSerialization.data(withJSONObject: body),
        )
    }

    /// On-demand peek: "does my teacher want a look?" — the PeekResponder's
    /// 5 s poll. Only a request younger than the server's pending TTL comes
    /// back, and null means no.
    public func fetchPendingPeek(attemptID: String) async throws -> PendingPeek? {
        let envelope: PendingPeekEnvelope = try await send(
            path: "/api/attempts/\(attemptID)/peek/pending",
            method: "GET",
            body: nil,
        )
        return envelope.pending
    }

    /// On-demand peek: the rendered frame, base64 JPEG. Fire-and-forget at
    /// the caller; the server refuses a stale or replaced request with 404,
    /// which the PeekResponder logs and drops.
    public func uploadPeekImage(
        attemptID: String,
        peekID: String,
        imageBase64: String,
    ) async throws {
        _ = try await sendRaw(
            path: "/api/attempts/\(attemptID)/peek/upload",
            method: "POST",
            rawBody: try JSONSerialization.data(withJSONObject: [
                "peek_id": peekID,
                "image_base64": imageBase64,
            ]),
        )
    }

    /// Ask for somewhere to put a drawing. The slot is registered server-side
    /// before any bytes exist, which is what stops one student's answer
    /// referencing another's file.
    ///
    /// The size is DECLARED here rather than discovered at upload time. A
    /// presigned PUT binds an exact Content-Length and cannot express a
    /// maximum, so the server applies its cap to this declaration and then
    /// signs it — after which the signature holds us to what we said.
    public func requestUpload(
        attemptID: String,
        itemID: String,
        contentType: String,
        contentLength: Int,
    ) async throws -> UploadTarget {
        let data = try await sendRaw(
            path: "/api/attempts/\(attemptID)/responses/\(itemID)/upload-url",
            method: "POST",
            rawBody: try JSONSerialization.data(withJSONObject: [
                "content_type": contentType,
                "content_length": contentLength,
            ]),
        )
        return try decode(UploadTarget.self, from: data)
    }

    /// PUT the bytes at the target.
    ///
    /// A direct target is object storage and must NOT receive the session
    /// token: it is a different trust domain, the signature is the credential,
    /// and attaching ours would leak it to a third party. A non-direct target is
    /// this app, and needs it.
    public func uploadBytes(_ bytes: Data, to target: UploadTarget) async throws {
        let url: URL
        if target.upload.direct {
            guard let absolute = URL(string: target.upload.url) else {
                throw APIError.decoding("upload url was not a url")
            }
            url = absolute
        } else {
            guard let relative = URL(string: target.upload.url, relativeTo: baseURL) else {
                throw APIError.decoding("upload url was not a url")
            }
            url = relative
        }

        var request = URLRequest(url: url)
        request.httpMethod = "PUT"
        request.httpBody = bytes
        for (name, value) in target.upload.headers {
            // Content-Length is set by URLSession from the body and cannot be
            // overridden here, so it is skipped rather than fought with. The
            // server signed the size we declared, so the two agree as long as
            // we upload what we said we would — which the guard below checks
            // before anything is sent.
            if name.lowercased() == "content-length" { continue }
            request.setValue(value, forHTTPHeaderField: name)
        }
        guard bytes.count == target.declaredBytes else {
            throw APIError.decoding(
                "upload size changed after the URL was signed (\(bytes.count) vs \(target.declaredBytes))"
            )
        }
        if !target.upload.direct {
            guard let token = tokens.token() else { throw APIError.notAuthenticated }
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }

        let (data, response) = try await transport.send(request)
        guard (200..<300).contains(response.statusCode) else {
            let code = try? JSONDecoder().decode(ErrorBody.self, from: data).error
            throw APIError.refused(status: response.statusCode, code: code)
        }
    }

    // MARK: plumbing

    private func send<T: Decodable>(
        path: String,
        method: String,
        body: [String: String]?,
    ) async throws -> T {
        let data = try await sendRaw(path: path, method: method, body: body)
        return try decode(T.self, from: data)
    }

    private func decode<T: Decodable>(_ type: T.Type, from data: Data) throws -> T {
        do {
            return try JSONDecoder().decode(type, from: data)
        } catch {
            throw APIError.decoding(String(describing: error))
        }
    }

    private func sendRaw(
        path: String,
        method: String,
        body: [String: String]?,
    ) async throws -> Data {
        try await sendRaw(
            path: path,
            method: method,
            rawBody: body.map { try? JSONSerialization.data(withJSONObject: $0) } ?? nil,
        )
    }

    private func sendRaw(
        path: String,
        method: String,
        rawBody: Data?,
    ) async throws -> Data {
        guard let token = tokens.token() else { throw APIError.notAuthenticated }

        var request = URLRequest(url: baseURL.appendingPathComponent(path))
        request.httpMethod = method
        // Bearer rather than a cookie: a native app has no cookie jar worth
        // emulating, and the server accepts either (slice 58).
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        if let rawBody {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = rawBody
        }

        let (data, response) = try await transport.send(request)
        guard (200..<300).contains(response.statusCode) else {
            let code = try? JSONDecoder().decode(ErrorBody.self, from: data).error
            throw APIError.refused(status: response.statusCode, code: code)
        }
        return data
    }
}
