import CryptoKit
import Foundation

// Server-delivered renderer slice 4a (docs/server-delivered-renderer-design.md
// D-2, 2.a, D-4, D-13): may this shell run the renderer the server named?
// Pure — no file, network or clock access; the caller passes the bytes, the
// trusted keys, the time and the policy. Mirrors packages/renderer
// src/verify.ts (`verifyManifestSignature`, `checkManifestUse`) plus the
// `requires` check the shell makes before `begin()`.
//
// Core stays config-agnostic: which keys count (release keys only, or the
// dev key too in a Debug build) is the app's decision (slice 4c).

/// Why the shell refused a renderer. `logLine` is what the client error log
/// carries — versions and capability names, never key material.
public enum RendererRefusal: Error, Equatable, Sendable, CustomStringConvertible {
    /// No trusted key verifies the signature over the manifest bytes.
    case badSignature
    case malformedManifest(String)
    case belowMinimumVersion(have: Int, need: Int)
    case notYetValid
    case expired
    /// The manifest `requires` terms this shell cannot answer for.
    case missingCapabilities([String])
    /// The compiled-in key list is wrong (empty, unparsable, not P-256). A
    /// shipped app must not crash on it, but it is a build defect, not a
    /// server problem — so it gets its own case.
    case badKeyConfiguration(String)

    public var logLine: String {
        switch self {
        case .badSignature:
            return "renderer refused: signature does not verify under any trusted key"
        case .malformedManifest(let why):
            return "renderer refused: malformed manifest (\(why))"
        case .belowMinimumVersion(let have, let need):
            return "renderer refused: version \(have) is below the minimum \(need)"
        case .notYetValid:
            return "renderer refused: manifest not yet valid (before issued_at)"
        case .expired:
            return "renderer refused: manifest expired (after not_after)"
        case .missingCapabilities(let terms):
            return "renderer refused: shell lacks \(terms.joined(separator: ", "))"
        case .badKeyConfiguration(let why):
            return "renderer refused: bad key configuration (\(why))"
        }
    }

    public var description: String { logLine }

    /// True when only a newer app can run this renderer — the student sees
    /// "update SecureTest" rather than "try again". Every other refusal is a
    /// server- or time-side problem a later attempt may not hit.
    public var isUpdateNeeded: Bool {
        if case .missingCapabilities = self { return true }
        return false
    }
}

public enum RendererVerifier {
    /// Signature, then shape, then minimum version, then the validity window
    /// (both ends inclusive), then `requires` ⊆ `supported` — in that order,
    /// so nothing about an unsigned manifest is read before the signature.
    public static func verify(
        manifestBytes: Data,
        signature: Data,
        publicKeysPEM: [String],
        now: Date,
        minimumVersion: Int,
        supported: Set<String>
    ) -> Result<RendererManifest, RendererRefusal> {
        let keys: [P256.Signing.PublicKey]
        switch parseKeys(publicKeysPEM) {
        case .success(let parsed): keys = parsed
        case .failure(let refusal): return .failure(refusal)
        }

        // A malformed DER signature is the same as a wrong one: do not use it.
        guard
            let sig = try? P256.Signing.ECDSASignature(derRepresentation: signature),
            keys.contains(where: { $0.isValidSignature(sig, for: manifestBytes) })
        else { return .failure(.badSignature) }

        let manifest: RendererManifest
        switch RendererManifest.decode(manifestBytes) {
        case .success(let m): manifest = m
        case .failure(let error): return .failure(.malformedManifest(error.message))
        }

        if manifest.version < minimumVersion {
            return .failure(.belowMinimumVersion(have: manifest.version, need: minimumVersion))
        }

        let nowMs = Int64((now.timeIntervalSince1970 * 1000).rounded())
        if nowMs < manifest.issuedAtMillis { return .failure(.notYetValid) }
        if nowMs > manifest.notAfterMillis { return .failure(.expired) }

        let missing = manifest.requires.filter { !supported.contains($0) }
        if !missing.isEmpty {
            return .failure(.missingCapabilities(Array(Set(missing)).sorted()))
        }
        return .success(manifest)
    }

    /// True when `name` is listed in the (already verified) manifest and the
    /// bytes match its size and SHA-256.
    public static func verifyFile(name: String, bytes: Data, manifest: RendererManifest) -> Bool {
        guard let entry = manifest.files[name], entry.bytes == bytes.count else { return false }
        let hex = SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
        return hex == entry.sha256
    }

    private static func parseKeys(_ pems: [String]) -> Result<[P256.Signing.PublicKey], RendererRefusal> {
        guard !pems.isEmpty else { return .failure(.badKeyConfiguration("no public keys")) }
        var keys: [P256.Signing.PublicKey] = []
        for (index, pem) in pems.enumerated() {
            // CryptoKit refuses a PEM that is not an EC P-256 public key
            // (P-384, RSA, a private key, garbage) — all a build defect.
            guard let key = try? P256.Signing.PublicKey(pemRepresentation: pem) else {
                return .failure(.badKeyConfiguration("key \(index) is not a P-256 PEM public key"))
            }
            keys.append(key)
        }
        return .success(keys)
    }
}
