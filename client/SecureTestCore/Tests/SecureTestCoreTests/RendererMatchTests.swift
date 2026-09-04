import XCTest
@testable import SecureTestCore

/// Slice 55. The match item in the fixture is index 4: Dog/Cat/Cow against
/// Puppy/Kitten/Calf, with pair ids p1/p2/p3.
final class RendererMatchTests: XCTestCase {
    private let item = "__item(4)"

    /// Slice 64: both sides carry per-attempt sealed ids, and the two sides of
    /// one pair no longer share one — so a test cannot name an option by its
    /// authoring id and must look it up by the text a student would read.
    private func leftID(_ h: RendererHarness, text: String) throws -> String {
        try h.string(
            "BUNDLE.items[4].lefts.filter(function (l) { return l.text === '\(text)'; })[0].id"
        ) ?? ""
    }

    private func rightID(_ h: RendererHarness, text: String) throws -> String {
        try h.string(
            "BUNDLE.items[4].rights.filter(function (r) { return r.text === '\(text)'; })[0].id"
        ) ?? ""
    }

    private func harness() throws -> RendererHarness {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .appendingPathComponent("Fixtures/delivery-bundle.json")
        return try RendererHarness(bundleJSON: try String(contentsOf: url, encoding: .utf8))
    }

    func testRendersOneDropdownPerLeft() throws {
        let h = try harness()
        XCTAssertEqual(try h.int("__count('.match-row', \(item))"), 3)
        XCTAssertEqual(try h.int("__count('select', \(item))"), 3)
        XCTAssertEqual(try h.string("__first('.match-left', \(item)).textContent"), "Dog")
    }

    /// A dropdown rather than drag-and-drop, so the item is answerable with a
    /// keyboard and with assistive technology. A drag-only interaction would
    /// exclude some students from answering at all.
    func testEveryLeftIsOfferedEveryRightPlusABlank() throws {
        let h = try harness()
        let joined = try h.string(
            "__all('option', __all('.match-row', \(item))[1])"
            + ".map(function (o) { return o.textContent; }).join('|')"
        )
        let options = joined?.components(separatedBy: "|") ?? []
        XCTAssertEqual(options.count, 4, "three rights plus the blank")
        XCTAssertEqual(options.first, "Choose…")
        XCTAssertTrue(options.contains("Puppy"))
        XCTAssertTrue(options.contains("Kitten"))
        XCTAssertTrue(options.contains("Calf"))
    }

    func testPostsEveryPairingTheStudentHasMade() throws {
        let h = try harness()
        let puppy = try rightID(h, text: "Puppy")
        let kitten = try rightID(h, text: "Kitten")
        try h.eval(
            "var s = __all('select', \(item));"
            + "s[0].value = '\(puppy)'; s[0].onchange();"
            + "s[1].value = '\(kitten)'; s[1].onchange();"
        )
        let messages = try h.postedMessages()
        XCTAssertEqual(messages.count, 2)
        let response = messages[1]["response"] as? [String: Any]
        XCTAssertEqual(response?["type"] as? String, "match")
        let matches = response?["matches"] as? [String: String]
        XCTAssertEqual(matches, [
            try leftID(h, text: "Dog"): puppy,
            try leftID(h, text: "Cat"): kitten,
        ])
    }

    /// A pair's left and right derive from the same authoring id, so without a
    /// side discriminator the bundle would re-pair itself for anyone who read
    /// the identifiers.
    func testTheTwoSidesShareNoIdentifier() throws {
        let h = try harness()
        for text in ["Dog", "Cat", "Cow"] {
            let left = try leftID(h, text: text)
            XCTAssertEqual(left.count, 24)
            XCTAssertFalse(["p1", "p2", "p3"].contains(left))
            for rightText in ["Puppy", "Kitten", "Calf"] {
                XCTAssertNotEqual(left, try rightID(h, text: rightText))
            }
        }
    }

    func testOmitsLeftsTheStudentHasNotAnswered() throws {
        let h = try harness()
        let calf = try rightID(h, text: "Calf")
        try h.eval("var s = __all('select', \(item)); s[2].value = '\(calf)'; s[2].onchange();")
        let matches = (try h.postedMessages().last?["response"] as? [String: Any])?["matches"]
            as? [String: String]
        // Blank selections would post empty-string values, which the wire
        // schema rejects (record values are min(1)).
        XCTAssertEqual(matches, [try leftID(h, text: "Cow"): calf])
    }

    func testClearingEveryDropdownPostsNothingFurther() throws {
        let h = try harness()
        let puppy = try rightID(h, text: "Puppy")
        try h.eval(
            "var s = __all('select', \(item));"
            + "s[0].value = '\(puppy)'; s[0].onchange();"
            + "s[0].value = ''; s[0].onchange();"
        )
        // Same rule as multi-select: an unanswered item is the ABSENCE of a
        // response, so a fully-cleared item has nothing valid to send.
        XCTAssertEqual(try h.postedMessages().count, 1)
    }

    /// The client is never told which right belongs to which left — the bundle
    /// carries them as independent arrays with nothing associating them. So an
    /// implausible answer is recorded as faithfully as a plausible one; judging
    /// it is the server's job, against a key the client does not have.
    func testRecordsAnImplausiblePairingWithoutJudgingIt() throws {
        let h = try harness()
        let puppy = try rightID(h, text: "Puppy")
        try h.eval(
            "__all('select', \(item)).forEach(function (s) { s.value = '\(puppy)'; });"
            + "__all('select', \(item))[0].onchange();"
        )
        let matches = (try h.postedMessages().last?["response"] as? [String: Any])?["matches"]
            as? [String: String]
        XCTAssertEqual(matches, [
            try leftID(h, text: "Dog"): puppy,
            try leftID(h, text: "Cat"): puppy,
            try leftID(h, text: "Cow"): puppy,
        ])
    }

    // MARK: batch 0b slice 3 — the answered mark waits for every pair

    /// The fixture, paged, optionally seeded as the server would after a
    /// relaunch (answered_item_ids + saved_responses for the match item).
    private func paged(seedAnswered: Bool = false, savedPairs: [(String, String)]? = nil) throws -> RendererHarness {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .appendingPathComponent("Fixtures/delivery-bundle.json")
        var json = try String(contentsOf: url, encoding: .utf8)
        let probe = try RendererHarness(bundleJSON: json)
        let matchID = try XCTUnwrap(probe.string("BUNDLE.items[4].id"))
        var injected = "\"layout\": \"paged\", "
        if seedAnswered { injected += "\"answered_item_ids\": [\"\(matchID)\"], " }
        if let pairs = savedPairs {
            let body = pairs.map { "\"\($0.0)\": \"\($0.1)\"" }.joined(separator: ", ")
            injected += "\"saved_responses\": {\"\(matchID)\": {\"type\": \"match\", \"matches\": {\(body)}}}, "
        }
        let range = try XCTUnwrap(json.range(of: "\"test_id\":"))
        json.replaceSubrange(range, with: injected + "\"test_id\":")
        return try RendererHarness(bundleJSON: json)
    }

    /// The strip button for the match question (Q5), found by label rather
    /// than position so a passage page cannot shift it.
    private func stripClass(_ h: RendererHarness) throws -> String? {
        try h.string(
            "__all('button', __first('.pager-strip')).filter(function (b) {"
            + " return (b.getAttribute('aria-label') || '').indexOf('Question 5 of 9') === 0; })[0].className"
        )
    }

    /// The 2026-09-03 sitting: the strip went green on the first pair. Now a
    /// partial pairing posts but does not mark; the third pair marks; taking
    /// one back to "Choose…" drops the mark again.
    func testMarkWaitsForEveryPairAndDropsWhenOneIsCleared() throws {
        let h = try paged()
        let puppy = try rightID(h, text: "Puppy")
        let kitten = try rightID(h, text: "Kitten")
        let calf = try rightID(h, text: "Calf")
        XCTAssertEqual(try stripClass(h), "unanswered")
        try h.eval("var s = __all('select', \(item)); s[0].value = '\(puppy)'; s[0].onchange();")
        XCTAssertEqual(try h.postedMessages().count, 1, "the partial pairing still posts")
        XCTAssertEqual(try stripClass(h), "unanswered")
        try h.eval("var s = __all('select', \(item)); s[1].value = '\(kitten)'; s[1].onchange();")
        XCTAssertEqual(try stripClass(h), "unanswered")
        try h.eval("var s = __all('select', \(item)); s[2].value = '\(calf)'; s[2].onchange();")
        XCTAssertEqual(try stripClass(h), "answered")
        try h.eval("var s = __all('select', \(item)); s[1].value = ''; s[1].onchange();")
        XCTAssertEqual(try h.postedMessages().count, 4)
        XCTAssertEqual(try stripClass(h), "unanswered")
    }

    /// After a relaunch the server lists any saved response as answered; a
    /// restored partial pairing starts unmarked, a complete one marked, and
    /// neither restore posts anything.
    func testRestoredPartialPairingStartsUnmarkedACompleteOneMarked() throws {
        let probe = try paged()
        let dog = try leftID(probe, text: "Dog"), cat = try leftID(probe, text: "Cat"), cow = try leftID(probe, text: "Cow")
        let puppy = try rightID(probe, text: "Puppy"), kitten = try rightID(probe, text: "Kitten"), calf = try rightID(probe, text: "Calf")

        let partial = try paged(seedAnswered: true, savedPairs: [(dog, puppy), (cat, kitten)])
        XCTAssertEqual(try stripClass(partial), "unanswered")
        XCTAssertEqual(try partial.postedMessages().count, 0)
        XCTAssertEqual(try partial.string("__all('select', \(item))[0].value"), puppy, "the saved pairs are still restored")

        let whole = try paged(seedAnswered: true, savedPairs: [(dog, puppy), (cat, kitten), (cow, calf)])
        XCTAssertEqual(try stripClass(whole), "answered")
        XCTAssertEqual(try whole.postedMessages().count, 0)
    }

    func testRightsAreNotRenderedInTheSameOrderAsLefts() throws {
        // The route shuffles rights server-side; the fixture generator re-sorts
        // them by id for a stable diff. What matters here is that the renderer
        // presents the rights list as given rather than re-pairing it to the
        // lefts positionally, which would hand the answer to any student who
        // noticed.
        let h = try harness()
        let firstRight = try h.string(
            "__all('option', __first('.match-row', \(item)))[1].textContent"
        )
        let firstLeft = try h.string("__first('.match-left', \(item)).textContent")
        XCTAssertEqual(firstLeft, "Dog")
        XCTAssertNotNil(firstRight)
        // Every dropdown offers the identical rights list, in one order.
        let second = try h.string(
            "__all('option', __all('.match-row', \(item))[1])[1].textContent"
        )
        XCTAssertEqual(firstRight, second)
    }
}
