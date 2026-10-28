// swift-tools-version: 6.0
import PackageDescription

/// Shared core for the macOS and iOS clients. The Ghostty VT engine ships as an
/// xcframework with macOS, iOS and iOS-simulator slices, so both apps link the
/// same build of the same engine.
let package = Package(
  name: "PhiCore",
  platforms: [.macOS(.v14), .iOS(.v17)],
  products: [
    .library(name: "PhiKit", targets: ["PhiKit"]),
    .library(name: "PhiTerminal", targets: ["PhiTerminal"]),
    .executable(name: "PhiProbe", targets: ["PhiProbe"]),
  ],
  dependencies: [
    .package(url: "https://github.com/apple/swift-protobuf.git", exact: "1.39.0"),
  ],
  targets: [
    .binaryTarget(name: "GhosttyVt", path: "Vendor/ghostty-vt.xcframework"),
    .target(
      name: "PhiWire",
      dependencies: [.product(name: "SwiftProtobuf", package: "swift-protobuf")],
      path: "Sources/PhiWire"
    ),
    .target(
      name: "PhiTerminal",
      dependencies: ["GhosttyVt", "PhiWire"],
      path: "Sources/PhiTerminal"
    ),
    .target(
      name: "PhiKit",
      dependencies: ["PhiTerminal"],
      path: "Sources/PhiKit"
    ),
    .executableTarget(
      name: "PhiProbe",
      dependencies: ["PhiTerminal", "PhiKit"],
      path: "Sources/PhiProbe"
    ),
    .testTarget(
      name: "PhiTerminalTests",
      dependencies: ["PhiTerminal", "PhiKit"],
      path: "Tests/PhiTerminalTests"
    ),
  ],
  swiftLanguageModes: [.v6]
)
