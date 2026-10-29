import AppKit
@testable import PhiKit
import PhiWire
import SwiftTerm
import XCTest
@testable import PhiTerminal
@testable import PhiSwiftTermSpike

final class SwiftTermGeometryTests: XCTestCase {
  @MainActor
  func testStatusLabelStaysBelowTerminalWhenWindowGrows() throws {
    let controller = SpikeWindow()
    let nativeWindow = try XCTUnwrap(controller.window)
    defer {
      controller.closeSession()
      nativeWindow.close()
    }
    let contentView = try XCTUnwrap(nativeWindow.contentView)
    let label = try XCTUnwrap(contentView.subviews.compactMap { $0 as? NSTextField }.first)
    let initialHeight = contentView.bounds.height

    nativeWindow.setContentSize(NSSize(width: contentView.bounds.width, height: initialHeight + 200))
    contentView.layoutSubtreeIfNeeded()

    XCTAssertGreaterThan(contentView.bounds.height, initialHeight)
    XCTAssertEqual(label.frame.minY, 0, accuracy: 0.5)
    let terminalFrame = controller.terminalView.convert(controller.terminalView.bounds, to: contentView)
    XCTAssertLessThanOrEqual(label.frame.maxY, terminalFrame.minY + 0.5)
  }

  @MainActor
  func testRecordedGeometryStaysIndependentOfWindowLayout() throws {
    let controller = SpikeWindow()
    let window = try XCTUnwrap(controller.window)
    defer { controller.closeSession(); window.close() }
    let original = window.frame
    let connection = UUID()
    try controller.apply(.reset(
      connection: connection, epoch: 7, frontier: 0, cols: 80, rows: 24, bytes: Data()))
    XCTAssertEqual(controller.terminalView.terminalDimensions, TerminalDimensions(cols: 80, rows: 24))
    let text = String(repeating: "X", count: 80) + "Y"
    try controller.apply(.bytes(
      connection: connection, epoch: 7, start: 0, end: 81, data: Data(text.utf8)))
    XCTAssertEqual(controller.terminalView.visibleRowsText(0..<1).first, String(repeating: "X", count: 80))
    XCTAssertTrue(controller.terminalView.visibleRowsText(1..<2).first?.hasPrefix("Y") == true)
    try controller.apply(.resize(connection: connection, epoch: 7, position: 81, cols: 40, rows: 10))
    XCTAssertEqual(window.frame, original, "recorded geometry changed the user's window")
    window.setContentSize(NSSize(width: 1100, height: 700))
    window.contentView?.layoutSubtreeIfNeeded()
    XCTAssertEqual(controller.terminalView.terminalDimensions, TerminalDimensions(cols: 40, rows: 10))
  }

  @MainActor
  func testOnlyCurrentConnectionReadinessRestoresLocalGeometry() throws {
    let controller = SpikeWindow()
    let window = try XCTUnwrap(controller.window)
    defer { controller.closeSession(); window.close() }
    let connection = UUID()
    try controller.apply(.reset(
      connection: connection, epoch: 7, frontier: 0, cols: 80, rows: 24, bytes: Data()))
    var snapshot = PaneSession.Snapshot(
      frame: .init(cols: 80, rows: [], colored: []), cursor: nil,
      status: .init(attached: true, connectionID: UUID(), geometryRevision: 1), statusLine: "ready")
    controller.updateStatus(snapshot)
    XCTAssertEqual(controller.terminalView.terminalDimensions.cols, 80)
    snapshot.status.connectionID = connection
    controller.updateStatus(snapshot)
    XCTAssertGreaterThan(controller.terminalView.terminalDimensions.cols, 80)
    try controller.apply(.reset(
      connection: UUID(), epoch: 7, frontier: 0, cols: 40, rows: 10, bytes: Data()))
    controller.updateStatus(snapshot)
    XCTAssertEqual(controller.terminalView.terminalDimensions, TerminalDimensions(cols: 40, rows: 10))
  }

  @MainActor
  func testCachedReadyStatusCannotUndoNewRecordedGeometry() throws {
    let controller = SpikeWindow()
    let window = try XCTUnwrap(controller.window)
    defer { controller.closeSession(); window.close() }
    let connection = UUID()
    try controller.apply(.reset(
      connection: connection, epoch: 7, frontier: 0, cols: 80, rows: 24, bytes: Data()))
    let ready = PaneSession.Snapshot(
      frame: .init(cols: 80, rows: [], colored: []), cursor: nil,
      status: .init(attached: true, connectionID: connection, geometryRevision: 1), statusLine: "ready")
    controller.updateStatus(ready)
    try controller.apply(.resize(connection: connection, epoch: 7, position: 0, cols: 40, rows: 10))
    controller.updateStatus(ready)
    XCTAssertEqual(controller.terminalView.terminalDimensions, TerminalDimensions(cols: 40, rows: 10))
  }

  @MainActor
  func testResetAndClosePermanentlyShutDownRetiredViews() throws {
    let controller = SpikeWindow()
    let window = try XCTUnwrap(controller.window)
    defer { controller.closeSession(); window.close() }
    let original = controller.terminalView!
    var closed: Set<ObjectIdentifier> = []
    controller.closeTerminalView = { view in
      closed.insert(ObjectIdentifier(view))
      return view.updateUiClosed()
    }
    try controller.apply(.reset(
      connection: UUID(), epoch: 7, frontier: 0, cols: 80, rows: 24, bytes: Data()))
    XCTAssertTrue(closed.contains(ObjectIdentifier(original)))
    XCTAssertNil(original.terminalDelegate)
    let current = controller.terminalView!
    controller.closeSession()
    XCTAssertTrue(closed.contains(ObjectIdentifier(current)))
    XCTAssertNil(current.terminalDelegate)
  }

  @MainActor
  func testRetirementRetainsViewUntilShutdownReportsCompletion() async throws {
    let controller = SpikeWindow()
    let window = try XCTUnwrap(controller.window)
    defer { controller.closeSession(); window.close() }
    let original = controller.terminalView!
    var complete = false
    controller.closeTerminalView = { view in
      let closed = view.updateUiClosed()
      return view === original ? complete && closed : closed
    }
    try controller.apply(.reset(
      connection: UUID(), epoch: 7, frontier: 0, cols: 80, rows: 24, bytes: Data()))
    XCTAssertEqual(controller.retiringViews.count, 1)
    do {
      try controller.apply(.reset(
        connection: UUID(), epoch: 7, frontier: 0, cols: 40, rows: 10, bytes: Data()))
      XCTFail("another replacement bypassed outstanding teardown")
    } catch SpikeWindowError.staleConnection {}
    complete = true
    let deadline = ContinuousClock.now + .seconds(2)
    while !controller.retiringViews.isEmpty, ContinuousClock.now < deadline {
      try await Task.sleep(for: .milliseconds(10))
    }
    XCTAssertTrue(controller.retiringViews.isEmpty)
    XCTAssertNil(original.terminalDelegate)
  }

  @MainActor
  func testRejectedReplacementIsPermanentlyClosed() throws {
    let controller = SpikeWindow()
    let window = try XCTUnwrap(controller.window)
    defer { controller.closeSession(); window.close() }
    let original = controller.terminalView!
    var closed = 0
    controller.closeTerminalView = { view in closed += 1; return view.updateUiClosed() }
    do {
      try controller.apply(.reset(
        connection: UUID(), epoch: 7, frontier: 0, cols: 80, rows: 24,
        bytes: Data(repeating: 65, count: RecordingPage.maxPage + 1)))
      XCTFail("invalid reset was accepted")
    } catch SpikeWindowError.unsupportedGeometry {}
    XCTAssertEqual(closed, 1)
    XCTAssertTrue(controller.terminalView === original)
  }

  @MainActor
  func testUnsupportedGeometryKeepsPreviousDisplay() async throws {
    let view = SpikeTerminalView()
    let sink = ViewObservationSink(view)
    let client = try PaneWireClient(
      origin: URL(string: "http://127.0.0.1:1")!, paneID: "geometry-pane",
      useKeychain: false, checkpointKind: PaneWireClient.ansiKind,
      observer: { event in try await sink.apply(event) })
    addTeardownBlock { await client.close() }
    let connection = UUID()
    let originalRows = view.visibleRowsText(0..<1)

    do {
      _ = try await client.applyAttach(
        attach(cols: 1, rows: 24, through: 10, data: Data("bad".utf8)),
        connection: connection)
      XCTFail("a one-column checkpoint was accepted")
    } catch PaneWireError.protocolViolation {
      // The adapter rejects the checkpoint before asking the visible view to reset.
    }
    XCTAssertEqual(view.visibleRowsText(0..<1), originalRows)
    XCTAssertNil(view.connectionID)
    let invalidCheckpointStatus = await client.status()
    XCTAssertEqual(invalidCheckpointStatus.frontier, 0)

    _ = try await client.applyAttach(
      attach(cols: 2, rows: 1, through: 10, data: Data("base".utf8)),
      connection: connection)
    XCTAssertEqual(view.terminalDimensions, TerminalDimensions(cols: 2, rows: 1))
    let previousRows = view.visibleRowsText(0..<1)
    let invalidResize = RecordingPage(
      epoch: 7, start: 10, end: 12,
      resizes: [RecordingPage.Resize(at: 11, cols: 1, rows: 1)], data: Data("xy".utf8))
    do {
      try await client.applyRecordedPage(invalidResize, source: .boundary, connection: connection)
      XCTFail("a one-column resize marker was accepted")
    } catch PaneWireError.protocolViolation {
      // The whole page is validated before any bytes or geometry reach the view.
    }
    XCTAssertEqual(view.terminalDimensions, TerminalDimensions(cols: 2, rows: 1))
    XCTAssertEqual(view.visibleRowsText(0..<1), previousRows)
    let invalidResizeStatus = await client.status()
    XCTAssertEqual(invalidResizeStatus.frontier, 10)
  }

  private func attach(
    cols: UInt32, rows: UInt32, through: UInt64, data: Data
  ) -> Phi_Websocket_Terminal_V1_TerminalAttach {
    var wire = Phi_Websocket_Terminal_V1_TerminalAttach()
    wire.epoch = 7
    wire.oldest = 0
    wire.head = through
    var checkpoint = Phi_Websocket_Terminal_V1_TerminalCheckpoint()
    checkpoint.kind = PaneWireClient.ansiKind
    checkpoint.through = through
    checkpoint.cols = cols
    checkpoint.rows = rows
    checkpoint.data = data
    wire.checkpoint = checkpoint
    return wire
  }
}

@MainActor
private final class ViewObservationSink: @unchecked Sendable {
  private let view: SpikeTerminalView

  init(_ view: SpikeTerminalView) { self.view = view }

  func apply(_ event: TerminalObservation) throws {
    try view.apply(event)
  }
}
