import Foundation

/// What the drain needs of the network. `APIClient` conforms; the tests hand
/// in a stub, which is the only way this is verifiable here (ADR 0013).
public protocol ClientErrorUploading: Sendable {
    /// Returns the server's `accepted` count. Any throw means "keep the file".
    func postClientErrors(_ entries: [ClientErrorEntry]) async throws -> Int
}

/// Observability slice 4: send what `errors.log` collected while nobody was
/// signed in.
///
/// The client cannot post an error at the moment it happens — the sign-in
/// screen, a failed join and a crash on the previous launch all have no
/// session token — so the file is the buffer and this is the flush. It runs
/// after a successful sign-in, off the main queue, and nothing waits for it.
///
/// The one rule: **a line leaves the file only once the server has said it
/// took it.** A failure keeps everything not yet accepted, so the next
/// sign-in tries again.
public enum ClientErrorDrain {
    /// The server caps a request at 50 entries.
    public static let batchSize = 50

    /// Returns how many entries the server accepted, for the tests and the log
    /// line.
    @discardableResult
    public static func drain(
        log: ClientErrorLog,
        api: ClientErrorUploading,
        batchSize: Int = ClientErrorDrain.batchSize,
        now: @Sendable () -> Date = { Date() },
        report: (String) -> Void = { _ in }
    ) async -> Int {
        let entries = log.readEntries()
        guard !entries.isEmpty else { return 0 }

        var accepted = 0
        var index = 0
        while index < entries.count {
            let batch = Array(entries[index..<min(index + batchSize, entries.count)])
            do {
                _ = try await api.postClientErrors(batch)
                accepted += batch.count
                index += batch.count
            } catch {
                // Keep everything from here on. Lines already accepted are
                // dropped below so a partial drain does not resend them.
                report("client-error drain stopped after \(accepted) of \(entries.count): \(error)")
                break
            }
        }
        if accepted > 0 {
            log.removeFirstLines(accepted)
            report("client-error drain sent \(accepted) of \(entries.count) line(s)")
        }
        return accepted
    }
}

/// The drain's transport. The implementation lives beside the rest of the
/// student plane in `APIClient.swift`.
extension APIClient: ClientErrorUploading {}
