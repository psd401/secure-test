import XCTest
@testable import SecureTestCore

/// STT slice 3 (`docs/speech-tools-design.md`): the page half of "Speak my
/// answer" — drawn only when the host's pre-flight said ready, what it sends on
/// the `stt` channel, how a final phrase reaches the field (through the field's
/// own input path, so autosave behaves as for typing), one field at a time,
/// no listening while read-aloud speaks, and the stops.
///
/// What this cannot prove: the microphone, the recognizer, any prompt, or the
/// listening state's colours in WebKit — hand-run rows, two of them in a real
/// AAC session.
final class RendererSpeechToTextTests: XCTestCase {
    private static let bundle = #"""
    {
      "test_id": "stt", "title": "STT",
      "items": [
        { "type": "short_text", "id": "st", "stem": "Name it." },
        { "type": "essay", "id": "es", "stem": "Explain." },
        { "type": "table", "id": "tb", "stem": "Record.", "corner": "",
          "columns": [ { "id": "c1", "label": "Mass" } ], "rows": [ { "id": "r1", "label": "Trial 1" } ] }
      ],
      "item_sets": [
        { "id": "set", "stimulus": "Use your outline.", "layout": "inline", "item_ids": ["es"],
          "inline_item_id": "outline", "inline_text": "", "source_missing": true }
      ]
    }
    """#

    private func harness(_ state: String?, tts: String = "{ items: false, stimuli: false, responses: false }",
                         paged: Bool = false) throws -> RendererHarness {
        var json = Self.bundle
        if paged {
            json = json.replacingOccurrences(of: #""test_id": "stt","#, with: #""layout": "paged", "test_id": "stt","#)
        }
        var prelude = "var TTS_SCOPE = \(tts);\n"
        if let state { prelude += "var STT_STATE = '\(state)';\n" }
        return try RendererHarness(bundleJSON: json, prelude: prelude)
    }

    private let short = "__first('.short-text', __item(0))"
    private let essay = "__first('.essay', __item(1))"
    private func toggle(_ container: String) -> String { "__first('.stt-toggle', \(container))" }

    private func actions(_ h: RendererHarness) throws -> [String?] {
        try h.postedDictation().map { $0["action"] as? String }
    }

    // MARK: - Drawn only when ready

    func testReadyDrawsAControlUnderShortTextEssayAndOutlineButNotTables() throws {
        let h = try harness("ready")
        XCTAssertEqual(try h.int("__count('.stt-toggle')"), 3)
        XCTAssertEqual(try h.int("__count('.stt-toggle', __item(0))"), 1)
        XCTAssertEqual(try h.int("__count('.stt-toggle', __item(1))"), 1)
        XCTAssertEqual(try h.int("__count('.stt-toggle', __first('.outline-inline'))"), 1)
        XCTAssertEqual(try h.int("__count('.stt-toggle', __item(2))"), 0, "tables are not in v1")
        XCTAssertEqual(try h.string("\(toggle("__item(0)")).textContent"), "Speak my answer")
        XCTAssertEqual(try h.string("\(toggle("__item(0)")).getAttribute('tabindex')"), "0")
        XCTAssertEqual(try h.int("__count('.stt-notice')"), 0)
    }

    func testOffAndAbsentDrawNothing() throws {
        for state in ["off", nil] {
            let h = try harness(state)
            XCTAssertEqual(try h.int("__count('.stt-toggle')"), 0)
            XCTAssertEqual(try h.int("__count('.stt-notice')"), 0)
        }
    }

    func testUnavailableDrawsNoControlAndOneNotice() throws {
        let h = try harness("unavailable")
        XCTAssertEqual(try h.int("__count('.stt-toggle')"), 0)
        XCTAssertEqual(try h.int("__count('.stt-notice')"), 1)
        XCTAssertEqual(
            try h.string("__first('.stt-notice').textContent"),
            "Speech-to-text isn\u{2019}t available on this Mac \u{2014} tell your teacher.")
    }

    // MARK: - Listening

    func testListenSendsTheCaretContextAndShowsTheListeningState() throws {
        let h = try harness("ready")
        try h.eval("\(short).value = 'The answer is '; \(short).setSelectionRange(14, 14);")
        try h.eval("\(toggle("__item(0)")).onclick()")
        let sent = try h.postedDictation()
        XCTAssertEqual(sent.count, 1)
        XCTAssertEqual(sent[0]["action"] as? String, "listen")
        XCTAssertEqual(sent[0]["before"] as? String, "The answer is ")
        XCTAssertEqual(sent[0]["after"] as? String, "")
        XCTAssertEqual(sent[0]["single_line"] as? Bool, true)
        XCTAssertEqual(try h.string("\(toggle("__item(0)")).textContent"), "Stop listening")
        XCTAssertEqual(try h.string("\(toggle("__item(0)")).getAttribute('aria-pressed')"), "true")
        XCTAssertTrue(try h.bool("(' ' + \(short).className + ' ').indexOf(' stt-listening ') !== -1"))
        // The essay is multi-line.
        try h.eval("\(toggle("__item(1)")).onclick()")
        XCTAssertEqual(try h.postedDictation().last?["single_line"] as? Bool, false)
    }

    func testAPointerPressKeepsFocusInTheField() throws {
        let h = try harness("ready")
        XCTAssertTrue(try h.bool("""
        (function () { var d = false; \(toggle("__item(0)")).onpointerdown({ preventDefault: function () { d = true; } }); return d; })()
        """))
    }

    func testHearingShowsVolatileTextAndClears() throws {
        let h = try harness("ready")
        try h.eval("\(toggle("__item(1)")).onclick()")
        let id = try XCTUnwrap(try h.postedDictation().last?["id"] as? String)
        try h.eval("window.__secureTestDictation.hearing('\(id)', 'the cat')")
        XCTAssertEqual(try h.string("__first('.stt-hearing', __item(1)).textContent"), "Hearing: the cat")
        XCTAssertFalse(try h.bool("__first('.stt-hearing', __item(1)).hidden"))
        try h.eval("window.__secureTestDictation.hearing('\(id)', '')")
        XCTAssertEqual(try h.string("__first('.stt-hearing', __item(1)).textContent"), "")
    }

    /// The final phrase goes in at the caret, replacing a selection, and the
    /// field's own input path runs — the word count updates and the autosave
    /// is scheduled exactly as for typing.
    func testAFinalPhraseIsInsertedThroughTheInputPath() throws {
        let h = try harness("ready")
        try h.eval("\(essay).value = 'Start XX end'; \(essay).setSelectionRange(6, 8);")
        try h.eval("\(toggle("__item(1)")).onclick()")
        let id = try XCTUnwrap(try h.postedDictation().last?["id"] as? String)
        XCTAssertEqual(try h.eval("__pendingTimers()").toInt32(), 0)
        try h.eval("window.__secureTestDictation.insert('\(id)', 'middle')")
        XCTAssertEqual(try h.string("\(essay).value"), "Start middle end")
        try h.eval("window.__secureTestDictation.insert('\(id)', ' again')")
        XCTAssertEqual(try h.string("\(essay).value"), "Start middle again end")
        XCTAssertEqual(try h.int("\(essay).selectionStart"), 18)
        XCTAssertGreaterThan(try h.eval("__pendingTimers()").toInt32(), 0, "autosave scheduled as for typing")
        XCTAssertEqual(try actions(h), ["listen"], "an insertion is not typing — still listening")
        // The autosave posts the dictated text.
        try h.eval("__fireTimers()")
        let posted = try h.postedMessages()
        XCTAssertEqual((posted.last?["response"] as? [String: Any])?["text"] as? String, "Start middle again end")
    }

    func testShortTextPreviewFollowsADictatedPhrase() throws {
        let h = try harness("ready")
        try h.eval("\(toggle("__item(0)")).onclick()")
        let id = try XCTUnwrap(try h.postedDictation().last?["id"] as? String)
        try h.eval("window.__secureTestDictation.insert('\(id)', 'Mitochondria')")
        XCTAssertEqual(try h.string("\(short).value"), "Mitochondria")
    }

    func testStopSavesAndALateFinalPhraseStillLands() throws {
        let h = try harness("ready")
        try h.eval("\(toggle("__item(1)")).onclick()")
        let id = try XCTUnwrap(try h.postedDictation().last?["id"] as? String)
        try h.eval("window.__secureTestDictation.insert('\(id)', 'One')")
        try h.eval("\(toggle("__item(1)")).onclick()")
        XCTAssertEqual(try actions(h), ["listen", "stop"])
        XCTAssertEqual(try h.string("\(toggle("__item(1)")).textContent"), "Speak my answer")
        XCTAssertEqual(try h.postedMessages().count, 1, "stopping saves what was dictated")
        // The recognizer finalizes after Stop; that phrase still lands.
        try h.eval("window.__secureTestDictation.insert('\(id)', ' two.')")
        XCTAssertEqual(try h.string("\(essay).value"), "One two.")
        try h.eval("window.__secureTestDictation.stopped('\(id)', 'pressed')")
        try h.eval("window.__secureTestDictation.insert('\(id)', ' three')")
        XCTAssertEqual(try h.string("\(essay).value"), "One two.", "nothing after the host said stopped")
    }

    func testAHostStopResetsTheControl() throws {
        let h = try harness("ready")
        try h.eval("\(toggle("__item(1)")).onclick()")
        let id = try XCTUnwrap(try h.postedDictation().last?["id"] as? String)
        try h.eval("window.__secureTestDictation.stopped('\(id)', 'silence')")
        XCTAssertEqual(try h.string("\(toggle("__item(1)")).textContent"), "Speak my answer")
        XCTAssertEqual(try actions(h), ["listen"], "the page does not echo a stop the host made")
    }

    // MARK: - One at a time, and never with read-aloud

    func testStartingAnotherFieldStopsTheFirst() throws {
        let h = try harness("ready")
        try h.eval("\(toggle("__item(0)")).onclick()")
        let first = try XCTUnwrap(try h.postedDictation().last?["id"] as? String)
        try h.eval("\(toggle("__item(1)")).onclick()")
        XCTAssertEqual(try actions(h), ["listen", "stop", "listen"])
        XCTAssertEqual(try h.string("\(toggle("__item(0)")).textContent"), "Speak my answer")
        XCTAssertEqual(try h.string("\(toggle("__item(1)")).textContent"), "Stop listening")
        // The old field's live line does not come back.
        try h.eval("window.__secureTestDictation.hearing('\(first)', 'stale')")
        XCTAssertEqual(try h.string("__first('.stt-hearing', __item(0)).textContent"), "")
    }

    func testListeningStopsReadAloudAndReadAloudStopsListening() throws {
        let h = try harness("ready", tts: "{ items: true, stimuli: false, responses: true }")
        try h.eval("__first('.tts-play', __item(0)).onclick()")
        try h.eval("\(toggle("__item(1)")).onclick()")
        XCTAssertEqual(try h.postedSpeech().map { $0["action"] as? String }, ["speak", "stop"])
        try h.eval("__first('.tts-play', __item(0)).onclick()")
        XCTAssertEqual(try actions(h), ["listen", "stop"])
    }

    // MARK: - Stops

    func testTypingInTheListeningFieldStopsIt() throws {
        let h = try harness("ready")
        try h.eval("\(toggle("__item(1)")).onclick()")
        try h.eval("\(essay).value = 'typed'; \(essay).oninput();")
        XCTAssertEqual(try actions(h), ["listen", "stop"])
    }

    func testTypingElsewhereDoesNotStopIt() throws {
        let h = try harness("ready")
        try h.eval("\(toggle("__item(1)")).onclick()")
        try h.eval("\(short).value = 'x'; \(short).oninput();")
        XCTAssertEqual(try actions(h), ["listen"])
    }

    func testAPageTurnStops() throws {
        let h = try harness("ready", paged: true)
        try h.eval("\(toggle("__item(0)")).onclick()")
        try h.eval("__first('.pager-next').onclick()")
        XCTAssertEqual(try actions(h), ["listen", "stop"])
    }

    func testFinishStops() throws {
        let h = try harness("ready")
        try h.eval("\(toggle("__item(0)")).onclick()")
        try h.eval("__first('button', __first('.finish')).onclick()")
        XCTAssertEqual(try actions(h), ["listen", "stop"])
        XCTAssertEqual(try h.postedSubmits().count, 1)
    }
}
