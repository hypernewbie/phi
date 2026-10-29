#if DEBUG
import AppKit
import Foundation
import PhiTerminal
import XCTest
@testable import PhiTerminal
@testable import PhiSwiftTermSpike

private struct DebugSnapshotPixelRegion {
  let x: Range<Int>
  let y: Range<Int>
}

final class DebugSnapshotTests: XCTestCase {
  @MainActor
  func testFixtureExportsReadablePNGAndViewportJSON() async throws {
    let stateDirectory = try makeStateDirectory()
    let window = SpikeWindow()
    let view = window.terminalView!
    let connection = UUID()
    let frontier: UInt64 = 9_007_199_254_740_993
    let fixtureText =
      "\u{1B}[?1h\u{1B}=\u{1B}[?2004h\u{1B}[?1003h\u{1B}[H"
      + "\u{1B}[1;31;44mCOLOR\u{1B}[0m WIDE 界A e\u{301}"
      + "\u{1B}[3;4H"
    let fixture = Data(fixtureText.utf8)
    try view.apply(.reset(
      connection: connection, epoch: 42, frontier: frontier,
      cols: 80, rows: 24, bytes: fixture))

    let nativeWindow = try XCTUnwrap(window.window)
    defer {
      window.closeSession()
      nativeWindow.close()
    }
    nativeWindow.orderOut(nil)
    XCTAssertFalse(nativeWindow.isVisible)
    XCTAssertTrue(view.window === nativeWindow)

    let firstExport = try await window.exportDebugSnapshot(to: stateDirectory)
    XCTAssertTrue(view.suspendsRenderingWhenNotVisible, "the original true setting must be restored")
    XCTAssertTrue(view.window === nativeWindow)
    let imageURL = firstExport.appendingPathComponent("terminal.png")
    let stateURL = firstExport.appendingPathComponent("state.json")
    let image = try XCTUnwrap(NSBitmapImageRep(data: Data(contentsOf: imageURL)))
    let stateData = try Data(contentsOf: stateURL)
    let state = try XCTUnwrap(JSONSerialization.jsonObject(with: stateData) as? [String: Any])

    XCTAssertLessThanOrEqual(stateData.count, RecordingPage.maxPage)
    XCTAssertEqual(Set(state.keys), [
      "format", "version", "timestamp", "captureKind", "status", "source",
      "viewport", "modes", "cachedSession", "image",
    ])
    XCTAssertEqual(state["format"] as? String, "phi-dev-snapshot-v1")
    XCTAssertEqual(state["version"] as? Int, 1)
    XCTAssertEqual(state["captureKind"] as? String, "appkit-view")
    XCTAssertEqual(state["status"] as? String, "success")
    let imageState = try XCTUnwrap(state["image"] as? [String: Any])
    XCTAssertEqual(imageState["exists"] as? Bool, true)
    XCTAssertNil(imageState["errorCode"])

    let source = try XCTUnwrap(state["source"] as? [String: Any])
    XCTAssertTrue(Set(source.keys).isSubset(of: ["connectionID", "epoch", "frontier"]))
    XCTAssertEqual(source["connectionID"] as? String, connection.uuidString)
    XCTAssertEqual(source["epoch"] as? String, "42")
    XCTAssertEqual(source["frontier"] as? String, String(frontier))

    let viewport = try XCTUnwrap(state["viewport"] as? [String: Any])
    XCTAssertEqual(Set(viewport.keys), [
      "cols", "rowCount", "capturedRange", "liveTopRow", "cursorRow", "cursorColumn", "rows",
    ])
    XCTAssertEqual(viewport["cols"] as? Int, 80)
    XCTAssertEqual(viewport["rowCount"] as? Int, 24)
    XCTAssertEqual(viewport["cursorRow"] as? Int, 2)
    XCTAssertEqual(viewport["cursorColumn"] as? Int, 3)
    let rows = try XCTUnwrap(viewport["rows"] as? [[String: Any]])
    let coloredRow: [String: Any] = try XCTUnwrap(rows.first(where: { row in
      (row["text"] as? String)?.contains("COLOR") == true
    }))
    XCTAssertEqual(Set(coloredRow.keys), ["absoluteRow", "text", "cellWidths", "isWrapped"])
    let text = try XCTUnwrap(coloredRow["text"] as? String)
    XCTAssertTrue(text.contains("界A"))
    XCTAssertTrue(text.contains("e\u{301}"))
    let widths = try XCTUnwrap(coloredRow["cellWidths"] as? [Int])
    XCTAssertTrue(widths.contains(2), "wide glyph's leading cell width must be retained")
    XCTAssertTrue(widths.contains(0), "wide glyph continuation width must be retained")
    XCTAssertEqual(coloredRow["isWrapped"] as? Bool, false)

    let modes = try XCTUnwrap(state["modes"] as? [String: Any])
    XCTAssertEqual(Set(modes.keys), [
      "alternateBuffer", "applicationCursor", "applicationKeypad", "bracketedPaste", "mouse",
    ])
    XCTAssertEqual(modes["alternateBuffer"] as? Bool, false)
    XCTAssertEqual(modes["applicationCursor"] as? Bool, true)
    XCTAssertEqual(modes["applicationKeypad"] as? Bool, true)
    XCTAssertEqual(modes["bracketedPaste"] as? Bool, true)
    XCTAssertEqual(modes["mouse"] as? String, "anyEvent")

    let scale = view.window?.backingScaleFactor ?? 1
    XCTAssertEqual(image.pixelsWide, Int(ceil(view.bounds.width * scale)))
    XCTAssertEqual(image.pixelsHigh, Int(ceil(view.bounds.height * scale)))
    let pixelRegions = firstRowPixelRegions(in: image, view: view)
    let fixtureRegion = try XCTUnwrap(pixelRegions.max {
      redPixels(in: $0, image: image) < redPixels(in: $1, image: image)
    })
    XCTAssertGreaterThan(
      redPixels(in: fixtureRegion, image: image), 0,
      "the known first-row COLOR cells must render red")

    view.suspendsRenderingWhenNotVisible = false
    let changedBytes = Data(
      "\u{1B}[s\u{1B}[1;1H\u{1B}[2K\u{1B}[1;32;44mFRESH\u{1B}[0m\u{1B}[u".utf8)
    let nextFrontier = frontier + UInt64(changedBytes.count)
    try window.apply(.bytes(
      connection: connection, epoch: 42, start: frontier, end: nextFrontier, data: changedBytes))
    XCTAssertFalse(nativeWindow.isVisible)
    XCTAssertTrue(view.window === nativeWindow)
    XCTAssertTrue(window.terminalView === view, "hidden output must update the same attached view")

    let secondExport = try await window.exportDebugSnapshot(to: stateDirectory)
    XCTAssertFalse(view.suspendsRenderingWhenNotVisible, "the original false setting must be restored")
    XCTAssertTrue(view.window === nativeWindow)
    let secondImage = try XCTUnwrap(NSBitmapImageRep(
      data: Data(contentsOf: secondExport.appendingPathComponent("terminal.png"))))
    XCTAssertGreaterThan(greenPixels(in: fixtureRegion, image: secondImage), 0)
    XCTAssertEqual(redPixels(in: fixtureRegion, image: secondImage), 0)
    let secondStateData = try Data(contentsOf: secondExport.appendingPathComponent("state.json"))
    let secondState = try XCTUnwrap(
      JSONSerialization.jsonObject(with: secondStateData) as? [String: Any])
    let secondViewport = try XCTUnwrap(secondState["viewport"] as? [String: Any])
    let secondRows = try XCTUnwrap(secondViewport["rows"] as? [[String: Any]])
    let freshRow = try XCTUnwrap(secondRows.first(where: {
      ($0["text"] as? String)?.contains("FRESH") == true
    }))
    XCTAssertFalse((freshRow["text"] as? String ?? "").contains("COLOR"))
    let secondSource = try XCTUnwrap(secondState["source"] as? [String: Any])
    XCTAssertEqual(secondSource["frontier"] as? String, String(nextFrontier))

    print("debug snapshot first hidden fixture export: \(firstExport.path)")
    print("debug snapshot second hidden fixture export: \(secondExport.path)")
  }

  @MainActor
  func testExportIsPrivateAndDoesNotSendInput() async throws {
    let stateDirectory = try makeStateDirectory()
    defer { try? FileManager.default.removeItem(at: stateDirectory) }
    let journal = try await ActionJournal.open(directory: stateDirectory, pane: "snapshot")
    _ = try await journal.reserve("keep this draft", rawBytes: Data([0, 0xFF]))
    let journalURL = await journal.fileURL
    let journalBefore = try Data(contentsOf: journalURL)

    let window = SpikeWindow()
    defer {
      window.closeSession()
      window.window?.close()
    }
    let view = window.terminalView!
    var inputCalls = 0
    var resizeCalls = 0
    view.onInput = { _ in inputCalls += 1 }
    view.onGridResize = { _, _ in resizeCalls += 1 }
    let dimensions = view.terminalDimensions

    let first = try await window.exportDebugSnapshot(to: stateDirectory)
    let second = try await window.exportDebugSnapshot(to: stateDirectory)

    XCTAssertNotEqual(first, second, "every request must get a fresh directory")
    XCTAssertEqual(permissions(of: first), 0o700)
    XCTAssertEqual(permissions(of: second), 0o700)
    for directory in [first, second] {
      XCTAssertEqual(permissions(of: directory.appendingPathComponent("terminal.png")), 0o600)
      XCTAssertEqual(permissions(of: directory.appendingPathComponent("state.json")), 0o600)
      let data = try Data(contentsOf: directory.appendingPathComponent("state.json"))
      let json = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
      XCTAssertEqual(Set(json.keys), [
        "format", "version", "timestamp", "captureKind", "status", "source",
        "viewport", "modes", "cachedSession", "image",
      ])
      XCTAssertNil(json["statusLine"])
      XCTAssertNil(json["input"])
      XCTAssertNil(json["origin"])
      XCTAssertNil(json["environment"])
      let source = try XCTUnwrap(json["source"] as? [String: Any])
      XCTAssertTrue(Set(source.keys).isSubset(of: ["connectionID", "epoch", "frontier"]))
      let viewport = try XCTUnwrap(json["viewport"] as? [String: Any])
      XCTAssertEqual(Set(viewport.keys), [
        "cols", "rowCount", "capturedRange", "liveTopRow", "cursorRow", "cursorColumn", "rows",
      ])
      let modes = try XCTUnwrap(json["modes"] as? [String: Any])
      XCTAssertEqual(Set(modes.keys), [
        "alternateBuffer", "applicationCursor", "applicationKeypad", "bracketedPaste", "mouse",
      ])
      let cached = try XCTUnwrap(json["cachedSession"] as? [String: Any])
      XCTAssertEqual(Set(cached.keys), ["cached", "attached", "reconnects", "gaps", "dropNotices"])
      XCTAssertEqual(cached["cached"] as? Bool, true)
    }
    XCTAssertEqual(try Data(contentsOf: journalURL), journalBefore)
    XCTAssertEqual(view.terminalDimensions, dimensions)
    XCTAssertEqual(inputCalls, 0)
    XCTAssertEqual(resizeCalls, 0)
  }

  @MainActor
  func testStorageFailureKeepsPreviousExportAndSessionUsable() async throws {
    let stateDirectory = try makeStateDirectory()
    defer {
      try? FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: stateDirectory.path)
      try? FileManager.default.removeItem(at: stateDirectory)
    }
    let window = SpikeWindow()
    defer {
      window.closeSession()
      window.window?.close()
    }
    let view = window.terminalView!
    let previous = try await window.exportDebugSnapshot(to: stateDirectory)
    let previousImage = try Data(contentsOf: previous.appendingPathComponent("terminal.png"))
    let previousState = try Data(contentsOf: previous.appendingPathComponent("state.json"))
    let dimensions = view.terminalDimensions

    try FileManager.default.setAttributes([.posixPermissions: 0o500], ofItemAtPath: stateDirectory.path)
    do {
      _ = try await window.exportDebugSnapshot(to: stateDirectory)
      XCTFail("snapshot storage failure was reported as success")
    } catch let error as DebugSnapshotError {
      XCTAssertEqual(error.code, "storage-unavailable")
    }
    try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: stateDirectory.path)

    XCTAssertEqual(try Data(contentsOf: previous.appendingPathComponent("terminal.png")), previousImage)
    XCTAssertEqual(try Data(contentsOf: previous.appendingPathComponent("state.json")), previousState)
    XCTAssertEqual(view.terminalDimensions, dimensions)
    let recovered = try await window.exportDebugSnapshot(to: stateDirectory)
    XCTAssertNotEqual(recovered, previous)
    XCTAssertTrue(FileManager.default.fileExists(atPath: recovered.appendingPathComponent("state.json").path))
  }

  @MainActor
  func testBoundsAndCloseRejectBeforeExport() async throws {
    XCTAssertThrowsError(try DebugSnapshotGeometry.pixelDimensions(bounds: .zero, scaleFactor: 1)) {
      XCTAssertEqual(($0 as? DebugSnapshotError)?.code, "invalid-bounds")
    }
    XCTAssertThrowsError(try DebugSnapshotGeometry.pixelDimensions(
      bounds: NSRect(x: 0, y: 0, width: 4097, height: 4097), scaleFactor: 1)) {
      XCTAssertEqual(($0 as? DebugSnapshotError)?.code, "bounds-too-large")
    }
    XCTAssertThrowsError(try DebugSnapshotGeometry.pixelDimensions(
      bounds: NSRect(x: 0, y: 0, width: CGFloat.infinity, height: 10), scaleFactor: 1)) {
      XCTAssertEqual(($0 as? DebugSnapshotError)?.code, "invalid-bounds")
    }

    let stateDirectory = try makeStateDirectory()
    defer { try? FileManager.default.removeItem(at: stateDirectory) }
    let window = SpikeWindow()
    defer { window.window?.close() }
    let view = window.terminalView!
    let connectionID = view.connectionID
    let epoch = view.epoch
    let frontier = view.sourceFrontier
    let dimensions = view.terminalDimensions
    let rows = view.visibleRowsText(0..<dimensions.rows)

    window.closeSession()
    do {
      _ = try await window.exportDebugSnapshot(to: stateDirectory)
      XCTFail("a late snapshot after close was accepted")
    } catch let error as DebugSnapshotError {
      XCTAssertEqual(error.code, "closed")
    }
    XCTAssertTrue(try FileManager.default.contentsOfDirectory(atPath: stateDirectory.path).isEmpty)
    XCTAssertEqual(view.connectionID, connectionID)
    XCTAssertEqual(view.epoch, epoch)
    XCTAssertEqual(view.sourceFrontier, frontier)
    XCTAssertEqual(view.terminalDimensions, dimensions)
    XCTAssertEqual(view.visibleRowsText(0..<dimensions.rows), rows)
  }

  @MainActor
  func testPreparationRestoresVisibilityOnCancellationCloseAndReset() async throws {
    let cancelDirectory = try makeStateDirectory()
    let cancelWindow = SpikeWindow()
    let cancelView = cancelWindow.terminalView!
    let cancelTask = Task { @MainActor in
      try await cancelWindow.exportDebugSnapshot(to: cancelDirectory)
    }
    let cancelPrepared = await waitForPreparation(cancelView)
    XCTAssertTrue(cancelPrepared)
    cancelTask.cancel()
    do {
      _ = try await cancelTask.value
      XCTFail("cancelled preparation completed an export")
    } catch is CancellationError {
    }
    XCTAssertTrue(cancelView.suspendsRenderingWhenNotVisible)
    XCTAssertTrue(try FileManager.default.contentsOfDirectory(atPath: cancelDirectory.path).isEmpty)
    cancelWindow.closeSession()
    cancelWindow.window?.close()
    try FileManager.default.removeItem(at: cancelDirectory)

    let closeDirectory = try makeStateDirectory()
    let closeWindow = SpikeWindow()
    let closeView = closeWindow.terminalView!
    let closeTask = Task { @MainActor in
      try await closeWindow.exportDebugSnapshot(to: closeDirectory)
    }
    let closePrepared = await waitForPreparation(closeView)
    XCTAssertTrue(closePrepared)
    closeWindow.closeSession()
    do {
      _ = try await closeTask.value
      XCTFail("closed preparation completed an export")
    } catch let error as DebugSnapshotError {
      XCTAssertEqual(error.code, "closed")
    }
    XCTAssertTrue(closeView.suspendsRenderingWhenNotVisible)
    XCTAssertTrue(try FileManager.default.contentsOfDirectory(atPath: closeDirectory.path).isEmpty)
    closeWindow.window?.close()
    try FileManager.default.removeItem(at: closeDirectory)

    let resetDirectory = try makeStateDirectory()
    let resetWindow = SpikeWindow()
    let retiredView = resetWindow.terminalView!
    let resetTask = Task { @MainActor in
      try await resetWindow.exportDebugSnapshot(to: resetDirectory)
    }
    let resetPrepared = await waitForPreparation(retiredView)
    XCTAssertTrue(resetPrepared)
    try resetWindow.apply(.reset(
      connection: UUID(), epoch: 43, frontier: 1, cols: 80, rows: 24,
      bytes: Data("replacement".utf8)))
    XCTAssertFalse(resetWindow.terminalView === retiredView)
    do {
      _ = try await resetTask.value
      XCTFail("retired-view preparation completed an export")
    } catch let error as DebugSnapshotError {
      XCTAssertEqual(error.code, "capture-unavailable")
    }
    XCTAssertTrue(retiredView.suspendsRenderingWhenNotVisible)
    XCTAssertTrue(try FileManager.default.contentsOfDirectory(atPath: resetDirectory.path).isEmpty)
    resetWindow.closeSession()
    resetWindow.window?.close()
    try FileManager.default.removeItem(at: resetDirectory)
  }

  @MainActor
  private func waitForPreparation(_ view: SpikeTerminalView) async -> Bool {
    let clock = ContinuousClock()
    let deadline = clock.now.advanced(by: .milliseconds(500))
    while view.suspendsRenderingWhenNotVisible, clock.now < deadline {
      try? await Task.sleep(for: .milliseconds(1))
    }
    return !view.suspendsRenderingWhenNotVisible
  }

  @MainActor
  private func makeStateDirectory() throws -> URL {
    let directory = FileManager.default.temporaryDirectory
      .appendingPathComponent("phi-debug-snapshot-test-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(
      at: directory, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
    return directory
  }

  private func permissions(of url: URL) -> Int? {
    guard let attributes = try? FileManager.default.attributesOfItem(atPath: url.path),
          let permissions = attributes[.posixPermissions] as? NSNumber else { return nil }
    return permissions.intValue
  }

  @MainActor
  private func firstRowPixelRegions(
    in image: NSBitmapImageRep, view: SpikeTerminalView
  ) -> [DebugSnapshotPixelRegion] {
    let dimensions = view.terminalDimensions
    let optimal = view.getOptimalFrameSize()
    let scale = view.window?.backingScaleFactor ?? 1
    let cellWidth = max(
      1, Int(ceil(optimal.width / CGFloat(dimensions.cols) * scale)))
    let cellHeight = max(
      1, Int(ceil(optimal.height / CGFloat(dimensions.rows) * scale)))
    let width = min(image.pixelsWide, cellWidth * 8)
    let height = min(image.pixelsHigh, cellHeight * 2)
    let x = 0..<width
    return [
      DebugSnapshotPixelRegion(x: x, y: 0..<height),
      DebugSnapshotPixelRegion(x: x, y: image.pixelsHigh - height..<image.pixelsHigh),
    ]
  }

  private func redPixels(in region: DebugSnapshotPixelRegion, image: NSBitmapImageRep) -> Int {
    countPixels(in: region, image: image) {
      $0.redComponent > 0.5 && $0.redComponent > $0.greenComponent * 1.5
    }
  }

  private func greenPixels(in region: DebugSnapshotPixelRegion, image: NSBitmapImageRep) -> Int {
    countPixels(in: region, image: image) {
      $0.greenComponent > 0.5 && $0.greenComponent > $0.redComponent * 1.5
    }
  }

  private func countPixels(
    in region: DebugSnapshotPixelRegion, image: NSBitmapImageRep, matching: (NSColor) -> Bool
  ) -> Int {
    var count = 0
    for y in region.y {
      for x in region.x {
        guard let color = image.colorAt(x: x, y: y)?.usingColorSpace(.deviceRGB) else { continue }
        if matching(color) { count += 1 }
      }
    }
    return count
  }
}
#endif
