// Software keys only: the Secure Enclave path needs Touch ID and cannot run
// here. The signature format is the same for both keys (P-256 / SHA-256,
// DER), so these cover everything but where the private key lives.

import CryptoKit
import Foundation
import RendererSignCore
import XCTest

final class RendererSignCoreTests: XCTestCase {
    let commit = "0123456789abcdef0123456789abcdef01234567"

    func manifest(version: Int = 1_760_000_000) -> Data {
        Data(#"{"commit":"\#(commit)","files":{"renderer.js":{"bytes":3,"sha256":"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"}},"format":1,"issued_at":"2026-10-13T17:00:00.000Z","not_after":"2026-12-12T17:00:00.000Z","requires":["home"],"version":\#(version)}"#.utf8)
    }

    func testSignVerifyRoundTrip() throws {
        let key = P256.Signing.PrivateKey()
        let bytes = manifest()
        let sig = try signWithSoftwareKey(manifestBytes: bytes, privateKey: key)
        XCTAssertTrue(verifyManifestSignature(manifestBytes: bytes, derSignature: sig, publicKey: key.publicKey))
    }

    func testTamperedManifestFails() throws {
        let key = P256.Signing.PrivateKey()
        var bytes = manifest()
        let sig = try signWithSoftwareKey(manifestBytes: bytes, privateKey: key)
        bytes[bytes.count - 2] ^= 0x01 // a digit of `version`
        XCTAssertFalse(verifyManifestSignature(manifestBytes: bytes, derSignature: sig, publicKey: key.publicKey))
        // A trailing newline is a different byte string too.
        let withNewline = manifest() + Data("\n".utf8)
        XCTAssertFalse(verifyManifestSignature(manifestBytes: withNewline, derSignature: sig, publicKey: key.publicKey))
    }

    func testWrongKeyFails() throws {
        let bytes = manifest()
        let sig = try signWithSoftwareKey(manifestBytes: bytes, privateKey: P256.Signing.PrivateKey())
        XCTAssertFalse(verifyManifestSignature(manifestBytes: bytes, derSignature: sig, publicKey: P256.Signing.PrivateKey().publicKey))
    }

    func testMalformedSignatureIsFalseNotAnError() throws {
        let key = P256.Signing.PrivateKey()
        let bytes = manifest()
        let sig = try signWithSoftwareKey(manifestBytes: bytes, privateKey: key)
        XCTAssertFalse(verifyManifestSignature(manifestBytes: bytes, derSignature: sig.prefix(sig.count - 4), publicKey: key.publicKey))
        XCTAssertFalse(verifyManifestSignature(manifestBytes: bytes, derSignature: Data(), publicKey: key.publicKey))
        // Raw r||s (64 bytes) is not DER.
        let raw = try P256.Signing.ECDSASignature(derRepresentation: sig).rawRepresentation
        XCTAssertFalse(verifyManifestSignature(manifestBytes: bytes, derSignature: raw, publicKey: key.publicKey))
    }

    func testDERRoundTrip() throws {
        let key = P256.Signing.PrivateKey()
        let sig = try key.signature(for: manifest())
        let der = sig.derRepresentation
        XCTAssertEqual(der.first, 0x30) // ASN.1 SEQUENCE
        let back = try P256.Signing.ECDSASignature(derRepresentation: der)
        XCTAssertEqual(back.rawRepresentation, sig.rawRepresentation)
        XCTAssertEqual(back.derRepresentation, der)
    }

    func testPEMRoundTrip() throws {
        let key = P256.Signing.PrivateKey()
        let dev = try devPrivateKey(fromPEM: key.pemRepresentation)
        XCTAssertEqual(dev.rawRepresentation, key.rawRepresentation)
        let pub = try publicKey(fromPEM: key.publicKey.pemRepresentation)
        XCTAssertEqual(pub.rawRepresentation, key.publicKey.rawRepresentation)
        XCTAssertTrue(key.publicKey.pemRepresentation.hasPrefix("-----BEGIN PUBLIC KEY-----"))
        XCTAssertThrowsError(try publicKey(fromPEM: "not a key"))
        // A P-384 key is not a P-256 key.
        XCTAssertThrowsError(try publicKey(fromPEM: P384.Signing.PrivateKey().publicKey.pemRepresentation))
    }

    func testSummaryAndTouchIDReason() throws {
        let s = try ManifestSummary(manifestBytes: manifest(version: 42))
        XCTAssertEqual(s.version, 42)
        XCTAssertEqual(s.commit, commit)
        XCTAssertEqual(s.touchIDReason, "sign SecureTest renderer 42 @ 0123456789")
    }

    func testSummaryRefusesBadManifests() {
        XCTAssertThrowsError(try ManifestSummary(manifestBytes: Data("[]".utf8)))
        XCTAssertThrowsError(try ManifestSummary(manifestBytes: Data(#"{"version":true,"commit":"\#(commit)"}"#.utf8)))
        XCTAssertThrowsError(try ManifestSummary(manifestBytes: Data(#"{"version":1.5,"commit":"\#(commit)"}"#.utf8)))
        XCTAssertThrowsError(try ManifestSummary(manifestBytes: Data(#"{"version":0,"commit":"\#(commit)"}"#.utf8)))
        XCTAssertThrowsError(try ManifestSummary(manifestBytes: Data(#"{"version":1,"commit":"ABC"}"#.utf8)))
        XCTAssertThrowsError(try ManifestSummary(manifestBytes: Data(#"{"commit":"\#(commit)"}"#.utf8)))
    }

    func testSha256Hex() {
        XCTAssertEqual(sha256Hex(Data("abc".utf8)), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
    }

    /// The committed cross-language fixture (packages/renderer/test/fixtures/
    /// cross-language) — the same files the TypeScript verifier checks.
    func testCrossLanguageFixtureVerifies() throws {
        let dir = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent() // RendererSignCoreTests
            .deletingLastPathComponent() // Tests
            .deletingLastPathComponent() // renderer-sign
            .deletingLastPathComponent() // tools
            .deletingLastPathComponent() // repo root
            .appendingPathComponent("packages/renderer/test/fixtures/cross-language")
        let bytes = try Data(contentsOf: dir.appendingPathComponent("manifest.json"))
        let sig = try Data(contentsOf: dir.appendingPathComponent("manifest.sig"))
        let pem = try String(contentsOf: dir.appendingPathComponent("public.pem"), encoding: .utf8)
        let key = try publicKey(fromPEM: pem)
        XCTAssertTrue(verifyManifestSignature(manifestBytes: bytes, derSignature: sig, publicKey: key))
        var tampered = bytes
        tampered[10] ^= 0x01
        XCTAssertFalse(verifyManifestSignature(manifestBytes: tampered, derSignature: sig, publicKey: key))
    }
}
