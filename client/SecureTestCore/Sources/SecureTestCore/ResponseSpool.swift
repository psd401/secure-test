import Foundation
import SQLite3

/// Slice 67: the offline spool.
///
/// `docs/plan.md` asks the MVP for "response upload (HTTPS, idempotent retry,
/// local SQLite spool if offline)". A classroom Mac loses its network mid-test
/// often enough that treating an upload failure as lost work is not acceptable:
/// the student cannot tell, and the teacher finds out at scoring time.
///
/// Every answer is written to disk FIRST and sent afterwards. A crash, a
/// dropped network, or a lid closed on the way to the next room leaves the work
/// on the machine, and the next flush sends it.
///
/// Keyed on (attempt, item), latest write wins — mirroring the server's own
/// unique constraint. Spooling a row per keystroke would replay a student's
/// whole edit history at the server and, worse, could land an earlier answer
/// after a later one if a retry overtook a fresh write.
///
/// Uses the system SQLite through the C API rather than taking a dependency.
/// One table, four statements; a package would be more code to audit than the
/// thing it wraps.
public actor ResponseSpool {
    /// A withdrawal (the student cleared their answer) is a spooled row with no
    /// payload, so it queues and retries exactly like an answer does.
    public struct Entry: Equatable, Sendable {
        public let attemptID: String
        public let itemID: String
        /// nil means "delete this answer".
        public let responseJSON: String?
    }

    public enum SpoolError: Error, Equatable {
        case open(String)
        case statement(String)
    }

    private var db: OpaquePointer?

    public init(path: String) throws {
        var handle: OpaquePointer?
        let flags = SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX
        guard sqlite3_open_v2(path, &handle, flags, nil) == SQLITE_OK, let handle else {
            let message = handle.map { String(cString: sqlite3_errmsg($0)) } ?? "unknown"
            sqlite3_close_v2(handle)
            throw SpoolError.open(message)
        }
        self.db = handle

        // Setup runs against the local handle through free functions rather
        // than the actor's own helpers: `init` is nonisolated, so calling
        // actor-isolated methods here is an error under the Swift 6 language
        // mode. Nothing else can reach this actor yet anyway.
        //
        // WAL so a crash mid-write cannot corrupt the queue, and NORMAL sync so
        // a fast typist is not waiting on a disk flush per keystroke — the
        // durability that matters here is "survives the app dying", which WAL
        // gives, not "survives power loss mid-fsync".
        try Self.exec(handle, "PRAGMA journal_mode=WAL;")
        try Self.exec(handle, "PRAGMA synchronous=NORMAL;")
        try Self.exec(
            handle,
            """
            CREATE TABLE IF NOT EXISTS pending_responses (
              attempt_id TEXT NOT NULL,
              item_id    TEXT NOT NULL,
              payload    TEXT,
              queued_at  REAL NOT NULL,
              PRIMARY KEY (attempt_id, item_id)
            );
            """
        )
    }

    private static func exec(_ handle: OpaquePointer, _ sql: String) throws {
        guard sqlite3_exec(handle, sql, nil, nil, nil) == SQLITE_OK else {
            throw SpoolError.statement(String(cString: sqlite3_errmsg(handle)))
        }
    }

    deinit {
        sqlite3_close_v2(db)
    }

    // MARK: queue

    /// Record an answer. Replaces any earlier unsent answer for the same item —
    /// only the student's latest intent is worth sending.
    public func enqueue(attemptID: String, itemID: String, responseJSON: String) throws {
        try upsert(attemptID: attemptID, itemID: itemID, payload: responseJSON)
    }

    /// Record a withdrawal. Also replaces an unsent answer: a student who
    /// answers then clears has, on balance, not answered.
    public func enqueueWithdrawal(attemptID: String, itemID: String) throws {
        try upsert(attemptID: attemptID, itemID: itemID, payload: nil)
    }

    private func upsert(attemptID: String, itemID: String, payload: String?) throws {
        let sql = """
        INSERT INTO pending_responses (attempt_id, item_id, payload, queued_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(attempt_id, item_id)
        DO UPDATE SET payload = excluded.payload, queued_at = excluded.queued_at;
        """
        let statement = try prepare(sql)
        defer { sqlite3_finalize(statement) }
        bindText(statement, 1, attemptID)
        bindText(statement, 2, itemID)
        if let payload { bindText(statement, 3, payload) } else { sqlite3_bind_null(statement, 3) }
        sqlite3_bind_double(statement, 4, Date().timeIntervalSince1970)
        guard sqlite3_step(statement) == SQLITE_DONE else { throw lastError() }
    }

    /// Oldest first, so a student's answers reach the server in the order they
    /// were given.
    public func pending() throws -> [Entry] {
        let statement = try prepare(
            "SELECT attempt_id, item_id, payload FROM pending_responses ORDER BY queued_at ASC;"
        )
        defer { sqlite3_finalize(statement) }

        var out: [Entry] = []
        while sqlite3_step(statement) == SQLITE_ROW {
            let attemptID = text(statement, 0) ?? ""
            let itemID = text(statement, 1) ?? ""
            out.append(Entry(attemptID: attemptID, itemID: itemID, responseJSON: text(statement, 2)))
        }
        return out
    }

    public func count() throws -> Int {
        try pending().count
    }

    public func remove(attemptID: String, itemID: String) throws {
        let statement = try prepare(
            "DELETE FROM pending_responses WHERE attempt_id = ? AND item_id = ?;"
        )
        defer { sqlite3_finalize(statement) }
        bindText(statement, 1, attemptID)
        bindText(statement, 2, itemID)
        guard sqlite3_step(statement) == SQLITE_DONE else { throw lastError() }
    }

    /// Slice 73: drop everything queued for one attempt.
    ///
    /// Called after a successful submit, when the server has the answers and the
    /// local copies are pure residue. Deliberately NOT called on any other
    /// failure path: a student who never gets back online still has their work
    /// on the machine, and clearing that would destroy the only copy.
    public func clear(attemptID: String) throws {
        let statement = try prepare("DELETE FROM pending_responses WHERE attempt_id = ?;")
        defer { sqlite3_finalize(statement) }
        bindText(statement, 1, attemptID)
        guard sqlite3_step(statement) == SQLITE_DONE else { throw lastError() }
    }

    // MARK: flush

    public struct FlushResult: Equatable, Sendable {
        public let sent: Int
        public let remaining: Int
        /// Entries the server refused permanently (a 4xx other than 408/429)
        /// and the spool discarded. Finding 10.1: the host logs these — a
        /// student whose answers are being thrown away must not be the only
        /// one who never hears about it.
        public let dropped: Int

        public init(sent: Int, remaining: Int, dropped: Int = 0) {
            self.sent = sent
            self.remaining = remaining
            self.dropped = dropped
        }
    }

    /// Send everything queued, dropping each entry only once the server has
    /// taken it.
    ///
    /// Stops at the FIRST failure rather than continuing. Two reasons: a failure
    /// is almost always the network being gone, so the rest would fail too; and
    /// carrying on would deliver later answers before earlier ones, which for
    /// two edits to the same item is the difference between the right answer and
    /// a stale one.
    ///
    /// A refusal the server will never accept — a 4xx that is not 408/429 — is
    /// DROPPED rather than retried forever. A permanently-rejected entry at the
    /// head of the queue would otherwise block every answer behind it.
    public func flush(using client: APIClient) async -> FlushResult {
        var sent = 0
        var dropped = 0
        let queued = (try? pending()) ?? []

        for entry in queued {
            do {
                if let payload = entry.responseJSON {
                    try await client.putResponse(
                        attemptID: entry.attemptID,
                        itemID: entry.itemID,
                        responseJSON: payload,
                    )
                } else {
                    try await client.deleteResponse(
                        attemptID: entry.attemptID,
                        itemID: entry.itemID,
                    )
                }
                try? remove(attemptID: entry.attemptID, itemID: entry.itemID)
                sent += 1
            } catch let error as APIError {
                if case .refused(let status, _) = error, Self.isPermanent(status) {
                    try? remove(attemptID: entry.attemptID, itemID: entry.itemID)
                    dropped += 1
                    continue
                }
                break
            } catch {
                break
            }
        }
        return FlushResult(sent: sent, remaining: (try? count()) ?? 0, dropped: dropped)
    }

    /// 4xx means the server understood and refused, so repeating it changes
    /// nothing — except 408 and 429, which explicitly ask for a retry.
    static func isPermanent(_ status: Int) -> Bool {
        (400..<500).contains(status) && status != 408 && status != 429
    }

    // MARK: sqlite plumbing

    private func prepare(_ sql: String) throws -> OpaquePointer? {
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &statement, nil) == SQLITE_OK else {
            throw lastError()
        }
        return statement
    }

    /// SQLITE_TRANSIENT is a macro C exposes and Swift does not, so SQLite is
    /// told to copy the bytes rather than keep a pointer into a Swift String
    /// that may not outlive the call.
    private func bindText(_ statement: OpaquePointer?, _ index: Int32, _ value: String) {
        let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
        sqlite3_bind_text(statement, index, value, -1, transient)
    }

    private func text(_ statement: OpaquePointer?, _ index: Int32) -> String? {
        guard let raw = sqlite3_column_text(statement, index) else { return nil }
        return String(cString: raw)
    }

    private func lastError() -> SpoolError {
        .statement(String(cString: sqlite3_errmsg(db)))
    }
}
