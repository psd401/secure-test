import Foundation
import XCTest
@testable import SecureTestCore

/// Client UI pass slice B (`docs/client-ui-pass-design.md` §B).
///
/// CSS is not testable in this harness (no window server, ADR 0013), so what
/// these assert is the layer under the paint: that the right attribute lands on
/// `<html>` for every value the catalog can send, that the stylesheet carries a
/// complete set behind each of those attributes, and — the one that costs bytes
/// on every page — that an unaccommodated student's document is unchanged.
/// The colours themselves are rows in `client/MANUAL-CHECKS.md`.
final class PageAccommodationsTests: XCTestCase {

    // MARK: - Attribute selection from the bundle

    func testEveryContrastValueSelectsItsOwnAttribute() {
        XCTAssertEqual(PageAccommodations.contrastSets.count, 8)
        for set in PageAccommodations.contrastSets {
            let attributes = PageAccommodations.rootAttributes(["color_contrast": set.value])
            XCTAssertEqual(attributes["data-contrast"], set.value)
            XCTAssertNil(attributes["data-font"])
            XCTAssertNil(attributes["data-zoom"])
        }
    }

    func testTheEightValuesAreTIDEsOwnStrings() {
        // docs/accommodations-data-dictionary.md, Color Contrast row.
        XCTAssertEqual(
            PageAccommodations.contrastSets.map(\.value),
            ["Black on Rose", "Black on White", "Medium Gray on Light Gray", "Red on White",
             "Reverse Contrast", "White on Red", "Yellow on Black", "Yellow on Blue"])
    }

    func testEveryZoomLevelSelectsItsOwnAttribute() {
        XCTAssertEqual(PageAccommodations.zoomLevels.count, 9)
        for level in PageAccommodations.zoomLevels {
            let attributes = PageAccommodations.rootAttributes(["zoom": level.value])
            XCTAssertEqual(attributes["data-zoom"], level.value)
            XCTAssertNil(attributes["data-contrast"])
        }
    }

    func testTheNineZoomValuesAreTIDEsOwnStringsAndRunOneToThree() {
        XCTAssertEqual(
            PageAccommodations.zoomLevels.map(\.value),
            ["1X (Default)", "1.5X", "1.75X", "2.5X", "3X",
             "05X (Streamlined Mode Only)", "10X (Streamlined Mode Only)",
             "15X (Streamlined Mode Only)", "20X (Streamlined Mode Only)"])
        let multipliers = PageAccommodations.zoomLevels.compactMap { Double($0.multiplier) }
        XCTAssertEqual(multipliers.count, 9)
        XCTAssertEqual(multipliers.min(), 1)
        XCTAssertEqual(multipliers.max(), 3)
        // The four streamlined-only levels ramp rather than repeat, so a bigger
        // entitlement is never a smaller page.
        XCTAssertEqual(Array(multipliers.suffix(4)), [1.5, 2, 2.5, 3])
    }

    func testTheOptionalFontIsOneAttributeValueWhateverTheToolSays() {
        for value in ["On", "on", "Yes", "dyslexia-friendly"] {
            XCTAssertEqual(
                PageAccommodations.rootAttributes(["optional_font": value])["data-font"],
                "optional",
                "optional_font=\(value)")
        }
    }

    func testAllThreeApplyTogether() {
        let attributes = PageAccommodations.rootAttributes([
            "color_contrast": "Yellow on Blue",
            "optional_font": "On",
            "zoom": "2.5X",
            // Tools slice B does not render must not add attributes.
            "spell_check": "On",
            "highlighter": "On",
        ])
        XCTAssertEqual(attributes, [
            "data-contrast": "Yellow on Blue",
            "data-font": "optional",
            "data-zoom": "2.5X",
        ])
    }

    // MARK: - The absence case

    func testNoAccommodationsMeansNoAttributes() {
        XCTAssertEqual(PageAccommodations.rootAttributes([:]), [:])
        XCTAssertEqual(PageAccommodations.rootAttributes(["spell_check": "On"]), [:])
    }

    /// The server drops off-ish rows before the bundle is built; if one ever
    /// arrives anyway it must not theme the page.
    func testOffIshAndUnknownValuesSelectNothing() {
        for value in ["Off", "off", "None", "None (Default)", "", "  ", "Default"] {
            XCTAssertEqual(PageAccommodations.rootAttributes([
                "color_contrast": value, "optional_font": value, "zoom": value,
            ]), [:], "value \(value)")
        }
        XCTAssertEqual(
            PageAccommodations.rootAttributes(["color_contrast": "Purple on Teal"]), [:])
        XCTAssertEqual(PageAccommodations.rootAttributes(["zoom": "42X"]), [:])
    }

    // MARK: - The stylesheet

    func testTheStylesheetCarriesAllEightContrastSetsWithAllTwelveTokens() {
        let css = PageShell.accommodationStyles
        let tokens = ["--paper", "--ink", "--ink-soft", "--line", "--line-strong", "--panel",
                      "--panel-line", "--accent", "--accent-ink", "--ok", "--warn", "--danger"]
        for set in PageAccommodations.contrastSets {
            let selector = "html[data-contrast=\"\(set.value)\"] {"
            XCTAssertTrue(css.contains(selector), "missing \(selector)")
            for token in tokens {
                XCTAssertTrue(set.css.contains("\(token): "), "\(set.value) is missing \(token)")
            }
            XCTAssertTrue(css.contains(set.css))
        }
    }

    /// Every set's body text clears WCAG AA. The numbers are the recorded
    /// measurements; this pins them so an edit to a hex has to update the
    /// record with it.
    func testEveryContrastSetIsRecordedAtOrAboveAA() {
        for set in PageAccommodations.contrastSets {
            XCTAssertGreaterThanOrEqual(set.bodyRatio, 4.5, set.value)
            XCTAssertEqual(contrastRatio(set.ink, set.paper), set.bodyRatio, accuracy: 0.01,
                           "\(set.value): recorded ratio does not match its hexes")
            // The panel is the ground most body text actually sits on inside a
            // stimulus or the pager, so it has to clear AA too.
            XCTAssertGreaterThanOrEqual(contrastRatio(set.ink, set.panel), 4.5,
                                        "\(set.value): ink on panel")
            // The three state colours are read as text on both grounds.
            for (name, colour) in [("ok", set.ok), ("warn", set.warn), ("danger", set.danger)] {
                XCTAssertGreaterThanOrEqual(contrastRatio(colour, set.paper), 4.5,
                                            "\(set.value): \(name) on paper")
                XCTAssertGreaterThanOrEqual(contrastRatio(colour, set.panel), 4.5,
                                            "\(set.value): \(name) on panel")
            }
        }
    }

    /// The finish button and the focus ring: the filled button is `--accent` on
    /// `--accent-ink`, so that pair carries the button's label.
    func testTheFilledButtonPairClearsAAInEverySet() {
        for set in PageAccommodations.contrastSets {
            XCTAssertGreaterThanOrEqual(contrastRatio(set.accent, set.accentInk), 4.5, set.value)
            // The focus ring is --accent drawn on --paper.
            XCTAssertGreaterThanOrEqual(contrastRatio(set.accent, set.paper), 3.0, set.value)
        }
    }

    func testNoSetLeavesATokenInThePSDPalette() {
        // The default palette's own hexes, which must not survive into a set.
        let defaults = ["#25424c", "#5a6c73", "#cddadf", "#7d888d", "#eeebe4", "#d7cdbe",
                        "#346780", "#fffaec", "#466857", "#8d5d1c", "#a04034"]
        for set in PageAccommodations.contrastSets {
            for hex in defaults {
                XCTAssertFalse(set.css.lowercased().contains(hex), "\(set.value) kept \(hex)")
            }
        }
    }

    func testTheStylesheetCarriesAllNineZoomRules() {
        let css = PageShell.accommodationStyles
        for level in PageAccommodations.zoomLevels {
            XCTAssertTrue(
                css.contains("html[data-zoom=\"\(level.value)\"] { --zoom: \(level.multiplier); }"),
                "missing zoom rule for \(level.value)")
        }
    }

    func testTheOptionalFontRuleNamesAtkinsonForBodyAndHeading() {
        let css = PageShell.accommodationStyles
        XCTAssertTrue(css.contains("html[data-font=\"optional\"] {"))
        XCTAssertEqual(css.components(separatedBy: "'Atkinson Hyperlegible'").count - 1, 2)
        XCTAssertTrue(css.contains("--font-body: 'Atkinson Hyperlegible', 'Inter'"))
        XCTAssertTrue(css.contains("--font-heading: 'Atkinson Hyperlegible', 'Inter'"))
    }

    // MARK: - The emitted document

    func testTheDocumentPutsTheAttributesOnTheHTMLElement() {
        let html = PageShell.document(
            title: "Quiz", body: "",
            accommodations: ["color_contrast": "Black on Rose", "zoom": "3X",
                             "optional_font": "On"])
        XCTAssertTrue(html.contains(
            #"<html lang="en" data-contrast="Black on Rose" data-font="optional" data-zoom="3X">"#))
    }

    func testAnUnaccommodatedDocumentCarriesNoAttributeAndNoAtkinsonBytes() {
        let plain = PageShell.document(title: "Quiz", body: "<p>hi</p>")
        // The `<html>` tag is bare. (The ATTRIBUTE NAMES still appear further
        // down, in the stylesheet's selectors — those rules are always shipped
        // and simply match nothing, which is what makes an accommodated and an
        // unaccommodated page differ by an attribute rather than by a rule.)
        XCTAssertTrue(plain.contains(#"<html lang="en"><head>"#))
        XCTAssertFalse(htmlTag(plain).contains("data-"))
        // D-B2: the optional face's bytes are not in the page at all.
        XCTAssertFalse(plain.contains("font-family: 'Atkinson Hyperlegible';"))
        XCTAssertEqual(plain.components(separatedBy: "data:font/woff2;base64,").count - 1, 2)
        // The RULE is always there — it just has nothing to match.
        XCTAssertTrue(plain.contains(#"html[data-font="optional"]"#))
    }

    func testTheOptionalFontsBytesRideOnlyWhenSelected() {
        let with = PageShell.document(
            title: "Quiz", body: "", accommodations: ["optional_font": "On"])
        XCTAssertTrue(with.contains("font-family: 'Atkinson Hyperlegible';"))
        XCTAssertEqual(with.components(separatedBy: "data:font/woff2;base64,").count - 1, 4)
        // Regular and bold, so nothing is synthesised.
        XCTAssertTrue(with.contains("font-weight: 400;"))
        XCTAssertTrue(with.contains("font-weight: 700;"))

        // A contrast-only page pays nothing for it.
        let contrastOnly = PageShell.document(
            title: "Quiz", body: "", accommodations: ["color_contrast": "Yellow on Black"])
        XCTAssertFalse(contrastOnly.contains("font-family: 'Atkinson Hyperlegible';"))
    }

    func testTheAccommodationStylesFollowTheTokenBlockSoTheyCanOverrideIt() {
        let html = PageShell.document(title: "T", body: "")
        let root = try? XCTUnwrap(html.range(of: "--paper: #ffffff;"))
        let set = try? XCTUnwrap(html.range(of: #"html[data-contrast="Black on Rose"]"#))
        XCTAssertNotNil(root)
        XCTAssertNotNil(set)
        if let root, let set { XCTAssertTrue(root.lowerBound < set.lowerBound) }
    }

    // MARK: - Reaching the page from the bundle, with no caller change

    func testTheAssessmentPageReadsTheAccommodationsOutOfTheBundleBytes() {
        let json = """
        {"test_id":"t","title":"Quiz","items":[],
         "accommodations":{"color_contrast":"Reverse Contrast","zoom":"1.75X",
                           "optional_font":"On","spell_check":"On"}}
        """
        let html = AssessmentPage.html(title: "Quiz", bundleJSON: json)
        XCTAssertTrue(html.contains(#"data-contrast="Reverse Contrast""#))
        XCTAssertTrue(html.contains(#"data-zoom="1.75X""#))
        XCTAssertTrue(html.contains(#"data-font="optional""#))
    }

    func testABundleWithNoAccommodationsRendersThePlainPage() {
        for json in ["{}", #"{"accommodations":{}}"#, #"{"accommodations":null}"#, "not json"] {
            let html = AssessmentPage.html(title: "Quiz", bundleJSON: json)
            XCTAssertFalse(htmlTag(html).contains("data-"), json)
            XCTAssertFalse(html.contains("font-family: 'Atkinson Hyperlegible';"), json)
        }
    }

    /// The opening `<html …>` tag only — the attribute names also occur in the
    /// stylesheet's selectors, which ship on every page.
    private func htmlTag(_ html: String) -> String {
        guard let start = html.range(of: "<html "),
              let end = html.range(of: ">", range: start.lowerBound..<html.endIndex)
        else { return "" }
        return String(html[start.lowerBound..<end.upperBound])
    }

    /// A non-string value in the map is dropped, not crashed on.
    func testNonStringAccommodationValuesAreIgnored() {
        XCTAssertEqual(
            AssessmentPage.accommodationsIn(#"{"accommodations":{"zoom":3,"a":"b"}}"#),
            ["a": "b"])
    }

    // MARK: - WCAG 2.x relative luminance

    private func contrastRatio(_ a: String, _ b: String) -> Double {
        let (la, lb) = (luminance(a), luminance(b))
        return (max(la, lb) + 0.05) / (min(la, lb) + 0.05)
    }

    private func luminance(_ hex: String) -> Double {
        let digits = Array(hex.dropFirst())
        func channel(_ i: Int) -> Double {
            let value = Double(Int(String(digits[i...(i + 1)]), radix: 16)!) / 255
            return value <= 0.04045 ? value / 12.92 : pow((value + 0.055) / 1.055, 2.4)
        }
        return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4)
    }
}
