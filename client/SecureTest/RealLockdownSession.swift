import AutomaticAssessmentConfiguration
import Foundation
import Security
import SecureTestCore

/// AAC-2a: the real `AEAssessmentSession` behind `AssessmentLockdown.Session`.
///
/// This file is the ONLY place the client touches
/// `AutomaticAssessmentConfiguration` — the framework can be linked solely by
/// the entitled app target, which is why the lifecycle machine lives in
/// `SecureTestCore` behind the `Session` protocol and this adapter stays thin:
/// four delegate callbacks mapped to `SessionEvent`, nothing else. Every rule
/// that keeps a student able to leave (watchdog, escalation, confirmed
/// teardown, the exit controls) is upstream in `AssessmentLockdown` and is
/// exactly what PoC-A verified inside a real session on 2026-08-26
/// (poc-a-aac-capture/RESULTS.md finding #12).
///
/// AAC-2b: the configuration starts from the restrictive default and opens
/// only what the attempt's `LockdownConfigurationPlan` says — the mapping
/// itself (which catalog ids open which knobs, and what deliberately stays
/// closed) lives with that type in SecureTestCore, where it is unit-tested;
/// this adapter applies it property-for-property. No secondary apps
/// (`permissive_mode` is its own future slice).
final class RealLockdownSession: NSObject, AssessmentLockdown.Session, AEAssessmentSessionDelegate {

    var onEvent: ((AssessmentLockdown.SessionEvent) -> Void)?
    private var session: AEAssessmentSession?
    private let plan: LockdownConfigurationPlan

    init(plan: LockdownConfigurationPlan) {
        self.plan = plan
    }

    /// Whether the running binary was signed with the AAC entitlement. The
    /// selection between this adapter and `SimulatedLockdownSession` hangs on
    /// this — a begin() attempted without the entitlement fails, and the
    /// simulation is the designed fallback, not the error path.
    static var binaryHasEntitlement: Bool {
        guard let task = SecTaskCreateFromSelf(nil) else { return false }
        let value = SecTaskCopyValueForEntitlement(
            task,
            "com.apple.developer.automatic-assessment-configuration" as CFString,
            nil
        )
        return (value as? Bool) == true
    }

    func begin() {
        let config = AEAssessmentConfiguration()
        config.allowsSpellCheck = plan.allowsSpellCheck
        config.allowsPredictiveKeyboard = plan.allowsPredictiveKeyboard
        config.allowsAccessibilityLiveCaptions = plan.allowsLiveCaptions
        // KNOWN PLATFORM GAP (2026-08-27 real-session run): dictation stays
        // LIVE inside a session on macOS 26.6.2 and AAC offers no knob for it
        // here — `allowsDictation` is API_UNAVAILABLE(macos) in the framework
        // headers (iOS-only). Speech-to-text into an essay is a construct
        // hole this configuration cannot close; the mitigation is a device
        // profile (Jamf) disabling dictation on the test fleet, per-student
        // exceptions where speech-to-text is an entitled accommodation. See
        // docs/phase-7-slices.md "Hand-run findings".
        let session = AEAssessmentSession(configuration: config)
        session.delegate = self
        self.session = session
        session.begin()
    }

    func end() {
        session?.end()
    }

    // MARK: AEAssessmentSessionDelegate

    func assessmentSessionDidBegin(_ session: AEAssessmentSession) {
        onEvent?(.didBegin)
    }

    func assessmentSession(_ session: AEAssessmentSession, failedToBeginWithError error: Error) {
        self.session = nil
        onEvent?(.failedToBegin(Self.describe(error)))
    }

    func assessmentSession(_ session: AEAssessmentSession, wasInterruptedWithError error: Error) {
        self.session = nil
        onEvent?(.interrupted(Self.describe(error)))
    }

    func assessmentSessionDidEnd(_ session: AEAssessmentSession) {
        self.session = nil
        onEvent?(.didEnd)
    }

    /// The AEErrors.h decoder ring PoC-A established — a bare code number in a
    /// student-facing incident log helps nobody.
    private static func describe(_ error: Error) -> String {
        let ns = error as NSError
        var text = "\(error.localizedDescription) [domain=\(ns.domain) code=\(ns.code)]"
        if ns.domain == AEAssessmentErrorDomain {
            text += " (per AEErrors.h: 1=Unknown, 2=UnsupportedPlatform,"
                + " 3=MultipleParticipantsNotSupported, 4=ConfigurationUpdatesNotSupported,"
                + " 5=RequiredParticipantsNotAvailable)"
        }
        return text
    }
}
