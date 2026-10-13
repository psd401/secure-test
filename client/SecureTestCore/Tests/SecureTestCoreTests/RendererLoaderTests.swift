import CryptoKit
import XCTest
@testable import SecureTestCore

/// Renderer slice 4b: fetch, cache, verify-on-every-use. An in-memory fetcher
/// and a temp cache directory; manifests signed with a key made per test.
final class RendererLoaderTests: XCTestCase {
    // MARK: - Fakes and helpers

    final class FakeFetcher: RendererFetching, @unchecked Sendable {
        private let lock = NSLock()
        private var files: [String: Data]
        private var _fetched: [String] = []
        var failWith: Error?

        init(files: [String: Data] = [:]) { self.files = files }

        var fetched: [String] { lock.withLock { _fetched } }

        func set(_ sha: String, _ name: String, _ data: Data) {
            lock.withLock { files["\(sha)/\(name)"] = data }
        }

        func fetchRendererFile(sha256: String, file: String) async throws -> Data {
            try lock.withLock {
                _fetched.append(file)
                if let failWith { throw failWith }
                guard let data = files["\(sha256)/\(file)"] else {
                    throw RendererFetchError.notFound(file: file)
                }
                return data
            }
        }
    }

    private struct Signed {
        let files: RendererFiles
        let ref: RendererRef
    }

    private let key = P256.Signing.PrivateKey()
    private var pem: String { key.publicKey.pemRepresentation }
    private let now = ISO8601DateFormatter().date(from: "2026-11-01T00:00:00Z")!
    private var cacheDir: URL!

    override func setUpWithError() throws {
        cacheDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("renderer-cache-\(UUID().uuidString)", isDirectory: true)
            .appendingPathComponent("renderers", isDirectory: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: cacheDir.deletingLastPathComponent())
    }

    private var cache: RendererCache { RendererCache(baseURL: cacheDir) }

    private func hex(_ d: Data) -> String { SHA256.hash(data: d).map { String(format: "%02x", $0) }.joined() }

    private func make(
        script: String = "window.render = function () { return 1; };",
        styles: String = "body { margin: 0; }",
        version: Int = 1_760_000_000,
        requires: [String] = ["home", "response", "submit"],
        notAfter: String = "2026-12-12T17:00:00.000Z",
        refVersion: Int? = nil,
        signWith signer: P256.Signing.PrivateKey? = nil
    ) -> Signed {
        let js = Data(script.utf8), css = Data(styles.utf8)
        let files = #"{"renderer.css":{"bytes":\#(css.count),"sha256":"\#(hex(css))"},"#
            + #""renderer.js":{"bytes":\#(js.count),"sha256":"\#(hex(js))"}}"#
        let req = "[" + requires.map { "\"\($0)\"" }.joined(separator: ",") + "]"
        let manifest = Data(("{" + #""commit":"0123456789abcdef0123456789abcdef01234567","#
            + #""files":\#(files),"format":1,"issued_at":"2026-10-13T17:00:00.000Z","#
            + #""not_after":"\#(notAfter)","requires":\#(req),"version":\#(version)}"#).utf8)
        let sig = try! (signer ?? key).signature(for: manifest).derRepresentation
        return Signed(
            files: RendererFiles(manifest: manifest, signature: sig, script: js, styles: css),
            ref: RendererRef(version: refVersion ?? version, sha256: hex(manifest)))
    }

    private func serving(_ s: Signed) -> FakeFetcher {
        let f = FakeFetcher()
        for name in RendererFileName.all { f.set(s.ref.sha256, name, s.files.bytes(for: name)) }
        return f
    }

    private func load(
        _ s: Signed, _ f: FakeFetcher, supported: Set<String> = RendererCapabilities.supported
    ) async -> Result<LoadedRenderer, RendererLoadFailure> {
        await RendererLoader.load(
            ref: s.ref, fetcher: f, cache: cache, publicKeysPEM: [pem],
            minimumVersion: 0, supported: supported, now: now)
    }

    private func failure(_ r: Result<LoadedRenderer, RendererLoadFailure>) -> RendererLoadFailure? {
        if case .failure(let e) = r { return e }
        return nil
    }

    private func entry(_ s: Signed) -> URL { cacheDir.appendingPathComponent(s.ref.sha256) }

    private func overwrite(_ s: Signed, _ name: String, _ data: Data) throws {
        try data.write(to: entry(s).appendingPathComponent(name))
    }

    // MARK: - Fresh fetch and cache hit

    func testFreshFetchVerifiesAndWritesTheCache() async throws {
        let s = make()
        let f = serving(s)
        let loaded = try await load(s, f).get()
        XCTAssertFalse(loaded.fromCache)
        XCTAssertEqual(loaded.script, "window.render = function () { return 1; };")
        XCTAssertEqual(loaded.styles, "body { margin: 0; }")
        XCTAssertEqual(loaded.ref, s.ref)
        XCTAssertEqual(f.fetched, RendererFileName.all, "manifest, then sig, then the code")
        XCTAssertEqual(cache.read(s.ref.sha256), s.files)
    }

    func testSecondLoadComesFromTheCacheWithZeroFetches() async throws {
        let s = make()
        _ = try await load(s, serving(s)).get()
        let offline = FakeFetcher()
        offline.failWith = URLError(.notConnectedToInternet)
        let loaded = try await load(s, offline).get()
        XCTAssertTrue(loaded.fromCache)
        XCTAssertEqual(offline.fetched, [])
    }

    // MARK: - A tampered cache costs a download, never a changed page

    func testTamperedCachedScriptIsRemovedAndRefetched() async throws {
        let s = make()
        _ = try await load(s, serving(s)).get()
        try overwrite(s, RendererFileName.script, Data("evil();".utf8))
        let f = serving(s)
        let loaded = try await load(s, f).get()
        XCTAssertFalse(loaded.fromCache)
        XCTAssertEqual(loaded.script, "window.render = function () { return 1; };")
        XCTAssertEqual(f.fetched, RendererFileName.all)
        XCTAssertEqual(cache.read(s.ref.sha256), s.files, "the cache holds the good copy again")
    }

    func testTamperedCachedManifestIsRemovedAndRefetched() async throws {
        let s = make()
        _ = try await load(s, serving(s)).get()
        // A different, validly signed manifest swapped in — the hash catches it.
        let other = make(script: "other();")
        try overwrite(s, RendererFileName.manifest, other.files.manifest)
        let f = serving(s)
        let loaded = try await load(s, f).get()
        XCTAssertFalse(loaded.fromCache)
        XCTAssertEqual(f.fetched.count, 4)
    }

    func testTamperedCachedSignatureIsRemovedAndRefetched() async throws {
        let s = make()
        _ = try await load(s, serving(s)).get()
        let forged = try P256.Signing.PrivateKey().signature(for: s.files.manifest).derRepresentation
        try overwrite(s, RendererFileName.signature, forged)
        let f = serving(s)
        let loaded = try await load(s, f).get()
        XCTAssertFalse(loaded.fromCache)
        XCTAssertEqual(f.fetched.count, 4)
    }

    func testAMissingCachedFileFallsThroughToAFetch() async throws {
        let s = make()
        _ = try await load(s, serving(s)).get()
        try FileManager.default.removeItem(at: entry(s).appendingPathComponent(RendererFileName.styles))
        XCTAssertNil(cache.read(s.ref.sha256))
        let loaded = try await load(s, serving(s)).get()
        XCTAssertFalse(loaded.fromCache)
    }

    func testASymlinkPlantedInTheCacheIsNotFollowed() async throws {
        let s = make()
        _ = try await load(s, serving(s)).get()
        let outside = cacheDir.deletingLastPathComponent().appendingPathComponent("planted.js")
        try Data(s.files.script).write(to: outside)
        let link = entry(s).appendingPathComponent(RendererFileName.script)
        try FileManager.default.removeItem(at: link)
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: outside)
        XCTAssertNil(cache.read(s.ref.sha256), "a symlink reads as absent")
        _ = try await load(s, serving(s)).get()
        let type = try FileManager.default.attributesOfItem(atPath: link.path)[.type] as? FileAttributeType
        XCTAssertEqual(type, .typeRegular, "the rewrite replaced the link, not its target")
    }

    // MARK: - Fresh-fetch failures

    func testManifestHashMismatchIsIntegrityWithoutFetchingTheRest() async throws {
        let s = make()
        let f = serving(s)
        f.set(s.ref.sha256, RendererFileName.manifest, make(script: "x();").files.manifest)
        guard case .integrity = failure(await load(s, f)) else { return XCTFail("want integrity") }
        XCTAssertEqual(f.fetched, [RendererFileName.manifest])
        XCTAssertNil(cache.read(s.ref.sha256))
    }

    /// Chosen: integrity. The manifest hash already equals the ref, so the
    /// bytes are exactly what was signed — the bundle named the version
    /// wrongly. Not a verifier refusal (nothing about the signature or policy
    /// failed) and not worth a refetch (the same hash gives the same bytes).
    func testVersionMismatchWithTheBundleIsIntegrityAndNotRefetchedFromCache() async throws {
        let s = make(version: 7, refVersion: 8)
        let f = serving(s)
        guard case .integrity(let why) = failure(await load(s, f)) else { return XCTFail("want integrity") }
        XCTAssertTrue(why.contains("version 8"))
        XCTAssertNil(cache.read(s.ref.sha256), "nothing cached on a failed fresh load")

        // Even if such an entry sat in the cache, it is not refetched in a loop.
        try cache.write(s.ref.sha256, files: s.files)
        let again = serving(s)
        guard case .integrity = failure(await load(s, again)) else { return XCTFail("want integrity") }
        XCTAssertEqual(again.fetched, [])
    }

    func testNotFoundIsUnavailable() async throws {
        let s = make()
        let f = FakeFetcher()
        let result = failure(await load(s, f))
        guard case .unavailable(let why) = result else { return XCTFail("want unavailable") }
        XCTAssertTrue(why.contains("manifest.json"))
        XCTAssertEqual(result?.studentShouldUpdate, false)
    }

    func testANetworkErrorMidwayIsUnavailableAndCachesNothing() async throws {
        let s = make()
        let partial = FakeFetcher()
        partial.set(s.ref.sha256, RendererFileName.manifest, s.files.manifest)
        partial.set(s.ref.sha256, RendererFileName.signature, s.files.signature)
        partial.set(s.ref.sha256, RendererFileName.script, s.files.script)
        guard case .unavailable = failure(await load(s, partial)) else { return XCTFail("want unavailable") }
        XCTAssertNil(cache.read(s.ref.sha256))
    }

    func testABadSignatureOnAFreshFetchIsRefusedBeforeTheCodeIsFetched() async throws {
        let s = make(signWith: P256.Signing.PrivateKey())
        let f = serving(s)
        let got = failure(await load(s, f))
        XCTAssertEqual(got, .refused(.badSignature))
        XCTAssertEqual(f.fetched, [RendererFileName.manifest, RendererFileName.signature])
    }

    func testAScriptThatDoesNotMatchTheManifestIsIntegrity() async throws {
        let s = make()
        let f = serving(s)
        f.set(s.ref.sha256, RendererFileName.script, Data("evil();".utf8))
        guard case .integrity = failure(await load(s, f)) else { return XCTFail("want integrity") }
        XCTAssertNil(cache.read(s.ref.sha256))
    }

    func testClosingTagInTheScriptIsIntegrity() async throws {
        let s = make(script: "var s = '</script>';")
        guard case .integrity(let why) = failure(await load(s, serving(s))) else {
            return XCTFail("want integrity")
        }
        XCTAssertTrue(why.contains("</"))
        XCTAssertNil(cache.read(s.ref.sha256))
    }

    func testNonUTF8ScriptIsIntegrity() async throws {
        // Build a manifest over bytes that are not UTF-8.
        let bad = Data([0xFF, 0xFE, 0x00])
        let base = make()
        let css = base.files.styles
        let files = #"{"renderer.css":{"bytes":\#(css.count),"sha256":"\#(hex(css))"},"#
            + #""renderer.js":{"bytes":\#(bad.count),"sha256":"\#(hex(bad))"}}"#
        let manifest = Data(("{" + #""commit":"0123456789abcdef0123456789abcdef01234567","#
            + #""files":\#(files),"format":1,"issued_at":"2026-10-13T17:00:00.000Z","#
            + #""not_after":"2026-12-12T17:00:00.000Z","requires":[],"version":1}"#).utf8)
        let s = Signed(
            files: RendererFiles(
                manifest: manifest, signature: try key.signature(for: manifest).derRepresentation,
                script: bad, styles: css),
            ref: RendererRef(version: 1, sha256: hex(manifest)))
        guard case .integrity = failure(await load(s, serving(s))) else { return XCTFail("want integrity") }
    }

    // MARK: - Policy refusals: returned directly, no refetch loop

    func testExpiredIsRefusedAndACachedCopyIsNotRefetched() async throws {
        let s = make(notAfter: "2026-10-20T00:00:00.000Z")
        let got = failure(await load(s, serving(s)))
        XCTAssertEqual(got, .refused(.expired))
        XCTAssertNil(cache.read(s.ref.sha256))

        try cache.write(s.ref.sha256, files: s.files)
        let f = serving(s)
        let got2 = failure(await load(s, f))
        XCTAssertEqual(got2, .refused(.expired))
        XCTAssertEqual(f.fetched, [], "a fresh copy would be refused the same way")
    }

    func testMissingCapabilityIsRefusedAndTellsTheStudentToUpdate() async throws {
        let s = make(requires: ["home", "teleport"])
        let f = serving(s)
        let result = failure(await load(s, f))
        XCTAssertEqual(result, .refused(.missingCapabilities(["teleport"])))
        XCTAssertEqual(result?.studentShouldUpdate, true)
        XCTAssertEqual(f.fetched, [RendererFileName.manifest, RendererFileName.signature])

        try cache.write(s.ref.sha256, files: s.files)
        let again = serving(s)
        let got = failure(await load(s, again))
        XCTAssertEqual(got, .refused(.missingCapabilities(["teleport"])))
        XCTAssertEqual(again.fetched, [])
    }

    func testBelowMinimumVersionIsRefused() async throws {
        let s = make(version: 5)
        let result = await RendererLoader.load(
            ref: s.ref, fetcher: serving(s), cache: cache, publicKeysPEM: [pem],
            minimumVersion: 6, now: now)
        XCTAssertEqual(failure(result), .refused(.belowMinimumVersion(have: 5, need: 6)))
        XCTAssertEqual(failure(result)?.studentShouldUpdate, false)
    }

    // MARK: - Eviction

    func testEvictionKeepsKeepingAndRecentEntriesAndRemovesStaleAndJunk() async throws {
        let old = make(script: "old();"), recent = make(script: "recent();"), kept = make(script: "kept();")
        let day: TimeInterval = 24 * 60 * 60
        try cache.write(old.ref.sha256, files: old.files, now: now.addingTimeInterval(-40 * day))
        try cache.write(recent.ref.sha256, files: recent.files, now: now.addingTimeInterval(-2 * day))
        try cache.write(kept.ref.sha256, files: kept.files, now: now.addingTimeInterval(-90 * day))
        try Data("junk".utf8).write(to: cacheDir.appendingPathComponent("not-a-hash"))

        let removed = cache.evict(keeping: [kept.ref.sha256], now: now)
        XCTAssertEqual(removed, 2)
        XCTAssertNil(cache.read(old.ref.sha256))
        XCTAssertNotNil(cache.read(recent.ref.sha256))
        XCTAssertNotNil(cache.read(kept.ref.sha256))
        XCTAssertFalse(FileManager.default.fileExists(atPath: cacheDir.appendingPathComponent("not-a-hash").path))
    }

    func testACacheHitCountsAsUse() async throws {
        let s = make()
        let day: TimeInterval = 24 * 60 * 60
        try cache.write(s.ref.sha256, files: s.files, now: now.addingTimeInterval(-40 * day))
        _ = try await load(s, FakeFetcher()).get() // hit at `now`
        XCTAssertEqual(cache.evict(now: now), 0)
        XCTAssertNotNil(cache.read(s.ref.sha256))
    }

    // MARK: - Permissions

    func testCacheDirectoriesAre0700AndFiles0600() async throws {
        let s = make()
        _ = try await load(s, serving(s)).get()
        func mode(_ url: URL) throws -> Int {
            (try FileManager.default.attributesOfItem(atPath: url.path)[.posixPermissions] as! NSNumber).intValue
        }
        XCTAssertEqual(try mode(cacheDir), 0o700)
        XCTAssertEqual(try mode(entry(s)), 0o700)
        for name in RendererFileName.all {
            XCTAssertEqual(try mode(entry(s).appendingPathComponent(name)), 0o600, name)
        }
        let leftovers = try FileManager.default.contentsOfDirectory(atPath: entry(s).path)
        XCTAssertEqual(Set(leftovers), Set(RendererFileName.all), "no temp files left behind")
    }

    func testABadHashIsNeverAPathComponent() {
        XCTAssertNil(cache.read("../../etc"))
        XCTAssertThrowsError(try cache.write("../x", files: make().files))
    }

    // MARK: - APIClient conformance

    func testAPIClientFetchesByHashWithTheBearerTokenAndMaps404() async throws {
        let sha = String(repeating: "a", count: 64)
        let transport = RecordingTransport(replies: [
            .init(status: 200, body: "{\"x\":1}"),
            .init(status: 404, body: #"{"ok":false,"error":"not_found"}"#),
        ])
        let client = APIClient(
            baseURL: URL(string: "https://design.example")!, transport: transport,
            tokens: InMemoryTokenStore(token: "tok-1"), clientVersion: "2.0.0")
        let data = try await client.fetchRendererFile(sha256: sha, file: "manifest.json")
        XCTAssertEqual(data, Data("{\"x\":1}".utf8))
        XCTAssertEqual(transport.sent[0].url?.path, "/api/renderer/\(sha)/manifest.json")
        XCTAssertEqual(transport.sent[0].httpMethod, "GET")
        XCTAssertEqual(transport.sent[0].value(forHTTPHeaderField: "Authorization"), "Bearer tok-1")
        XCTAssertEqual(transport.sent[0].value(forHTTPHeaderField: APIClient.versionHeader), "2.0.0")

        do {
            _ = try await client.fetchRendererFile(sha256: sha, file: "renderer.js")
            XCTFail("want notFound")
        } catch let error as RendererFetchError {
            XCTAssertEqual(error, .notFound(file: "renderer.js"))
        }

        do {
            _ = try await client.fetchRendererFile(sha256: "../x", file: "renderer.js")
            XCTFail("want badRequest")
        } catch let error as RendererFetchError {
            XCTAssertEqual(error, .badRequest)
        }
        XCTAssertEqual(transport.sent.count, 2, "a bad hash never reaches the network")
    }

    // MARK: - DeliveryBundle.renderer

    private let minimalBundle = #"{"test_id":"t","title":"T","items":[]"#

    func testBundleDecodesWithoutRenderer() throws {
        let b = try DeliveryBundle.decode(from: Data((minimalBundle + "}").utf8))
        XCTAssertNil(b.renderer)
    }

    func testBundleDecodesARenderer() throws {
        let sha = String(repeating: "0f", count: 32)
        let b = try DeliveryBundle.decode(from: Data(
            (minimalBundle + #","renderer":{"version":3,"sha256":"\#(sha)"}}"#).utf8))
        XCTAssertEqual(b.renderer, RendererRef(version: 3, sha256: sha))
    }

    func testBundleRefusesAMalformedRenderer() {
        let sha = String(repeating: "0f", count: 32)
        let bad = [
            "null",
            #"{"version":0,"sha256":"\#(sha)"}"#,
            #"{"version":-1,"sha256":"\#(sha)"}"#,
            #"{"version":1.5,"sha256":"\#(sha)"}"#,
            #"{"version":"1","sha256":"\#(sha)"}"#,
            #"{"version":1,"sha256":"\#(sha.uppercased())"}"#,
            #"{"version":1,"sha256":"abc"}"#,
            #"{"version":1}"#,
            #"{"version":1,"sha256":"\#(sha)","extra":true}"#,
        ]
        for value in bad {
            XCTAssertThrowsError(
                try DeliveryBundle.decode(from: Data((minimalBundle + #","renderer":\#(value)}"#).utf8)),
                value)
        }
    }
}
