import Foundation

// Server-delivered renderer slice 4a (docs/server-delivered-renderer-design.md
// D-1, D-2, 2.a, D-4): the shell's reading of a signed renderer manifest.
// Mirrors packages/renderer/src/manifest.ts (`RendererManifest`,
// `parseManifest`).
//
// The signature covers the EXACT bytes the server sent, and RendererVerifier
// checks it before this type ever sees them. So unlike parseManifest, this
// decode does NOT re-encode to prove the bytes are canonical: one byte form
// per manifest is the build's concern, and a non-canonical but signed
// manifest was still signed by a key we trust. What this decode does refuse
// is any shape the shell would have to guess about — a missing or unknown
// key at either level, a wrong type, a value outside its pattern.
//
// `requires` entries are NOT checked against a vocabulary here: a term this
// shell does not know is a renderer for a newer shell, which RendererVerifier
// reports as `missingCapabilities` (update needed), not as a malformed
// manifest.

public struct RendererManifest: Decodable, Equatable, Sendable {
    public struct File: Decodable, Equatable, Sendable {
        /// Lowercase hex SHA-256 of the file's bytes.
        public let sha256: String
        public let bytes: Int

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: AnyKey.self)
            try requireExactKeys(c, ["bytes", "sha256"], at: "a files entry")
            let sha = try c.decode(String.self, forKey: AnyKey("sha256"))
            guard isLowerHex(sha, length: 64) else {
                throw RendererManifestError("sha256 must be 64 lowercase hex characters")
            }
            let bytes = try c.decode(Int.self, forKey: AnyKey("bytes"))
            guard bytes >= 0 else { throw RendererManifestError("bytes must be a non-negative integer") }
            self.sha256 = sha
            self.bytes = bytes
        }

        init(sha256: String, bytes: Int) {
            self.sha256 = sha256
            self.bytes = bytes
        }
    }

    public static let format = 1

    public let version: Int
    /// The 40-hex lowercase commit the files were built from.
    public let commit: String
    /// The exact `Date.prototype.toISOString` strings, e.g.
    /// `2026-10-13T17:00:00.000Z`.
    public let issuedAt: String
    public let notAfter: String
    /// The same two instants as integer milliseconds since 1970 — what the
    /// validity check compares, so the inclusive edges are exact.
    public let issuedAtMillis: Int64
    public let notAfterMillis: Int64
    public let requires: [String]
    public let files: [String: File]

    private static let keys = ["commit", "files", "format", "issued_at", "not_after", "requires", "version"]

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: AnyKey.self)
        try requireExactKeys(c, Self.keys, at: "the manifest")

        let format = try c.decode(Int.self, forKey: AnyKey("format"))
        guard format == Self.format else { throw RendererManifestError("unsupported manifest format \(format)") }

        let version = try c.decode(Int.self, forKey: AnyKey("version"))
        guard version > 0 else { throw RendererManifestError("version must be a positive integer") }

        let commit = try c.decode(String.self, forKey: AnyKey("commit"))
        guard isLowerHex(commit, length: 40) else {
            throw RendererManifestError("commit must be a 40-character lowercase hex SHA")
        }

        let issuedAt = try c.decode(String.self, forKey: AnyKey("issued_at"))
        let notAfter = try c.decode(String.self, forKey: AnyKey("not_after"))
        let issuedMs = try parseISOMillis("issued_at", issuedAt)
        let notAfterMs = try parseISOMillis("not_after", notAfter)
        guard notAfterMs > issuedMs else { throw RendererManifestError("not_after must be after issued_at") }

        let requires = try c.decode([String].self, forKey: AnyKey("requires"))
        let files = try c.decode([String: File].self, forKey: AnyKey("files"))
        guard !files.isEmpty else { throw RendererManifestError("files must not be empty") }
        for name in files.keys where !isAllowedFileName(name) {
            throw RendererManifestError("file name \"\(name)\" is not allowed")
        }

        self.version = version
        self.commit = commit
        self.issuedAt = issuedAt
        self.notAfter = notAfter
        self.issuedAtMillis = issuedMs
        self.notAfterMillis = notAfterMs
        self.requires = requires
        self.files = files
    }

    /// Decodes and validates manifest bytes. The message names the field, never
    /// a value beyond the manifest's own (public) contents.
    public static func decode(_ bytes: Data) -> Result<RendererManifest, RendererManifestError> {
        do {
            return .success(try JSONDecoder().decode(RendererManifest.self, from: bytes))
        } catch let error as RendererManifestError {
            return .failure(error)
        } catch let DecodingError.typeMismatch(_, context) {
            return .failure(RendererManifestError("wrong type at \(pathString(context.codingPath))"))
        } catch let DecodingError.valueNotFound(_, context) {
            return .failure(RendererManifestError("null at \(pathString(context.codingPath))"))
        } catch let DecodingError.keyNotFound(key, _) {
            return .failure(RendererManifestError("missing key \(key.stringValue)"))
        } catch let DecodingError.dataCorrupted(context) where context.codingPath.isEmpty {
            return .failure(RendererManifestError("not valid JSON"))
        } catch let DecodingError.dataCorrupted(context) {
            return .failure(RendererManifestError("bad value at \(pathString(context.codingPath))"))
        } catch {
            return .failure(RendererManifestError("not a manifest"))
        }
    }
}

public struct RendererManifestError: Error, Equatable, Sendable, CustomStringConvertible {
    public let message: String
    public init(_ message: String) { self.message = message }
    public var description: String { message }
}

// MARK: - Shape checks (mirror manifest.ts's regexes)

struct AnyKey: CodingKey {
    let stringValue: String
    var intValue: Int? { nil }
    init(_ string: String) { stringValue = string }
    init?(stringValue: String) { self.stringValue = stringValue }
    init?(intValue: Int) { nil }
}

private func requireExactKeys(_ c: KeyedDecodingContainer<AnyKey>, _ expected: [String], at place: String) throws {
    let have = c.allKeys.map(\.stringValue).sorted()
    guard have == expected.sorted() else {
        throw RendererManifestError("\(place) keys must be exactly \(expected.joined(separator: ", "))")
    }
}

private func pathString(_ path: [CodingKey]) -> String {
    path.isEmpty ? "the top level" : path.map(\.stringValue).joined(separator: ".")
}

private func isLowerHex(_ s: String, length: Int) -> Bool {
    s.utf8.count == length && s.utf8.allSatisfy { (0x30...0x39).contains($0) || (0x61...0x66).contains($0) }
}

/// `^[a-z0-9][a-z0-9._-]*$` without `..` — one path segment, no traversal.
private func isAllowedFileName(_ name: String) -> Bool {
    let u = Array(name.utf8)
    guard let first = u.first else { return false }
    let alnum: (UInt8) -> Bool = { (0x61...0x7A).contains($0) || (0x30...0x39).contains($0) }
    guard alnum(first) else { return false }
    guard u.allSatisfy({ alnum($0) || $0 == 0x2E || $0 == 0x5F || $0 == 0x2D }) else { return false }
    return !name.contains("..")
}

/// `YYYY-MM-DDTHH:MM:SS.mmmZ`, a real UTC date — the exact shape of
/// JavaScript's `toISOString` for years 0000–9999.
private func parseISOMillis(_ field: String, _ s: String) throws -> Int64 {
    let bad = RendererManifestError("\(field) must be an ISO-8601 UTC timestamp like 2026-10-13T17:00:00.000Z")
    let u = Array(s.utf8)
    guard u.count == 24 else { throw bad }
    let shape = "dddd-dd-ddTdd:dd:dd.dddZ"
    for (ch, want) in zip(u, shape.utf8) {
        if want == UInt8(ascii: "d") {
            guard (0x30...0x39).contains(ch) else { throw bad }
        } else if ch != want {
            throw bad
        }
    }
    func num(_ from: Int, _ len: Int) -> Int {
        u[from..<(from + len)].reduce(0) { $0 * 10 + Int($1 - 0x30) }
    }
    var parts = DateComponents()
    parts.year = num(0, 4)
    parts.month = num(5, 2)
    parts.day = num(8, 2)
    parts.hour = num(11, 2)
    parts.minute = num(14, 2)
    parts.second = num(17, 2)
    let millis = num(20, 3)

    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = TimeZone(identifier: "UTC")!
    // Calendar silently rolls 02-30 into March; round-trip to refuse it.
    guard let date = calendar.date(from: parts) else {
        throw RendererManifestError("\(field) is not a real date")
    }
    let back = calendar.dateComponents([.year, .month, .day, .hour, .minute, .second], from: date)
    guard back.year == parts.year, back.month == parts.month, back.day == parts.day,
          back.hour == parts.hour, back.minute == parts.minute, back.second == parts.second
    else {
        throw RendererManifestError("\(field) is not a real date")
    }
    return Int64(date.timeIntervalSince1970.rounded()) * 1000 + Int64(millis)
}
