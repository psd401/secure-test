import Foundation

/// Slice 66: the words a student reads when joining fails.
///
/// Lives in the package rather than beside the AppKit view so it can be tested.
/// The distinctions matter: `session_unavailable` and `not_on_roster` share a
/// status code but call for completely different next steps — check the code
/// versus fetch the teacher — and a student who reads the same sentence for
/// both will do the wrong one.
public enum JoinErrorCopy {
    public static func message(for error: Error) -> String {
        guard let apiError = error as? APIError else {
            return "Something went wrong. Tell your teacher."
        }
        switch apiError {
        case .notAuthenticated:
            return "You are not signed in. Tell your teacher."
        case .refused(_, let code):
            return message(forCode: code)
        case .decoding, .notHTTP:
            return "Could not read the reply from the server. Tell your teacher."
        }
    }

    public static func message(forCode code: String?) -> String {
        switch code {
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
