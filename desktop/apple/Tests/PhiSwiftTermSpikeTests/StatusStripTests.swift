import AppKit
import Foundation
import XCTest

@testable import PhiSwiftTermSpike

final class StatusStripTests: XCTestCase {
  @MainActor
  func testTheStripDrawsItsText() throws {
    let strip = PhiStatusStrip(frame: NSRect(x: 0, y: 0, width: 600, height: 22))
    strip.text = "attached · epoch 42 · view 80×24"
    let path = URL(fileURLWithPath: NSTemporaryDirectory())
      .appendingPathComponent("strip-\(UUID().uuidString).png")
    defer { try? FileManager.default.removeItem(at: path) }
    _ = try SpikeUIDump.writePNG(of: strip, to: path)

    let rep = try XCTUnwrap(NSBitmapImageRep(data: Data(contentsOf: path)))
    var colours = Set<String>()
    for y in stride(from: 0, to: rep.pixelsHigh, by: 2) {
      for x in stride(from: 0, to: rep.pixelsWide, by: 2) {
        if let c = rep.colorAt(x: x, y: y) {
          colours.insert("\(Int(c.redComponent * 255)),\(Int(c.greenComponent * 255)),\(Int(c.blueComponent * 255))")
        }
      }
    }
    XCTAssertGreaterThan(colours.count, 2, "expected panel, hairline, and text: \(colours.sorted())")
  }
}
