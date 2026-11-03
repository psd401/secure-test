import XCTest
@testable import SecureTestCore

/// Revision feedback, the page half (competency assessments, D-16,
/// `docs/competency-assessment-design.md` §Release and results): on an attempt
/// passed back as Needs Revision, the question being revised shows the
/// scorer's per-row feedback in a read-only "Scorer feedback" panel. The
/// server decides what rides (`revision_feedback` on the bundle); the page
/// draws it as text, never posts it, and is unchanged when it is absent or
/// malformed.
///
/// What this cannot prove: how the panel looks in WebKit at each zoom level
/// and contrast set, its layout beside a rich-text essay, or what VoiceOver
/// says — the hand-run rows in `client/MANUAL-CHECKS.md`.
final class RendererRevisionFeedbackTests: XCTestCase {
    private static let mc = "c15585ea-aee6-4c1c-b781-f0c304166720"
    private static let shortText = "16114532-42f8-4c01-b806-ea2bb883694c"
    private static let essay = "7a4b99ad-a4e3-48c1-a950-9e3cc9b61f0f"
    private static let fillBlank = "f770cdcf-7038-421a-a9fd-d398549154ad"

    private func harness(feedback: String?) throws -> RendererHarness {
        var json = try RendererHarness.fixtureJSON()
        if let feedback, let brace = json.firstIndex(of: "{") {
            json.replaceSubrange(brace...brace, with: "{\"revision_feedback\": \(feedback), ")
        }
        return try RendererHarness(bundleJSON: json)
    }

    private func itemIndex(_ id: String) throws -> Int {
        let json = try RendererHarness.fixtureJSON()
        let data = try XCTUnwrap(json.data(using: .utf8))
        let bundle = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let items = try XCTUnwrap(bundle["items"] as? [[String: Any]])
        return try XCTUnwrap(items.firstIndex { ($0["id"] as? String) == id })
    }

    private func panelExpr(_ id: String) throws -> String {
        "__first('.revision-feedback', __item(\(try itemIndex(id))))"
    }

    private static let essayFeedback = """
        { "\(essay)": {
            "criteria": [
              { "name": "Claim", "level_label": "Meets", "rationale": "Clear and arguable." },
              { "name": "Evidence", "level_label": "Approaching" }
            ],
            "note": "Revise the second paragraph."
        } }
        """

    // MARK: - Absent or malformed

    func testAbsentFieldChangesNothing() throws {
        let h = try harness(feedback: nil)
        XCTAssertEqual(try h.int("__count('.revision-feedback')"), 0)
    }

    func testUnknownItemIdsAndMalformedEntriesAreIgnored() throws {
        let h = try harness(feedback: """
            {
              "not-an-item": { "criteria": [ { "name": "Claim", "level_label": "Meets" } ] },
              "\(Self.mc)": { "criteria": [ { "name": 5, "level_label": "Meets" }, { "name": "Claim" }, null ] },
              "\(Self.shortText)": "Meets",
              "\(Self.fillBlank)": { "criteria": "Claim", "note": 7 }
            }
            """)
        XCTAssertEqual(try h.int("__count('.revision-feedback')"), 0)
        // An array in place of the map is ignored too.
        let h2 = try harness(feedback: "[1, 2]")
        XCTAssertEqual(try h2.int("__count('.revision-feedback')"), 0)
    }

    func testAnItemWithoutAnEntryRendersAsBefore() throws {
        let plain = try harness(feedback: nil)
        let h = try harness(feedback: Self.essayFeedback)
        for id in [Self.mc, Self.shortText, Self.fillBlank] {
            let n = try itemIndex(id)
            XCTAssertEqual(try h.int("__count('.revision-feedback', __item(\(n)))"), 0)
            XCTAssertEqual(
                try h.string("__item(\(n)).textContent"),
                try plain.string("__item(\(n)).textContent"),
                "item \(id) changed without an entry"
            )
        }
        XCTAssertEqual(try h.int("__count('.revision-feedback')"), 1)
    }

    // MARK: - The panel

    func testPanelShowsHeadingRowsAndNote() throws {
        let h = try harness(feedback: Self.essayFeedback)
        let panel = try panelExpr(Self.essay)
        XCTAssertEqual(try h.string("__first('.revision-feedback-heading', \(panel)).textContent"), "Scorer feedback")
        XCTAssertEqual(try h.int("__count('.revision-feedback-row', \(panel))"), 2)
        XCTAssertEqual(
            try h.string("__all('.revision-feedback-criterion', \(panel)).map(function (x) { return x.textContent; }).join('|')"),
            "Claim: Meets|Evidence: Approaching"
        )
        // The rationale belongs to its own row; a row without one has none.
        XCTAssertEqual(
            try h.string("__first('.revision-feedback-rationale', __all('.revision-feedback-row', \(panel))[0]).textContent"),
            "Clear and arguable."
        )
        XCTAssertEqual(try h.int("__count('.revision-feedback-rationale', __all('.revision-feedback-row', \(panel))[1])"), 0)
        XCTAssertEqual(try h.string("__first('.revision-feedback-note', \(panel)).textContent"), "Note: Revise the second paragraph.")
    }

    func testPanelSitsBetweenTheStemAndTheAnswer() throws {
        let h = try harness(feedback: Self.essayFeedback)
        let n = try itemIndex(Self.essay)
        XCTAssertTrue(try h.bool("""
            (function () {
              var kids = __item(\(n)).children;
              var at = kids.indexOf(__first('.revision-feedback', __item(\(n))));
              return at > kids.indexOf(__first('.stem', __item(\(n)))) && at < kids.length - 1;
            })()
            """))
    }

    func testNoteOnlyAndRowsOnly() throws {
        let h = try harness(feedback: """
            { "\(Self.mc)": { "criteria": [], "note": "See me." },
              "\(Self.shortText)": { "criteria": [ { "name": "Accuracy", "level_label": "Beginning" } ] } }
            """)
        let mc = try panelExpr(Self.mc)
        XCTAssertEqual(try h.int("__count('ul', \(mc))"), 0)
        XCTAssertEqual(try h.string("__first('.revision-feedback-note', \(mc)).textContent"), "Note: See me.")
        let st = try panelExpr(Self.shortText)
        XCTAssertEqual(try h.int("__count('.revision-feedback-note', \(st))"), 0)
        XCTAssertEqual(try h.int("__count('.revision-feedback-row', \(st))"), 1)
    }

    func testTeacherTextIsInsertedAsTextNeverHTML() throws {
        let h = try harness(feedback: """
            { "\(Self.essay)": {
                "criteria": [ { "name": "<b>Claim</b>", "level_label": "<i>Meets</i>",
                                "rationale": "<script>alert(1)</script><img src=x onerror=alert(2)>" } ],
                "note": "<script>alert(3)</script>"
            } }
            """)
        let panel = try panelExpr(Self.essay)
        XCTAssertEqual(
            try h.string("__first('.revision-feedback-rationale', \(panel)).textContent"),
            "<script>alert(1)</script><img src=x onerror=alert(2)>"
        )
        XCTAssertEqual(try h.string("__first('.revision-feedback-criterion', \(panel)).textContent"), "<b>Claim</b>: <i>Meets</i>")
        XCTAssertEqual(try h.string("__first('.revision-feedback-note', \(panel)).textContent"), "Note: <script>alert(3)</script>")
        // No element was parsed out of the text, and nothing went through innerHTML.
        for tag in ["script", "img", "b", "i"] {
            XCTAssertEqual(try h.int("__count('\(tag)', \(panel))"), 0, tag)
        }
        XCTAssertTrue(try h.bool("""
            (function () {
              var bad = false;
              (function walk(x) {
                if (Object.prototype.hasOwnProperty.call(x, 'innerHTML')) bad = true;
                (x.children || []).forEach(walk);
              })(\(panel));
              return !bad;
            })()
            """))
    }

    // MARK: - Accessibility and read-only

    func testPanelIsALabelledRegionWithAListOfRows() throws {
        let h = try harness(feedback: Self.essayFeedback)
        let panel = try panelExpr(Self.essay)
        XCTAssertEqual(try h.string("\(panel).tagName"), "section")
        XCTAssertEqual(try h.string("\(panel).getAttribute('role')"), "region")
        // aria-labelledby names the heading, so VoiceOver reads "Scorer feedback, region".
        XCTAssertEqual(
            try h.string("\(panel).getAttribute('aria-labelledby')"),
            try h.string("__first('.revision-feedback-heading', \(panel)).id")
        )
        XCTAssertEqual(try h.string("__first('.revision-feedback-heading', \(panel)).tagName"), "h2")
        XCTAssertEqual(try h.string("__first('ul', \(panel)).getAttribute('role')"), "list")
        XCTAssertEqual(try h.int("__count('li', \(panel))"), 2)
    }

    func testPanelHasNoControlsAndPostsNothing() throws {
        let h = try harness(feedback: Self.essayFeedback)
        let panel = try panelExpr(Self.essay)
        for tag in ["input", "textarea", "select", "button"] {
            XCTAssertEqual(try h.int("__count('\(tag)', \(panel))"), 0, tag)
        }
        XCTAssertTrue(try h.bool("""
            (function () {
              var editable = false;
              (function walk(x) {
                if (x.getAttribute && x.getAttribute('contenteditable') !== null) editable = true;
                if (x.getAttribute && x.getAttribute('tabindex') !== null) editable = true;
                (x.children || []).forEach(walk);
              })(\(panel));
              return !editable;
            })()
            """))
        XCTAssertEqual(try h.postedMessages().count, 0)
        // The answer beside it still posts as usual.
        let n = try itemIndex(Self.mc)
        try h.eval("var b = __all('input', __item(\(n)))[0]; b.checked = true; b.onchange();")
        XCTAssertEqual(try h.postedMessages().count, 1)
    }
}
