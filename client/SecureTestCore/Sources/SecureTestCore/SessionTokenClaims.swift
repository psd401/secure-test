import Foundation

/// The design tool's session JWT payload, read WITHOUT verifying the
/// signature — the same posture as `IdTokenClaims`: the server verifies the
/// token on every request, and nothing here is acted on beyond display and
/// deciding whether to show the sign-in button. The claims are what
/// `mintSessionJWT` signs (design-tool `lib/auth/session.ts`): `sub`, `role`,
/// `email`, `exp`.
public struct SessionTokenClaims: Equatable, Sendable {
    public let sub: String?
    public let role: String?
    public let email: String?
    /// `exp`, as a date. The design tool mints with an 8-hour TTL.
    public let expiresAt: Date?

    /// nil rather than throwing: an opaque token from `--token` /
    /// `SECURE_TEST_TOKEN` is not an error, it is just not readable, and the
    /// UI degrades to "Signed in" with no email.
    public static func decodeUnverified(_ token: String) -> SessionTokenClaims? {
        let parts = token.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 3,
              let payload = Base64URL.decode(String(parts[1])),
              let json = try? JSONSerialization.jsonObject(with: payload) as? [String: Any]
        else {
            return nil
        }
        return SessionTokenClaims(
            sub: json["sub"] as? String,
            role: json["role"] as? String,
            email: json["email"] as? String,
            expiresAt: (json["exp"] as? NSNumber).map { Date(timeIntervalSince1970: $0.doubleValue) },
        )
    }
}
