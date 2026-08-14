// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "MDEditor",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [
        .library(name: "MDECore", targets: ["MDECore"]),
        .library(name: "MDEditorUI", targets: ["MDEditorUI"]),
        .library(name: "MDEHost", targets: ["MDEHost"]),
    ],
    targets: [
        // Built by scripts/build-rust.sh — macOS, device, and simulator slices.
        .binaryTarget(name: "CMDE", path: "MDECore.xcframework"),
        .target(name: "MDECore", dependencies: ["CMDE"]),
        .target(name: "MDEditorUI", dependencies: ["MDECore"]),
        // Host-side code shared verbatim by the iOS and macOS reference apps: the
        // extension manifest, the widget drawing, and the resource resolver.
        .target(name: "MDEHost", dependencies: ["MDECore", "MDEditorUI"]),
        .testTarget(name: "MDECoreTests", dependencies: ["MDECore"]),
        // Drives the real AppKit NSTextView and asserts on what it renders — the
        // macOS half of verifying the renderer, without needing a screenshot.
        .testTarget(
            name: "MDEditorUITests",
            dependencies: ["MDEditorUI", "MDEHost"],
            resources: [.copy("Fixtures")]
        ),
    ]
)
