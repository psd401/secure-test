import CryptoKit
import XCTest
@testable import SecureTestCore

/// Slice 80: everything in the sign-in flow that is not the browser sheet.
final class PKCETests: XCTestCase {
    func testVerifierIsURLSafeAndLongEnough() {
        let pair = PKCEPair.generate()
        XCTAssertGreaterThanOrEqual(pair.verifier.count, 43)
        XCTAssertLessThanOrEqual(pair.verifier.count, 128)
        XCTAssertNil(pair.verifier.rangeOfCharacter(from: CharacterSet(charactersIn: "-._~")
            .union(.alphanumerics).inverted))
    }

    func testChallengeIsBase64URLOfSHA256OfVerifier() {
        let pair = PKCEPair(verifier: "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")
        // RFC 7636 appendix B.
        XCTAssertEqual(pair.challenge, "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")
        XCTAssertEqual(PKCEPair.method, "S256")
    }

    func testEachPairIsFresh() {
        XCTAssertNotEqual(PKCEPair.generate().verifier, PKCEPair.generate().verifier)
    }

    func testBase64URLRoundTrip() {
        let bytes = Data((0..<64).map { UInt8($0 * 4 % 256) })
        let encoded = Base64URL.encode(bytes)
        XCTAssertFalse(encoded.contains("="))
        XCTAssertFalse(encoded.contains("+"))
        XCTAssertFalse(encoded.contains("/"))
        XCTAssertEqual(Base64URL.decode(encoded), bytes)
    }
}

final class SignInConfigTests: XCTestCase {
    func testGoogleConfigDerivesTheReverseClientIDRedirect() {
        let config = SignInConfig.google(clientID: "123-abc.apps.googleusercontent.com")
        XCTAssertEqual(config.redirectURI, "com.googleusercontent.apps.123-abc:/oauth2redirect")
        XCTAssertEqual(config.callbackScheme, "com.googleusercontent.apps.123-abc")
        XCTAssertEqual(config.issuer.absoluteString, "https://accounts.google.com")
        XCTAssertEqual(config.authorizationEndpoint.absoluteString, "https://accounts.google.com/o/oauth2/v2/auth")
        XCTAssertEqual(config.tokenEndpoint.absoluteString, "https://oauth2.googleapis.com/token")
        XCTAssertEqual(config.scopes, ["openid", "email", "profile"])
    }
}

final class AuthorizationRequestTests: XCTestCase {
    private let config = SignInConfig.google(clientID: "123-abc.apps.googleusercontent.com")

    private func query(_ url: URL) -> [String: String] {
        Dictionary(
            uniqueKeysWithValues: (URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? [])
                .map { ($0.name, $0.value ?? "") }
        )
    }

    func testAuthorizationURLCarriesEveryParameterGoogleNeeds() {
        let pkce = PKCEPair(verifier: "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")
        let url = AuthorizationRequest.url(config: config, pkce: pkce, state: "st", nonce: "nn")
        XCTAssertEqual(url.host, "accounts.google.com")
        XCTAssertEqual(url.path, "/o/oauth2/v2/auth")
        let q = query(url)
        XCTAssertEqual(q["response_type"], "code")
        XCTAssertEqual(q["client_id"], "123-abc.apps.googleusercontent.com")
        XCTAssertEqual(q["redirect_uri"], "com.googleusercontent.apps.123-abc:/oauth2redirect")
        XCTAssertEqual(q["scope"], "openid email profile")
        XCTAssertEqual(q["state"], "st")
        XCTAssertEqual(q["nonce"], "nn")
        XCTAssertEqual(q["code_challenge"], "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")
        XCTAssertEqual(q["code_challenge_method"], "S256")
        // UX pass 2 (James): credentials demanded on every sign-in.
        XCTAssertEqual(q["prompt"], "login")
    }

    func testCallbackYieldsTheCodeWhenStateMatches() throws {
        let url = URL(string: "com.googleusercontent.apps.123-abc:/oauth2redirect?state=st&code=4%2Fabc&scope=email")!
        XCTAssertEqual(try AuthorizationRequest.parseCallback(url, expectedState: "st"), "4/abc")
    }

    func testCallbackWithTheWrongStateIsNotOurs() {
        let url = URL(string: "com.googleusercontent.apps.123-abc:/oauth2redirect?state=other&code=abc")!
        XCTAssertThrowsError(try AuthorizationRequest.parseCallback(url, expectedState: "st")) {
            XCTAssertEqual($0 as? SignInError, .stateMismatch)
        }
    }

    func testCallbackWithoutACodeIsRefused() {
        let url = URL(string: "com.googleusercontent.apps.123-abc:/oauth2redirect?state=st")!
        XCTAssertThrowsError(try AuthorizationRequest.parseCallback(url, expectedState: "st")) {
            XCTAssertEqual($0 as? SignInError, .callbackMissingCode)
        }
    }

    func testProviderErrorIsSurfacedByNameBeforeAnythingElse() {
        // Workspace refusing the app for a student account arrives this way.
        let url = URL(string: "com.googleusercontent.apps.123-abc:/oauth2redirect?error=access_denied&state=wrong")!
        XCTAssertThrowsError(try AuthorizationRequest.parseCallback(url, expectedState: "st")) {
            XCTAssertEqual($0 as? SignInError, .providerError("access_denied"))
        }
    }
}

final class TokenRequestTests: XCTestCase {
    func testTokenRequestIsAFormPostWithTheVerifierAndNoSecret() {
        let config = SignInConfig.google(clientID: "123-abc.apps.googleusercontent.com")
        let request = TokenRequest.build(config: config, code: "4/abc def", verifier: "ver~ifier")
        XCTAssertEqual(request.url?.absoluteString, "https://oauth2.googleapis.com/token")
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "application/x-www-form-urlencoded")
        let form = TokenRequest.decodeFormBody(request.httpBody)
        XCTAssertEqual(form["grant_type"], "authorization_code")
        XCTAssertEqual(form["code"], "4/abc def")
        XCTAssertEqual(form["redirect_uri"], "com.googleusercontent.apps.123-abc:/oauth2redirect")
        XCTAssertEqual(form["client_id"], "123-abc.apps.googleusercontent.com")
        XCTAssertEqual(form["code_verifier"], "ver~ifier")
        XCTAssertNil(form["client_secret"])
        // Reserved characters in values are encoded, not passed through.
        let raw = String(data: request.httpBody!, encoding: .utf8)!
        XCTAssertTrue(raw.contains("code=4%2Fabc%20def"))
    }
}

final class IdTokenClaimsTests: XCTestCase {
    func testDecodesThePayloadWithoutVerifying() throws {
        let claims = try IdTokenClaims.decodeUnverified(
            TestJWT.make(["sub": "g-1", "email": "ada.fixture@edtools.psd401.net", "nonce": "nn"])
        )
        XCTAssertEqual(claims, IdTokenClaims(sub: "g-1", email: "ada.fixture@edtools.psd401.net", nonce: "nn"))
    }

    func testMalformedTokensAreRefused() {
        for bad in ["", "abc", "a.b", "a.!!!.c", "a.\(Base64URL.encode(Data("[]".utf8))).c"] {
            XCTAssertThrowsError(try IdTokenClaims.decodeUnverified(bad), bad) {
                XCTAssertEqual($0 as? SignInError, .malformedIdToken)
            }
        }
    }
}

final class GoogleSignInFlowTests: XCTestCase {
    private let config = SignInConfig.google(clientID: "123-abc.apps.googleusercontent.com")
    private let base = URL(string: "https://design.example")!

    /// A presenter that answers the authorization URL the way Google would:
    /// echoing the state, and (unless told otherwise) noting the nonce so the
    /// scripted id_token can carry it.
    private final class FakeBrowser: @unchecked Sendable {
        var seenURL: URL?
        var seenScheme: String?
        var nonce: String?
        var state: String?
        var respond: (String) -> String = { state in "?state=\(state)&code=CODE" }

        func present(_ url: URL, _ scheme: String) async throws -> URL {
            seenURL = url
            seenScheme = scheme
            let q = Dictionary(uniqueKeysWithValues: (URLComponents(url: url, resolvingAgainstBaseURL: false)?
                .queryItems ?? []).map { ($0.name, $0.value ?? "") })
            nonce = q["nonce"]
            state = q["state"]
            return URL(string: "\(scheme):/oauth2redirect\(respond(q["state"] ?? ""))")!
        }
    }

    /// Two transports in one: the first send goes to Google's token endpoint,
    /// the second to the design tool's exchange.
    private final class ScriptedTransport: HTTPTransport, @unchecked Sendable {
        var sent: [URLRequest] = []
        var tokenStatus = 200
        var idTokenFor: (String?) -> String = { nonce in TestJWT.make(["sub": "g-1", "nonce": nonce ?? ""]) }
        var exchangeStatus = 200
        var exchangeBody = #"{"ok":true,"sub":"g-1","role":"student","email":"ada.fixture@edtools.psd401.net","session_token":"SESSION-JWT"}"#
        let browser: FakeBrowser

        init(browser: FakeBrowser) { self.browser = browser }

        func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
            sent.append(request)
            let isToken = request.url?.host == "oauth2.googleapis.com"
            let status = isToken ? tokenStatus : exchangeStatus
            let body = isToken
                ? #"{"id_token":"\#(idTokenFor(browser.nonce))","access_token":"x","token_type":"Bearer"}"#
                : exchangeBody
            let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!
            return (Data(body.utf8), response)
        }
    }

    private func flow(_ browser: FakeBrowser, _ transport: ScriptedTransport, tokens: InMemoryTokenStore) -> GoogleSignInFlow {
        let api = APIClient(baseURL: base, transport: transport, tokens: tokens)
        return GoogleSignInFlow(config: config, transport: transport, api: api, present: browser.present)
    }

    func testHappyPathStoresTheSessionToken() async throws {
        let browser = FakeBrowser()
        let transport = ScriptedTransport(browser: browser)
        let tokens = InMemoryTokenStore()
        let session = try await flow(browser, transport, tokens: tokens).signIn()

        XCTAssertEqual(session.role, "student")
        XCTAssertEqual(session.email, "ada.fixture@edtools.psd401.net")
        XCTAssertEqual(tokens.token(), "SESSION-JWT")

        XCTAssertEqual(browser.seenScheme, "com.googleusercontent.apps.123-abc")
        XCTAssertEqual(browser.seenURL?.host, "accounts.google.com")

        XCTAssertEqual(transport.sent.count, 2)
        let tokenForm = TokenRequest.decodeFormBody(transport.sent[0].httpBody)
        XCTAssertEqual(tokenForm["code"], "CODE")
        XCTAssertEqual(tokenForm["client_id"], config.clientID)
        // The verifier sent to Google hashes to the challenge sent in the URL.
        let challenge = Dictionary(uniqueKeysWithValues: (URLComponents(url: browser.seenURL!, resolvingAgainstBaseURL: false)?
            .queryItems ?? []).map { ($0.name, $0.value ?? "") })["code_challenge"]
        XCTAssertEqual(PKCEPair(verifier: tokenForm["code_verifier"]!).challenge, challenge)

        let exchange = transport.sent[1]
        XCTAssertEqual(exchange.url?.path, "/api/auth/exchange")
        XCTAssertNil(exchange.value(forHTTPHeaderField: "Authorization"), "no bearer before a session exists")
        let exchangeBody = try JSONSerialization.jsonObject(with: exchange.httpBody!) as? [String: String]
        XCTAssertEqual(exchangeBody?["id_token"], transport.idTokenFor(browser.nonce))
    }

    func testWrongStateIsRefusedBeforeAnyRequestIsSent() async {
        let browser = FakeBrowser()
        browser.respond = { _ in "?state=somebody-elses&code=CODE" }
        let transport = ScriptedTransport(browser: browser)
        let tokens = InMemoryTokenStore()
        do {
            _ = try await flow(browser, transport, tokens: tokens).signIn()
            XCTFail("expected stateMismatch")
        } catch {
            XCTAssertEqual(error as? SignInError, .stateMismatch)
        }
        XCTAssertEqual(transport.sent.count, 0)
        XCTAssertNil(tokens.token())
    }

    func testProviderErrorIsSurfacedByName() async {
        let browser = FakeBrowser()
        browser.respond = { _ in "?error=access_denied" }
        let transport = ScriptedTransport(browser: browser)
        do {
            _ = try await flow(browser, transport, tokens: InMemoryTokenStore()).signIn()
            XCTFail("expected providerError")
        } catch {
            XCTAssertEqual(error as? SignInError, .providerError("access_denied"))
        }
    }

    func testTokenEndpointFailureStopsTheFlow() async {
        let browser = FakeBrowser()
        let transport = ScriptedTransport(browser: browser)
        transport.tokenStatus = 400
        let tokens = InMemoryTokenStore()
        do {
            _ = try await flow(browser, transport, tokens: tokens).signIn()
            XCTFail("expected tokenEndpoint")
        } catch {
            XCTAssertEqual(error as? SignInError, .tokenEndpoint(status: 400))
        }
        XCTAssertEqual(transport.sent.count, 1)
        XCTAssertNil(tokens.token())
    }

    func testAnIdTokenWithAnotherNonceIsNotExchanged() async {
        let browser = FakeBrowser()
        let transport = ScriptedTransport(browser: browser)
        transport.idTokenFor = { _ in TestJWT.make(["sub": "g-1", "nonce": "replayed"]) }
        let tokens = InMemoryTokenStore()
        do {
            _ = try await flow(browser, transport, tokens: tokens).signIn()
            XCTFail("expected nonceMismatch")
        } catch {
            XCTAssertEqual(error as? SignInError, .nonceMismatch)
        }
        XCTAssertEqual(transport.sent.count, 1, "the exchange must not be attempted")
        XCTAssertNil(tokens.token())
    }

    func testTheServerRefusingTheAccountLeavesNoToken() async {
        let browser = FakeBrowser()
        let transport = ScriptedTransport(browser: browser)
        transport.exchangeStatus = 403
        transport.exchangeBody = #"{"ok":false,"error":"account_not_allowed"}"#
        let tokens = InMemoryTokenStore()
        do {
            _ = try await flow(browser, transport, tokens: tokens).signIn()
            XCTFail("expected exchangeRefused")
        } catch {
            XCTAssertEqual(error as? SignInError, .exchangeRefused(status: 403, code: "account_not_allowed"))
        }
        XCTAssertNil(tokens.token())
    }

    func testAuthorizeLogLineShowsThePromptValueButNoSecrets() async throws {
        let browser = FakeBrowser()
        let transport = ScriptedTransport(browser: browser)
        let tokens = InMemoryTokenStore()
        let lines = Lines()
        let api = APIClient(baseURL: base, transport: transport, tokens: tokens)
        let flow = GoogleSignInFlow(
            config: config, transport: transport, api: api,
            present: browser.present, log: { lines.append($0) }
        )
        _ = try await flow.signIn()

        let authorizeLine = lines.all().first { $0.contains("opening accounts.google.com") }
        XCTAssertNotNil(authorizeLine)
        XCTAssertTrue(authorizeLine?.contains("prompt=login") ?? false)
        // state/nonce stay name-only: their values must not appear anywhere.
        for line in lines.all() {
            XCTAssertFalse(line.contains(browser.state ?? "-"), line)
            XCTAssertFalse(line.contains(browser.nonce ?? "-"), line)
        }
    }

    /// A thread-safe log sink for the @Sendable log closure.
    private final class Lines: @unchecked Sendable {
        private var lines: [String] = []
        private let lock = NSLock()
        func append(_ line: String) { lock.lock(); lines.append(line); lock.unlock() }
        func all() -> [String] { lock.lock(); defer { lock.unlock() }; return lines }
    }

    func testJoinErrorCopyKnowsTheNewCodes() {
        XCTAssertEqual(
            JoinErrorCopy.message(forCode: "account_not_allowed"),
            "That Google account cannot be used here. Sign in with your school account."
        )
        XCTAssertEqual(JoinErrorCopy.message(forCode: "no_email"), JoinErrorCopy.message(forCode: "no_sourced_id"))
    }
}

final class APIClientSignInTests: XCTestCase {
    func testSignOutClearsTheTokenAndIsSignedInReflectsIt() async throws {
        let tokens = InMemoryTokenStore(token: "t")
        let client = APIClient(baseURL: URL(string: "https://d.example")!, transport: RecordingTransport(), tokens: tokens)
        let before = await client.isSignedIn()
        XCTAssertTrue(before)
        try await client.signOut()
        let after = await client.isSignedIn()
        XCTAssertFalse(after)
    }
}

/// An unsigned JWT with the given payload — the client never verifies the
/// signature (the server does), so a fixed signature segment is enough here.
enum TestJWT {
    static func make(_ payload: [String: Any]) -> String {
        let header = Base64URL.encode(Data(#"{"alg":"RS256","kid":"test"}"#.utf8))
        let body = Base64URL.encode(try! JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys]))
        return "\(header).\(body).sig"
    }
}
