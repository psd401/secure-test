import XCTest
@testable import SecureTestCore

/// STT slice 3 (`docs/speech-tools-design.md`): the grant, the pre-flight's
/// outcome, the transcript → insertion rules, the auto-stop and the `stt`
/// channel both ways. The microphone and the recognizer are the app target's
/// and are hand-run rows (a real AAC session among them).
final class SpeechToTextTests: XCTestCase {

    // MARK: - Grant

    func testGrant() {
        XCTAssertTrue(SpeechToText.isGranted(["speech_to_text": "On"]))
        XCTAssertTrue(SpeechToText.isGranted(["speech_to_text": " on "]))
        for value in ["Off", "off", "", "None", "None (Default)"] {
            XCTAssertFalse(SpeechToText.isGranted(["speech_to_text": value]), value)
        }
        XCTAssertFalse(SpeechToText.isGranted([:]))
        // The language setting alone is not a grant (and Spanish is held).
        XCTAssertFalse(SpeechToText.isGranted(["speech_to_text_language": "English & Spanish"]))
    }

    // MARK: - Pre-flight outcome

    private var allReady: SpeechToTextPreflight {
        SpeechToTextPreflight(
            microphone: .authorized, recognition: .authorized,
            transcriberAvailable: true, assetsInstalled: true)
    }

    func testEverythingAnsweredYesIsReady() {
        XCTAssertEqual(allReady.availability, .ready)
    }

    func testAnyMissingStepIsUnavailable() {
        var r = allReady; r.microphone = .denied
        XCTAssertEqual(r.availability, .unavailable)
        r = allReady; r.microphone = .notDetermined
        XCTAssertEqual(r.availability, .unavailable, "never start on a prompt nobody answered")
        r = allReady; r.recognition = .restricted
        XCTAssertEqual(r.availability, .unavailable)
        r = allReady; r.transcriberAvailable = false
        XCTAssertEqual(r.availability, .unavailable)
        r = allReady; r.assetsInstalled = false
        XCTAssertEqual(r.availability, .unavailable)
        r = allReady; r.assetsInstalled = nil
        XCTAssertEqual(r.availability, .unavailable, "a step that never answered")
        r = allReady; r.timedOut = true
        XCTAssertEqual(r.availability, .unavailable)
        r = allReady; r.failure = "assets_Error"
        XCTAssertEqual(r.availability, .unavailable)
        XCTAssertEqual(SpeechToTextPreflight(timedOut: true).availability, .unavailable)
    }

    func testLogLine() {
        XCTAssertEqual(
            allReady.logDescription,
            "mic=authorized recognition=authorized transcriber=true assets=true → ready")
        XCTAssertEqual(
            SpeechToTextPreflight(microphone: .denied).logDescription,
            "mic=denied recognition=- transcriber=- assets=- → unavailable")
        XCTAssertEqual(
            SpeechToTextPreflight(timedOut: true).logDescription,
            "mic=- recognition=- transcriber=- assets=- TIMED OUT → unavailable")
    }

    func testPageScript() {
        XCTAssertEqual(SpeechToTextAvailability.ready.pageScript, "const STT_STATE = 'ready';")
        XCTAssertEqual(SpeechToTextAvailability.off.pageScript, "const STT_STATE = 'off';")
    }

    func testThePageCarriesTheState() {
        let katex = KatexBundle.Assets(css: "", js: "", autoRender: "", missing: [])
        let json = #"{"test_id":"t","title":"t","items":[]}"#
        XCTAssertTrue(AssessmentPage.html(title: "t", bundleJSON: json, katex: katex)
            .contains("const STT_STATE = 'off';"))
        XCTAssertTrue(AssessmentPage.html(title: "t", bundleJSON: json, katex: katex, speechToText: .unavailable)
            .contains("const STT_STATE = 'unavailable';"))
    }

    // MARK: - Transcript

    func testVolatileIsOnlyShownAndFinalIsInsertedOnce() {
        var t = DictationTranscript(before: "", after: "", singleLine: false)
        XCTAssertEqual(t.apply(text: "the cat", isFinal: false), .hearing("the cat"))
        XCTAssertEqual(t.apply(text: "the cat sat", isFinal: false), .hearing("the cat sat"))
        XCTAssertEqual(t.apply(text: "the cat sat.", isFinal: true), .insert("The cat sat."))
        XCTAssertEqual(t.before, "The cat sat.")
        XCTAssertEqual(t.apply(text: "It was happy.", isFinal: true), .insert(" It was happy."))
        XCTAssertEqual(t.before, "The cat sat. It was happy.")
    }

    func testAnEmptyFinalClearsTheLineAndInsertsNothing() {
        var t = DictationTranscript(before: "x", after: "", singleLine: false)
        XCTAssertEqual(t.apply(text: "  ", isFinal: true), .hearing(""))
        XCTAssertEqual(t.before, "x")
    }

    func testSingleLineFoldsNewlines() {
        var t = DictationTranscript(before: "", after: "", singleLine: true)
        XCTAssertEqual(t.apply(text: "one\ntwo", isFinal: true), .insert("One two"))
    }

    func testSpacing() {
        // Mid-word context: a space before; mid-sentence keeps the case.
        XCTAssertEqual(DictationTranscript.insertion("and then", before: "I ran", after: ""), " and then")
        XCTAssertEqual(DictationTranscript.insertion("Paris", before: "I went to", after: ""), " Paris")
        // Already a space: none added.
        XCTAssertEqual(DictationTranscript.insertion("and then", before: "I ran ", after: ""), "and then")
        // After an opening bracket or quote: none.
        XCTAssertEqual(DictationTranscript.insertion("note", before: "(", after: ""), "note")
        // A phrase starting with punctuation hugs the text before.
        XCTAssertEqual(DictationTranscript.insertion(", then", before: "first", after: ""), ", then")
        // A word follows the caret: a trailing space.
        XCTAssertEqual(DictationTranscript.insertion("big", before: "the ", after: "d"), "big ")
        XCTAssertEqual(DictationTranscript.insertion("big", before: "the ", after: " "), "big")
        XCTAssertEqual(DictationTranscript.insertion("big", before: "the ", after: "."), "big")
    }

    func testCapitalisation() {
        XCTAssertEqual(DictationTranscript.insertion("hello", before: "", after: ""), "Hello")
        XCTAssertEqual(DictationTranscript.insertion("hello", before: "Done.", after: ""), " Hello")
        XCTAssertEqual(DictationTranscript.insertion("hello", before: "Done? ", after: ""), "Hello")
        XCTAssertEqual(DictationTranscript.insertion("hello", before: "Line\n", after: ""), "Hello")
        XCTAssertEqual(DictationTranscript.insertion("hello", before: "   ", after: ""), "Hello")
        XCTAssertEqual(DictationTranscript.insertion("hello", before: "said", after: ""), " hello")
        XCTAssertEqual(DictationTranscript.insertion("", before: "x", after: "y"), "")
    }

    // MARK: - Auto-stop

    func testTimeouts() {
        let start = Date(timeIntervalSince1970: 1_000)
        XCTAssertNil(DictationTimeout.check(startedAt: start, lastHeardAt: nil, now: start.addingTimeInterval(9)))
        XCTAssertEqual(DictationTimeout.check(startedAt: start, lastHeardAt: nil, now: start.addingTimeInterval(10)), .silence)
        XCTAssertNil(DictationTimeout.check(
            startedAt: start, lastHeardAt: start.addingTimeInterval(50), now: start.addingTimeInterval(59)))
        XCTAssertEqual(DictationTimeout.check(
            startedAt: start, lastHeardAt: start.addingTimeInterval(59), now: start.addingTimeInterval(60)), .maxListen)
        XCTAssertEqual(DictationTimeout.check(
            startedAt: start, lastHeardAt: start.addingTimeInterval(20), now: start.addingTimeInterval(30)), .silence)
    }

    // MARK: - Channel

    func testListenDecodes() throws {
        XCTAssertEqual(
            try DictationCommand.decode(fromMessageBody: [
                "action": "listen", "id": "stt-1", "before": "abc", "after": "d", "single_line": true,
            ]),
            .listen(id: "stt-1", before: "abc", after: "d", singleLine: true))
        XCTAssertEqual(try DictationCommand.decode(fromMessageBody: ["action": "stop"]), .stop)
    }

    /// Context is bounded whatever the page sends: spacing needs a few
    /// characters, and nothing more of the answer should cross the bridge.
    func testContextIsBounded() throws {
        let long = String(repeating: "a", count: 500) + "END"
        guard case .listen(_, let before, let after, let singleLine) = try DictationCommand.decode(
            fromMessageBody: ["action": "listen", "id": "x", "before": long, "after": "xyz"])
        else { return XCTFail("not a listen") }
        XCTAssertEqual(before.count, 16)
        XCTAssertTrue(before.hasSuffix("END"))
        XCTAssertEqual(after, "x")
        XCTAssertFalse(singleLine)
    }

    func testMalformedIsRefused() {
        XCTAssertThrowsError(try DictationCommand.decode(fromMessageBody: ["action": "record"]))
        XCTAssertThrowsError(try DictationCommand.decode(fromMessageBody: ["action": "listen"]))
        XCTAssertThrowsError(try DictationCommand.decode(fromMessageBody: ["id": "x"]))
    }

    func testCallbacks() {
        XCTAssertEqual(
            DictationCallback.insert(id: "stt-1", text: "He said \"hi\"."),
            #"window.__secureTestDictation && window.__secureTestDictation.insert("stt-1", "He said \"hi\".");"#)
        XCTAssertEqual(
            DictationCallback.stopped(id: "stt-1", reason: "silence"),
            #"window.__secureTestDictation && window.__secureTestDictation.stopped("stt-1", "silence");"#)
        XCTAssertEqual(
            DictationCallback.hearing(id: "a", text: "x\u{2028}y"),
            #"window.__secureTestDictation && window.__secureTestDictation.hearing("a", "x\u2028y");"#)
    }
}
