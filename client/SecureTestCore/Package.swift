// swift-tools-version: 5.9
import PackageDescription

// Slice 52: the client's logic lives in this package rather than in the app
// target so it can be exercised with `swift test` — no Xcode, no window server,
// no browser automation. That constraint is deliberate: headless Chrome and
// Playwright both hang in this dev environment (ADR 0013), so anything that can
// only be verified by driving a UI effectively cannot be verified at all here.
//
// The app target (../SecureTest.xcodeproj) is a thin AppKit shell that owns the
// WKWebView, the hardening overrides, and — once Apple grants the entitlement —
// the AEAssessmentSession. It exists as an .xcodeproj rather than a SwiftPM
// executable because SwiftPM packages opened in Xcode do not expose the
// Signing & Capabilities tab, which is where the restricted AAC entitlement has
// to be added (poc-a-aac-capture/README.md).
let package = Package(
    name: "SecureTestCore",
    platforms: [
        .macOS(.v14)
    ],
    products: [
        .library(name: "SecureTestCore", targets: ["SecureTestCore"])
    ],
    targets: [
        .target(
            name: "SecureTestCore",
            // KaTeX (ADR 0009, ported from PoC-B): vendored by
            // client/scripts/vendor-katex.mjs, inlined into the assessment
            // page by KatexBundle so the student sees math the way the
            // teacher's preview renders it.
            resources: [.copy("Resources/katex")]
        ),
        .testTarget(
            name: "SecureTestCoreTests",
            dependencies: ["SecureTestCore"]
        ),
    ]
)
