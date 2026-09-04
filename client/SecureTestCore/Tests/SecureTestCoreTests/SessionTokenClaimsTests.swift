import XCTest
@testable import SecureTestCore

/// The relaunch fix (MANUAL-CHECKS "Still open" 2026-08-27): the "Signed in
/// as" email comes out of the stored session JWT's claims, and an expired
/// token reads as signed out instead of "Signed in" + 401 on Join.
final class SessionTokenClaimsTests: XCTestCase {
    func testDecodesTheDesignToolSessionPayload() {
        let claims = SessionTokenClaims.decodeUnverified(TestJWT.make([
            "sub": "google-oidc|123",
            "role": "student",
            "email": "kid@edtools.psd401.net",
            "exp": 1_800_000_000,
        ]))
        XCTAssertEqual(claims?.sub, "google-oidc|123")
        XCTAssertEqual(claims?.role, "student")
        XCTAssertEqual(claims?.email, "kid@edtools.psd401.net")
        XCTAssertEqual(claims?.expiresAt, Date(timeIntervalSince1970: 1_800_000_000))
    }

    func testMissingClaimsDecodeAsNilsNotFailure() {
        let claims = SessionTokenClaims.decodeUnverified(TestJWT.make(["sub": "s"]))
        XCTAssertNotNil(claims)
        XCTAssertNil(claims?.email)
        XCTAssertNil(claims?.role)
        XCTAssertNil(claims?.expiresAt)
    }

    func testAnOpaqueDevTokenIsNotReadableAndNotAnError() {
        XCTAssertNil(SessionTokenClaims.decodeUnverified("not-a-jwt"))
        XCTAssertNil(SessionTokenClaims.decodeUnverified("a.%%%%.c"))
    }
}

final class APIClientSignedInStateTests: XCTestCase {
    private func client(token: String?) -> APIClient {
        APIClient(
            baseURL: URL(string: "https://d.example")!,
            transport: RecordingTransport(),
            tokens: InMemoryTokenStore(token: token),
        )
    }

    func testExpiredSessionTokenReadsAsSignedOut() async {
        let now = Date(timeIntervalSince1970: 1_700_000_000)
        let expired = TestJWT.make(["sub": "s", "exp": 1_700_000_000 - 60])
        let signedIn = await client(token: expired).isSignedIn(at: now)
        XCTAssertFalse(signedIn)
    }

    func testUnexpiredSessionTokenReadsAsSignedIn() async {
        let now = Date(timeIntervalSince1970: 1_700_000_000)
        let live = TestJWT.make(["sub": "s", "exp": 1_700_000_000 + 60])
        let signedIn = await client(token: live).isSignedIn(at: now)
        XCTAssertTrue(signedIn)
    }

    func testOpaqueDevTokenStaysSignedIn() async {
        // --token / SECURE_TEST_TOKEN carries no readable exp; the dev and CI
        // posture is unchanged.
        let signedIn = await client(token: "opaque-dev-token").isSignedIn()
        XCTAssertTrue(signedIn)
    }

    func testSignedInEmailComesFromTheStoredToken() async {
        let jwt = TestJWT.make(["sub": "s", "email": "kid@edtools.psd401.net"])
        let email = await client(token: jwt).signedInEmail()
        XCTAssertEqual(email, "kid@edtools.psd401.net")
    }

    func testSignedInEmailIsNilForOpaqueOrMissingTokens() async {
        let opaque = await client(token: "opaque-dev-token").signedInEmail()
        XCTAssertNil(opaque)
        let none = await client(token: nil).signedInEmail()
        XCTAssertNil(none)
    }
}
