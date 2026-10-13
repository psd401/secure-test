import CryptoKit
import Foundation

// Server-delivered renderer slice 4b (docs/server-delivered-renderer-design.md
// D-1, D-2, D-6): turn the bundle's `renderer` ref into script and style text
// the shell may inline — from the cache when every byte there still checks
// out, otherwise freshly fetched. Verify-on-every-use: a cached copy is
// re-hashed and re-verified exactly as a fresh one is. No app wiring here
// (slice 4c decides the keys, the copy and where this runs before begin()).

/// Where the four files come from. `APIClient` conforms; tests use memory.
public protocol RendererFetching: Sendable {
    func fetchRendererFile(sha256: String, file: String) async throws -> Data
}

public enum RendererFetchError: Error, Equatable, CustomStringConvertible {
    /// The route answered 404: no such hash, or no such file under it.
    case notFound(file: String)
    /// The caller asked for a hash or file name the route never serves.
    case badRequest

    public var description: String {
        switch self {
        case .notFound(let file): return "\(file) not found on the server"
        case .badRequest: return "not a renderer hash or file name"
        }
    }
}

public struct LoadedRenderer: Equatable, Sendable {
    public let manifest: RendererManifest
    /// renderer.js as text — verified, UTF-8, free of `</`.
    public let script: String
    /// renderer.css as text — verified, UTF-8.
    public let styles: String
    public let ref: RendererRef
    /// True when the bytes came from the cache (still fully re-verified).
    public let fromCache: Bool
}

public enum RendererLoadFailure: Error, Equatable, Sendable, CustomStringConvertible {
    /// Network, 404 or a server error — the student's "try again".
    case unavailable(String)
    /// The verifier refused the signed manifest.
    case refused(RendererRefusal)
    /// The bytes do not match what the bundle or the manifest names — a hash,
    /// size, version or inlining mismatch on a FRESH fetch.
    case integrity(String)

    public var logLine: String {
        switch self {
        case .unavailable(let why): return "renderer unavailable: \(why)"
        case .refused(let refusal): return refusal.logLine
        case .integrity(let why): return "renderer integrity: \(why)"
        }
    }

    public var description: String { logLine }

    /// True only when a newer app could run this renderer (the "update
    /// SecureTest" copy in 4c); every other failure is "try again".
    public var studentShouldUpdate: Bool {
        if case .refused(let refusal) = self { return refusal.isUpdateNeeded }
        return false
    }
}

public enum RendererLoader {
    public static func load(
        ref: RendererRef,
        fetcher: RendererFetching,
        cache: RendererCache,
        publicKeysPEM: [String],
        minimumVersion: Int = RendererPolicy.minimumVersion,
        supported: Set<String> = RendererCapabilities.supported,
        now: Date = Date(),
        log: @Sendable (String) -> Void = { _ in }
    ) async -> Result<LoadedRenderer, RendererLoadFailure> {
        let check = { (files: RendererFiles, fromCache: Bool) in
            validate(files, ref: ref, publicKeysPEM: publicKeysPEM, now: now,
                     minimumVersion: minimumVersion, supported: supported, fromCache: fromCache)
        }

        // 1. The cache, never trusted.
        if let cached = cache.read(ref.sha256) {
            switch check(cached, true) {
            case .success(let loaded):
                cache.touch(ref.sha256, now: now)
                return .success(loaded)
            case .failure(let error) where !error.refetchCouldHelp:
                // Decided by the signed manifest, whose bytes the bundle's
                // hash pins: a fresh copy would be refused the same way.
                log("renderer cache \(ref.sha256.prefix(12)): \(error.failure.logLine)")
                return .failure(error.failure)
            case .failure(let error):
                log("renderer cache \(ref.sha256.prefix(12)) discarded: \(error.failure.logLine)")
                cache.remove(ref.sha256)
            }
        }

        // 2. A fresh fetch: the manifest first, and nothing else unless its
        //    hash is the one the bundle named.
        let manifestBytes: Data
        do {
            manifestBytes = try await fetcher.fetchRendererFile(
                sha256: ref.sha256, file: RendererFileName.manifest)
        } catch {
            return .failure(.unavailable(String(describing: error)))
        }
        guard sha256Hex(manifestBytes) == ref.sha256 else {
            return .failure(.integrity("manifest does not hash to the bundle's sha256"))
        }

        let signature: Data
        do {
            signature = try await fetcher.fetchRendererFile(
                sha256: ref.sha256, file: RendererFileName.signature)
        } catch {
            return .failure(.unavailable(String(describing: error)))
        }
        // Verify before fetching the code, so a refused manifest costs two
        // small requests, not the renderer.
        if case .failure(let refusal) = RendererVerifier.verify(
            manifestBytes: manifestBytes, signature: signature, publicKeysPEM: publicKeysPEM,
            now: now, minimumVersion: minimumVersion, supported: supported) {
            return .failure(.refused(refusal))
        }

        let script: Data
        let styles: Data
        do {
            script = try await fetcher.fetchRendererFile(sha256: ref.sha256, file: RendererFileName.script)
            styles = try await fetcher.fetchRendererFile(sha256: ref.sha256, file: RendererFileName.styles)
        } catch {
            return .failure(.unavailable(String(describing: error)))
        }

        let files = RendererFiles(manifest: manifestBytes, signature: signature, script: script, styles: styles)
        switch check(files, false) {
        case .failure(let error):
            return .failure(error.failure)
        case .success(let loaded):
            do {
                try cache.write(ref.sha256, files: files, now: now)
            } catch {
                // The renderer verified in memory; a cache that cannot be
                // written costs the next load a download, nothing more.
                log("renderer cache write failed: \(error)")
            }
            return .success(loaded)
        }
    }

    /// The full check, identical for cached and fresh bytes: manifest hash,
    /// signature + policy, version against the bundle, each file's size and
    /// hash, then the inlining rules.
    static func validate(
        _ files: RendererFiles,
        ref: RendererRef,
        publicKeysPEM: [String],
        now: Date,
        minimumVersion: Int,
        supported: Set<String>,
        fromCache: Bool
    ) -> Result<LoadedRenderer, ValidationError> {
        // Tamperable: anything the manifest hash does not pin.
        func swapped(_ failure: RendererLoadFailure) -> Result<LoadedRenderer, ValidationError> {
            .failure(ValidationError(failure: failure, refetchCouldHelp: true))
        }
        // Decided by the signed manifest bytes the hash pins.
        func pinned(_ failure: RendererLoadFailure) -> Result<LoadedRenderer, ValidationError> {
            .failure(ValidationError(failure: failure, refetchCouldHelp: false))
        }
        guard sha256Hex(files.manifest) == ref.sha256 else {
            return swapped(.integrity("manifest does not hash to the bundle's sha256"))
        }
        let manifest: RendererManifest
        switch RendererVerifier.verify(
            manifestBytes: files.manifest, signature: files.signature, publicKeysPEM: publicKeysPEM,
            now: now, minimumVersion: minimumVersion, supported: supported) {
        case .success(let m): manifest = m
        case .failure(let refusal):
            // Only the signature file is outside the hash; every other
            // refusal (policy, shape, keys) is the signed manifest's own.
            return refusal == .badSignature ? swapped(.refused(refusal)) : pinned(.refused(refusal))
        }
        // The hash already pins these exact signed bytes, so a version that
        // disagrees with the bundle is the server naming the renderer wrongly
        // — not tampering, and not something a refetch can change.
        guard manifest.version == ref.version else {
            return pinned(.integrity(
                "bundle names version \(ref.version), manifest is version \(manifest.version)"))
        }
        for (name, bytes) in [(RendererFileName.script, files.script), (RendererFileName.styles, files.styles)] {
            guard RendererVerifier.verifyFile(name: name, bytes: bytes, manifest: manifest) else {
                return swapped(.integrity("\(name) does not match the manifest"))
            }
        }
        guard let script = String(data: files.script, encoding: .utf8) else {
            return swapped(.integrity("renderer.js is not UTF-8"))
        }
        guard let styles = String(data: files.styles, encoding: .utf8) else {
            return swapped(.integrity("renderer.css is not UTF-8"))
        }
        // The shell inlines the script into a <script> element: a `</` could
        // close it early. The build refuses it too; this is the shell's guard.
        guard !script.contains("</") else {
            return swapped(.integrity("renderer.js contains </"))
        }
        return .success(LoadedRenderer(
            manifest: manifest, script: script, styles: styles, ref: ref, fromCache: fromCache))
    }

    /// A failed check, and whether a fresh download could change the
    /// outcome. Only the files the bundle's manifest hash does NOT pin — the
    /// signature and the two code files — or the manifest file itself being
    /// swapped can be wrong in the cache and right on the server. A verifier
    /// refusal other than `badSignature`, or a version that disagrees with the
    /// bundle, is decided by the signed manifest whose bytes the hash pins.
    struct ValidationError: Error {
        let failure: RendererLoadFailure
        let refetchCouldHelp: Bool
    }

    static func sha256Hex(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }
}
