import Foundation

/// Slice 66: the words a student reads when joining fails.
///
/// Lives in the package rather than beside the AppKit view so it can be tested.
/// The distinctions matter: `session_unavailable` and `not_on_roster` share a
/// status code but call for completely different next steps — check the code
/// versus fetch the teacher — and a student who reads the same sentence for
/// both will do the wrong one.
public enum JoinErrorCopy {
    public static func message(for error: Error, isPractice: Bool = false, isStaff: Bool = false) -> String {
        guard let apiError = error as? APIError else {
            return "Something went wrong. Tell your teacher."
        }
        switch apiError {
        case .notAuthenticated:
            return "You are not signed in. Tell your teacher."
        case .refused(_, let code):
            return message(forCode: code, isPractice: isPractice, isStaff: isStaff)
        case .decoding, .notHTTP:
            return "Could not read the reply from the server. Tell your teacher."
        }
    }

    /// `isPractice` disambiguates `not_in_sitting` (`docs/practice-sitting-design.md`,
    /// D-3): the wire code is the SAME string for a student outside a class
    /// sitting and for a staff member on someone else's practice sitting —
    /// the resolver returns one reason for both (`resolveStudent.ts`,
    /// `resolvePracticePrincipal`). The caller knows which row it tried to
    /// join (`SittingRowModel.isPractice`), so that is what tells the two
    /// apart here rather than the code alone.
    ///
    /// `isStaff` (practice slice 3 follow-up, 2026-09-22): a teacher joins
    /// only practice sittings, and the redeem route answers EVERY wrong code
    /// `session_unavailable` on purpose (no code oracle), so a teacher who
    /// types a colleague's practice code, a class code or a closed one reads
    /// words meant for them rather than "check it with your teacher".
    public static func message(forCode code: String?, isPractice: Bool = false, isStaff: Bool = false) -> String {
        switch code {
        case "session_unavailable" where isStaff:
            return "That code is not open for you. A practice test opens only for the teacher who started it."
        case "malformed_code":
            // The only failure the student can act on alone.
            return "That code does not look right. Check it and try again."
        case "session_unavailable":
            // UX pass 2 slice 6 (10.6): the server deliberately answers the same
            // 404 for a nonexistent code and an open sitting the student is not
            // in; "for you" keeps the copy honest for both without disclosing
            // which. The next step is still the teacher.
            return "That code is not open for you right now. Check it with your teacher."
        case "not_on_roster":
            return "You are not on the list for this test. Tell your teacher."
        case "not_in_sitting" where isPractice:
            return "This practice test is for the teacher who started it."
        case "no_practice_sitting":
            // The staff empty-list reason (D-3): no open practice sitting
            // names this account. Today a staff sign-in with nothing to
            // practise reads the student copy for `not_on_roster`; this is
            // its own line because "tell your teacher" is nonsense advice
            // for a teacher.
            return "No practice tests right now. Start one from your assessment's Test sessions tab."
        case "no_email", "no_sourced_id":
            // no_sourced_id is the pre-slice-78 name; a server still sending
            // it deserves the same words.
            return "Your account is missing information. Tell your teacher."
        case "account_not_allowed":
            // Slice 80: the exchange refused the Google account — the one
            // failure where the fix is on the student's side of the screen.
            return "That Google account cannot be used here. Sign in with your school account."
        case "identity_conflict":
            return "There is a problem with your account. Tell your teacher."
        default:
            return "Could not join. Tell your teacher."
        }
    }
}
