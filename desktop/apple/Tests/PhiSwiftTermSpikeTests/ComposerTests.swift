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

@MainActor
final class TabStripTests: XCTestCase {
  func testTheFirstTabIsActiveAndTheSelectionFollowsAClick() {
    let strip = PhiTabStrip()
    var selected: [String] = []
    strip.onSelect = { selected.append($0) }
    strip.items = [
      PhiTabStrip.Item(id: "a1", title: "bash"), PhiTabStrip.Item(id: "b2", title: "pi"),
    ]

    XCTAssertEqual(strip.activeID, "a1", "a fresh strip raises its first tab")
    XCTAssertEqual(strip.tab("a1")?.isActive, true)
    XCTAssertEqual(strip.tab("b2")?.isActive, false)

    strip.tab("b2")?.onSelect?("b2")
    strip.activeID = "b2"

    XCTAssertEqual(selected, ["b2"])
    XCTAssertEqual(strip.tab("b2")?.isActive, true)
    XCTAssertEqual(strip.tab("a1")?.isActive, false, "only one tab is raised")
  }

  func testTheCloseGlyphClosesItsOwnPaneAndTheTitleSelects() {
    let strip = PhiTabStrip()
    var closed: [String] = []
    strip.onClose = { closed.append($0) }
    strip.items = [
      PhiTabStrip.Item(id: "a1", title: "bash"), PhiTabStrip.Item(id: "b2", title: "pi"),
    ]
    strip.frame = NSRect(x: 0, y: 0, width: 600, height: PhiTabStrip.height)
    strip.layoutSubtreeIfNeeded()
    guard let tab = strip.tab("b2"), let other = strip.tab("a1") else {
      return XCTFail("both tabs must exist")
    }

    XCTAssertEqual(tab.hit(at: NSPoint(x: 20, y: 19)), .select)
    XCTAssertEqual(
      tab.hit(at: NSPoint(x: tab.bounds.width - 17, y: 19)), .close,
      "the × sits in the trailing inset")

    tab.onClose?()
    XCTAssertEqual(closed, ["b2"], "the × closes the tab it belongs to")
    other.onClose?()
    XCTAssertEqual(closed, ["b2", "a1"])
  }

  func testDroppingATabRemovesItsViewAndKeepsTheRest() {
    let strip = PhiTabStrip()
    strip.items = [
      PhiTabStrip.Item(id: "a1", title: "bash"), PhiTabStrip.Item(id: "b2", title: "pi"),
    ]
    strip.activeID = "b2"

    strip.items = [PhiTabStrip.Item(id: "b2", title: "pi")]

    XCTAssertNil(strip.tab("a1"))
    XCTAssertEqual(strip.activeID, "b2", "the raised tab stays raised when another closes")

    strip.items = []
    XCTAssertNil(strip.activeID)
  }

  func testASingleWideTabStopsAtTheMaximumWidth() {
    let strip = PhiTabStrip()
    strip.items = [PhiTabStrip.Item(id: "a1", title: "a very long pane title that cannot fit")]
    strip.frame = NSRect(x: 0, y: 0, width: 600, height: PhiTabStrip.height)
    strip.layoutSubtreeIfNeeded()

    let tab = strip.tab("a1")
    XCTAssertEqual(tab?.frame.height, PhiTabStrip.tabHeight)
    XCTAssertEqual(
      tab?.frame.width, PhiTabStrip.maximumTabWidth,
      "one tab stops at the 240-point maximum instead of spanning the bar")
    XCTAssertEqual(tab?.frame.maxY, PhiTabStrip.height, "tabs sit on the bar floor")
  }
}

@MainActor
final class TabStripRenderTests: XCTestCase {
  func testTheStripDrawsItsBarTheTabsAndTheAccentLine() throws {
    let strip = PhiTabStrip()
    strip.frame = NSRect(x: 0, y: 0, width: 600, height: PhiTabStrip.height)
    strip.items = [
      PhiTabStrip.Item(id: "a1", title: "bash"), PhiTabStrip.Item(id: "b2", title: "pi"),
    ]
    strip.activeID = "b2"
    strip.layoutSubtreeIfNeeded()

    guard let rep = strip.bitmapImageRepForCachingDisplay(in: strip.bounds) else {
      return XCTFail("no bitmap")
    }
    strip.cacheDisplay(in: strip.bounds, to: rep)
    // The raised tab carries the accent line; no other part of the strip is
    // that blue, so finding it anywhere proves the tab painted.
    var accentPixels = 0
    var brightPixels = 0
    for y in 0..<rep.pixelsHigh {
      for x in 0..<rep.pixelsWide {
        guard let colour = rep.colorAt(x: x, y: y)?.usingColorSpace(.sRGB) else { continue }
        if colour.blueComponent > 0.8 && colour.redComponent < 0.6 { accentPixels += 1 }
        if colour.brightnessComponent > 0.6 { brightPixels += 1 }
      }
    }
    XCTAssertGreaterThan(accentPixels, 100, "the raised tab shows the accent line")
    XCTAssertGreaterThan(brightPixels, 100, "the tab titles are drawn")
  }

}

@MainActor
final class MultiTabTests: XCTestCase {
  func testASecondTabShowsItsOwnTerminalAndTheFirstComesBack() throws {
    let window = SpikeWindow()
    guard let host = window.window else { return XCTFail("no window") }
    defer { window.closeSession(); host.close() }
    let container = try XCTUnwrap(
      host.contentView?.subviews.compactMap { $0.subviews.first(where: { $0 is SpikeTerminalView }) }
        .first?.superview)

    window.addTab(paneID: "a1", title: "bash")
    let first = window.terminalView
    XCTAssertTrue(container.subviews.contains { $0 === first })

    window.addTab(paneID: "b2", title: "pi")
    let second = window.terminalView
    XCTAssertFalse(first === second, "a second tab brings its own terminal")
    XCTAssertTrue(container.subviews.contains { $0 === second })
    XCTAssertFalse(container.subviews.contains { $0 === first }, "the hidden tab leaves the screen")

    window.selectTab(paneID: "a1")
    XCTAssertTrue(window.terminalView === first, "switching back shows the first terminal")
    XCTAssertTrue(container.subviews.contains { $0 === first })
    XCTAssertFalse(container.subviews.contains { $0 === second })

    XCTAssertEqual(window.contains(paneID: "a1"), true)
    XCTAssertEqual(window.contains(paneID: "b2"), true)
  }

  func testClosingOneTabLeavesTheOtherOpen() throws {
    let window = SpikeWindow()
    guard let host = window.window else { return XCTFail("no window") }
    var closedWithWindow = false
    window.onClose = { closedWithWindow = true }
    defer { window.closeSession(); host.close() }

    window.addTab(paneID: "a1", title: "bash")
    window.addTab(paneID: "b2", title: "pi")

    window.closeTab(paneID: "a1")

    XCTAssertFalse(window.contains(paneID: "a1"))
    XCTAssertTrue(window.contains(paneID: "b2"))
    XCTAssertFalse(closedWithWindow, "the window stays open while a tab remains")
    XCTAssertEqual(window.paneID, "b2", "the neighbour becomes active")
  }

  func testClosingTheLastTabClosesTheWindow() {
    let window = SpikeWindow()
    var closed = false
    window.onClose = { closed = true }
    window.addTab(paneID: "a1", title: "bash")

    window.closeTab(paneID: "a1")

    XCTAssertFalse(window.contains(paneID: "a1"))
    XCTAssertTrue(closed, "closing the last tab closes its window")
  }
}
