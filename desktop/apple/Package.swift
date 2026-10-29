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
    .executable(name: "PhiSwiftTermSpike", targets: ["PhiSwiftTermSpike"]),
  ],
  dependencies: [
    .package(url: "https://github.com/apple/swift-protobuf.git", exact: "1.39.0"),
    .package(url: "https://github.com/migueldeicaza/SwiftTerm.git", exact: "1.99.1"),
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
    .executableTarget(
      name: "PhiSwiftTermSpike",
      dependencies: ["PhiTerminal", "PhiKit", .product(name: "SwiftTerm", package: "SwiftTerm")],
      path: "Sources/PhiSwiftTermSpike",
      resources: [.copy("THIRD_PARTY_NOTICES.txt")]
    ),
    .testTarget(
      name: "PhiTerminalTests",
      dependencies: ["PhiTerminal", "PhiKit"],
      path: "Tests/PhiTerminalTests"
    ),
    .testTarget(
      name: "PhiSwiftTermSpikeTests",
      dependencies: [
        "PhiSwiftTermSpike", "PhiTerminal", "PhiKit",
        .product(name: "SwiftTerm", package: "SwiftTerm"),
      ],
      path: "Tests/PhiSwiftTermSpikeTests"
    ),
  ],
  swiftLanguageModes: [.v6]
)
