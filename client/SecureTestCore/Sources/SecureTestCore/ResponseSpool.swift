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

    /// v1.3.4 (`docs/client-autosave-and-deferred-spool-design.md` D-5): a row
    /// the server refused with 409 `sitting_closed` is HELD rather than
    /// dropped. The same attempt resumes through the next sitting — the join
    /// rebinds it — and the write is accepted then, so throwing the words away
    /// at the first refusal is the one loss this slice exists to stop.
    private static let deferredColumn = "deferred_at"

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
        // v1.3.4: additive migration for an existing spool on a student's Mac.
        // SQLite has no `ADD COLUMN IF NOT EXISTS`, so the column list is read
        // first and the ALTER runs at most once; a re-open is a no-op.
        if !Self.hasDeferredColumn(handle) {
            try Self.exec(
                handle,
                "ALTER TABLE pending_responses ADD COLUMN \(Self.deferredColumn) INTEGER;"
            )
        }
    }

    private static func hasDeferredColumn(_ handle: OpaquePointer) -> Bool {
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(
            handle, "PRAGMA table_info(pending_responses);", -1, &statement, nil
        ) == SQLITE_OK else { return false }
        defer { sqlite3_finalize(statement) }
        while sqlite3_step(statement) == SQLITE_ROW {
            guard let raw = sqlite3_column_text(statement, 1) else { continue }
            if String(cString: raw) == deferredColumn { return true }
        }
        return false
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
        // v1.3.4 (D-5): a newer write REPLACES a deferred row and clears the
        // mark with it — the student has typed since, so the held copy is stale
        // and the fresh one flushes normally.
        let sql = """
        INSERT INTO pending_responses (attempt_id, item_id, payload, queued_at, deferred_at)
        VALUES (?, ?, ?, ?, NULL)
        ON CONFLICT(attempt_id, item_id)
        DO UPDATE SET payload = excluded.payload,
                      queued_at = excluded.queued_at,
                      deferred_at = NULL;
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
    ///
    /// v1.3.4 (D-5): deferred rows are NOT part of the normal queue — they are
    /// waiting on the next sitting, and a flush that tried them every time
    /// would refuse them every time. `includeDeferred` is for the retry pass
    /// and for tests.
    public func pending(includeDeferred: Bool = false) throws -> [Entry] {
        let statement = try prepare(
            includeDeferred
                ? "SELECT attempt_id, item_id, payload FROM pending_responses ORDER BY queued_at ASC;"
                : "SELECT attempt_id, item_id, payload FROM pending_responses WHERE deferred_at IS NULL ORDER BY queued_at ASC;"
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

    /// Rows held back by a closed sitting. For the host's log line and the
    /// tests; the retry pass reads the rows themselves.
    public func deferredCount() throws -> Int {
        try deferredEntries().count
    }

    private func deferredEntries() throws -> [Entry] {
        let statement = try prepare(
            "SELECT attempt_id, item_id, payload FROM pending_responses WHERE deferred_at IS NOT NULL ORDER BY queued_at ASC;"
        )
        defer { sqlite3_finalize(statement) }
        var out: [Entry] = []
        while sqlite3_step(statement) == SQLITE_ROW {
            out.append(
                Entry(
                    attemptID: text(statement, 0) ?? "",
                    itemID: text(statement, 1) ?? "",
                    responseJSON: text(statement, 2)
                )
            )
        }
        return out
    }

    /// Hold a row until the next sitting instead of deleting it.
    private func markDeferred(attemptID: String, itemID: String, now: Date = Date()) throws {
        let statement = try prepare(
            "UPDATE pending_responses SET deferred_at = ? WHERE attempt_id = ? AND item_id = ?;"
        )
        defer { sqlite3_finalize(statement) }
        sqlite3_bind_int64(statement, 1, Int64(now.timeIntervalSince1970))
        bindText(statement, 2, attemptID)
        bindText(statement, 3, itemID)
        guard sqlite3_step(statement) == SQLITE_DONE else { throw lastError() }
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

    /// Client hygiene (2026-09-15, audit #17): drop another attempt's stale
    /// answers off a shared Mac.
    ///
    /// `responses.sqlite` holds answer text in plaintext, and rows only ever
    /// leave it two ways: `remove` once the server has taken the row, and
    /// `clear(attemptID:)` after a confirmed submit. An attempt that was
    /// abandoned, crashed out of, or ended by the clock therefore leaves the
    /// PREVIOUS student's answers on disk for the next person to sit down —
    /// readable by anyone with the container.
    ///
    /// Because a row is deleted the moment it is sent, every row still here is
    /// unsent, which is the offline case finding 10.7 exists for: the spool is
    /// the only copy of that work until the server is reachable. So the rule is
    /// not "delete other attempts" but "delete other attempts that are stale":
    ///
    /// - rows of `keeping` (the attempt on screen) are never touched;
    /// - rows of any other attempt go once they are older than `olderThan`.
    ///
    /// 24 hours is the default: a student who lost Wi-Fi yesterday afternoon
    /// and comes back this morning still hands in, and a row from last week is
    /// a leak with no owner left to claim it.
    ///
    /// Returns how many rows were deleted, for the caller's `[security]` line.
    @discardableResult
    public func purge(
        keeping attemptID: String? = nil,
        olderThan age: TimeInterval = ResponseSpool.staleAfter,
        now: Date = Date()
    ) throws -> Int {
        let cutoff = now.timeIntervalSince1970 - age
        let sql: String
        if attemptID == nil {
            sql = "DELETE FROM pending_responses WHERE queued_at < ?;"
        } else {
            sql = "DELETE FROM pending_responses WHERE queued_at < ? AND attempt_id <> ?;"
        }
        let statement = try prepare(sql)
        defer { sqlite3_finalize(statement) }
        sqlite3_bind_double(statement, 1, cutoff)
        if let attemptID { bindText(statement, 2, attemptID) }
        guard sqlite3_step(statement) == SQLITE_DONE else { throw lastError() }
        return Int(sqlite3_changes(db))
    }

    /// How old another attempt's unsent row has to be before the purge takes
    /// it. One day, deliberately generous — the cost of keeping it a few hours
    /// too long is small; the cost of deleting a student's only copy is their
    /// whole test.
    public static let staleAfter: TimeInterval = 24 * 60 * 60

    // MARK: flush

    public struct FlushResult: Equatable, Sendable {
        public let sent: Int
        public let remaining: Int
        /// Entries the server refused permanently (a 4xx other than 408/429)
        /// and the spool discarded. Finding 10.1: the host logs these — a
        /// student whose answers are being thrown away must not be the only
        /// one who never hears about it.
        public let dropped: Int
        /// Row CS (D-5): at least one entry was refused with
        /// `sitting_closed` — the teacher closed the sitting, or it expired.
        /// The host needs to tell these apart, because this one ends the
        /// session rather than raising an error.
        public let sittingClosed: Bool
        /// v1.3.4 (D-5): entries HELD for the next sitting rather than sent or
        /// dropped. Not counted in `dropped` — nothing was thrown away — and
        /// not counted in `remaining`, because the normal queue will not try
        /// them again; `flushDeferred` will, after the next join.
        public let deferred: Int

        public init(
            sent: Int,
            remaining: Int,
            dropped: Int = 0,
            sittingClosed: Bool = false,
            deferred: Int = 0
        ) {
            self.sent = sent
            self.remaining = remaining
            self.dropped = dropped
            self.sittingClosed = sittingClosed
            self.deferred = deferred
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
        await send((try? pending()) ?? [], using: client, isRetry: false)
    }

    /// v1.3.4 (D-5): the retry pass, run once by the host after a join or a
    /// resume has rebound this attempt to an open sitting.
    ///
    /// Only rows held by a closed sitting are tried. A row that goes is gone
    /// from the spool like any other; a row the server now refuses for good —
    /// the teacher handed the attempt in meanwhile (`attempt_submitted`), or
    /// the clock ran out (`time_expired`) — is DROPPED, because the state the
    /// teacher captured is the one that counts. A row refused with
    /// `sitting_closed` a second time simply stays deferred.
    public func flushDeferred(using client: APIClient) async -> FlushResult {
        await send((try? deferredEntries()) ?? [], using: client, isRetry: true)
    }

    private func send(_ queued: [Entry], using client: APIClient, isRetry: Bool) async -> FlushResult {
        var sent = 0
        var dropped = 0
        var deferred = 0
        var sittingClosed = false

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
                    // v1.3.4 (D-5): a closed sitting is the one refusal that is
                    // not final — the same attempt resumes through the next
                    // sitting and the write is accepted then. Held, not
                    // deleted, and the queue carries on past it.
                    if error.isSittingClosed {
                        try? markDeferred(attemptID: entry.attemptID, itemID: entry.itemID)
                        deferred += 1
                        // Only the normal pass raises the flag. On the retry a
                        // held row may belong to an OLDER attempt whose sitting
                        // is shut for good; ending the session the student has
                        // just joined over that would be wrong.
                        if !isRetry { sittingClosed = true }
                        continue
                    }
                    try? remove(attemptID: entry.attemptID, itemID: entry.itemID)
                    dropped += 1
                    continue
                }
                break
            } catch {
                break
            }
        }
        return FlushResult(
            sent: sent,
            remaining: (try? count()) ?? 0,
            dropped: dropped,
            sittingClosed: sittingClosed,
            deferred: deferred
        )
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
