import Foundation
import XCTest

@testable import PhiSwiftTermSpike

/// Launch selection: a named pane, or the in-window catalog.
final class SpikeLaunchTests: XCTestCase {
  private var stateDirectory: URL!

  override func setUpWithError() throws {
    stateDirectory = URL(fileURLWithPath: NSTemporaryDirectory())
      .appendingPathComponent("spike-launch-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(
      at: stateDirectory, withIntermediateDirectories: false,
      attributes: [.posixPermissions: 0o700])
  }

  override func tearDownWithError() throws {
    try? FileManager.default.removeItem(at: stateDirectory)
  }

  private func parse(_ arguments: [String]) throws -> SpikeOptions {
    try SpikeOptions.parse(["--state-dir", stateDirectory.path] + arguments)
  }

  func testStateDirectoryAloneOpensTheCatalog() throws {
    XCTAssertEqual(try parse([]).launch, .catalog(nil))
  }

  func testNamedPaneAndServerOpenDirectly() throws {
    let options = try parse(["--server", "http://127.0.0.1:7070", "--pane", "pane-1"])
    XCTAssertEqual(options.launch, .pane(URL(string: "http://127.0.0.1:7070")!, "pane-1"))
  }

  func testAServerWithoutAPaneOpensTheCatalogThere() throws {
    XCTAssertEqual(
      try parse(["--server", "http://127.0.0.1:7070"]).launch,
      .catalog(URL(string: "http://127.0.0.1:7070")))
  }

  func testAPaneWithoutAServerIsRejected() {
    XCTAssertThrowsError(try parse(["--pane", "pane-1"]))
  }

  func testAnEmptyPaneIsRejected() {
    XCTAssertThrowsError(
      try parse(["--server", "http://127.0.0.1:7070", "--pane", ""]))
  }

  func testTheKeychainFlagStaysAccepted() throws {
    XCTAssertEqual(
      try parse(["--no-keychain"]).launch, .catalog(nil),
      "Earlier preview instructions pass --no-keychain; the preview never uses the Keychain.")
  }

  func testRepeatedFlagsAreRejected() {
    XCTAssertThrowsError(
      try parse(["--server", "http://a:1", "--server", "http://b:2", "--pane", "p"]))
  }

  func testOriginRejectsCredentialsQueryFragmentAndPath() {
    XCTAssertNil(SpikeOptions.origin(from: "http://user:secret@host:7070"))
    XCTAssertNil(SpikeOptions.origin(from: "http://host:7070?x=1"))
    XCTAssertNil(SpikeOptions.origin(from: "http://host:7070#frag"))
    XCTAssertNil(SpikeOptions.origin(from: "http://host:7070/phi"))
    XCTAssertNil(SpikeOptions.origin(from: "ftp://host:7070"))
    XCTAssertNil(SpikeOptions.origin(from: ""))
  }

  func testOriginAcceptsBareAndTrailingSlashForms() {
    XCTAssertEqual(SpikeOptions.origin(from: "https://host:7070"), URL(string: "https://host:7070"))
    XCTAssertEqual(SpikeOptions.origin(from: "http://host:7070/")?.host, "host")
  }

  func testMissingStateDirectoryIsRejected() {
    XCTAssertThrowsError(try SpikeOptions.parse([]))
  }

}

extension SpikeLaunchTests {
  func testAServerAloneOpensTheCatalogThere() throws {
    let options = try parse(["--server", "http://hyperion.example.ts.net:18640"])
    XCTAssertEqual(options.launch, .catalog(URL(string: "http://hyperion.example.ts.net:18640")))
  }
  func testAServerAloneOpensTheCatalogThereButNotACredentialledOne() throws {
    XCTAssertThrowsError(try parse(["--server", "http://user:secret@host:7070"]))
  }
}

extension SpikeLaunchTests {
  func testAMissingStateDirectoryIsCreatedPrivate() throws {
    let missing = URL(fileURLWithPath: NSTemporaryDirectory())
      .appendingPathComponent("phi-state-\(UUID().uuidString)", isDirectory: true)
    XCTAssertFalse(FileManager.default.fileExists(atPath: missing.path))
    defer { try? FileManager.default.removeItem(at: missing) }

    let options = try SpikeOptions.parse(["--state-dir", missing.path])

    XCTAssertEqual(options.stateDirectory.path, missing.standardizedFileURL.path)
    let attributes = try FileManager.default.attributesOfItem(atPath: missing.path)
    XCTAssertEqual(attributes[.type] as? FileAttributeType, .typeDirectory)
    XCTAssertEqual((attributes[.posixPermissions] as? NSNumber)?.intValue, 0o700)
  }
}
