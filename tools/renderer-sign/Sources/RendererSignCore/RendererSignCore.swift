// The pure half of renderer-sign: what is signed, how it is verified, and
// the text a signer sees. No Secure Enclave, no file system — so it is
// testable with software keys and is the same check the client shell makes
// in slice 4 (docs/server-delivered-renderer-design.md 2.a).
//
// The signature: ECDSA P-256 over SHA-256 of the EXACT bytes of
// dist/manifest.json (the canonical form from packages/renderer
// src/manifest.ts), DER-encoded. Nothing re-canonicalizes here — the bytes
// on disk are the bytes signed.

import CryptoKit
import Foundation

public enum RendererSignError: Error, CustomStringConvertible, Equatable {
    case manifestNotJSONObject
    case manifestMissingVersion
    case manifestMissingCommit
    case badPublicKey(String)
    case badPrivateKey(String)

    public var description: String {
        switch self {
        case .manifestNotJSONObject: return "the manifest is not a JSON object"
        case .manifestMissingVersion: return "the manifest has no positive integer `version`"
        case .manifestMissingCommit: return "the manifest has no 40-hex lowercase `commit`"
        case .badPublicKey(let why): return "the public key is not a P-256 PEM key: \(why)"
        case .badPrivateKey(let why): return "the dev key is not a P-256 PEM private key: \(why)"
        }
    }
}

/// Just enough of the manifest to tell the signer what they are signing.
/// The full shape is checked by packages/renderer's parseManifest; this tool
/// signs the bytes it is given.
public struct ManifestSummary: Equatable {
    public let version: Int
    public let commit: String

    public init(manifestBytes: Data) throws {
        guard
            let obj = try? JSONSerialization.jsonObject(with: manifestBytes),
            let dict = obj as? [String: Any]
        else { throw RendererSignError.manifestNotJSONObject }

        // JSONSerialization hands back NSNumber; refuse booleans and
        // fractions so `true` or `1.5` never reads as a version.
        guard
            let num = dict["version"] as? NSNumber,
            CFGetTypeID(num) != CFBooleanGetTypeID(),
            num.doubleValue == Double(num.intValue),
            num.intValue > 0
        else { throw RendererSignError.manifestMissingVersion }

        guard
            let commit = dict["commit"] as? String,
            commit.count == 40,
            commit.allSatisfy({ "0123456789abcdef".contains($0) })
        else { throw RendererSignError.manifestMissingCommit }

        self.version = num.intValue
        self.commit = commit
    }

    /// The Touch ID prompt's reason. macOS shows it as
    /// "<process> is trying to <reason>." — so it starts with a verb.
    public var touchIDReason: String {
        "sign SecureTest renderer \(version) @ \(commit.prefix(10))"
    }
}

public func sha256Hex(_ data: Data) -> String {
    SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
}

public func publicKey(fromPEM pem: String) throws -> P256.Signing.PublicKey {
    do {
        return try P256.Signing.PublicKey(pemRepresentation: pem)
    } catch {
        throw RendererSignError.badPublicKey("\(error)")
    }
}

public func devPrivateKey(fromPEM pem: String) throws -> P256.Signing.PrivateKey {
    do {
        return try P256.Signing.PrivateKey(pemRepresentation: pem)
    } catch {
        throw RendererSignError.badPrivateKey("\(error)")
    }
}

/// Signs with a software key (the DEV key path and the tests). CryptoKit
/// hashes the bytes with SHA-256 before signing.
public func signWithSoftwareKey(manifestBytes: Data, privateKey: P256.Signing.PrivateKey) throws -> Data {
    try privateKey.signature(for: manifestBytes).derRepresentation
}

/// True when the DER signature verifies over the manifest bytes under the
/// key. A malformed signature is `false`, not an error — to a caller, an
/// unreadable signature and a wrong one mean the same thing: do not use it.
public func verifyManifestSignature(manifestBytes: Data, derSignature: Data, publicKey: P256.Signing.PublicKey) -> Bool {
    guard let sig = try? P256.Signing.ECDSASignature(derRepresentation: derSignature) else {
        return false
    }
    return publicKey.isValidSignature(sig, for: manifestBytes)
}
