import JavaScriptCore
import XCTest
@testable import SecureTestCore

/// IF slice 3 (`docs/instant-feedback-design.md`): decoding the submit
/// response's `feedback`, the words the results page says, the page markup,
/// and the page script's Done / Return / Read aloud behaviour (Escape is not Done).
final class InstantFeedbackTests: XCTestCase {
    // Shapes taken from design-tool/test/instant-feedback-api.test.ts and
    // lib/feedback/buildFeedback.ts (the server's own output).
    private let scoreBody = #"""
    {"attempt":{"id":"a1","status":"submitted"},"already_submitted":false,
     "feedback":{"level":"score","earned":3,"max_auto":5,"pending_count":1}}
    """#

    private let rightWrongBody = #"""
    {"attempt":{"id":"a1"},"already_submitted":false,
     "feedback":{"level":"right_wrong","earned":3,"max_auto":5,"pending_count":1,"items":[
       {"item_id":"i1","number":1,"result":"correct","earned":1,"max":1,"your_answer":"Paris"},
       {"item_id":"i2","number":2,"result":"incorrect","earned":0,"max":1,"your_answer":"0.4"},
       {"item_id":"i3","number":3,"result":"partial","earned":2,"max":3,"your_answer":"A, Value: 1\nB, Value: 5\nC, Value: 3"},
       {"item_id":"i4","number":4,"result":"pending","earned":null,"max":null,"your_answer":"My essay"}]}}
    """#

    private let answersBeforeReleaseBody = #"""
    {"feedback":{"level":"answers","earned":3,"max_auto":5,"pending_count":1,
     "answers_note":"Your teacher will go over the correct answers.","items":[
       {"item_id":"i1","number":1,"result":"correct","earned":1,"max":1,"your_answer":"Paris"},
       {"item_id":"i2","number":2,"result":"incorrect","earned":0,"max":1,"your_answer":null}]}}
    """#

    private let answersReleasedBody = #"""
    {"feedback":{"level":"answers","earned":3,"max_auto":5,"pending_count":1,"items":[
       {"item_id":"i1","number":1,"result":"correct","earned":1,"max":1,"your_answer":"Paris"},
       {"item_id":"i2","number":2,"result":"incorrect","earned":0,"max":1,"your_answer":"0.4","correct_answer":"1/2"},
       {"item_id":"i3","number":3,"result":"partial","earned":2,"max":3,"your_answer":"x","correct_answer":"A, Value: 1\nB, Value: 2\nC, Value: 3"},
       {"item_id":"i4","number":4,"result":"pending","earned":null,"max":null,"your_answer":"My essay"}]}}
    """#

    private func decode(_ body: String) -> InstantFeedback? {
        InstantFeedback.fromSubmitResponse(Data(body.utf8))
    }

    // MARK: decode

    func testScoreLevelDecodesTotalsWithNoItems() throws {
        let f = try XCTUnwrap(decode(scoreBody))
        XCTAssertEqual(f.level, .score)
        XCTAssertEqual(f.earned, 3)
        XCTAssertEqual(f.maxAuto, 5)
        XCTAssertEqual(f.pendingCount, 1)
        XCTAssertNil(f.items)
        XCTAssertNil(f.answersNote)
    }

    func testRightWrongDecodesEveryRowInOrder() throws {
        let f = try XCTUnwrap(decode(rightWrongBody))
        XCTAssertEqual(f.level, .rightWrong)
        XCTAssertEqual(f.items?.map(\.result), [.correct, .incorrect, .partial, .pending])
        XCTAssertEqual(f.items?[2].earned, 2)
        XCTAssertEqual(f.items?[2].max, 3)
        XCTAssertEqual(f.items?[2].yourAnswer, "A, Value: 1\nB, Value: 5\nC, Value: 3")
        XCTAssertNil(f.items?[3].earned)
        XCTAssertTrue(f.items?.allSatisfy { $0.correctAnswer == nil } ?? false)
    }

    func testAnswersBeforeReleaseCarriesTheNoteAndNoKey() throws {
        let f = try XCTUnwrap(decode(answersBeforeReleaseBody))
        XCTAssertEqual(f.level, .answers)
        XCTAssertEqual(f.answersNote, "Your teacher will go over the correct answers.")
        XCTAssertNil(f.items?[1].yourAnswer, "an unanswered question is null on the wire")
        XCTAssertNil(f.items?[1].correctAnswer)
    }

    func testAnswersAfterReleaseCarriesTheKeyOnMissedRows() throws {
        let f = try XCTUnwrap(decode(answersReleasedBody))
        XCTAssertEqual(f.items?.map(\.correctAnswer), [nil, "1/2", "A, Value: 1\nB, Value: 2\nC, Value: 3", nil])
        XCTAssertNil(f.answersNote)
    }

    func testAnOlderServerOrFeedbackOffIsNil() {
        XCTAssertNil(decode(#"{"attempt":{"id":"a1"},"already_submitted":false}"#))
        XCTAssertNil(decode(""), "an empty body is no feedback, not a failure")
        XCTAssertNil(decode("not json"))
        XCTAssertNil(decode(#"{"feedback":null}"#))
    }

    func testAnUnknownLevelOrAMissingTotalIsNil() {
        XCTAssertNil(decode(#"{"feedback":{"level":"everything","earned":1,"max_auto":1,"pending_count":0}}"#))
        XCTAssertNil(decode(#"{"feedback":{"level":"score","max_auto":1,"pending_count":0}}"#))
        XCTAssertNil(decode(#"{"feedback":{"level":"score","earned":"3","max_auto":5,"pending_count":0}}"#))
        XCTAssertNil(decode(#"{"feedback":{"level":"score","earned":true,"max_auto":5,"pending_count":0}}"#))
    }

    /// Decided: an unknown result word drops THAT row rather than calling it
    /// "Scored by your teacher" — a claim this build could not back.
    func testAnUnknownResultOrAMissingNumberDropsOnlyThatRow() throws {
        let f = try XCTUnwrap(decode(#"""
        {"feedback":{"level":"right_wrong","earned":1,"max_auto":2,"pending_count":0,"items":[
          {"item_id":"i1","number":1,"result":"correct","earned":1,"max":1,"your_answer":"a"},
          {"item_id":"i2","number":2,"result":"excused","earned":0,"max":1,"your_answer":"b"},
          {"item_id":"i3","result":"incorrect","earned":0,"max":1,"your_answer":"c"},
          "not an object"]}}
        """#))
        XCTAssertEqual(f.items?.map(\.number), [1])
        XCTAssertEqual(f.earned, 1, "the score line stays the server's own total")
    }

    func testAPendingRowNeverCarriesPointsOrAKey() throws {
        let f = try XCTUnwrap(decode(#"""
        {"feedback":{"level":"answers","earned":0,"max_auto":0,"pending_count":1,"items":[
          {"item_id":"i1","number":1,"result":"pending","earned":2,"max":4,"your_answer":"x","correct_answer":"k"}]}}
        """#))
        let row = try XCTUnwrap(f.items?.first)
        XCTAssertNil(row.earned)
        XCTAssertNil(row.max)
        XCTAssertNil(row.correctAnswer)
    }

    func testTheSubmitCallReturnsTheFeedback() async throws {
        let transport = RecordingTransport(body: rightWrongBody)
        let client = APIClient(
            baseURL: URL(string: "https://design.example")!,
            transport: transport,
            tokens: InMemoryTokenStore(token: "t")
        )
        let feedback = try await client.submit(attemptID: "a1")
        XCTAssertEqual(feedback?.level, .rightWrong)
        XCTAssertEqual(transport.sent.first?.url?.path, "/api/attempts/a1/submit")
    }

    func testTheSubmitCallStillSucceedsWithAnUnreadableFeedbackObject() async throws {
        let transport = RecordingTransport(body: #"{"attempt":{"id":"a1"},"feedback":{"level":42}}"#)
        let client = APIClient(
            baseURL: URL(string: "https://design.example")!,
            transport: transport,
            tokens: InMemoryTokenStore(token: "t")
        )
        let feedback = try await client.submit(attemptID: "a1")
        XCTAssertNil(feedback)
    }

    // MARK: presentation

    func testScoreLineAndPendingLineMatchD1() throws {
        let p = InstantFeedbackPresentation(try XCTUnwrap(decode(scoreBody)))
        XCTAssertEqual(p.scoreLine, "You scored 3 of 5 on the questions scored right away.")
        XCTAssertEqual(p.pendingLine, "Your teacher will score 1 more question.")
        XCTAssertTrue(p.rows.isEmpty)
    }

    func testPendingLinePluralAndAbsence() {
        func line(_ pending: Int, max: Double = 18) -> String? {
            InstantFeedbackPresentation(InstantFeedback(
                level: .score, earned: 14, maxAuto: max, pendingCount: pending, items: nil, answersNote: nil
            )).pendingLine
        }
        XCTAssertEqual(line(2), "Your teacher will score 2 more questions.")
        XCTAssertNil(line(0))
    }

    func testATestWithNothingScoredRightAwaySaysSo() {
        let p = InstantFeedbackPresentation(InstantFeedback(
            level: .score, earned: 0, maxAuto: 0, pendingCount: 3, items: nil, answersNote: nil
        ))
        XCTAssertEqual(p.scoreLine, "None of the questions on this test are scored right away.")
        XCTAssertEqual(p.pendingLine, "Your teacher will score all 3 questions.")
    }

    func testRowHeadingsUseTheResultWords() throws {
        let p = InstantFeedbackPresentation(try XCTUnwrap(decode(rightWrongBody)))
        XCTAssertEqual(p.rows.map(\.heading), [
            "Question 1 — Right",
            "Question 2 — Not right",
            "Question 3 — Partly right (2 of 3)",
            "Question 4 — Scored by your teacher",
        ])
    }

    func testFractionalPointsReadCleanly() {
        XCTAssertEqual(InstantFeedbackPresentation.points(14), "14")
        XCTAssertEqual(InstantFeedbackPresentation.points(1.5), "1.5")
        XCTAssertEqual(InstantFeedbackPresentation.points(2.0 / 3.0), "0.67")
    }

    func testRowsAreOrderedByQuestionNumber() {
        let item = { (n: Int) in
            InstantFeedback.Item(itemID: "i\(n)", number: n, result: .correct, earned: 1, max: 1, yourAnswer: "a", correctAnswer: nil)
        }
        let p = InstantFeedbackPresentation(InstantFeedback(
            level: .rightWrong, earned: 2, maxAuto: 2, pendingCount: 0, items: [item(2), item(1)], answersNote: nil
        ))
        XCTAssertEqual(p.rows.map(\.number), [1, 2])
    }

    // MARK: page markup

    private let bare = KatexBundle.Assets(css: "", js: "", autoRender: "", missing: [])

    func testThePageReadsInOrderHeadingScorePendingNoteRows() throws {
        let html = InstantFeedbackPage.html(try XCTUnwrap(decode(answersBeforeReleaseBody)), katex: bare)
        let order = ["<h1", "feedback-score", "feedback-pending", "feedback-note", "role=\"list\"", "feedback-done"]
        var last = html.startIndex
        for marker in order {
            let range = try XCTUnwrap(html.range(of: marker, range: last..<html.endIndex), "missing \(marker) in order")
            last = range.upperBound
        }
        XCTAssertTrue(html.contains(">Your results</h1>"))
        XCTAssertTrue(html.contains("Your teacher will go over the correct answers."))
        XCTAssertTrue(html.contains("(no answer)"))
        XCTAssertFalse(html.contains("Correct answer:"))
    }

    func testScoreLevelHasNoList() throws {
        let html = InstantFeedbackPage.html(try XCTUnwrap(decode(scoreBody)), katex: bare)
        XCTAssertFalse(html.contains("<ol"))
        XCTAssertTrue(html.contains("You scored 3 of 5 on the questions scored right away."))
    }

    func testTheKeyLineAppearsOnlyWhereTheServerSentOne() throws {
        let html = InstantFeedbackPage.html(try XCTUnwrap(decode(answersReleasedBody)), katex: bare)
        XCTAssertEqual(html.components(separatedBy: "Correct answer:").count - 1, 2)
        XCTAssertTrue(html.contains("1/2"))
    }

    func testTheResultIsWordsAndTheMarkIsHiddenFromVoiceOver() throws {
        let html = InstantFeedbackPage.html(try XCTUnwrap(decode(rightWrongBody)), katex: bare)
        XCTAssertTrue(html.contains("<span class=\"feedback-mark\" aria-hidden=\"true\">✓</span>Question 1 — Right</p>"))
        XCTAssertTrue(html.contains("class=\"feedback-item result-incorrect\""))
    }

    func testAuthoredTextIsEscapedNeverParsedAsMarkup() {
        let feedback = InstantFeedback(
            level: .answers, earned: 0, maxAuto: 1, pendingCount: 0,
            items: [InstantFeedback.Item(
                itemID: "i1", number: 1, result: .incorrect, earned: 0, max: 1,
                yourAnswer: "<img src=x onerror=alert(1)>",
                correctAnswer: "</p><script>bad()</script>"
            )],
            answersNote: nil
        )
        let html = InstantFeedbackPage.html(feedback, katex: bare)
        XCTAssertFalse(html.contains("<img src=x"))
        XCTAssertFalse(html.contains("<script>bad()"))
        XCTAssertTrue(html.contains("&lt;img src=x onerror=alert(1)&gt;"))
    }

    func testDoneIsReachableByTabWithKeyboardNavigationOff() throws {
        let html = InstantFeedbackPage.html(try XCTUnwrap(decode(scoreBody)), katex: bare)
        XCTAssertTrue(html.contains("id=\"feedback-done\" class=\"feedback-done\" tabindex=\"0\">Done</button>"))
    }

    func testReadAloudButtonFollowsTheTTSGrant() throws {
        let f = try XCTUnwrap(decode(scoreBody))
        XCTAssertFalse(InstantFeedbackPage.html(f, katex: bare).contains("feedback-read\""))
        let granted = InstantFeedbackPage.html(f, accommodations: ["tts_test_content": "Items"], katex: bare)
        XCTAssertTrue(granted.contains("id=\"feedback-read\""))
        let responses = InstantFeedbackPage.html(f, accommodations: ["tts_student_responses": "On"], katex: bare)
        XCTAssertTrue(responses.contains("id=\"feedback-read\""))
    }

    func testContrastFontAndZoomApplyAsOnTheTest() throws {
        let f = try XCTUnwrap(decode(scoreBody))
        let plain = PageAccommodations.rootAttributes([:])
        XCTAssertTrue(plain.isEmpty)
        let map = ["color_contrast": PageAccommodations.contrastSets.last!.value, "zoom": PageAccommodations.zoomLevels.last!.value]
        let attributes = PageAccommodations.rootAttributes(map)
        XCTAssertFalse(attributes.isEmpty)
        let html = InstantFeedbackPage.html(f, accommodations: map, katex: bare)
        for (name, value) in attributes {
            XCTAssertTrue(html.contains("\(name)=\"\(HTMLEscape.text(value))\""), "missing \(name)")
        }
        XCTAssertTrue(html.contains(PageShell.contentSecurityPolicy))
    }

    func testThePageStylesReadTokensOnly() {
        XCTAssertNil(InstantFeedbackPage.styles.range(of: #"#[0-9a-fA-F]{3,6}\b"#, options: .regularExpression),
                     "a literal colour would ignore the contrast sets")
    }

    func testThePageCarriesTheTestsOwnMathPass() throws {
        let html = InstantFeedbackPage.html(try XCTUnwrap(decode(scoreBody)), katex: bare)
        XCTAssertTrue(html.contains(AssessmentPage.mathPassFunctions))
        XCTAssertTrue(AssessmentPage.rendererScript.contains(AssessmentPage.mathPassFunctions),
                      "the test page and the results page share one copy")
    }

    // MARK: page script

    /// A minimal DOM: the three elements the script looks up, a keydown
    /// listener slot, and the two message channels.
    private func runScript(withReadButton: Bool) throws -> JSContext {
        let context = try XCTUnwrap(JSContext())
        var thrown: String?
        context.exceptionHandler = { _, e in thrown = e?.toString() }
        context.evaluateScript(#"""
        var __home = [], __tts = [], __keydown = null, __focused = null;
        function el(tag, id) {
          return { localName: tag, nodeType: 1, id: id, childNodes: [], textContent: '',
            getAttribute: function (n) { return this.attrs ? this.attrs[n] : null; },
            focus: function () { __focused = this; } };
        }
        function text(t) { return { nodeType: 3, textContent: t }; }
        var heading = el('h1', 'feedback-heading'); heading.childNodes = [text('Your results')];
        var score = el('p'); score.childNodes = [text('You scored 1 of 2 on the questions scored right away.')];
        var mark = el('span'); mark.attrs = { 'aria-hidden': 'true' }; mark.childNodes = [text('✓')];
        var formula = el('span'); formula.__tex = '\\frac{1}{2}';
        var row = el('p'); row.childNodes = [mark, text('Question 1 — Right')];
        var answer = el('p'); answer.childNodes = [text('Your answer: '), formula];
        var li = el('li'); li.childNodes = [row, answer];
        var done = el('button', 'feedback-done'); done.childNodes = [text('Done')];
        var read = el('button', 'feedback-read'); read.childNodes = [text('Read aloud')];
        var main = el('main', 'feedback'); main.childNodes = [heading, score, li, done];
        var byId = { 'feedback': main, 'feedback-heading': heading, 'feedback-done': done };
        if (WITH_READ) byId['feedback-read'] = read;
        var document = {
          activeElement: null,
          getElementById: function (id) { return byId[id] || null; },
          addEventListener: function (type, fn) { if (type === 'keydown') __keydown = fn; }
        };
        var window = { webkit: { messageHandlers: {
          home: { postMessage: function (m) { __home.push(m); } },
          tts: { postMessage: function (m) { __tts.push(m); } }
        } } };
        var console = { log: function () {} };
        """#.replacingOccurrences(of: "WITH_READ", with: withReadButton ? "true" : "false"))
        context.evaluateScript(AssessmentPage.mathPassFunctions)
        context.evaluateScript(InstantFeedbackPage.script)
        if let thrown { throw NSError(domain: "js", code: 1, userInfo: [NSLocalizedDescriptionKey: thrown]) }
        return context
    }

    func testFocusStartsOnTheHeading() throws {
        let c = try runScript(withReadButton: false)
        XCTAssertEqual(c.evaluateScript("__focused && __focused.id")?.toString(), "feedback-heading")
    }

    func testDoneAndReturnEachGoHomeOnceEscapeDoesNot() throws {
        let c = try runScript(withReadButton: false)
        c.evaluateScript("done.onclick();")
        XCTAssertEqual(c.evaluateScript("__home.length")?.toInt32(), 1)
        c.evaluateScript("__keydown({ key: 'Enter', preventDefault: function () {} });")
        XCTAssertEqual(c.evaluateScript("__home.length")?.toInt32(), 1, "once only")

        let r = try runScript(withReadButton: false)
        r.evaluateScript("__keydown({ key: 'Enter', preventDefault: function () {} });")
        XCTAssertEqual(r.evaluateScript("__home.length")?.toInt32(), 1)

        let e = try runScript(withReadButton: false)
        e.evaluateScript("__keydown({ key: 'Escape', preventDefault: function () {} });")
        XCTAssertEqual(e.evaluateScript("__home.length")?.toInt32(), 0, "Escape is not Done (IF-2)")

        let other = try runScript(withReadButton: false)
        other.evaluateScript("__keydown({ key: 'a', preventDefault: function () {} });")
        XCTAssertEqual(other.evaluateScript("__home.length")?.toInt32(), 0)
    }

    func testReturnOnTheReadAloudButtonDoesNotLeave() throws {
        let c = try runScript(withReadButton: true)
        c.evaluateScript("document.activeElement = read; __keydown({ key: 'Enter', preventDefault: function () {} });")
        XCTAssertEqual(c.evaluateScript("__home.length")?.toInt32(), 0)
    }

    func testReadAloudSpeaksTheResultsAsSegmentsTheHostAccepts() throws {
        let c = try runScript(withReadButton: true)
        c.evaluateScript("read.onclick();")
        let json = try XCTUnwrap(c.evaluateScript("JSON.stringify(__tts[0])")?.toString())
        let body = try JSONSerialization.jsonObject(with: Data(json.utf8))
        guard case .speak(let id, let segments, _) = try SpeechCommand.decode(fromMessageBody: body) else {
            return XCTFail("not a speak command")
        }
        XCTAssertEqual(id, "feedback")
        XCTAssertTrue(segments.contains(.math(tex: "\\frac{1}{2}")))
        let spoken = SpeechScript(segments: segments, mathWords: { _ in "one half" }).string
        XCTAssertTrue(spoken.contains("Your results. You scored 1 of 2"), spoken)
        XCTAssertTrue(spoken.contains("Question 1 — Right. Your answer:"), spoken)
        XCTAssertFalse(spoken.contains("✓"), "the decorative mark is not read")
        XCTAssertFalse(spoken.contains("Done"), "buttons are not read")
        XCTAssertEqual(c.evaluateScript("read.textContent")?.toString(), "Stop reading")
        c.evaluateScript("window.__secureTestSpeech.finished('feedback');")
        XCTAssertEqual(c.evaluateScript("read.textContent")?.toString(), "Read aloud")
    }
}
