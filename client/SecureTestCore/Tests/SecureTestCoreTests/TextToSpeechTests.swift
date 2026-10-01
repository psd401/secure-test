import XCTest
@testable import SecureTestCore

/// TTS slice 1 (`docs/speech-tools-design.md`): the accommodation → Speak
/// control mapping, the spoken script and its word-range mapping, the page
/// message boundary and the host → page callbacks. The synthesizer itself is
/// the app target's and is a hand-run row.
final class TextToSpeechTests: XCTestCase {

    // MARK: - Scope (the value mapping)

    func testNoAccommodationIsOff() {
        XCTAssertEqual(TextToSpeechScope(accommodations: [:]), .off)
        XCTAssertFalse(TextToSpeechScope(accommodations: [:]).isEnabled)
    }

    /// TIDE's four values, verbatim from tide-catalog.json.
    func testTideTestContentValues() {
        func scope(_ value: String) -> TextToSpeechScope {
            TextToSpeechScope(accommodations: ["tts_test_content": value])
        }
        XCTAssertEqual(scope("Items"), TextToSpeechScope(items: true, stimuli: false))
        XCTAssertEqual(scope("Stimuli"), TextToSpeechScope(items: false, stimuli: true))
        XCTAssertEqual(scope("Stimuli+Items"), TextToSpeechScope(items: true, stimuli: true))
        XCTAssertEqual(scope("None (Default)"), .off)
    }

    /// A teacher's hand grant ("On", the editors' fallback for a tool with no
    /// TIDE value) or any other enabled value reads as both.
    func testAnyOtherEnabledValueReadsAsBoth() {
        for value in ["On", "on", "Yes", "Stimuli + Items"] {
            XCTAssertEqual(
                TextToSpeechScope(accommodations: ["tts_test_content": value]),
                TextToSpeechScope(items: true, stimuli: true), value)
        }
    }

    func testValuesAreMatchedWithoutCaseOrSurroundingSpace() {
        XCTAssertEqual(
            TextToSpeechScope(accommodations: ["tts_test_content": " items "]),
            TextToSpeechScope(items: true, stimuli: false))
        XCTAssertEqual(
            TextToSpeechScope(accommodations: ["tts_test_content": "STIMULI"]),
            TextToSpeechScope(items: false, stimuli: true))
    }

    /// The server drops these before the bundle is built; a row that slipped
    /// through still cannot switch the tool on.
    func testOffishValuesAreOff() {
        for value in ["", "Off", "off", "None", "none (default)", "Default"] {
            XCTAssertEqual(TextToSpeechScope(accommodations: ["tts_test_content": value]), .off, value)
            XCTAssertEqual(TextToSpeechScope(accommodations: ["tts_for_ela_reading": value]), .off, value)
        }
    }

    /// D-5: ELA reading read-aloud is stimulus read-aloud, unioned.
    func testElaReadingAddsStimuli() {
        XCTAssertEqual(
            TextToSpeechScope(accommodations: ["tts_for_ela_reading": "On"]),
            TextToSpeechScope(items: false, stimuli: true))
        XCTAssertEqual(
            TextToSpeechScope(accommodations: ["tts_test_content": "Items", "tts_for_ela_reading": "On"]),
            TextToSpeechScope(items: true, stimuli: true))
    }

    /// Neither student-response read-aloud (slice 2) nor Spanish (held, D-6)
    /// opens anything in this slice.
    func testOtherSpeechToolsDoNotOpenContentReadAloud() {
        XCTAssertEqual(
            TextToSpeechScope(accommodations: ["tts_student_responses": "On", "tts_spanish": "On", "speech_to_text": "On"]),
            .off)
    }

    func testPageScript() {
        XCTAssertEqual(
            TextToSpeechScope(items: true, stimuli: false).pageScript,
            "const TTS_SCOPE = { items: true, stimuli: false };")
    }

    func testThePageCarriesTheScopeFromTheBundle() {
        let json = #"{"test_id":"t","title":"t","items":[],"accommodations":{"tts_test_content":"Stimuli"}}"#
        let html = AssessmentPage.html(title: "t", bundleJSON: json, katex: .init(css: "", js: "", autoRender: "", missing: []))
        XCTAssertTrue(html.contains("const TTS_SCOPE = { items: false, stimuli: true };"))
        let none = AssessmentPage.html(title: "t", bundleJSON: #"{"test_id":"t","title":"t","items":[]}"#, katex: .init(css: "", js: "", autoRender: "", missing: []))
        XCTAssertTrue(none.contains("const TTS_SCOPE = { items: false, stimuli: false };"))
    }

    // MARK: - Rate

    func testRates() {
        XCTAssertLessThan(SpeechRate.slow.utteranceRate, SpeechRate.normal.utteranceRate)
        XCTAssertLessThan(SpeechRate.normal.utteranceRate, SpeechRate.fast.utteranceRate)
        XCTAssertEqual(SpeechRate.normal.utteranceRate, 0.5)
    }

    // MARK: - Script

    func testTextIsSpokenVerbatimAndMathIsPadded() {
        let script = SpeechScript(
            segments: [.text("Solve "), .math(tex: "x^2"), .text("for x.")],
            mathWords: { _ in "x squared" })
        XCTAssertEqual(script.string, "Solve  x squared for x.")
    }

    func testWordRangesMapBackToTheirSegment() {
        let script = SpeechScript(
            segments: [.text("Solve "), .math(tex: "x^2"), .text("for x.")],
            mathWords: { _ in "x squared" })
        let ns = script.string as NSString
        // "Solve" → segment 0, from 0, 5 long.
        XCTAssertEqual(script.mark(for: ns.range(of: "Solve")), .init(segment: 0, offset: 0, length: 5))
        // Any word of the formula → the whole formula.
        XCTAssertEqual(script.mark(for: ns.range(of: "squared")), .init(segment: 1, offset: 0, length: 0))
        // "for" → segment 2 from 0; "x." later in it.
        XCTAssertEqual(script.mark(for: ns.range(of: "for")), .init(segment: 2, offset: 0, length: 3))
        XCTAssertEqual(script.mark(for: NSRange(location: ns.length - 2, length: 1)), .init(segment: 2, offset: 4, length: 1))
    }

    /// UTF-16 on both sides — an emoji or an accented letter before a word
    /// must not shift the highlight.
    func testOffsetsAreUTF16() {
        let script = SpeechScript(segments: [.text("Café 🙂 menu")])
        let ns = script.string as NSString
        XCTAssertEqual(script.mark(for: ns.range(of: "menu")), .init(segment: 0, offset: 8, length: 4))
    }

    func testARangeRunningPastItsSegmentIsClamped() {
        let script = SpeechScript(segments: [.text("one"), .text("two")])
        XCTAssertEqual(script.mark(for: NSRange(location: 1, length: 10)), .init(segment: 0, offset: 1, length: 2))
    }

    func testPaddingAndNotFoundMapToNothing() {
        let script = SpeechScript(segments: [.math(tex: "1")], mathWords: { _ in "one" })
        XCTAssertNil(script.mark(for: NSRange(location: 0, length: 1)))
        XCTAssertNil(script.mark(for: NSRange(location: NSNotFound, length: 0)))
    }

    func testEmptyScripts() {
        XCTAssertTrue(SpeechScript(segments: []).isEmpty)
        XCTAssertTrue(SpeechScript(segments: [.text("  \n ")]).isEmpty)
        XCTAssertFalse(SpeechScript(segments: [.math(tex: "?")]).isEmpty, "a formula always says something")
    }

    func testTheDefaultMathWordsAreMathSpeech() {
        XCTAssertEqual(SpeechScript(segments: [.math(tex: "x^2")]).string, " x squared ")
    }

    // MARK: - Page messages

    func testSpeakDecodes() throws {
        let body: [String: Any] = [
            "action": "speak", "id": "tts-1:2", "rate": "slow",
            "segments": [["kind": "text", "text": "Hi "], ["kind": "math", "tex": "\\pi"]],
        ]
        XCTAssertEqual(
            try SpeechCommand.decode(fromMessageBody: body),
            .speak(id: "tts-1:2", segments: [.text("Hi "), .math(tex: "\\pi")], rate: .slow))
    }

    func testAnUnknownRateIsNormal() throws {
        let body: [String: Any] = ["action": "speak", "id": "a", "rate": "warp", "segments": [[String: Any]]()]
        XCTAssertEqual(try SpeechCommand.decode(fromMessageBody: body), .speak(id: "a", segments: [], rate: .normal))
        let noRate: [String: Any] = ["action": "speak", "id": "a", "segments": [[String: Any]]()]
        XCTAssertEqual(try SpeechCommand.decode(fromMessageBody: noRate), .speak(id: "a", segments: [], rate: .normal))
    }

    func testControlActionsDecode() throws {
        XCTAssertEqual(try SpeechCommand.decode(fromMessageBody: ["action": "pause"]), .pause)
        XCTAssertEqual(try SpeechCommand.decode(fromMessageBody: ["action": "resume"]), .resume)
        XCTAssertEqual(try SpeechCommand.decode(fromMessageBody: ["action": "stop"]), .stop)
    }

    func testMalformedMessagesAreRefused() {
        XCTAssertThrowsError(try SpeechCommand.decode(fromMessageBody: ["action": "sing"]))
        XCTAssertThrowsError(try SpeechCommand.decode(fromMessageBody: ["nothing": true]))
        XCTAssertThrowsError(try SpeechCommand.decode(fromMessageBody: ["action": "speak", "segments": [[String: Any]]()]))
        XCTAssertThrowsError(try SpeechCommand.decode(fromMessageBody: ["action": "speak", "id": "a"]))
        XCTAssertThrowsError(try SpeechCommand.decode(fromMessageBody: [
            "action": "speak", "id": "a", "segments": [["kind": "html", "text": "<b>"]],
        ]))
        XCTAssertThrowsError(try SpeechCommand.decode(fromMessageBody: [
            "action": "speak", "id": "a", "segments": [["kind": "math"]],
        ]))
    }

    // MARK: - Host → page

    func testCallbacks() {
        XCTAssertEqual(
            SpeechCallback.script(.finished, id: "tts-1:2"),
            #"window.__secureTestSpeech && window.__secureTestSpeech.finished("tts-1:2");"#)
        XCTAssertEqual(
            SpeechCallback.word(id: "tts-1:2", mark: .init(segment: 3, offset: 4, length: 5)),
            #"window.__secureTestSpeech && window.__secureTestSpeech.word("tts-1:2", 3, 4, 5);"#)
    }

    func testTheIdIsEscaped() {
        let js = SpeechCallback.script(.started, id: "a\"); alert(1); (\"")
        XCTAssertEqual(js, #"window.__secureTestSpeech && window.__secureTestSpeech.started("a\"); alert(1); (\"");"#)
    }
}
