import Foundation

/// Observability slice 4 (`docs/observability-design.md`): the build's identity
/// on every error line.
///
/// Core cannot read it — `Bundle.main` under `swift test` is the test runner's
/// — so the app target hands its `AppVersion` values in at launch.
public struct AppBuildStamp: Equatable, Sendable {
    public let version: String
    public let commit: String

    public init(version: String, commit: String) {
        self.version = version
        self.commit = commit
    }

    public static let unknown = AppBuildStamp(version: "unknown", commit: "unknown")
}

/// One line of `errors.log`.
///
/// `occurredAt` is optional because the crash line cannot have one: it is
/// pre-formatted at install time and written from a signal handler, where no
/// clock read and no string building is allowed. The drain substitutes the
/// drain time for those, which is honest about what the client can know.
public struct ClientErrorEntry: Equatable, Sendable {
    public let occurredAt: String?
    public let kind: String
    public let message: String
    public let context: [String: String]
    public let appVersion: String
    public let appCommit: String
    public let attemptID: String?

    public init(
        occurredAt: String?,
        kind: String,
        message: String,
        context: [String: String] = [:],
        appVersion: String,
        appCommit: String,
        attemptID: String? = nil
    ) {
        self.occurredAt = occurredAt
        self.kind = kind
        self.message = message
        self.context = context
        self.appVersion = appVersion
        self.appCommit = appCommit
        self.attemptID = attemptID
    }

    /// The wire shape, both on disk and in the `POST /api/client-errors` body.
    /// `attempt_id` rides inside `context` for the POST because the server's
    /// contract has no top-level field for it.
    public func jsonObject(occurredAtFallback: String) -> [String: Any] {
        var context = self.context
        if let attemptID { context["attempt_id"] = attemptID }
        return [
            "kind": kind,
            "message": message,
            "context": context,
            "occurred_at": occurredAt ?? occurredAtFallback,
            "app_version": appVersion,
            "app_commit": appCommit,
        ]
    }
}

/// Observability slice 4: the client's on-disk error sink.
///
/// `~/Library/Application Support/SecureTest/errors.log` — beside
/// `responses.sqlite`, inside the sandbox container, JSON lines. The
/// descriptor is opened once and kept open for the life of the process,
/// because the two writers that matter most cannot open a file: a signal
/// handler (nothing but `write(2)` is allowed there) and the `exit(70)` path,
/// which runs with the main thread presumed gone.
///
/// Every write is synchronous and under a lock. An error line that is still in
/// a buffer when the process dies is not a log line.
public final class ClientErrorLog: @unchecked Sendable {
    /// Set once by the app at launch so a call site anywhere — including
    /// inside this package, where no closure reaches — can record without
    /// being handed a reference. Nil under `swift test` unless a test sets it.
    public nonisolated(unsafe) static var shared: ClientErrorLog?

    /// Messages are truncated so one runaway `String(describing:)` cannot fill
    /// a student's container. 2 000 is the same cap the server side uses.
    public static let maxMessageLength = 2000

    public let fileURL: URL
    private let stamp: AppBuildStamp
    private let now: @Sendable () -> Date
    private let lock = NSLock()
    private var descriptor: Int32 = -1
    private var _attemptID: String?

    /// Fired after every record, on the caller's thread. The app hangs the
    /// `client_error` attempt event off this (D-4) so Core call sites need to
    /// know nothing about attempts or reporters.
    public nonisolated(unsafe) var onRecord: (@Sendable (ClientErrorEntry) -> Void)?

    /// Also written to stderr, so the `[security]` channel keeps showing
    /// everything it showed before this slice.
    public nonisolated(unsafe) var echo: (@Sendable (String) -> Void)?

    public init(
        fileURL: URL,
        stamp: AppBuildStamp,
        now: @escaping @Sendable () -> Date = { Date() }
    ) throws {
        self.fileURL = fileURL
        self.stamp = stamp
        self.now = now
        try FileManager.default.createDirectory(
            at: fileURL.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        descriptor = open(fileURL.path, O_WRONLY | O_CREAT | O_APPEND, 0o600)
        if descriptor < 0 {
            throw ClientErrorLogError.couldNotOpen(errno)
        }
    }

    deinit {
        if descriptor >= 0 { close(descriptor) }
    }

    /// The pre-opened descriptor the crash handler writes to. Never closed
    /// while the process lives.
    public var rawDescriptor: Int32 {
        lock.lock()
        defer { lock.unlock() }
        return descriptor
    }

    /// The attempt this process is currently inside, stamped onto later lines.
    /// The crash handler's pre-formatted lines are re-prepared separately
    /// (`CrashReporter.prepare`) — a signal handler cannot read this.
    public var attemptID: String? {
        get {
            lock.lock()
            defer { lock.unlock() }
            return _attemptID
        }
        set {
            lock.lock()
            _attemptID = newValue
            lock.unlock()
        }
    }

    /// The default location: beside the response spool, inside the container.
    public static func defaultFileURL() -> URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)
            .first ?? URL(fileURLWithPath: NSTemporaryDirectory())
        return base
            .appendingPathComponent("SecureTest", isDirectory: true)
            .appendingPathComponent("errors.log")
    }

    @discardableResult
    public func record(
        kind: String,
        message: String,
        context: [String: String] = [:]
    ) -> ClientErrorEntry {
        let entry = ClientErrorEntry(
            occurredAt: ClientErrorLog.iso8601(now()),
            kind: kind,
            message: String(message.prefix(ClientErrorLog.maxMessageLength)),
            context: context,
            appVersion: stamp.version,
            appCommit: stamp.commit,
            attemptID: attemptID
        )
        write(entry)
        echo?("\(kind): \(entry.message)")
        onRecord?(entry)
        return entry
    }

    private func write(_ entry: ClientErrorEntry) {
        var object: [String: Any] = [
            "occurred_at": entry.occurredAt ?? "",
            "kind": entry.kind,
            "message": entry.message,
            "app_version": entry.appVersion,
            "app_commit": entry.appCommit,
        ]
        if !entry.context.isEmpty { object["context"] = entry.context }
        if let attemptID = entry.attemptID { object["attempt_id"] = attemptID }
        guard
            let data = try? JSONSerialization.data(
                withJSONObject: object, options: [.sortedKeys]
            ),
            var line = String(data: data, encoding: .utf8)
        else { return }
        line.append("\n")
        writeRaw(Array(line.utf8))
    }

    private func writeRaw(_ bytes: [UInt8]) {
        lock.lock()
        defer { lock.unlock() }
        guard descriptor >= 0 else { return }
        bytes.withUnsafeBufferPointer { buffer in
            var offset = 0
            while offset < buffer.count {
                let written = Darwin.write(
                    descriptor,
                    buffer.baseAddress! + offset,
                    buffer.count - offset
                )
                if written <= 0 { break }
                offset += written
            }
        }
    }

    /// Every line currently in the file, junk lines skipped. A half-written
    /// line from a crash mid-`write` should cost the crash line, not the
    /// drain.
    public func readEntries() -> [ClientErrorEntry] {
        lock.lock()
        let data = (try? Data(contentsOf: fileURL)) ?? Data()
        lock.unlock()
        guard let text = String(data: data, encoding: .utf8) else { return [] }
        return text.split(separator: "\n", omittingEmptySubsequences: true)
            .compactMap { ClientErrorLog.decode(String($0)) }
    }

    static func decode(_ line: String) -> ClientErrorEntry? {
        guard
            let data = line.data(using: .utf8),
            let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let kind = object["kind"] as? String,
            let message = object["message"] as? String
        else { return nil }
        let occurredAt = object["occurred_at"] as? String
        return ClientErrorEntry(
            occurredAt: (occurredAt?.isEmpty ?? true) ? nil : occurredAt,
            kind: kind,
            message: message,
            context: object["context"] as? [String: String] ?? [:],
            appVersion: object["app_version"] as? String ?? "unknown",
            appCommit: object["app_commit"] as? String ?? "unknown",
            attemptID: object["attempt_id"] as? String
        )
    }

    /// Drop the first `count` lines, keeping anything appended since the read.
    /// The drain uses this rather than a blanket truncate: the file is
    /// append-only and a line written while the POST was in flight has never
    /// been sent anywhere.
    public func removeFirstLines(_ count: Int) {
        guard count > 0 else { return }
        lock.lock()
        defer { lock.unlock() }
        let data = (try? Data(contentsOf: fileURL)) ?? Data()
        let text = String(data: data, encoding: .utf8) ?? ""
        let lines = text.split(separator: "\n", omittingEmptySubsequences: true).map(String.init)
        let remaining = lines.count > count ? lines[count...] : []
        let rebuilt = remaining.isEmpty ? "" : remaining.joined(separator: "\n") + "\n"
        // Rewrite through the path, then re-open: the descriptor is O_APPEND
        // and cannot shorten the file it points at.
        try? Data(rebuilt.utf8).write(to: fileURL, options: .atomic)
        if descriptor >= 0 { close(descriptor) }
        descriptor = open(fileURL.path, O_WRONLY | O_CREAT | O_APPEND, 0o600)
    }

    public func truncate() {
        removeFirstLines(Int.max)
    }

    static func iso8601(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.string(from: date)
    }
}

public enum ClientErrorLogError: Error, Equatable {
    case couldNotOpen(Int32)
}
