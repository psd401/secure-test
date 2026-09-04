import CryptoKit
import Foundation

/// Slice 80: RFC 7636 PKCE, ported from PoC-C (`poc-c-classlink-sso/client/
/// Sources/PocCClient/PKCE.swift`) into the package so it is covered by
/// `swift test`. The verifier is 64 random bytes base64url-encoded (86
/// characters, inside RFC 7636's 43–128), the challenge is the base64url
/// SHA-256 of the verifier's ASCII bytes, and the method is always S256 —
/// `plain` is not offered because nothing here needs it and Google refuses it.
public struct PKCEPair: Sendable, Equatable {
    public let verifier: String
    public let challenge: String
    public static let method = "S256"

    public init(verifier: String) {
        self.verifier = verifier
        self.challenge = Base64URL.encode(Data(SHA256.hash(data: Data(verifier.utf8))))
    }

    public static func generate() -> PKCEPair {
        PKCEPair(verifier: randomURLSafeToken(byteCount: 64))
    }
}

public enum Base64URL {
    public static func encode(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    public static func decode(_ string: String) -> Data? {
        var s = string
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        while s.count % 4 != 0 { s.append("=") }
        return Data(base64Encoded: s)
    }
}

/// `byteCount` random bytes from the system CSPRNG, base64url-encoded. Used
/// for the PKCE verifier and for the `state` and `nonce` values.
public func randomURLSafeToken(byteCount: Int = 32) -> String {
    var bytes = [UInt8](repeating: 0, count: byteCount)
    let status = SecRandomCopyBytes(kSecRandomDefault, byteCount, &bytes)
    precondition(status == errSecSuccess, "SecRandomCopyBytes failed: \(status)")
    return Base64URL.encode(Data(bytes))
}
