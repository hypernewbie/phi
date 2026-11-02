import AppKit
import Foundation
import XCTest

@testable import PhiSwiftTermSpike

/// Copy, paste, scrollback, and focus are what make the terminal usable with a
/// keyboard, so each one is exercised through the same calls the menu makes.
final class TerminalInteractionTests: XCTestCase {
  private let connection = UUID()

  override func setUp() {
    super.setUp()
    NSPasteboard.general.clearContents()
  }

  @MainActor
  private func makeView(text: String) throws -> SpikeTerminalView {
    let view = SpikeTerminalView()
    try view.apply(
      .reset(
        connection: connection, epoch: 1, frontier: UInt64(text.utf8.count),
        cols: 80, rows: 24, bytes: Data(text.utf8)))
    return view
  }

  @MainActor
  func testCopyPutsTheSelectedTextOnThePasteboard() throws {
    let view = try makeView(text: "hello selection\r\n")

    view.selectAll(nil)
    view.copy(self)

    let copied = try XCTUnwrap(NSPasteboard.general.string(forType: .string))
    XCTAssertTrue(copied.contains("hello selection"), "copied text was \(copied.debugDescription)")
  }

  @MainActor
  func testPasteSendsThePasteboardTextToThePane() throws {
    let view = try makeView(text: "$ ")
    var sent: [UInt8] = []
    view.onInput = { sent.append(contentsOf: $0) }

    NSPasteboard.general.clearContents()
    NSPasteboard.general.setString("printf ok", forType: .string)
    view.paste(self)

    // Input reaches the pane through the main-actor delivery queue.
    let deadline = Date().addingTimeInterval(2)
    while sent.isEmpty, Date() < deadline {
      RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.01))
    }
    XCTAssertEqual(String(decoding: sent, as: UTF8.self), "printf ok")
  }

  @MainActor
  func testOldLinesSurviveInScrollback() throws {
    let lines = (1...1_200).map { "line-\($0)" }.joined(separator: "\r\n")
    let view = try makeView(text: lines + "\r\n")

    XCTAssertGreaterThan(SpikeTerminalView.scrollbackLines, 1_200)
    view.selectAll(nil)
    view.copy(self)

    let copied = try XCTUnwrap(NSPasteboard.general.string(forType: .string))
    XCTAssertTrue(copied.hasPrefix("line-1"), "the oldest line is missing from \(copied.count) copied characters: \(copied.prefix(40).debugDescription)")
    XCTAssertTrue(copied.contains("line-1200"))
  }

  @MainActor
  func testRepliesToServerQueriesAreNotEchoed() throws {
    var sent: [UInt8] = []
    let view = SpikeTerminalView()
    view.onInput = { sent.append(contentsOf: $0) }
    // Device status and attribute queries: the server answered both already.
    try view.apply(
      .reset(
        connection: connection, epoch: 1, frontier: 4, cols: 80, rows: 24,
        bytes: Data("\u{1B}[6n".utf8)))

    XCTAssertGreaterThan(view.discardedParserReplies.count, 0, "the local parser should have replied")
    XCTAssertTrue(sent.isEmpty, "a reply to the server\u{27}s stream must not reach the pane")
  }

  @MainActor
  func testTheTerminalCanTakeFocus() throws {
    let controller = SpikeWindow()
    let window = try XCTUnwrap(controller.window)
    let view = try XCTUnwrap(controller.terminalView)
    defer {
      controller.closeSession()
      window.close()
    }

    XCTAssertTrue(window.makeFirstResponder(view))
    XCTAssertTrue(window.firstResponder === view, "keystrokes would go nowhere")
  }
}
