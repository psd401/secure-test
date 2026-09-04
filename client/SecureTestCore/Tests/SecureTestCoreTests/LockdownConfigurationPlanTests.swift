import XCTest
@testable import SecureTestCore

/// AAC-2b: the accommodations → session-knob mapping. The adapter applying
/// this to `AEAssessmentConfiguration` is property-for-property, so these
/// tests ARE the mapping's coverage.
final class LockdownConfigurationPlanTests: XCTestCase {

    func testEmptyAccommodationsIsFullyRestrictive() {
        let plan = LockdownConfigurationPlan(accommodations: [:])
        XCTAssertFalse(plan.allowsSpellCheck)
        XCTAssertFalse(plan.allowsPredictiveKeyboard)
        XCTAssertFalse(plan.allowsLiveCaptions)
        XCTAssertEqual(plan, .restrictive)
    }

    func testSpellCheckOpensOnlyTheSpellCheckKnob() {
        let plan = LockdownConfigurationPlan(accommodations: ["spell_check": "on"])
        XCTAssertTrue(plan.allowsSpellCheck)
        XCTAssertFalse(plan.allowsPredictiveKeyboard)
        XCTAssertFalse(plan.allowsLiveCaptions)
    }

    func testWordCompletionOpensOnlyThePredictiveKeyboardKnob() {
        let plan = LockdownConfigurationPlan(accommodations: ["word_completion": "on"])
        XCTAssertFalse(plan.allowsSpellCheck)
        XCTAssertTrue(plan.allowsPredictiveKeyboard)
        XCTAssertFalse(plan.allowsLiveCaptions)
    }

    func testClosedCaptioningOpensOnlyTheLiveCaptionsKnob() {
        let plan = LockdownConfigurationPlan(accommodations: ["closed_captioning": "on"])
        XCTAssertFalse(plan.allowsSpellCheck)
        XCTAssertFalse(plan.allowsPredictiveKeyboard)
        XCTAssertTrue(plan.allowsLiveCaptions)
    }

    /// Presence is the signal — the server resolved the effective set, so the
    /// value string never flips a knob back off.
    func testPresenceCountsWhateverTheValueSays() {
        let plan = LockdownConfigurationPlan(accommodations: ["spell_check": ""])
        XCTAssertTrue(plan.allowsSpellCheck)
    }

    /// Tools that map to in-app rendering (strategy A) or out-of-band support
    /// must not open session knobs.
    func testUnmappedToolsLeaveEverythingClosed() {
        let plan = LockdownConfigurationPlan(accommodations: [
            "color_contrast": "black-on-rose",
            "optional_font": "OpenDyslexic",
            "masking": "on",
            "tts_test_content": "on",
            "speech_to_text": "on",
            "permissive_mode": "on",
        ])
        XCTAssertEqual(plan, .restrictive)
    }

    func testAllThreeTogether() {
        let plan = LockdownConfigurationPlan(accommodations: [
            "spell_check": "on",
            "word_completion": "on",
            "closed_captioning": "on",
        ])
        XCTAssertTrue(plan.allowsSpellCheck)
        XCTAssertTrue(plan.allowsPredictiveKeyboard)
        XCTAssertTrue(plan.allowsLiveCaptions)
    }

    /// The begin() log is how hand-runs audit what a locked session was asked
    /// to permit; every knob must be present by name with its state.
    func testLogDescriptionNamesEveryKnob() {
        let plan = LockdownConfigurationPlan(accommodations: ["spell_check": "on"])
        XCTAssertEqual(
            plan.logDescription,
            "spellCheck=true predictiveKeyboard=false liveCaptions=false"
        )
    }
}
