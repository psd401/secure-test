/**
 * UX pass 1 (docs/ux-pass-1-proposal.md §2.3): one place that turns the
 * codes our routes put in `?error=` into a sentence a teacher can act on.
 * The raw code stays available so IT has something exact to search for.
 *
 * Slice 2 covers the sign-in codes (app/api/auth/callback/route.ts and
 * proxy.ts). Later slices add the API codes as their screens are reworked.
 */

export interface ErrorCopy {
  /** The sentence shown to the teacher. */
  message: string;
  /** Show the raw code under the sentence (true when the fix is IT's, not the teacher's). */
  showCode: boolean;
}

/** Codes where the teacher's own action fixes it: try again. */
const AUTH_RETRY = new Set([
  "missing_code_or_state",
  "missing_pkce_cookie",
  "invalid_pkce_cookie",
  "state_mismatch",
  "nonce_mismatch",
]);

/** Codes where nothing the teacher does will help: hand the code to IT. */
const AUTH_TELL_IT = new Set([
  "server_misconfigured",
  "token_exchange_failed",
  "id_token_invalid",
  "id_token_no_sub",
]);

export function authErrorCopy(code: string): ErrorCopy {
  // token_exchange_failed carries the upstream message after a colon.
  const base = code.split(":")[0] ?? code;
  switch (base) {
    case "access_denied":
      return { message: "You cancelled the Google sign-in.", showCode: false };
    case "account_not_allowed":
      return {
        message: "That Google account is not a PSD staff account. Use your psd401.net account.",
        showCode: false,
      };
    case "student_account":
      return {
        message:
          "That is a student account. Sign out, then sign in with your psd401.net staff account.",
        showCode: false,
      };
    default:
      if (AUTH_RETRY.has(base)) {
        return { message: "That sign-in link expired. Try again.", showCode: false };
      }
      if (AUTH_TELL_IT.has(base)) {
        return {
          message: "Sign-in isn't working right now. Tell IT this code:",
          showCode: true,
        };
      }
      return { message: "Sign-in didn't complete. Try again, or tell IT this code:", showCode: true };
  }
}

/** app/dashboard/import (assessment file) — the codes its server action puts in `?error=`. */
export function importErrorCopy(code: string): ErrorCopy {
  const base = code.split(":")[0] ?? code;
  switch (base) {
    case "no_file_selected":
      return { message: "Choose a file first.", showCode: false };
    case "file_too_large":
      return { message: "That file is over 50 MB.", showCode: false };
    case "read_failed":
      return { message: "The file couldn't be read. Try again.", showCode: false };
    case "invalid_json":
      return { message: "That isn't a Secure-Test assessment file (.json).", showCode: false };
    case "schema_invalid":
      return {
        message: "That file isn't in the Secure-Test assessment format.",
        showCode: true,
      };
    case "asset_content_type_not_allowed":
    case "asset_base64_invalid":
    case "asset_storage_put_failed":
    case "asset_db_insert_failed":
      return { message: "An image inside the file couldn't be imported.", showCode: true };
    default:
      return { message: "The import didn't finish. Try again, or tell IT this code:", showCode: true };
  }
}

/** app/api/uploads/image and app/api/assets — the codes their JSON bodies carry. */
export function uploadErrorCopy(code: string): ErrorCopy {
  switch (code) {
    case "missing_file":
    case "empty_file":
      return { message: "Choose an image first.", showCode: false };
    case "file_too_large":
      return { message: "That image is over 5 MB.", showCode: false };
    case "unsupported_content_type":
      return { message: "Use a PNG, JPG, GIF, WebP or SVG.", showCode: false };
    default:
      return { message: "The upload didn't finish. Try again, or tell IT this code:", showCode: true };
  }
}

/**
 * Thrown by the editor's fetch helper: the route's JSON `error` code plus
 * the HTTP status, so copy can be chosen by code rather than by status text.
 */
export class ApiError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    public readonly detail?: string,
  ) {
    super(`${status} ${code}`);
    this.name = "ApiError";
  }
}

/** app/api/assessments/[id]/items — the codes a question save/delete can come back with. */
export function itemErrorCopy(code: string): ErrorCopy {
  switch (code) {
    case "invalid_body":
      return {
        message: "This question isn't complete yet — check its text, choices and answer.",
        showCode: false,
      };
    case "assessment_published_editing_locked":
      return { message: "This assessment is published. Unpublish to edit.", showCode: false };
    case "has_responses":
      return {
        message: "Students have already answered this question, so it can't be deleted.",
        showCode: false,
      };
    case "type_change_not_supported":
      return { message: "A question's type can't change. Add a new question instead.", showCode: false };
    case "not_found":
    case "forbidden":
      return { message: "This assessment isn't available any more. Reload the page.", showCode: false };
    case "network":
      return { message: "Couldn't reach the server. Check your connection and try again.", showCode: false };
    default:
      return { message: "That didn't save. Try again, or tell IT this code:", showCode: true };
  }
}

/** app/api/test-sessions — the codes a Start / Close session can come back with. */
export function sessionErrorCopy(code: string): ErrorCopy {
  switch (code) {
    case "not_published":
      return { message: "Publish the assessment before starting a session.", showCode: false };
    case "invalid_body":
      return { message: "Check the session's length and who it's for, then try again.", showCode: false };
    case "scope_conflict":
      return { message: "Choose either one section or picked students, not both.", showCode: false };
    case "section_not_taught":
      return { message: "That section isn't on your class list any more. Pick another.", showCode: false };
    case "students_not_taught":
      return { message: "One of those students isn't in your sections any more. Check the list.", showCode: false };
    case "code_unavailable":
      return { message: "Couldn't get a free session code. Try again.", showCode: false };
    case "not_found":
      return { message: "That session isn't available any more. Refresh the list.", showCode: false };
    case "network":
      return { message: "Couldn't reach the server. Check your connection and try again.", showCode: false };
    default:
      return { message: "That didn't work. Try again, or tell IT this code:", showCode: true };
  }
}

/** app/api/students/[id]/accommodations and the overrides routes. */
export function accommodationErrorCopy(code: string): ErrorCopy {
  switch (code) {
    case "already_exists":
      return {
        message: "This student already has that support for that subject. Edit the existing row instead.",
        showCode: false,
      };
    case "tide_row_not_deletable":
      return {
        message: "Settings that came from TIDE can't be removed here — set the value to Off instead.",
        showCode: false,
      };
    case "invalid_body":
      return { message: "Pick a subject, a tool and a value.", showCode: false };
    case "not_found":
    case "forbidden":
    case "invalid_id":
      return { message: "That record isn't available any more. Reload the page.", showCode: false };
    case "network":
      return { message: "Couldn't reach the server. Check your connection and try again.", showCode: false };
    default:
      return { message: "That didn't save. Try again, or tell IT this code:", showCode: true };
  }
}

/** app/api/accommodations/import — the TIDE xlsx upload. */
export function tideImportErrorCopy(code: string): ErrorCopy {
  switch (code) {
    case "missing_file":
      return { message: "Choose the TIDE export first.", showCode: false };
    case "file_too_large":
      return { message: "That file is too large to import.", showCode: false };
    case "unsupported_mime":
    case "expected_multipart":
    case "form_parse_failed":
      return { message: "That isn't an Excel (.xlsx) file. Export Student Settings from TIDE and try again.", showCode: false };
    case "import_failed":
      return {
        message: "The file was read but couldn't be imported — it may not be the Student Settings export.",
        showCode: true,
      };
    case "network":
      return { message: "Couldn't reach the server. Check your connection and try again.", showCode: false };
    default:
      return { message: "The import didn't finish. Try again, or tell IT this code:", showCode: true };
  }
}
