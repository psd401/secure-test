import Foundation

/// Slice 84: the student's pre-assigned sittings (`GET /api/me/sittings`,
/// phase-7 contract as of slice 83). One row per open, unexpired sitting whose
/// scope admits the signed-in student; joining one is the existing
/// `POST /api/attempts` — no code, no redeem.
public struct MySittings: Decodable, Equatable, Sendable {
    public let sittings: [Sitting]
    /// Set only when the empty list is about the CALLER's account
    /// ("no_email" | "not_on_roster" | "identity_conflict") rather than there
    /// being nothing assigned. The codes are the redeem codes, so the wording
    /// comes from `JoinErrorCopy`.
    public let reason: String?

    public struct Sitting: Decodable, Equatable, Sendable {
        public let testSessionID: String
        /// The redeem code the teacher reads out (finding 10.5). Optional on
        /// the wire so a server from before the field still decodes.
        public let code: String?
        public let assessmentID: String
        public let assessmentName: String
        public let teacherEmail: String?
        /// "sections" | "section" | "students" | "practice" (D-3,
        /// `docs/practice-sitting-design.md`) — a staff member's own row,
        /// running on the same student-side routes. An older client reads an
        /// unknown scope as "sections" (`SittingRowModel`), so a v1.3.4
        /// client shows a practice row with the wrong label rather than
        /// choking on it — the server half can deploy ahead of the release.
        public let scope: String
        public let sectionLabel: String?
        /// Kept as the wire string — it carries fractional seconds, which
        /// `JSONDecoder.dateDecodingStrategy.iso8601` refuses — and parsed on
        /// demand. An unparseable date degrades the display, never the row.
        public let expiresAt: String?
        public let attempt: Attempt?

        public var expiryDate: Date? {
            expiresAt.flatMap(ISO8601.parse)
        }

        private enum CodingKeys: String, CodingKey {
            case testSessionID = "test_session_id"
            case code
            case assessmentID = "assessment_id"
            case assessmentName = "assessment_name"
            case teacherEmail = "teacher_email"
            case scope
            case sectionLabel = "section_label"
            case expiresAt = "expires_at"
            case attempt
        }
    }

    public struct Attempt: Decodable, Equatable, Sendable {
        public let id: String
        /// "in_progress" | "submitted"
        public let status: String

        private enum CodingKeys: String, CodingKey {
            case id, status
        }
    }
}

enum ISO8601 {
    /// The server writes fractional seconds ("….000Z"); a plain internet-date
    /// parse is kept as the fallback so a server that stops doing so still
    /// parses.
    static func parse(_ string: String) -> Date? {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = fractional.date(from: string) { return date }
        let plain = ISO8601DateFormatter()
        plain.formatOptions = [.withInternetDateTime]
        return plain.date(from: string)
    }
}

/// What the entry screen shows for one sitting, derived here so `swift test`
/// covers it — the row view just lays these strings out.
public struct SittingRowModel: Equatable, Sendable {
    public enum State: Equatable, Sendable {
        /// No attempt yet — the button says "Join".
        case join
        /// An in-progress attempt — the same POST resumes it; "Resume".
        case resume
        /// Submitted — rendered as done, no button (the contract's "a
        /// submitted attempt should render as done, not as Join").
        case done
    }

    public let testSessionID: String
    public let assessmentID: String
    public let title: String
    /// D-8 (`docs/practice-sitting-design.md`): a staff member's own row —
    /// used to pick the right words when joining it fails
    /// (`JoinErrorCopy.message(forCode:isPractice:)`), since the wire code
    /// `not_in_sitting` is shared with the class-sitting case.
    public let isPractice: Bool
    /// The sitting code first (finding 10.5: it is what the teacher reads out,
    /// so it leads and survives tail truncation), then where this sitting
    /// comes from — the section label when the scope names one, otherwise
    /// words for the scope — plus the teacher.
    public let detail: String
    public let expiryDate: Date?
    public let state: State

    public init(_ sitting: MySittings.Sitting) {
        testSessionID = sitting.testSessionID
        assessmentID = sitting.assessmentID
        title = sitting.assessmentName
        isPractice = sitting.scope == "practice"

        let where_: String
        // Practice ignores the section label — a practice sitting never has
        // one (D-1, `docs/practice-sitting-design.md`) — but checking scope
        // first is what an older client that already reads a label would
        // want anyway.
        if sitting.scope == "practice" {
            where_ = "Practice — only you"
        } else if let label = sitting.sectionLabel, !label.isEmpty {
            where_ = label
        } else {
            switch sitting.scope {
            case "students": where_ = "Assigned to you"
            case "sections": where_ = "All sections"
            default: where_ = sitting.scope
            }
        }
        let place = [sitting.code, where_].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
        detail = [place, sitting.teacherEmail].compactMap { $0 }.joined(separator: " — ")

        expiryDate = sitting.expiryDate

        switch sitting.attempt?.status {
        case "submitted": state = .done
        case .some: state = .resume
        case nil: state = .join
        }
    }

    /// "closes 3:08 PM", with the date prepended when it is not today.
    /// Everything injectable, so tests pin locale, zone and now.
    public func expiryLabel(
        now: Date = Date(),
        calendar: Calendar = .current,
        locale: Locale = .current,
        timeZone: TimeZone = .current,
    ) -> String? {
        guard let expiryDate else { return nil }
        var calendar = calendar
        calendar.timeZone = timeZone
        let formatter = DateFormatter()
        formatter.locale = locale
        formatter.timeZone = timeZone
        formatter.timeStyle = .short
        formatter.dateStyle = calendar.isDate(expiryDate, inSameDayAs: now) ? .none : .medium
        return "closes \(formatter.string(from: expiryDate))"
    }
}
