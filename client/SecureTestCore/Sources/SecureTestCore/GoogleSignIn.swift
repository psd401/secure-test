import Foundation

/// Slice 80 (ADR 0017): the client's Google sign-in, everything except the
/// browser.
///
/// The shape is PoC-C's (`OIDCClient.swift`) with two changes. The issuer is
/// Google, not ClassLink; and the one piece that needs AppKit — presenting an
/// `ASWebAuthenticationSession` and getting the callback URL back — is
/// injected as a closure (`WebAuthPresenter`), so every other step runs under
/// `swift test`: building the authorization URL, parsing the callback,
/// exchanging the code at Google's token endpoint, checking the nonce, and
/// exchanging the id_token for a session at `/api/auth/exchange`.
///
/// What the client does NOT do is verify the id_token's signature. The
/// design tool does that (issuer, audience, JWKS — slice 77) before it mints
/// a session; the client only checks the nonce it sent, so a token replayed
/// from somewhere else cannot complete a sign-in it did not start.
public struct SignInConfig: Sendable, Equatable {
    public let issuer: URL
    public let authorizationEndpoint: URL
    public let tokenEndpoint: URL
    public let clientID: String
    /// Full redirect URI, e.g. `com.googleusercontent.apps.123-abc:/oauth2redirect`.
    public let redirectURI: String
    public let scopes: [String]

    public init(
        issuer: URL,
        authorizationEndpoint: URL,
        tokenEndpoint: URL,
        clientID: String,
        redirectURI: String,
        scopes: [String],
    ) {
        self.issuer = issuer
        self.authorizationEndpoint = authorizationEndpoint
        self.tokenEndpoint = tokenEndpoint
        self.clientID = clientID
        self.redirectURI = redirectURI
        self.scopes = scopes
    }

    /// The scheme `ASWebAuthenticationSession` is told to wait for.
    public var callbackScheme: String {
        String(redirectURI.prefix { $0 != ":" })
    }

    /// Google's fixed endpoints for an iOS/macOS-type OAuth client. Such a
    /// client has no secret; its redirect is the REVERSE of its client id
    /// (`123-abc.apps.googleusercontent.com` → `com.googleusercontent.apps.123-abc`)
    /// as a custom scheme, which is what Google registers for it.
    public static func google(clientID: String) -> SignInConfig {
        SignInConfig(
            issuer: URL(string: "https://accounts.google.com")!,
            authorizationEndpoint: URL(string: "https://accounts.google.com/o/oauth2/v2/auth")!,
            tokenEndpoint: URL(string: "https://oauth2.googleapis.com/token")!,
            clientID: clientID,
            redirectURI: "\(reverseClientID(clientID)):/oauth2redirect",
            scopes: ["openid", "email", "profile"],
        )
    }

    public static func reverseClientID(_ clientID: String) -> String {
        clientID.split(separator: ".").reversed().joined(separator: ".")
    }
}

public enum SignInError: Error, Equatable {
    /// The person closed the browser sheet.
    case cancelled
    /// Google sent back `error=…` instead of a code.
    case providerError(String)
    case callbackMissingCode
    /// The callback's `state` is not the one this flow sent: not our reply.
    case stateMismatch
    case tokenEndpoint(status: Int)
    case tokenResponseMissingIdToken
    case malformedIdToken
    /// The id_token's nonce is not the one this flow sent.
    case nonceMismatch
    /// The design tool refused the account (wrong domain, unverified address).
    case exchangeRefused(status: Int, code: String?)
}

public enum AuthorizationRequest {
    public static func url(
        config: SignInConfig,
        pkce: PKCEPair,
        state: String,
        nonce: String,
    ) -> URL {
        var components = URLComponents(url: config.authorizationEndpoint, resolvingAgainstBaseURL: false)!
        components.queryItems = [
            .init(name: "response_type", value: "code"),
            .init(name: "client_id", value: config.clientID),
            .init(name: "redirect_uri", value: config.redirectURI),
            .init(name: "scope", value: config.scopes.joined(separator: " ")),
            .init(name: "state", value: state),
            .init(name: "nonce", value: nonce),
            .init(name: "code_challenge", value: pkce.challenge),
            .init(name: "code_challenge_method", value: PKCEPair.method),
            // UX pass 2 (James, 2026-08-31, decided after select_account
            // proved insufficient): DEMAND credentials on every sign-in.
            // Google kept honouring a lingering web session — the chooser
            // appeared but bounced back to the previous student even after a
            // different address was typed, and a warm ephemeral cookie jar
            // survived longer than the docs suggest. prompt=login forces
            // reauthentication outright: on a shared lab Mac no student is
            // ever one click from the previous student's account. Our own
            // Keychain session still spares re-auth on relaunch; this bites
            // only at true Google sign-ins.
            .init(name: "prompt", value: "login"),
        ]
        return components.url!
    }

    /// The `code` from the callback, after checking it is the reply to THIS
    /// request. Google reports a refusal as `error=` (e.g. `access_denied`
    /// when Workspace blocks the app for the account — ADR 0017 "Depends on"
    /// #2), which is surfaced by name so the first student sign-in can be
    /// diagnosed from the log.
    public static func parseCallback(_ url: URL, expectedState: String) throws -> String {
        let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        func value(_ name: String) -> String? { items.first { $0.name == name }?.value }
        if let error = value("error") { throw SignInError.providerError(error) }
        guard value("state") == expectedState else { throw SignInError.stateMismatch }
        guard let code = value("code"), !code.isEmpty else { throw SignInError.callbackMissingCode }
        return code
    }
}

public enum TokenRequest {
    /// The authorization-code exchange at Google's token endpoint. No client
    /// secret: this is a public client, and the PKCE verifier is its proof.
    public static func build(config: SignInConfig, code: String, verifier: String) -> URLRequest {
        var request = URLRequest(url: config.tokenEndpoint)
        request.httpMethod = "POST"
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.httpBody = Data(formEncode([
            ("grant_type", "authorization_code"),
            ("code", code),
            ("redirect_uri", config.redirectURI),
            ("client_id", config.clientID),
            ("code_verifier", verifier),
        ]).utf8)
        return request
    }

    static func formEncode(_ fields: [(String, String)]) -> String {
        var allowed = CharacterSet.alphanumerics
        allowed.insert(charactersIn: "-._~")
        return fields
            .map { "\($0.0)=\($0.1.addingPercentEncoding(withAllowedCharacters: allowed) ?? $0.1)" }
            .joined(separator: "&")
    }

    public static func decodeFormBody(_ data: Data?) -> [String: String] {
        guard let data, let text = String(data: data, encoding: .utf8) else { return [:] }
        var out: [String: String] = [:]
        for pair in text.split(separator: "&") {
            let parts = pair.split(separator: "=", maxSplits: 1).map(String.init)
            guard parts.count == 2 else { continue }
            out[parts[0]] = parts[1].removingPercentEncoding ?? parts[1]
        }
        return out
    }
}

struct TokenResponse: Decodable {
    let id_token: String?
}

/// The id_token's payload, read WITHOUT verifying the signature. Only the
/// nonce is acted on here; `email` is carried for the "signed in as" label
/// and is what the server's verified copy will agree with or refuse.
public struct IdTokenClaims: Equatable, Sendable {
    public let sub: String?
    public let email: String?
    public let nonce: String?

    public static func decodeUnverified(_ jwt: String) throws -> IdTokenClaims {
        let parts = jwt.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 3,
              let payload = Base64URL.decode(String(parts[1])),
              let json = try? JSONSerialization.jsonObject(with: payload) as? [String: Any]
        else {
            throw SignInError.malformedIdToken
        }
        return IdTokenClaims(
            sub: json["sub"] as? String,
            email: json["email"] as? String,
            nonce: json["nonce"] as? String,
        )
    }
}

/// Presents the authorization URL in the system's web-auth sheet and returns
/// the callback URL. The app backs this with `ASWebAuthenticationSession`;
/// tests back it with a closure that returns a URL they built.
public typealias WebAuthPresenter = @Sendable (_ authorizationURL: URL, _ callbackScheme: String) async throws -> URL

public actor GoogleSignInFlow {
    private let config: SignInConfig
    private let transport: HTTPTransport
    private let api: APIClient
    private let present: WebAuthPresenter
    private let log: @Sendable (String) -> Void

    public init(
        config: SignInConfig,
        transport: HTTPTransport,
        api: APIClient,
        present: @escaping WebAuthPresenter,
        log: @escaping @Sendable (String) -> Void = { _ in },
    ) {
        self.config = config
        self.transport = transport
        self.api = api
        self.present = present
        self.log = log
    }

    /// The whole flow. On success the session token is already in the token
    /// store (via `APIClient.exchangeIdToken`) and the student can join.
    public func signIn() async throws -> SignedInSession {
        let pkce = PKCEPair.generate()
        let state = randomURLSafeToken()
        let nonce = randomURLSafeToken()

        let authURL = AuthorizationRequest.url(config: config, pkce: pkce, state: state, nonce: nonce)
        // Names only — state/nonce/challenge values stay out of the log.
        // `prompt` is the exception: its value is policy, not secret, and the
        // slice-9 stickiness hunt needed to see which prompt actually went out.
        let queryNames = URLComponents(url: authURL, resolvingAgainstBaseURL: false)?
            .queryItems?.map { $0.name == "prompt" ? "prompt=\($0.value ?? "?")" : $0.name }
            .joined(separator: " ") ?? "?"
        log("sign-in: opening \(config.authorizationEndpoint.host ?? "issuer") for client \(config.clientID.prefix(8))… params: \(queryNames)")

        let callback = try await present(authURL, config.callbackScheme)
        let code = try AuthorizationRequest.parseCallback(callback, expectedState: state)

        let (data, response) = try await transport.send(
            TokenRequest.build(config: config, code: code, verifier: pkce.verifier)
        )
        guard (200..<300).contains(response.statusCode) else {
            log("sign-in: token endpoint answered \(response.statusCode)")
            throw SignInError.tokenEndpoint(status: response.statusCode)
        }
        guard let idToken = (try? JSONDecoder().decode(TokenResponse.self, from: data))?.id_token else {
            throw SignInError.tokenResponseMissingIdToken
        }

        let claims = try IdTokenClaims.decodeUnverified(idToken)
        guard claims.nonce == nonce else { throw SignInError.nonceMismatch }

        do {
            let session = try await api.exchangeIdToken(idToken)
            log("sign-in: session minted for role \(session.role)")
            return session
        } catch APIError.refused(let status, let code) {
            // account_not_allowed is the one a student can act on: wrong
            // Google account. Everything else is the server's to explain.
            log("sign-in: exchange refused \(status) \(code ?? "-")")
            // Observability slice 4: nobody is signed in yet, so this cannot
            // be an event — the file is the only channel it has, and it
            // drains after whatever sign-in eventually succeeds.
            ClientErrorLog.shared?.record(
                kind: "signin_exchange_refused",
                message: "exchange refused",
                context: ["status": String(status), "code": code ?? "-"]
            )
            throw SignInError.exchangeRefused(status: status, code: code)
        }
    }
}
