import XCTest
@testable import SecureTestCore

/// Row NM (CLAUDE.md "Naming"): one product name. The app's Info.plist takes
/// it from the `PRODUCT_DISPLAY_NAME` build setting and the code from
/// `Brand.productName`; this keeps the two equal and refuses a hand-typed old
/// form ("Secure Test", "Secure-Test") in the client's sources.
final class BrandTests: XCTestCase {
    private let clientRoot = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent() // SecureTestCoreTests
        .deletingLastPathComponent() // Tests
        .deletingLastPathComponent() // SecureTestCore
        .deletingLastPathComponent() // client

    func testProductName() {
        XCTAssertEqual(Brand.productName, "SecureTest")
    }

    func testBuildSettingMatchesBrand() throws {
        let pbxproj = try String(
            contentsOf: clientRoot.appendingPathComponent("SecureTest.xcodeproj/project.pbxproj"),
            encoding: .utf8
        )
        let settings = pbxproj.components(separatedBy: "\n")
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { $0.hasPrefix("PRODUCT_DISPLAY_NAME = ") }
        XCTAssertFalse(settings.isEmpty, "PRODUCT_DISPLAY_NAME not found in project.pbxproj")
        for line in settings {
            XCTAssertEqual(line, "PRODUCT_DISPLAY_NAME = \(Brand.productName);")
        }
    }

    func testNoHandTypedOldForm() throws {
        let scanned = [
            "SecureTest",
            "SecureTestCore/Sources",
            "SecureTest.xcodeproj/project.pbxproj",
            "config-profile.example.mobileconfig",
        ]
        let oldForm = try NSRegularExpression(pattern: "Secure[ -]Test")
        var hits: [String] = []
        let fm = FileManager.default
        for path in scanned {
            let root = clientRoot.appendingPathComponent(path)
            var files: [URL] = []
            var isDir: ObjCBool = false
            if fm.fileExists(atPath: root.path, isDirectory: &isDir), isDir.boolValue {
                let walker = fm.enumerator(at: root, includingPropertiesForKeys: nil)
                while let url = walker?.nextObject() as? URL {
                    if ["swift", "js", "css", "html", "plist", "strings"].contains(url.pathExtension) {
                        files.append(url)
                    }
                }
            } else {
                files.append(root)
            }
            for file in files {
                guard let text = try? String(contentsOf: file, encoding: .utf8) else { continue }
                for (i, line) in text.components(separatedBy: "\n").enumerated() {
                    let range = NSRange(line.startIndex..., in: line)
                    if oldForm.firstMatch(in: line, range: range) != nil {
                        hits.append("\(file.lastPathComponent):\(i + 1): \(line.trimmingCharacters(in: .whitespaces))")
                    }
                }
            }
        }
        XCTAssertEqual(hits, [])
    }
}
