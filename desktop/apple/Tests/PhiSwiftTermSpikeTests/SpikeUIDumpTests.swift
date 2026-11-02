import AppKit
import Foundation
import XCTest

@testable import PhiSwiftTermSpike

/// The DEBUG self-capture and the catalog's own display rules.
final class SpikeUIDumpTests: XCTestCase {
  private var workDirectory: URL!

  override func setUpWithError() throws {
    workDirectory = URL(fileURLWithPath: NSTemporaryDirectory())
      .appendingPathComponent("spike-ui-dump-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(
      at: workDirectory, withIntermediateDirectories: false,
      attributes: [.posixPermissions: 0o700])
  }

  override func tearDownWithError() throws {
    try? FileManager.default.removeItem(at: workDirectory)
  }

  @MainActor
  private func makeCatalog() -> SpikeCatalogWindow {
    SpikeCatalogWindow(stateDirectory: workDirectory, onAttach: { _, _, _ in nil })
  }

  @MainActor
  func testUnnamedPaneFallsBackToItsCoder() {
    XCTAssertEqual(SpikeCatalogWindow.displayName(title: "", coder: "bash"), "bash")
    XCTAssertEqual(SpikeCatalogWindow.displayName(title: nil, coder: "pi"), "pi")
    XCTAssertEqual(SpikeCatalogWindow.displayName(title: "deploy", coder: "bash"), "deploy")
  }

  @MainActor
  func testCatalogWindowDrawsItsOwnLabels() throws {
    let catalog = makeCatalog()
    catalog.showWindow(nil)
    XCTAssertEqual(catalog.catalogSummary.status, "Enter a server address, then press Connect.")

    let path = workDirectory.appendingPathComponent("catalog.png")
    guard let view = catalog.window?.contentView else { return XCTFail("no content view") }
    let bytes = try SpikeUIDump.writePNG(of: view, to: path)
    XCTAssertGreaterThan(bytes, 4_000, "a blank window compresses far smaller than a drawn one")

    guard let rep = NSBitmapImageRep(data: try Data(contentsOf: path)) else {
      return XCTFail("written file is not a PNG")
    }
    XCTAssertEqual(rep.pixelsWide, Int(view.bounds.width * (rep.pixelsWide > 700 ? 2 : 1)))
    // A drawn window has more than one colour: background, labels, controls.
    var colours = Set<String>()
    for y in stride(from: 0, to: rep.pixelsHigh, by: 7) {
      for x in stride(from: 0, to: rep.pixelsWide, by: 7) {
        if let colour = rep.colorAt(x: x, y: y) {
          colours.insert("\(colour.redComponent),\(colour.greenComponent),\(colour.blueComponent)")
        }
      }
    }
    XCTAssertGreaterThan(colours.count, 3, "expected background, text, and control colours")
    catalog.close()
  }

  @MainActor
  func testEnvironmentWithoutAPathRequestsNothing() {
    XCTAssertNil(SpikeUIDump.Request.fromEnvironment([:]))
    XCTAssertNil(SpikeUIDump.Request.fromEnvironment(["PHI_SPIKE_UI_DUMP": "relative.png"]))
  }

  @MainActor
  func testEnvironmentParsesTheRequest() throws {
    let request = try XCTUnwrap(
      SpikeUIDump.Request.fromEnvironment([
        "PHI_SPIKE_UI_DUMP": "/tmp/catalog.png",
        "PHI_SPIKE_UI_CONNECT": "http://127.0.0.1:7070",
        "PHI_SPIKE_UI_ATTACH": "1",
      ]))
    XCTAssertEqual(request.imagePath.path, "/tmp/catalog.png")
    XCTAssertEqual(request.connectOrigin?.host, "127.0.0.1")
    XCTAssertEqual(request.attachPanes, 1)
    let two = try XCTUnwrap(
      SpikeUIDump.Request.fromEnvironment([
        "PHI_SPIKE_UI_DUMP": "/tmp/catalog.png", "PHI_SPIKE_UI_ATTACH": "2",
      ]))
    XCTAssertEqual(two.attachPanes, 2, "a count attaches that many panes")
    let none = try XCTUnwrap(
      SpikeUIDump.Request.fromEnvironment(["PHI_SPIKE_UI_DUMP": "/tmp/catalog.png"]))
    XCTAssertEqual(none.attachPanes, 0)
  }

  @MainActor
  func testAnInvalidConnectOriginIsIgnored() throws {
    let request = try XCTUnwrap(
      SpikeUIDump.Request.fromEnvironment([
        "PHI_SPIKE_UI_DUMP": "/tmp/catalog.png",
        "PHI_SPIKE_UI_CONNECT": "not-an-origin",
      ]))
    XCTAssertNil(request.connectOrigin)
  }
}
