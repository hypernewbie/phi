import AppKit
import XCTest
@testable import PhiTerminal
@testable import PhiMac

/// The grid is painted with Core Text. This renders it headlessly into a known
/// bitmap so the paint path has a check without screen-recording permission;
/// it does not prove on-screen compositing.
@MainActor
final class TerminalGridRenderTests: XCTestCase {
  private struct Image {
    let width: Int
    let height: Int
    let pixels: [UInt8]

    func rgb(_ x: Int, _ y: Int) -> (Double, Double, Double) {
      let i = (y * width + x) * 4
      return (Double(pixels[i]) / 255, Double(pixels[i + 1]) / 255, Double(pixels[i + 2]) / 255)
    }

    var backgroundColor: (Double, Double, Double) { rgb(width - 1, height - 1) }

    var inkPixels: Int {
      let bg = backgroundColor
      var count = 0
      for y in 0..<height {
        for x in 0..<width {
          let c = rgb(x, y)
          if abs(c.0 - bg.0) > 0.25 || abs(c.1 - bg.1) > 0.25 || abs(c.2 - bg.2) > 0.25 {
            count += 1
          }
        }
      }
      return count
    }

    var redPixels: Int {
      var count = 0
      for y in 0..<height {
        for x in 0..<width {
          let c = rgb(x, y)
          if c.0 - max(c.1, c.2) > 0.12 { count += 1 }
        }
      }
      return count
    }
  }

  private func sized(_ view: TerminalGridView, cols: Int, rows: Int) -> TerminalGridView {
    let cell = view.cellSize
    view.setFrameSize(NSSize(
      width: CGFloat(cols) * cell.width,
      height: CGFloat(rows) * cell.height + TerminalGridView.statusHeight
    ))
    return view
  }

  private func render(_ view: TerminalGridView) -> Image {
    let width = Int(view.bounds.width.rounded(.up))
    let height = Int(view.bounds.height.rounded(.up))
    var pixels = [UInt8](repeating: 0, count: width * height * 4)
    let space = CGColorSpace(name: CGColorSpace.sRGB)!
    pixels.withUnsafeMutableBytes { buffer in
      guard let ctx = CGContext(
        data: buffer.baseAddress, width: width, height: height,
        bitsPerComponent: 8, bytesPerRow: width * 4, space: space,
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
      ) else { return }
      let context = NSGraphicsContext(cgContext: ctx, flipped: false)
      NSGraphicsContext.saveGraphicsState()
      NSGraphicsContext.current = context
      view.draw(view.bounds)
      NSGraphicsContext.restoreGraphicsState()
    }
    return Image(width: width, height: height, pixels: pixels)
  }

  private func differingPixels(_ a: Image, _ b: Image) -> Int {
    guard a.width == b.width, a.height == b.height else { return 0 }
    var count = 0
    for y in 0..<a.height {
      for x in 0..<a.width {
        let (l, r) = (a.rgb(x, y), b.rgb(x, y))
        if abs(l.0 - r.0) > 0.1 || abs(l.1 - r.1) > 0.1 || abs(l.2 - r.2) > 0.1 { count += 1 }
      }
    }
    return count
  }

  func testPaintsTextAndRealForegroundColour() {
    let empty = render(sized(TerminalGridView(frame: .zero), cols: 12, rows: 2))
    XCTAssertGreaterThan(empty.pixels.count, 0)

    let plainView = sized(TerminalGridView(frame: .zero), cols: 12, rows: 2)
    plainView.apply(
      paneFrame: PaneWireClient.Frame(cols: 12, rows: ["hi there", ""], colored: []),
      cursor: nil, status: "test"
    )
    let plain = render(plainView)
    XCTAssertGreaterThan(plain.inkPixels, empty.inkPixels, "row text must be painted")
    XCTAssertEqual(plain.redPixels, 0, "plain text must not paint red")

    let redView = sized(TerminalGridView(frame: .zero), cols: 12, rows: 2)
    redView.apply(
      paneFrame: PaneWireClient.Frame(
        cols: 12, rows: ["hi there", ""],
        colored: [.init(row: 0, column: 0, text: "h", red: 204, green: 102, blue: 102)]
      ),
      cursor: nil, status: "test"
    )
    let red = render(redView)
    XCTAssertGreaterThan(red.redPixels, 0, "styled cell must paint its foreground colour")
  }

  func testCursorPaintsAInvertedCell() {
    let view = sized(TerminalGridView(frame: .zero), cols: 12, rows: 2)
    let frame = PaneWireClient.Frame(cols: 12, rows: ["ab", ""], colored: [])

    view.apply(paneFrame: frame, cursor: nil, status: "test")
    let without = render(view)

    view.apply(paneFrame: frame, cursor: (x: 1, y: 0), status: "test")
    let with = render(view)

    // A block cursor inverts a whole cell, so most of its pixels must change.
    let cellArea = Int(view.cellSize.width * view.cellSize.height)
    XCTAssertGreaterThan(differingPixels(without, with), cellArea / 2,
                         "cursor must paint an inverted cell")
  }

  // MARK: - Key encoding (no accessibility permission needed)

  private func key(_ characters: String, code: UInt16, flags: NSEvent.ModifierFlags = []) -> NSEvent {
    NSEvent.keyEvent(
      with: .keyDown, location: .zero, modifierFlags: flags, timestamp: 0,
      windowNumber: 0, context: nil, characters: characters,
      charactersIgnoringModifiers: characters, isARepeat: false, keyCode: code
    )!
  }

  func testKeyEncodingSendsPtyBytes() {
    XCTAssertEqual(TerminalGridView.encode(key("a", code: 0)), Array("a".utf8))
    XCTAssertEqual(TerminalGridView.encode(key("界", code: 0)), Array("界".utf8))
    XCTAssertEqual(TerminalGridView.encode(key("\r", code: 36)), [13])
    XCTAssertEqual(TerminalGridView.encode(key("\u{7f}", code: 51)), [0x7f])
    XCTAssertEqual(TerminalGridView.encode(key("\t", code: 48)), [9])
    XCTAssertEqual(TerminalGridView.encode(key("\u{1b}", code: 53)), [0x1b])
    XCTAssertEqual(TerminalGridView.encode(key("\u{f700}", code: 126)), Array("\u{1b}[A".utf8))
    XCTAssertEqual(TerminalGridView.encode(key("\u{3}", code: 8, flags: .control)), [3])
    XCTAssertEqual(TerminalGridView.encode(key("\r", code: 76)), Array("\r".utf8), "keypad enter")
    XCTAssertNil(TerminalGridView.encode(key("c", code: 8, flags: .command)), "⌘ stays with the app")
    XCTAssertNil(TerminalGridView.encode(key("\u{f700}", code: 126, flags: .command)))
  }
}
