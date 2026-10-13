// swift-tools-version: 5.9
import PackageDescription

// renderer-sign — signs and verifies the served renderer's manifest
// (docs/server-delivered-renderer-design.md 2.a, slice 3 commit 3).
//
// The signing / verifying logic lives in RendererSignCore so `swift test`
// can exercise it with software keys; the executable adds the Secure
// Enclave path (Touch ID), which no automated test can drive.
// CryptoKit + LocalAuthentication only — no third-party dependencies.
let package = Package(
    name: "renderer-sign",
    platforms: [
        .macOS(.v14)
    ],
    products: [
        .executable(name: "renderer-sign", targets: ["renderer-sign"])
    ],
    targets: [
        .target(name: "RendererSignCore"),
        .executableTarget(
            name: "renderer-sign",
            dependencies: ["RendererSignCore"]
        ),
        .testTarget(
            name: "RendererSignCoreTests",
            dependencies: ["RendererSignCore"]
        ),
    ]
)
