import Foundation

// Server-delivered renderer slice 4b (docs/server-delivered-renderer-design.md
// D-1): the per-account cache of signed renderers, one directory per
// manifest SHA-256 under `Application Support/SecureTest/renderers/`, beside
// the response spool and errors.log.
//
// NEVER TRUSTED. The directory sits in the app's container, which the
// student's own account can write, so a read returns bytes and nothing more:
// RendererLoader re-hashes and re-verifies every byte on every use. What
// this type guarantees is only hygiene — owner-only permissions, atomic
// writes, path components that cannot traverse, bounded reads.

/// The four files the route serves under a manifest hash.
public enum RendererFileName {
    public static let manifest = "manifest.json"
    public static let signature = "manifest.sig"
    public static let script = "renderer.js"
    public static let styles = "renderer.css"
    public static let all = [manifest, signature, script, styles]
}

/// One renderer's four files, as raw bytes.
public struct RendererFiles: Equatable, Sendable {
    public let manifest: Data
    public let signature: Data
    public let script: Data
    public let styles: Data

    public init(manifest: Data, signature: Data, script: Data, styles: Data) {
        self.manifest = manifest
        self.signature = signature
        self.script = script
        self.styles = styles
    }

    func bytes(for name: String) -> Data {
        switch name {
        case RendererFileName.manifest: return manifest
        case RendererFileName.signature: return signature
        case RendererFileName.script: return script
        default: return styles
        }
    }
}

public struct RendererCache: Sendable {
    /// An entry nobody has used for this long goes at the next eviction. The
    /// cost of keeping one too long is a few hundred KB of public code; the
    /// cost of evicting one in use is one download.
    public static let defaultUnusedFor: TimeInterval = 30 * 24 * 60 * 60

    /// A cached file larger than this is treated as absent (and the entry
    /// removed by the loader's refetch) — a planted multi-GB file must not be
    /// read into memory. Far above any real renderer.
    public static let maxFileBytes = 16 * 1024 * 1024

    public let baseURL: URL

    public init(baseURL: URL = RendererCache.defaultBaseURL()) {
        self.baseURL = baseURL
    }

    /// `~/Library/Application Support/SecureTest/renderers/` — inside the
    /// sandbox container, found the same way the spool and errors.log are.
    public static func defaultBaseURL() -> URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)
            .first ?? URL(fileURLWithPath: NSTemporaryDirectory())
        return base
            .appendingPathComponent("SecureTest", isDirectory: true)
            .appendingPathComponent("renderers", isDirectory: true)
    }

    private func entryURL(_ sha256: String) -> URL? {
        // The hash is the only path component that comes from outside; a
        // well-formed one cannot traverse.
        guard isLowerHex(sha256, length: 64) else { return nil }
        return baseURL.appendingPathComponent(sha256, isDirectory: true)
    }

    // MARK: read

    /// All four files, or nil when any is missing, unreadable, not a regular
    /// file, or over `maxFileBytes`. The bytes are unverified.
    public func read(_ sha256: String) -> RendererFiles? {
        guard let dir = entryURL(sha256) else { return nil }
        var found: [String: Data] = [:]
        for name in RendererFileName.all {
            guard let data = readRegularFile(dir.appendingPathComponent(name)) else { return nil }
            found[name] = data
        }
        return RendererFiles(
            manifest: found[RendererFileName.manifest]!,
            signature: found[RendererFileName.signature]!,
            script: found[RendererFileName.script]!,
            styles: found[RendererFileName.styles]!)
    }

    private func readRegularFile(_ url: URL) -> Data? {
        // lstat semantics: a symlink planted in the entry is not followed.
        guard let attrs = try? FileManager.default.attributesOfItem(atPath: url.path),
              attrs[.type] as? FileAttributeType == .typeRegular,
              let size = attrs[.size] as? Int, size <= Self.maxFileBytes
        else { return nil }
        return try? Data(contentsOf: url)
    }

    // MARK: write

    /// Writes all four files into `<base>/<sha256>/`, each atomically (temp
    /// file + rename), the directories 0700 and the files 0600, then marks
    /// the entry used at `now`.
    public func write(_ sha256: String, files: RendererFiles, now: Date = Date()) throws {
        guard let dir = entryURL(sha256) else { throw RendererCacheError.badHash }
        let fm = FileManager.default
        try makeOwnerOnlyDirectory(baseURL)
        // Something other than a real directory at the entry path (a planted
        // symlink, a file) is removed rather than written through.
        if let type = (try? fm.attributesOfItem(atPath: dir.path))?[.type] as? FileAttributeType,
           type != .typeDirectory {
            try fm.removeItem(at: dir)
        }
        try makeOwnerOnlyDirectory(dir)
        for name in RendererFileName.all {
            try writeAtomically(files.bytes(for: name), to: dir.appendingPathComponent(name), in: dir)
        }
        touch(sha256, now: now)
    }

    private func makeOwnerOnlyDirectory(_ url: URL) throws {
        let fm = FileManager.default
        try fm.createDirectory(
            at: url, withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700])
        // createDirectory leaves an existing directory's mode alone.
        try fm.setAttributes([.posixPermissions: 0o700], ofItemAtPath: url.path)
    }

    private func writeAtomically(_ bytes: Data, to target: URL, in dir: URL) throws {
        let temp = dir.appendingPathComponent(".tmp-\(UUID().uuidString)")
        // O_EXCL | O_NOFOLLOW: never write through something already there.
        let fd = open(temp.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)
        guard fd >= 0 else { throw RendererCacheError.couldNotWrite(errno) }
        var ok = true
        bytes.withUnsafeBytes { raw in
            var offset = 0
            while offset < raw.count {
                let n = Darwin.write(fd, raw.baseAddress!.advanced(by: offset), raw.count - offset)
                if n <= 0 { ok = false; return }
                offset += n
            }
        }
        if ok && fsync(fd) != 0 { ok = false }
        close(fd)
        guard ok else {
            let err = errno
            unlink(temp.path)
            throw RendererCacheError.couldNotWrite(err)
        }
        // rename(2) replaces the directory entry — a symlink at the target is
        // replaced, not followed.
        guard rename(temp.path, target.path) == 0 else {
            let err = errno
            unlink(temp.path)
            throw RendererCacheError.couldNotWrite(err)
        }
    }

    // MARK: use / remove / evict

    /// Marks the entry used at `now` (its directory's modification date),
    /// which is what eviction reads. Best effort.
    public func touch(_ sha256: String, now: Date = Date()) {
        guard let dir = entryURL(sha256) else { return }
        try? FileManager.default.setAttributes([.modificationDate: now], ofItemAtPath: dir.path)
    }

    public func remove(_ sha256: String) {
        guard let dir = entryURL(sha256) else { return }
        try? FileManager.default.removeItem(at: dir)
    }

    /// Deletes every entry not used within `unusedFor` of `now`, never one
    /// named in `keeping`; anything in the cache directory that is not a
    /// hash-named entry is removed too (it was not put there by this type).
    /// Returns how many items went, for the caller's log line.
    @discardableResult
    public func evict(
        keeping: Set<String> = [],
        unusedFor: TimeInterval = RendererCache.defaultUnusedFor,
        now: Date = Date()
    ) -> Int {
        let fm = FileManager.default
        guard let names = try? fm.contentsOfDirectory(atPath: baseURL.path) else { return 0 }
        let cutoff = now.addingTimeInterval(-unusedFor)
        var removed = 0
        for name in names {
            if keeping.contains(name) { continue }
            let url = baseURL.appendingPathComponent(name)
            let attrs = try? fm.attributesOfItem(atPath: url.path)
            let isEntry = isLowerHex(name, length: 64)
                && attrs?[.type] as? FileAttributeType == .typeDirectory
            if isEntry, let used = attrs?[.modificationDate] as? Date, used >= cutoff { continue }
            if (try? fm.removeItem(at: url)) != nil { removed += 1 }
        }
        return removed
    }
}

public enum RendererCacheError: Error, Equatable {
    case badHash
    case couldNotWrite(Int32)
}
