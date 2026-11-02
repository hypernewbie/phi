import AppKit
import Foundation
import XCTest

@testable import PhiSwiftTermSpike

/// The composer is what makes a distant pane usable: keystrokes stay local
/// and only a submitted prompt travels. These tests pin the bytes it sends.
final class PhiPromptTests: XCTestCase {
  private func string(_ text: String) -> String? {
    PhiPrompt.bytes(for: text).map { String(decoding: $0, as: UTF8.self) }
  }

  func testShortPromptTravelsAsTyped() {
    XCTAssertEqual(string("ls -la"), "ls -la\r")
  }

  func testSurroundingWhitespaceIsTrimmed() {
    XCTAssertEqual(string("  git status \n"), "git status\r")
  }

  func testEmptyPromptSendsNothing() {
    XCTAssertNil(PhiPrompt.bytes(for: ""))
    XCTAssertNil(PhiPrompt.bytes(for: "   \n "))
  }

  func testLongPromptRidesInBracketedPaste() {
    let prompt = "explain the diff between these two implementations"
    XCTAssertEqual(string(prompt), "\u{1B}[200~\(prompt)\u{1B}[201~\r")
  }

  func testMultilinePromptRidesInBracketedPaste() {
    XCTAssertEqual(string("one\ntwo"), "\u{1B}[200~one\ntwo\u{1B}[201~\r")
  }

  func testEscapeBytesInsideAPromptAreNeutralised() {
    XCTAssertEqual(string("a\n\u{1B}[31mb"), "\u{1B}[200~a\n\u{241B}[31mb\u{1B}[201~\r")
  }

  func testAShortPromptIsAlsoCleanedOfEscapeBytes() {
    XCTAssertEqual(string("a\u{1B}[2Jb"), "a\u{241B}[2Jb\r")
  }
}

final class ComposerTests: XCTestCase {
  @MainActor
  func testSendingClearsTheFieldOnlyWhenAccepted() {
    let composer = PhiComposerView(frame: NSRect(x: 0, y: 0, width: 600, height: 54))
    var sent: [String] = []
    composer.onSend = { text in
      sent.append(text)
      return false
    }

    composer.prompt = "make test"
    composer.send()
    XCTAssertEqual(sent, ["make test"])
    XCTAssertEqual(composer.prompt, "make test", "a refused send must keep the draft")

    composer.onSend = { text in
      sent.append(text)
      return true
    }
    composer.send()
    XCTAssertEqual(sent, ["make test", "make test"])
    XCTAssertEqual(composer.prompt, "")
  }

  @MainActor
  func testEnterSendsAndEscapeLeavesTheComposer() throws {
    let composer = PhiComposerView(frame: NSRect(x: 0, y: 0, width: 600, height: 54))
    var sent: [String] = []
    var escaped = 0
    composer.onSend = { sent.append($0); return true }
    composer.onEscape = { escaped += 1 }

    let editor = NSTextView()
    _ = composer.control(
      composer.field, textView: editor, doCommandBy: #selector(NSResponder.insertNewline(_:)))
    XCTAssertEqual(sent, [], "an empty draft is not sent, as in the web composer")

    composer.prompt = "uptime"
    _ = composer.control(
      composer.field, textView: editor, doCommandBy: #selector(NSResponder.insertNewline(_:)))
    XCTAssertEqual(sent, ["uptime"])

    XCTAssertTrue(
      composer.control(
        composer.field, textView: editor, doCommandBy: #selector(NSResponder.cancelOperation(_:))))
    XCTAssertEqual(escaped, 1)
  }

  @MainActor
  func testEmptyDraftIsNotOfferedToThePane() {
    let composer = PhiComposerView(frame: NSRect(x: 0, y: 0, width: 600, height: 54))
    var sent = 0
    composer.onSend = { _ in sent += 1; return true }

    composer.prompt = "   "
    composer.send()

    XCTAssertEqual(sent, 0)
  }
}

final class ComposerLayoutTests: XCTestCase {
  @MainActor
  func testComposerSitsBetweenTheTerminalAndTheStatusStrip() throws {
    let controller = SpikeWindow()
    let window = try XCTUnwrap(controller.window)
    let content = try XCTUnwrap(window.contentView)
    window.setContentSize(NSSize(width: 1000, height: 620))
    content.layoutSubtreeIfNeeded()
    defer {
      controller.closeSession()
      window.close()
    }

    let composer = try XCTUnwrap(content.subviews.compactMap { $0 as? PhiComposerView }.first)
    let strip = try XCTUnwrap(content.subviews.compactMap { $0 as? PhiStatusStrip }.first)
    let terminalFrame = controller.terminalView.convert(controller.terminalView.bounds, to: content)

    XCTAssertEqual(composer.frame.minY, 22, accuracy: 0.5, "the status strip keeps the bottom")
    XCTAssertEqual(composer.frame.height, PhiComposerView.barHeight, accuracy: 0.5)
    XCTAssertLessThanOrEqual(strip.frame.maxY, composer.frame.minY)
    XCTAssertEqual(
      terminalFrame.minY, composer.frame.maxY + SpikeWindow.terminalPadding, accuracy: 0.5,
      "the terminal keeps the same inset from the composer as from the window edges")
  }
}

final class ComposerDraftTests: XCTestCase {
  private let key = "phi.spike.draft.test-\(UUID().uuidString)"

  override func tearDown() {
    UserDefaults.standard.removeObject(forKey: key)
    super.tearDown()
  }

  @MainActor
  func testADraftSurvivesTheComposerAndIsClearedOnSend() throws {
    let first = PhiComposerView(frame: NSRect(x: 0, y: 0, width: 600, height: 54))
    first.draftKey = key
    first.prompt = "a long prompt in progress"
    XCTAssertEqual(
      UserDefaults.standard.string(forKey: key), "a long prompt in progress")

    let second = PhiComposerView(frame: NSRect(x: 0, y: 0, width: 600, height: 54))
    second.draftKey = key
    XCTAssertEqual(second.prompt, "a long prompt in progress")

    second.onSend = { _ in true }
    second.send()
    XCTAssertNil(UserDefaults.standard.string(forKey: key), "a sent draft is not restored next time")
  }

  @MainActor
  func testTheWindowKeepsTheComposerWideEnoughToUse() throws {
    let controller = SpikeWindow()
    let window = try XCTUnwrap(controller.window)
    defer {
      controller.closeSession()
      window.close()
    }
    XCTAssertGreaterThanOrEqual(
      window.contentMinSize.width, PhiComposerView.minimumWidth,
      "a narrower window would push the Send button over the field")
  }
}
