import CryptoKit
import Foundation
import XCTest
@testable import SecureTestCore

/// Client UI pass slice A: the PSD faces load from the package's resource
/// bundle and are inlined as `data:` URIs, because the page is a no-origin
/// document whose CSP allows `font-src data:` only — a `url()` anywhere else
/// fails silently and the student reads the fallback stack instead.
final class PageFontsTests: XCTestCase {
    func testBothFacesLoadFromTheResourceBundle() {
        let fonts = PageFonts.shared
        XCTAssertEqual(fonts.missing, [])
        XCTAssertTrue(fonts.isComplete)
        XCTAssertEqual(fonts.css.components(separatedBy: "@font-face").count - 1, 2)
        XCTAssertTrue(fonts.css.contains("font-family: 'Inter';"))
        XCTAssertTrue(fonts.css.contains("font-family: 'Josefin Sans';"))
    }

    func testFacesAreInlinedAsDataURIsAndNothingElse() {
        let css = PageFonts.shared.css
        XCTAssertEqual(css.components(separatedBy: "data:font/woff2;base64,").count - 1, 2)
        XCTAssertFalse(css.contains("url(fonts/"))
        XCTAssertFalse(css.contains("http"))
        // Both faces are variable, so the weight axis is declared as a range.
        XCTAssertTrue(css.contains("font-weight: 100 900;"))
        XCTAssertTrue(css.contains("font-weight: 100 700;"))
        // ~104 KB of base64 for the pair.
        XCTAssertGreaterThan(css.count, 90_000)
    }

    /// Nothing inlined can end the style element early, the same guard KaTeX's
    /// bundle carries for its script.
    func testNothingInlinedCanCloseTheStyleElement() {
        XCTAssertFalse(PageFonts.shared.css.contains("</"))
    }

    /// A missing resource costs the face, never the page.
    func testAMissingResourceIsReportedRatherThanFatal() {
        let fonts = PageFonts.load(bundle: Bundle(for: PageFontsTests.self))
        XCTAssertEqual(fonts.missing.count, PageFonts.faces.count)
        XCTAssertFalse(fonts.isComplete)
        XCTAssertEqual(fonts.css, "")
    }

    /// Drift check, the KaTeX VERSION file's equivalent: the vendored bytes
    /// are what `client/scripts/vendor-fonts.mjs` recorded, AND they are still
    /// byte-identical to the design tool's own copies — so a stem renders in
    /// the same face in the teacher's preview and on the student's screen.
    func testVendoredFilesMatchTheManifestAndTheDesignToolOriginals() throws {
        let bundle = Bundle.module
        let manifestURL = try XCTUnwrap(
            bundle.url(forResource: "MANIFEST", withExtension: nil, subdirectory: "fonts"))
        let manifest = try String(contentsOf: manifestURL, encoding: .utf8)
            .split(separator: "\n")
            .map { $0.split(separator: " ").map(String.init) }
        XCTAssertEqual(manifest.count, 4, "two woff2 and two OFL licences")

        // client/SecureTestCore/Tests/SecureTestCoreTests/<this file>
        let designToolFonts = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()   // SecureTestCoreTests
            .deletingLastPathComponent()   // Tests
            .deletingLastPathComponent()   // SecureTestCore
            .deletingLastPathComponent()   // client
            .deletingLastPathComponent()   // repo root
            .appendingPathComponent("design-tool/app/fonts")

        for row in manifest {
            XCTAssertEqual(row.count, 3)
            let (name, size, sha) = (row[0], Int(row[1]), row[2])
            let ext = (name as NSString).pathExtension
            let stem = (name as NSString).deletingPathExtension
            let url = try XCTUnwrap(
                bundle.url(forResource: stem, withExtension: ext, subdirectory: "fonts"),
                "\(name) is not vendored — run: cd client && bun scripts/vendor-fonts.mjs")
            let data = try Data(contentsOf: url)
            XCTAssertEqual(data.count, size, "\(name) size drifted from the MANIFEST")
            XCTAssertEqual(SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined(),
                           sha, "\(name) content drifted from the MANIFEST")

            let original = designToolFonts.appendingPathComponent(name)
            guard let source = try? Data(contentsOf: original) else { continue }
            XCTAssertEqual(source, data,
                           "\(name) differs from design-tool/app/fonts — re-run vendor-fonts.mjs")
        }
    }
}
