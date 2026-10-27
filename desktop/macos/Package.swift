// swift-tools-version: 6.0
import Foundation
import PackageDescription

// Package.swift lives at <repo>/desktop/macos/Package.swift.
let packageDir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
let repoRoot = packageDir.deletingLastPathComponent().deletingLastPathComponent().path
let includeDir = "\(repoRoot)/native/libghostty-vt/include"

guard let arch = ProcessInfo.processInfo.environment["PHI_MACOS_ARCH"],
      arch == "arm64" || arch == "x86_64" else {
  fatalError("PHI_MACOS_ARCH must be explicitly arm64 or x86_64")
}

let archiveDir = "\(repoRoot)/native/libghostty-vt/\(arch == "arm64" ? "darwin-arm64" : "darwin-amd64")"
let archivePath = "\(archiveDir)/libghostty-vt.a"

guard FileManager.default.fileExists(atPath: archivePath) else {
  fatalError("missing Ghostty archive: \(archivePath)")
}

let package = Package(
  name: "PhiMacOS",
  platforms: [.macOS(.v14)],
  products: [
    .executable(name: "PhiProbe", targets: ["PhiProbe"]),
  ],
  dependencies: [
    .package(url: "https://github.com/apple/swift-protobuf.git", exact: "1.39.0"),
  ],
  targets: [
    .systemLibrary(name: "CGhosttyVT", path: "Sources/CGhosttyVT"),
    .target(
      name: "PhiWire",
      dependencies: [.product(name: "SwiftProtobuf", package: "swift-protobuf")],
      path: "Sources/PhiWire"
    ),
    .target(
      name: "PhiTerminal",
      dependencies: ["CGhosttyVT", "PhiWire"],
      swiftSettings: [.unsafeFlags(["-Xcc", "-I\(includeDir)"])],
      linkerSettings: [
        .unsafeFlags([archivePath]),
        .linkedLibrary("m"),
        .linkedLibrary("pthread"),
      ]
    ),
    .executableTarget(
      name: "PhiProbe",
      dependencies: ["PhiTerminal"],
      swiftSettings: [.unsafeFlags(["-Xcc", "-I\(includeDir)"])]
    ),
    .testTarget(
      name: "PhiTerminalTests",
      dependencies: ["PhiTerminal"],
      swiftSettings: [.unsafeFlags(["-Xcc", "-I\(includeDir)"])]
    ),
  ],
  swiftLanguageModes: [.v6]
)
