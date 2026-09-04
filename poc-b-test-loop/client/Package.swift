// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "PocBClient",
    platforms: [
        .macOS(.v14)
    ],
    products: [
        .executable(name: "PocBClient", targets: ["PocBClient"])
    ],
    targets: [
        .executableTarget(
            name: "PocBClient",
            path: "Sources/PocBClient",
            resources: [
                .process("Resources")
            ]
        )
    ]
)
