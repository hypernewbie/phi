import Foundation
@testable import PhiKit

/// Builds and runs the Go oracle (`desktop/apple/TestSupport/oracle`) from the
/// repository's own engine pin, so a Swift gate compares against an independent
/// adapter and restore path instead of a fixture of itself (§9.2).
enum OracleRunner {
  struct Failure: Error, CustomStringConvertible {
    let message: String
    var description: String { message }
  }

  struct Binary: Sendable {
    let url: URL
    let root: URL

    func run(_ arguments: [String]) throws -> String {
      let process = Process()
      process.executableURL = url
      process.arguments = arguments
      process.currentDirectoryURL = root
      let pipe = Pipe()
      process.standardError = pipe
      process.standardOutput = pipe
      try process.run()
      let data = pipe.fileHandleForReading.readDataToEndOfFile()
      process.waitUntilExit()
      let text = String(decoding: data, as: UTF8.self)
      if process.terminationStatus != 0 {
        throw Failure(message: "oracle exited \(process.terminationStatus): \(text)")
      }
      return text
    }

    /// Decodes a capture directory's `state.bin` and returns its frame.
    func decodeCapture(_ directory: URL) throws -> FrameEvidence {
      let frameJSON = directory.appendingPathComponent("oracle-frame.json")
      _ = try run([
        "--ansi-state", directory.appendingPathComponent("state.bin").path,
        "--frame-json", frameJSON.path,
      ])
      return try FrameEvidence.decode(Data(contentsOf: frameJSON))
    }

    func decodeRaw(_ bytes: [UInt8], cols: UInt16, rows: UInt16) throws -> FrameEvidence {
      let directory = FileManager.default.temporaryDirectory
        .appendingPathComponent("phi-oracle-\(UUID().uuidString)")
      try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
      defer { try? FileManager.default.removeItem(at: directory) }
      let ansi = directory.appendingPathComponent("fixture.ansi")
      let frameJSON = directory.appendingPathComponent("oracle-frame.json")
      try Data(bytes).write(to: ansi)
      _ = try run([
        "--ansi-raw", ansi.path, "--cols", String(cols), "--rows", String(rows),
        "--frame-json", frameJSON.path,
      ])
      return try FrameEvidence.decode(Data(contentsOf: frameJSON))
    }
  }

  /// `go build` reuses its cache, so a per-test build costs about a second.
  static func build() throws -> Binary {
    let root = try repositoryRoot()
    let directory = FileManager.default.temporaryDirectory
      .appendingPathComponent("phi-oracle-build")
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let executable = directory.appendingPathComponent("oracle")
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
    process.arguments = ["go", "build", "-o", executable.path, "./desktop/apple/TestSupport/oracle"]
    process.currentDirectoryURL = root
    var environment = ProcessInfo.processInfo.environment
    environment["CGO_ENABLED"] = "1"
    process.environment = environment
    let pipe = Pipe()
    process.standardError = pipe
    process.standardOutput = pipe
    try process.run()
    let data = pipe.fileHandleForReading.readDataToEndOfFile()
    process.waitUntilExit()
    guard process.terminationStatus == 0 else {
      throw Failure(message: "go build of the oracle failed: \(String(decoding: data, as: UTF8.self))")
    }
    return Binary(url: executable, root: root)
  }

  /// Walks up from this file to the module root so the test needs no env hint.
  private static func repositoryRoot() throws -> URL {
    var directory = URL(fileURLWithPath: #filePath)
    for _ in 0..<8 {
      directory.deleteLastPathComponent()
      if FileManager.default.fileExists(atPath: directory.appendingPathComponent("go.mod").path) {
        return directory
      }
    }
    throw Failure(message: "go.mod not found above \(#filePath)")
  }
}
