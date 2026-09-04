// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "PocCClient",
    platforms: [
        .macOS(.v14)
    ],
    products: [
        .executable(name: "PocCClient", targets: ["PocCClient"])
    ],
    targets: [
        .executableTarget(
            name: "PocCClient",
            path: "Sources/PocCClient"
        )
    ]
)
