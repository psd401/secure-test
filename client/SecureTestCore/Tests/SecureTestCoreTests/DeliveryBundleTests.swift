import XCTest
@testable import SecureTestCore

/// Decodes the fixture produced by the REAL delivery route
/// (design-tool/scripts/generate-delivery-fixture.ts), so this suite fails if
/// the two sides of the wire drift apart — which a hand-written fixture could
/// not detect, since it would drift with whoever edited it.
final class DeliveryBundleTests: XCTestCase {
    private func loadFixture() throws -> Data {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .appendingPathComponent("Fixtures/delivery-bundle.json")
        return try Data(contentsOf: url)
    }

    private func loadBundle() throws -> DeliveryBundle {
        try DeliveryBundle.decode(from: try loadFixture())
    }

    func testDecodesEveryItemTypeTheDesignToolCanAuthor() throws {
        let bundle = try loadBundle()
        XCTAssertEqual(bundle.items.count, 9)
        XCTAssertEqual(
            Set(bundle.items.map(\.kind)),
            Set(DeliveryItem.Kind.allCases),
            "fixture must exercise every case, or a broken decoder could pass"
        )
    }

    func testDecodesBundleLevelMetadata() throws {
        let bundle = try loadBundle()
        XCTAssertEqual(bundle.title, "Delivery Fixture")
        XCTAssertFalse(bundle.testId.isEmpty)
        // Slice 62: the EFFECTIVE set for this student, with setting values.
        // The fixture's student has spell_check On and color_contrast set, and
        // highlighter Off in TIDE — so highlighter must not appear even though
        // the assessment permits it.
        XCTAssertEqual(
            bundle.accommodations,
            ["spell_check": "On", "color_contrast": "Black on Rose"]
        )
        XCTAssertNil(bundle.accommodation("highlighter"))
        XCTAssertTrue(bundle.hasAccommodation("spell_check"))
        XCTAssertEqual(bundle.constructAltering, ["spell_check"])
    }

    /// Client paging: absent — every bundle before the field — and unknown
    /// values both read as scroll; only an explicit "paged" pages.
    func testLayoutDefaultsToScrollAndOnlyPagedPages() throws {
        XCTAssertEqual(try loadBundle().layout, .scroll)
        let paged = try DeliveryBundle.decode(from: Data(#"{"test_id":"t","title":"t","items":[],"layout":"paged"}"#.utf8))
        XCTAssertEqual(paged.layout, .paged)
        let odd = try DeliveryBundle.decode(from: Data(#"{"test_id":"t","title":"t","items":[],"layout":"sideways"}"#.utf8))
        XCTAssertEqual(odd.layout, .scroll)
    }

    /// Client paging follow-up: the answered ids default to none.
    func testAnsweredItemIdsDefaultToEmpty() throws {
        XCTAssertEqual(try loadBundle().answeredItemIds, [])
        let some = try DeliveryBundle.decode(from: Data(#"{"test_id":"t","title":"t","items":[],"answered_item_ids":["a","b"]}"#.utf8))
        XCTAssertEqual(some.answeredItemIds, ["a", "b"])
    }

    /// P-1: the fixture is a fresh attempt, so it carries no saved answers —
    /// which is also what proves the renderer suites run against a bundle with
    /// nothing prefilled.
    func testTheFixtureCarriesNoSavedAnswers() throws {
        XCTAssertTrue(try loadBundle().savedResponses.isEmpty)
        XCTAssertTrue(try loadBundle().savedUploads.isEmpty)
    }

    func testEveryItemExposesIdAndStemThroughTheEnum() throws {
        for item in try loadBundle().items {
            XCTAssertFalse(item.id.isEmpty)
            XCTAssertFalse(item.stem.isEmpty)
        }
    }

    func testMultipleChoiceKeepsChoicesAndDistinguishesSingleFromMulti() throws {
        let items = try loadBundle().items
        guard case .multipleChoiceSingle(let single)? = items.first(where: {
            $0.kind == .multipleChoiceSingle
        }) else { return XCTFail("no single-select item") }
        XCTAssertEqual(single.choices.map(\.text), ["Mitochondrion", "Ribosome", "Golgi apparatus"])

        guard case .multipleChoiceMulti(let multi)? = items.first(where: {
            $0.kind == .multipleChoiceMulti
        }) else { return XCTFail("no multi-select item") }
        XCTAssertEqual(multi.choices.count, 3)
    }

    /// A markup-shaped stem must survive decoding as the literal text it is.
    /// The page renders it via textContent and JSONEmbedding neutralises it on
    /// the way in, but both of those rely on the decoder not mangling it first.
    func testMarkupShapedStemDecodesAsText() throws {
        let items = try loadBundle().items
        let stem = items.first { $0.kind == .multipleChoiceMulti }?.stem
        XCTAssertEqual(stem, "Select all prime numbers. </script><b>not markup</b>")
    }

    func testEssayCarriesAuthoringMetadataAndAVisibleRubric() throws {
        guard case .essay(let essay)? = try loadBundle().items.first(where: {
            $0.kind == .essay
        }) else { return XCTFail("no essay item") }
        XCTAssertEqual(essay.maxWordCount, 400)
        XCTAssertEqual(essay.placeholder, "Write your response here…")
        XCTAssertEqual(essay.rubric?.style, .analytic)
        XCTAssertEqual(essay.rubric?.criteria.first?.levels.count, 2)
        XCTAssertEqual(essay.rubric?.studentVisibility?.duringTest, true)
    }

    func testMatchArrivesAsIndependentLeftAndRightArrays() throws {
        guard case .match(let match)? = try loadBundle().items.first(where: {
            $0.kind == .match
        }) else { return XCTFail("no match item") }
        XCTAssertEqual(match.lefts.map(\.text), ["Dog", "Cat", "Cow"])
        XCTAssertEqual(match.rights.count, 3)
        XCTAssertEqual(Set(match.rights.map(\.text)), ["Puppy", "Kitten", "Calf"])
    }

    func testOrderArrivesAsEntriesWithNoPromisedOrder() throws {
        guard case .order(let order)? = try loadBundle().items.first(where: {
            $0.kind == .order
        }) else { return XCTFail("no order item") }
        XCTAssertEqual(order.entries.count, 4)
        XCTAssertEqual(
            Set(order.entries.map(\.label)),
            ["Evaporation", "Condensation", "Precipitation", "Collection"]
        )
    }

    /// E3 slice 3: the grid arrives; the expected text per cell — the answer —
    /// does not, and cannot: TableItem has no field for it.
    func testTableArrivesAsAGridWithoutItsKeys() throws {
        guard case .table(let table)? = try loadBundle().items.first(where: {
            $0.kind == .table
        }) else { return XCTFail("no table item") }
        XCTAssertEqual(table.columns.map(\.label), ["Observed (o)", "Expected (e)"])
        XCTAssertEqual(table.rows.map(\.id), ["r1", "r2"])
        XCTAssertEqual(table.corner, "Chamber position")
        let raw = String(decoding: try loadFixture(), as: UTF8.self)
        XCTAssertFalse(raw.contains("cell_keys"))
        XCTAssertFalse(raw.contains("\"12\""))
    }

    func testHotspotKeepsNormalisedRegionsAndItsImageRef() throws {
        guard case .hotspot(let hotspot)? = try loadBundle().items.first(where: {
            $0.kind == .hotspot
        }) else { return XCTFail("no hotspot item") }
        XCTAssertEqual(hotspot.imageAssetId, "33333333-3333-4333-8333-333333333333")
        XCTAssertEqual(hotspot.regions.count, 2)
        for region in hotspot.regions {
            XCTAssertTrue((0...1).contains(region.x))
            XCTAssertTrue((0...1).contains(region.y))
            XCTAssertTrue(region.w > 0 && region.w <= 1)
            XCTAssertTrue(region.h > 0 && region.h <= 1)
        }
    }

    func testDrawingUploadCarriesItsCanvasBounds() throws {
        guard case .drawingUpload(let drawing)? = try loadBundle().items.first(where: {
            $0.kind == .drawingUpload
        }) else { return XCTFail("no drawing item") }
        XCTAssertEqual(drawing.canvas?.width, 1000)
        XCTAssertEqual(drawing.canvas?.height, 700)
        XCTAssertNil(drawing.promptAssetId)
        // The paper the strokes go on (docs/drawing-background-design.md).
        XCTAssertEqual(drawing.canvas?.background, "axes")
    }

    /// A bundle from a design tool that has never heard of backgrounds — every
    /// bundle before that slice — still decodes, blank. The model carries the
    /// string rather than an enum, so a value a NEWER design tool starts
    /// sending cannot fail the decode and cost the student the whole test.
    func testACanvasWithNoBackgroundDecodesBlankAndAnUnknownOneIsCarried() throws {
        let json = """
        {"test_id":"t","title":"T","items":[
          {"type":"drawing_upload","id":"a","stem":"s","canvas":{"width":800,"height":600}},
          {"type":"drawing_upload","id":"b","stem":"s",
           "canvas":{"width":800,"height":600,"background":"dots"}}]}
        """
        let items = try DeliveryBundle.decode(from: Data(json.utf8)).items
        guard case .drawingUpload(let plain) = items[0],
              case .drawingUpload(let odd) = items[1] else {
            return XCTFail("expected two drawing items")
        }
        XCTAssertNil(plain.canvas?.background)
        XCTAssertEqual(odd.canvas?.background, "dots")
    }

    /// The negative property that motivated a separate delivery type: no case
    /// of this enum has anywhere to put an answer key, so a route that leaked
    /// one would have it dropped here rather than reaching a renderer.
    func testAnswerKeyFieldsAreAbsentFromTheFixtureEntirely() throws {
        let raw = String(data: try loadFixture(), encoding: .utf8) ?? ""
        for forbidden in [
            "correct_choice_id", "correct_choice_ids", "correct_answer",
            "correct_region_ids", "scoring_method", "pairs", "sequence",
        ] {
            XCTAssertFalse(raw.contains(forbidden), "fixture leaked \(forbidden)")
        }
        XCTAssertFalse(raw.contains("photosynthesis"))
    }

    // E5 slice 2: the stimulus set the fixture carries over positions 2–3.
    func testDecodesItemSetsWithTheirMembersInOrder() throws {
        let bundle = try loadBundle()
        XCTAssertEqual(bundle.itemSets.count, 2)
        let set = try XCTUnwrap(bundle.itemSets.first)
        XCTAssertEqual(set.layout, .ownPage)
        XCTAssertTrue(set.stimulus.contains("asset:33333333-3333-4333-8333-333333333333"))
        XCTAssertEqual(set.itemIds, [bundle.items[1].id, bundle.items[2].id])
        XCTAssertEqual(set.sources, [], "a set with no sources decodes as an empty list")
    }

    /// Multi-source stimulus slice 4: the fixture's second set — one essay
    /// (position 4) with two labelled sources and the side_by_side layout.
    func testDecodesASetsLabelledSourcesAndTheSideBySideLayout() throws {
        let bundle = try loadBundle()
        let set = try XCTUnwrap(bundle.itemSets.last)
        XCTAssertEqual(set.layout, .sideBySide)
        XCTAssertEqual(set.stimulus, "Read both sources, then answer the question.")
        XCTAssertEqual(set.itemIds, [bundle.items[3].id])
        XCTAssertEqual(set.sources.map(\.label), ["Source A", "Source B"])
        // The authored line break survives the whole way to the client, which
        // is what slice 1's `pre-line` rule renders.
        XCTAssertTrue(set.sources[0].text.contains("\n"))
        XCTAssertTrue(set.sources[0].text.contains("**Rain and rivers**"))
        XCTAssertTrue(set.sources[1].text.contains("asset:33333333-3333-4333-8333-333333333333"))
    }

    /// An older bundle has no `sources` key at all; it must not fail the set.
    func testASetWithNoSourcesKeyDecodesAsAnEmptyList() throws {
        let json = #"{"id":"s","stimulus":"Read.","layout":"inline","item_ids":["i1"]}"#
        let set = try JSONDecoder().decode(ItemSet.self, from: Data(json.utf8))
        XCTAssertEqual(set.sources, [])
        XCTAssertEqual(set.layout, .inline)
    }

    /// And a layout this build has not heard of still renders (as inline)
    /// rather than failing the whole bundle.
    func testAnUnknownLayoutStillDecodesAsInline() throws {
        let json = #"{"id":"s","stimulus":"Read.","layout":"sideways","item_ids":["i1"]}"#
        let set = try JSONDecoder().decode(ItemSet.self, from: Data(json.utf8))
        XCTAssertEqual(set.layout, .inline)
    }
}

final class DeliveryDecodingEdgeCaseTests: XCTestCase {
    func testUnknownItemTypeFailsTheWholeDecode() {
        let json = """
        {"test_id":"t","title":"T","items":[{"type":"essay_v2","id":"i","stem":"s"}]}
        """
        // Failing the bundle beats skipping the item: silently handing a student
        // a shorter test than the teacher assigned is the worse outcome.
        XCTAssertThrowsError(try DeliveryBundle.decode(from: Data(json.utf8)))
    }

    func testOmittedOptionalCollectionsNormaliseToEmpty() throws {
        let json = """
        {"test_id":"t","title":"T","items":[]}
        """
        let bundle = try DeliveryBundle.decode(from: Data(json.utf8))
        XCTAssertTrue(bundle.assets.isEmpty)
        XCTAssertTrue(bundle.accommodations.isEmpty)
        XCTAssertTrue(bundle.constructAltering.isEmpty)
    }

    func testHotspotWithoutRegionsDecodesAsEmptyRatherThanFailing() throws {
        let json = """
        {"test_id":"t","title":"T","items":[{"type":"hotspot","id":"i","stem":"s"}]}
        """
        let bundle = try DeliveryBundle.decode(from: Data(json.utf8))
        guard case .hotspot(let hotspot) = bundle.items[0] else {
            return XCTFail("expected hotspot")
        }
        XCTAssertTrue(hotspot.regions.isEmpty)
        XCTAssertNil(hotspot.imageAssetId)
    }

    func testAssetsDecodeIntoDataURIs() throws {
        let json = """
        {"test_id":"t","title":"T","items":[],
         "assets":{"44444444-4444-4444-8444-444444444444":
           {"content_type":"image/png","base64":"AAAA"}}}
        """
        let bundle = try DeliveryBundle.decode(from: Data(json.utf8))
        let asset = bundle.assets["44444444-4444-4444-8444-444444444444"]
        XCTAssertEqual(asset?.contentType, "image/png")
        XCTAssertEqual(asset?.dataURI, "data:image/png;base64,AAAA")
    }

    // E5 slice 2: absent → []; a layout this client does not know → inline.
    func testItemSetsDefaultToEmptyAndUnknownLayoutFallsBackToInline() throws {
        let none = try DeliveryBundle.decode(from: Data(#"{"test_id":"t","title":"T","items":[]}"#.utf8))
        XCTAssertEqual(none.itemSets, [])
        let odd = try DeliveryBundle.decode(from: Data(#"""
        {"test_id":"t","title":"T","items":[],
         "item_sets":[{"id":"s","stimulus":"x","layout":"sideways","item_ids":["a"]},
                      {"id":"u","stimulus":"y","item_ids":["b"]}]}
        """#.utf8))
        XCTAssertEqual(odd.itemSets.map(\.layout), [.inline, .inline])
    }

    // E12 slice 3: the optional inline-outline fields decode, and default
    // to absent / false on a bundle that predates them.
    func testItemSetInlineOutlineFieldsDecodeAndDefault() throws {
        let json = """
        {"test_id":"t","title":"T","items":[{"type":"essay","id":"a","stem":"s"}],
         "item_sets":[{"id":"s","stimulus":"x","item_ids":["a"],"inline_item_id":"q","inline_text":"draft","source_missing":true},
                      {"id":"p","stimulus":"y","item_ids":["a"]}]}
        """
        let bundle = try JSONDecoder().decode(DeliveryBundle.self, from: Data(json.utf8))
        XCTAssertEqual(bundle.itemSets[0].inlineItemId, "q")
        XCTAssertEqual(bundle.itemSets[0].inlineText, "draft")
        XCTAssertTrue(bundle.itemSets[0].sourceMissing)
        XCTAssertNil(bundle.itemSets[1].inlineItemId)
        XCTAssertFalse(bundle.itemSets[1].sourceMissing)
    }

    /// P-1: a fresh attempt, the offline bundle and every server that predates
    /// the fields all send neither — normalised to empty so callers never
    /// branch on nil-vs-empty.
    func testSavedAnswersDefaultToEmpty() throws {
        let json = #"{"test_id":"t","title":"T","items":[]}"#
        let bundle = try DeliveryBundle.decode(from: Data(json.utf8))
        XCTAssertTrue(bundle.savedResponses.isEmpty)
        XCTAssertTrue(bundle.savedUploads.isEmpty)
    }

    /// The values are the same union the page POSTS, so the field cannot carry
    /// anything but a student's own answer. Match ids are the per-attempt
    /// sealed ones (opaque hex, as the fixture's own `rights` carry), and a
    /// drawing answer is a reference whose bytes ride `saved_uploads`.
    func testSavedResponsesAndUploadsDecode() throws {
        let json = #"""
        {"test_id":"t","title":"T",
         "items":[{"type":"match","id":"m","stem":"s",
                   "lefts":[{"id":"28c873235a92ebd42edfaac6","text":"Dog"}],
                   "rights":[{"id":"faad741f2dfa13299d6dc0af","text":"Puppy"}]},
                  {"type":"drawing_upload","id":"d","stem":"s"}],
         "saved_responses":{
           "m":{"type":"match","matches":{"28c873235a92ebd42edfaac6":"faad741f2dfa13299d6dc0af"}},
           "d":{"type":"drawing_upload","upload_id":"11111111-1111-4111-8111-111111111111"}},
         "saved_uploads":{
           "11111111-1111-4111-8111-111111111111":{"content_type":"image/png","base64":"SEVMTE8="}}}
        """#
        let bundle = try DeliveryBundle.decode(from: Data(json.utf8))
        XCTAssertEqual(
            bundle.savedResponses["m"],
            .match(matches: ["28c873235a92ebd42edfaac6": "faad741f2dfa13299d6dc0af"])
        )
        XCTAssertEqual(
            bundle.savedResponses["d"],
            .drawingUpload(uploadID: "11111111-1111-4111-8111-111111111111")
        )
        let blob = try XCTUnwrap(bundle.savedUploads["11111111-1111-4111-8111-111111111111"])
        XCTAssertEqual(blob.contentType, "image/png")
        XCTAssertEqual(blob.dataURI, "data:image/png;base64,SEVMTE8=")
    }

    /// The union is the gate: a value that is not a response type fails the
    /// whole decode rather than being carried as something unrecognised.
    func testASavedValueThatIsNotAResponseTypeFailsTheDecode() {
        let json = #"""
        {"test_id":"t","title":"T","items":[{"type":"essay","id":"e","stem":"s"}],
         "saved_responses":{"e":{"type":"answer_key","text":"42"}}}
        """#
        XCTAssertThrowsError(try DeliveryBundle.decode(from: Data(json.utf8)))
    }
}
