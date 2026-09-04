import Foundation

/// AAC-2b: which of the lockdown session's knobs this attempt's accommodations
/// open, resolved from `DeliveryBundle.accommodations`.
///
/// This is the testable half of the mapping. `AEAssessmentConfiguration` can
/// only be touched by the entitled app target (see `RealLockdownSession`), so
/// the decision of WHAT to allow lives here in the package `swift test` can
/// drive, and the adapter applies it property-for-property with no logic of
/// its own.
///
/// Presence in the map is the signal: the server already resolved the
/// assessment's allowed list, the student's entitlements and any override into
/// the bundle's effective set, so a tool id being present means granted (the
/// same rule `AssessmentPage` uses for `spell_check`). The value string
/// carries per-tool settings (font name, contrast palette) that no session
/// knob needs.
///
/// Only three catalog ids map to session knobs macOS actually offers:
///
///   - `spell_check`        → `allowsSpellCheck` (macOS 15.0)
///   - `word_completion`    → `allowsPredictiveKeyboard` (macOS 15.0)
///   - `closed_captioning`  → `allowsAccessibilityLiveCaptions` (macOS 26.1)
///
/// Deliberately NOT mapped, so the restrictive default stands:
///
///   - `autocorrectMode` stays `[]` — no catalog id means autocorrect; OSPI
///     spell check is squiggles, not silent correction of a student's answer.
///   - `allowsScreenshots` stays false (finding #13: capture is redacted
///     either way; nothing entitles a student to clipboard screenshots).
///   - `allowsKeyboardShortcuts` (Text Replacement) stays false — no catalog
///     entry, and expansion snippets in a constructed response are a construct
///     hole.
///   - `permissive_mode` (secondary AT apps via participant configuration) is
///     its own future slice — blocked on the AT-app bundle id inventory.
///   - `speech_to_text` has no macOS knob at all (`allowsDictation` is
///     iOS-only); the platform gap and its Jamf mitigation are documented in
///     docs/phase-7-slices.md "Hand-run findings".
///   - `tts_*` are strategy A — in-app synthesis, not the OS reader.
public struct LockdownConfigurationPlan: Equatable, Sendable {
    public let allowsSpellCheck: Bool
    public let allowsPredictiveKeyboard: Bool
    public let allowsLiveCaptions: Bool

    /// Everything closed — what an empty accommodations map resolves to, and
    /// the fallback wherever no bundle is in hand yet.
    public static let restrictive = LockdownConfigurationPlan(accommodations: [:])

    public init(accommodations: [String: String]) {
        allowsSpellCheck = accommodations["spell_check"] != nil
        allowsPredictiveKeyboard = accommodations["word_completion"] != nil
        allowsLiveCaptions = accommodations["closed_captioning"] != nil
    }

    /// One auditable line for the begin() log — hand-runs check this against
    /// what the locked session actually permits.
    public var logDescription: String {
        "spellCheck=\(allowsSpellCheck)"
            + " predictiveKeyboard=\(allowsPredictiveKeyboard)"
            + " liveCaptions=\(allowsLiveCaptions)"
    }
}
