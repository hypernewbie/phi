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
    XCTAssertEqual(try parse([]).launch, .catalog)
  }

  func testNamedPaneAndServerOpenDirectly() throws {
    let options = try parse(["--server", "http://127.0.0.1:7070", "--pane", "pane-1"])
    XCTAssertEqual(options.launch, .pane(URL(string: "http://127.0.0.1:7070")!, "pane-1"))
  }

  func testAServerWithoutAPaneIsRejected() {
    XCTAssertThrowsError(try parse(["--server", "http://127.0.0.1:7070"]))
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
      try parse(["--no-keychain"]).launch, .catalog,
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

  func testANonexistentStateDirectoryIsRejected() {
    let missing = stateDirectory.appendingPathComponent("absent", isDirectory: true)
    XCTAssertThrowsError(try SpikeOptions.parse(["--state-dir", missing.path]))
  }
}
