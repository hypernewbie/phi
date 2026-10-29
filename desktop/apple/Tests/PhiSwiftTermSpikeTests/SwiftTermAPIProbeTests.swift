import AppKit
import SwiftTerm
import XCTest
@testable import PhiSwiftTermSpike

final class SwiftTermAPIProbeTests: XCTestCase {
  @MainActor
  func testRawOutputFeedsAndCopiesTerminalText() throws {
    let view = ProbeTerminalView()
    view.feed(byteArray: Array("界A\u{1B}[31mred\u{1B}[0m e\u{301}".utf8)[...])

    XCTAssertEqual(view.visibleRowsText(0..<1), ["界Ared e\u{301}"])
  }

  @MainActor
  func testPublicGeometryPreservesModeAndClampsUnsupportedFrameSizes() throws {
    let view = ProbeTerminalView()
    let delegate = ProbeDelegate()
    view.terminalDelegate = delegate
    view.scrollerStyle = .overlay
    view.feed(byteArray: Array("\u{1B}[?1h".utf8)[...])

    XCTAssertEqual(view.terminalDimensions, TerminalDimensions(cols: 80, rows: 24))
    setFrameGeometry(view, cols: 100, rows: 30)
    XCTAssertEqual(view.terminalDimensions, TerminalDimensions(cols: 100, rows: 30))
    XCTAssertEqual(view.terminalInputStateSnapshot()?.applicationCursor, true)
    setFrameGeometry(view, cols: 80, rows: 24)
    XCTAssertEqual(view.terminalDimensions, TerminalDimensions(cols: 80, rows: 24))
    XCTAssertEqual(view.terminalInputStateSnapshot()?.applicationCursor, true)

    setFrameGeometry(view, cols: 0, rows: 24)
    XCTAssertEqual(view.terminalDimensions, TerminalDimensions(cols: 2, rows: 24))
    setFrameGeometry(view, cols: 1, rows: 24)
    XCTAssertEqual(view.terminalDimensions, TerminalDimensions(cols: 2, rows: 24))
    setFrameGeometry(view, cols: 2, rows: 24)
    XCTAssertEqual(view.terminalDimensions, TerminalDimensions(cols: 2, rows: 24))
    setFrameGeometry(view, cols: 2, rows: 0)
    XCTAssertEqual(view.terminalDimensions, TerminalDimensions(cols: 2, rows: 1))

    XCTAssertEqual(delegate.outboundSizes, [
      TerminalDimensions(cols: 100, rows: 30),
      TerminalDimensions(cols: 80, rows: 24),
      TerminalDimensions(cols: 2, rows: 24),
      TerminalDimensions(cols: 2, rows: 24),
      TerminalDimensions(cols: 2, rows: 1),
    ])
  }

  @MainActor
  func testParserReplyUsesSubclassOverrideAndNeverUserInputDelegate() throws {
    let view = ProbeTerminalView()
    let delegate = ProbeDelegate()
    view.terminalDelegate = delegate
    view.feed(byteArray: Array("\u{1B}[6n".utf8)[...])

    XCTAssertEqual(view.parserReplies.read(), Array("\u{1B}[1;1R".utf8))
    XCTAssertTrue(delegate.input.isEmpty)
  }

  @MainActor
  func testViewInputReachesSessionDelegateOnceWithoutChangingBytes() throws {
    let view = ProbeTerminalView()
    let delegate = ProbeDelegate()
    view.terminalDelegate = delegate
    let input: [UInt8] = [0x00, 0x1b, 0x5b, 0x41, 0xff]
    view.send(data: input[...])

    XCTAssertEqual(delegate.input, [input])
  }

  @MainActor
  private func setFrameGeometry(_ view: ProbeTerminalView, cols: Int, rows: Int) {
    let current = view.terminalDimensions
    let optimal = view.getOptimalFrameSize()
    let cellWidth = optimal.width / CGFloat(current.cols)
    let cellHeight = optimal.height / CGFloat(current.rows)
    view.setFrameSize(NSSize(
      width: cellWidth * CGFloat(cols), height: cellHeight * CGFloat(rows)))
  }
}

@MainActor
private final class ProbeTerminalView: TerminalView {
  let parserReplies = ByteCapture()

  init() {
    super.init(
      frame: .zero,
      font: NSFont.monospacedSystemFont(ofSize: 12, weight: .regular),
      options: TerminalOptions(cols: 80, rows: 24))
  }

  required init?(coder: NSCoder) {
    fatalError("init(coder:) has not been implemented")
  }

  nonisolated override func send(source: Terminal, data: ArraySlice<UInt8>) {
    parserReplies.append(contentsOf: data)
  }
}

@MainActor
private final class ProbeDelegate: TerminalViewDelegate {
  var input: [[UInt8]] = []
  var outboundSizes: [TerminalDimensions] = []

  func sizeChanged(source: TerminalView, newCols: Int, newRows: Int) {
    outboundSizes.append(source.terminalDimensions)
  }

  func setTerminalTitle(source: TerminalView, title: String) {}
  func hostCurrentDirectoryUpdate(source: TerminalView, directory: String?) {}

  func send(source: TerminalView, data: ArraySlice<UInt8>) {
    input.append(Array(data))
  }

  func scrolled(source: TerminalView, position: Double) {}
  func requestOpenLink(source: TerminalView, link: String, params: [String: String]) {}
  func bell(source: TerminalView) {}
  func clipboardCopy(source: TerminalView, content: Data) {}
  func clipboardRead(source: TerminalView) -> Data? { nil }
  func iTermContent(source: TerminalView, content: ArraySlice<UInt8>) {}
  func rangeChanged(source: TerminalView, startY: Int, endY: Int) {}
}

private final class ByteCapture: @unchecked Sendable {
  private let lock = NSLock()
  private var bytes: [UInt8] = []

  func append<S: Sequence>(contentsOf newBytes: S) where S.Element == UInt8 {
    lock.lock()
    bytes.append(contentsOf: newBytes)
    lock.unlock()
  }

  func read() -> [UInt8] {
    lock.lock()
    defer { lock.unlock() }
    return bytes
  }
}
