import CryptoKit
import XCTest
@testable import SecureTestCore

/// Renderer slice 4a: the shell's manifest verifier against the TypeScript
/// reference (packages/renderer src/manifest.ts, src/verify.ts,
/// src/requires.ts) and its committed cross-language fixture.
final class RendererVerifierTests: XCTestCase {
    // MARK: - Helpers

    private static let repoRoot = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent() // SecureTestCoreTests
        .deletingLastPathComponent() // Tests
        .deletingLastPathComponent() // SecureTestCore
        .deletingLastPathComponent() // client
        .deletingLastPathComponent() // repo root

    private func repoFile(_ path: String) throws -> Data {
        try Data(contentsOf: Self.repoRoot.appendingPathComponent(path))
    }

    private func repoText(_ path: String) throws -> String {
        String(decoding: try repoFile(path), as: UTF8.self)
    }

    private func millis(_ iso: String) -> Date {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f.date(from: iso)!
    }

    private func at(ms: Int64) -> Date { Date(timeIntervalSince1970: Double(ms) / 1000) }

    private let issued = "2026-10-13T17:00:00.000Z"
    private let notAfter = "2026-12-12T17:00:00.000Z"
    private let js = Data("console.log('hi');".utf8)

    /// Canonical JSON in the TS build's byte form (sorted keys, no spaces).
    private func manifestJSON(
        commit: String = "0123456789abcdef0123456789abcdef01234567",
        format: String = "1",
        issuedAt: String? = nil,
        notAfter: String? = nil,
        requires: [String] = ["home", "response", "submit"],
        version: String = "1760000000",
        filesJSON: String? = nil,
        extraTopLevel: String = ""
    ) -> Data {
        let sha = SHA256.hash(data: js).map { String(format: "%02x", $0) }.joined()
        let files = filesJSON ?? #"{"renderer.js":{"bytes":\#(js.count),"sha256":"\#(sha)"}}"#
        let req = "[" + requires.map { "\"\($0)\"" }.joined(separator: ",") + "]"
        return Data(("{" + #""commit":"\#(commit)","files":\#(files),"format":\#(format),"#
            + #""issued_at":"\#(issuedAt ?? issued)","not_after":"\#(notAfter ?? self.notAfter)","#
            + #""requires":\#(req),"version":\#(version)\#(extraTopLevel)}"#).utf8)
    }

    private struct Signer {
        let key = P256.Signing.PrivateKey()
        var pem: String { key.publicKey.pemRepresentation }
        func sign(_ bytes: Data) -> Data { try! key.signature(for: bytes).derRepresentation }
    }

    private func verify(
        _ bytes: Data,
        signer: Signer,
        now: Date? = nil,
        minimumVersion: Int = 0,
        supported: Set<String> = RendererCapabilities.supported
    ) -> Result<RendererManifest, RendererRefusal> {
        RendererVerifier.verify(
            manifestBytes: bytes, signature: signer.sign(bytes), publicKeysPEM: [signer.pem],
            now: now ?? millis("2026-11-01T00:00:00.000Z"),
            minimumVersion: minimumVersion, supported: supported)
    }

    private func refusal(_ r: Result<RendererManifest, RendererRefusal>) -> RendererRefusal? {
        if case .failure(let e) = r { return e }
        return nil
    }

    private func isMalformed(_ r: Result<RendererManifest, RendererRefusal>, file: StaticString = #filePath, line: UInt = #line) {
        guard case .malformedManifest = refusal(r) else {
            return XCTFail("expected malformedManifest, got \(r)", file: file, line: line)
        }
    }

    // MARK: - Cross-language fixture (signed by tools/renderer-sign)

    private func fixture() throws -> (bytes: Data, sig: Data, pem: String) {
        let dir = "packages/renderer/test/fixtures/cross-language/"
        return (try repoFile(dir + "manifest.json"), try repoFile(dir + "manifest.sig"),
                try repoText(dir + "public.pem"))
    }

    func testCrossLanguageFixtureVerifies() throws {
        let f = try fixture()
        let result = RendererVerifier.verify(
            manifestBytes: f.bytes, signature: f.sig, publicKeysPEM: [f.pem],
            now: millis("2026-11-01T00:00:00.000Z"), minimumVersion: 0,
            supported: RendererCapabilities.supported)
        let m = try result.get()
        XCTAssertEqual(m.version, 1_760_000_000)
        XCTAssertEqual(m.commit, "0123456789abcdef0123456789abcdef01234567")
        XCTAssertEqual(m.requires, ["home", "response", "submit"])
        XCTAssertEqual(m.files.keys.sorted(), ["renderer.css", "renderer.js"])
        XCTAssertEqual(m.files["renderer.js"]?.bytes, 26)
        XCTAssertEqual(m.issuedAt, "2026-10-13T17:00:00.000Z")
    }

    func testTamperedFixtureByteIsBadSignature() throws {
        let f = try fixture()
        var bytes = f.bytes
        // Bump one digit of the version: still a valid manifest, not signed.
        let i = bytes.lastIndex(of: UInt8(ascii: "0"))!
        bytes[i] = UInt8(ascii: "1")
        let result = RendererVerifier.verify(
            manifestBytes: bytes, signature: f.sig, publicKeysPEM: [f.pem],
            now: millis("2026-11-01T00:00:00.000Z"), minimumVersion: 0,
            supported: RendererCapabilities.supported)
        XCTAssertEqual(refusal(result), .badSignature)
    }

    func testFixtureUnderWrongKeyIsBadSignature() throws {
        let f = try fixture()
        let result = RendererVerifier.verify(
            manifestBytes: f.bytes, signature: f.sig, publicKeysPEM: [Signer().pem],
            now: millis("2026-11-01T00:00:00.000Z"), minimumVersion: 0,
            supported: RendererCapabilities.supported)
        XCTAssertEqual(refusal(result), .badSignature)
    }

    func testMalformedSignatureIsBadSignature() throws {
        let f = try fixture()
        let result = RendererVerifier.verify(
            manifestBytes: f.bytes, signature: Data([0x30, 0x02, 0x01]), publicKeysPEM: [f.pem],
            now: millis("2026-11-01T00:00:00.000Z"), minimumVersion: 0,
            supported: RendererCapabilities.supported)
        XCTAssertEqual(refusal(result), .badSignature)
    }

    // MARK: - Keys

    func testAnyOfSeveralKeysVerifies() throws {
        let signer = Signer()
        let bytes = manifestJSON()
        let result = RendererVerifier.verify(
            manifestBytes: bytes, signature: signer.sign(bytes),
            publicKeysPEM: [Signer().pem, signer.pem, Signer().pem],
            now: millis("2026-11-01T00:00:00.000Z"), minimumVersion: 0,
            supported: RendererCapabilities.supported)
        XCTAssertNoThrow(try result.get())
    }

    func testP384KeyIsBadKeyConfiguration() {
        let signer = Signer()
        let bytes = manifestJSON()
        let p384 = P384.Signing.PrivateKey().publicKey.pemRepresentation
        let result = RendererVerifier.verify(
            manifestBytes: bytes, signature: signer.sign(bytes), publicKeysPEM: [signer.pem, p384],
            now: millis("2026-11-01T00:00:00.000Z"), minimumVersion: 0,
            supported: RendererCapabilities.supported)
        guard case .badKeyConfiguration = refusal(result) else { return XCTFail("\(result)") }
    }

    func testGarbageAndEmptyKeyListsAreBadKeyConfiguration() {
        let signer = Signer()
        let bytes = manifestJSON()
        for keys in [["not a key"], [], [signer.key.pemRepresentation]] {
            let result = RendererVerifier.verify(
                manifestBytes: bytes, signature: signer.sign(bytes), publicKeysPEM: keys,
                now: millis("2026-11-01T00:00:00.000Z"), minimumVersion: 0,
                supported: RendererCapabilities.supported)
            guard case .badKeyConfiguration = refusal(result) else { return XCTFail("\(keys.count) keys: \(result)") }
            XCTAssertFalse(refusal(result)!.logLine.contains("PRIVATE"))
        }
    }

    func testCompiledInKeysParse() {
        XCTAssertNotNil(try? P256.Signing.PublicKey(pemRepresentation: RendererKeys.working))
        XCTAssertNotNil(try? P256.Signing.PublicKey(pemRepresentation: RendererKeys.backup))
        XCTAssertNotNil(try? P256.Signing.PublicKey(pemRepresentation: RendererKeys.dev))
        XCTAssertEqual(RendererKeys.releaseKeys, [RendererKeys.working, RendererKeys.backup])
        XCTAssertFalse(RendererKeys.releaseKeys.contains(RendererKeys.devKey))
    }

    // MARK: - Malformed manifests (signed, so the shape check is reached)

    func testMalformedManifests() {
        let signer = Signer()
        isMalformed(verify(Data("{not json".utf8), signer: signer))
        isMalformed(verify(Data("[]".utf8), signer: signer))
        isMalformed(verify(manifestJSON(extraTopLevel: #","extra":1"#), signer: signer))
        isMalformed(verify(Data(#"{"format":1}"#.utf8), signer: signer))
        isMalformed(verify(manifestJSON(commit: "0123456789ABCDEF0123456789abcdef01234567"), signer: signer))
        isMalformed(verify(manifestJSON(commit: "abc"), signer: signer))
        isMalformed(verify(manifestJSON(format: "2"), signer: signer))
        isMalformed(verify(manifestJSON(format: "true"), signer: signer))
        isMalformed(verify(manifestJSON(version: "0"), signer: signer))
        isMalformed(verify(manifestJSON(version: "\"1\""), signer: signer))
        isMalformed(verify(manifestJSON(filesJSON: "{}"), signer: signer))
        isMalformed(verify(manifestJSON(filesJSON: #"{"../x":{"bytes":1,"sha256":"\#(String(repeating: "a", count: 64))"}}"#), signer: signer))
        isMalformed(verify(manifestJSON(filesJSON: #"{"Renderer.js":{"bytes":1,"sha256":"\#(String(repeating: "a", count: 64))"}}"#), signer: signer))
        isMalformed(verify(manifestJSON(filesJSON: #"{"a..js":{"bytes":1,"sha256":"\#(String(repeating: "a", count: 64))"}}"#), signer: signer))
        isMalformed(verify(manifestJSON(filesJSON: #"{"r.js":{"bytes":-1,"sha256":"\#(String(repeating: "a", count: 64))"}}"#), signer: signer))
        isMalformed(verify(manifestJSON(filesJSON: #"{"r.js":{"bytes":1,"sha256":"ABC"}}"#), signer: signer))
        isMalformed(verify(manifestJSON(filesJSON: #"{"r.js":{"bytes":1,"sha256":"\#(String(repeating: "a", count: 64))","x":1}}"#), signer: signer))
        isMalformed(verify(manifestJSON(filesJSON: #"{"r.js":{"bytes":1}}"#), signer: signer))
    }

    func testTimestampShapes() {
        let signer = Signer()
        for bad in ["2026-10-13T17:00:00Z", "2026-10-13T17:00:00.000+00:00", "2026-10-13 17:00:00.000Z",
                    "2026-02-30T17:00:00.000Z", "2026-10-13T24:00:00.000Z", "2026-10-13T17:00:00.0000Z"] {
            isMalformed(verify(manifestJSON(issuedAt: bad), signer: signer))
        }
        // not_after must come after issued_at.
        isMalformed(verify(manifestJSON(notAfter: issued), signer: signer))
    }

    // MARK: - Version, window, capabilities

    func testBelowMinimumVersion() {
        let signer = Signer()
        XCTAssertEqual(refusal(verify(manifestJSON(), signer: signer, minimumVersion: 1_760_000_001)),
                       .belowMinimumVersion(have: 1_760_000_000, need: 1_760_000_001))
        XCTAssertNoThrow(try verify(manifestJSON(), signer: signer, minimumVersion: 1_760_000_000).get())
    }

    func testValidityWindowEdgesAreInclusive() {
        let signer = Signer()
        let bytes = manifestJSON()
        let start = Int64(millis(issued).timeIntervalSince1970 * 1000)
        let end = Int64(millis(notAfter).timeIntervalSince1970 * 1000)
        XCTAssertEqual(refusal(verify(bytes, signer: signer, now: at(ms: start - 1))), .notYetValid)
        XCTAssertNoThrow(try verify(bytes, signer: signer, now: at(ms: start)).get())
        XCTAssertNoThrow(try verify(bytes, signer: signer, now: at(ms: end)).get())
        XCTAssertEqual(refusal(verify(bytes, signer: signer, now: at(ms: end + 1))), .expired)
    }

    func testMissingCapabilitiesListsTheTerms() {
        let signer = Signer()
        let bytes = manifestJSON(requires: ["home", "response", "response.generic", "submit", "zz.future", "zz.later"])
        let r = refusal(verify(bytes, signer: signer))
        XCTAssertEqual(r, .missingCapabilities(["zz.future", "zz.later"]))
        XCTAssertTrue(r!.isUpdateNeeded)
        XCTAssertTrue(r!.logLine.contains("zz.future"))
    }

    func testOnlyMissingCapabilitiesNeedsAnUpdate() {
        let others: [RendererRefusal] = [.badSignature, .malformedManifest("x"),
                                         .belowMinimumVersion(have: 1, need: 2), .notYetValid,
                                         .expired, .badKeyConfiguration("x")]
        for r in others { XCTAssertFalse(r.isUpdateNeeded, "\(r)") }
    }

    func testOrderSignatureBeforeShape() {
        // Unsigned garbage is a signature failure, not a malformed manifest.
        let signer = Signer()
        let result = RendererVerifier.verify(
            manifestBytes: Data("{".utf8), signature: signer.sign(Data("other".utf8)),
            publicKeysPEM: [signer.pem], now: Date(), minimumVersion: 0, supported: [])
        XCTAssertEqual(refusal(result), .badSignature)
    }

    // MARK: - Files

    func testVerifyFile() throws {
        let m = try verify(manifestJSON(), signer: Signer()).get()
        XCTAssertTrue(RendererVerifier.verifyFile(name: "renderer.js", bytes: js, manifest: m))
        var wrongHash = js
        wrongHash[0] ^= 0x01
        XCTAssertFalse(RendererVerifier.verifyFile(name: "renderer.js", bytes: wrongHash, manifest: m))
        XCTAssertFalse(RendererVerifier.verifyFile(name: "renderer.js", bytes: js + Data([0x20]), manifest: m))
        XCTAssertFalse(RendererVerifier.verifyFile(name: "renderer.css", bytes: js, manifest: m))
    }

    func testVerifyFileAgainstFixtureHashes() throws {
        let f = try fixture()
        let m = try RendererManifest.decode(f.bytes).get()
        // The fixture's renderer.css is 7 bytes; wrong content of the right size fails.
        XCTAssertFalse(RendererVerifier.verifyFile(name: "renderer.css", bytes: Data(repeating: 0x41, count: 7), manifest: m))
    }

    // MARK: - Drift against the TypeScript side

    func testWorkingKeyMatchesRepoPEM() throws {
        XCTAssertEqual(RendererKeys.working, try repoText("packages/renderer/keys/working.pub.pem"))
    }

    func testBackupKeyMatchesRepoPEM() throws {
        XCTAssertEqual(RendererKeys.backup, try repoText("packages/renderer/keys/backup.pub.pem"))
    }

    func testDevKeyMatchesRepoPEM() throws {
        XCTAssertEqual(RendererKeys.dev, try repoText("packages/renderer/dev-keys/dev.pub.pem"))
    }

    func testCapabilitiesMatchRequiresTS() throws {
        let ts = try repoText("packages/renderer/src/requires.ts")
        let start = try XCTUnwrap(ts.range(of: "export const REQUIREMENTS = ["))
        let end = try XCTUnwrap(ts.range(of: "] as const;", range: start.upperBound..<ts.endIndex))
        let body = ts[start.upperBound..<end.lowerBound]
        let terms = body.split(separator: "\n")
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { $0.hasPrefix("\"") }
            .map { String($0.dropFirst().prefix { $0 != "\"" }) }
        XCTAssertEqual(terms.count, 10, "parsed \(terms)")
        // Slice 4d: the shell answers for the full vocabulary.
        XCTAssertEqual(RendererCapabilities.supported, Set(terms))
    }

    /// D-13: the first production-signed renderer (2026-10-13, commit
    /// 0098a60). Changing it is a deliberate release decision.
    func testPolicyMinimumVersionIsTheFirstProductionRenderer() {
        XCTAssertEqual(RendererPolicy.minimumVersion, 1_791_926_804)
    }
}
