import AppKit
import Foundation
@testable import PhiKit
import SwiftTerm
import PhiWire
@testable import PhiTerminal
import XCTest
@testable import PhiSwiftTermSpike

final class LiveTerminalSpikeTests: XCTestCase {
  @MainActor
  func testExistingOutputAndInputRoundTrip() async throws {
    let server = try OwnedLoopbackServer.fromEnvironment()
    let stateDirectory = try makeStateDirectory()
    let pane = try await server.spawn()
    let view = SpikeTerminalView()
    let sink = TerminalObservationSink(view: view)
    let session = try PaneSession(
      origin: server.origin, paneID: pane.id, stateDir: stateDirectory,
      useKeychain: false, terminalObserver: { event in try await sink.apply(event) })
    connect(view, to: session)
    addOwnedTeardown(server: server, pane: pane, stateDirectory: stateDirectory, session: session)

    try await server.send(pane, text: "echo SPIKE_BEFORE_4729")
    session.resize(cols: view.terminalDimensions.cols, rows: view.terminalDimensions.rows)
    session.start()
    try await waitFor("attach and pre-attach output") {
      session.snapshot.status.attached && self.visibleRows(view).contains { $0.contains("SPIKE_BEFORE_4729") }
    }

    let result = "SPIKE_INPUT_RESULT_4729"
    view.send(data: Array("printf '\(result)\\n'\r".utf8)[...])
    try await waitFor("single user-input result") { self.exactRowCount(view, result) == 1 }
    XCTAssertEqual(exactRowCount(view, result), 1)
    let status = session.snapshot.status
    print("live existing-output/input: epoch \(status.attach?.epoch ?? 0) frontier \(status.frontier) view \(view.terminalDimensions.cols)x\(view.terminalDimensions.rows) result-count 1")
  }

  @MainActor
  func testResizeRoundTrip() async throws {
    let server = try OwnedLoopbackServer.fromEnvironment()
    let stateDirectory = try makeStateDirectory()
    let pane = try await server.spawn()
    let view = SpikeTerminalView()
    let sink = TerminalObservationSink(view: view)
    let session = try PaneSession(
      origin: server.origin, paneID: pane.id, stateDir: stateDirectory,
      useKeychain: false, terminalObserver: { event in try await sink.apply(event) })
    connect(view, to: session)
    addOwnedTeardown(server: server, pane: pane, stateDirectory: stateDirectory, session: session)
    session.resize(cols: view.terminalDimensions.cols, rows: view.terminalDimensions.rows)
    session.start()
    try await waitFor("initial attach") { session.snapshot.status.attached }

    let target = TerminalDimensions(cols: 100, rows: 32)
    let current = view.terminalDimensions
    let optimal = view.getOptimalFrameSize()
    view.setFrameSize(NSSize(
      width: optimal.width / CGFloat(current.cols) * CGFloat(target.cols),
      height: optimal.height / CGFloat(current.rows) * CGFloat(target.rows)))
    XCTAssertEqual(view.terminalDimensions, target)
    let epoch = try XCTUnwrap(session.snapshot.status.attach?.epoch)
    try await waitFor("server resize", timeout: .seconds(12)) {
      guard let geometry = try? await server.geometry(pane, epoch: epoch) else { return false }
      return geometry.cols == target.cols && geometry.rows == target.rows
    }
    let geometry = try await server.geometry(pane, epoch: epoch)
    XCTAssertEqual(geometry.cols, UInt32(view.terminalDimensions.cols))
    XCTAssertEqual(geometry.rows, UInt32(view.terminalDimensions.rows))
    print("live resize: epoch \(epoch) frontier \(session.snapshot.status.frontier) view \(view.terminalDimensions.cols)x\(view.terminalDimensions.rows) server \(geometry.cols)x\(geometry.rows)")
  }

  @MainActor
  func testNeverSentRollbackFailureRetainsInput() async throws {
    let server = try OwnedLoopbackServer.fromEnvironment()
    let stateDirectory = try makeStateDirectory()
    let pane = try await server.spawn()
    let view = SpikeTerminalView()
    let sink = TerminalObservationSink(view: view)
    let session = try PaneSession(
      origin: server.origin, paneID: pane.id, stateDir: stateDirectory,
      useKeychain: false, terminalObserver: { event in try await sink.apply(event) })
    let gate = HeldNonSend()
    connect(view, to: session)
    session.inputDeliveryOverride = { _ in await gate.wait() }
    addOwnedTeardown(server: server, pane: pane, stateDirectory: stateDirectory, session: session, gate: gate)
    session.resize(cols: view.terminalDimensions.cols, rows: view.terminalDimensions.rows)
    session.start()
    try await waitFor("initial attach") { session.snapshot.status.attached }

    let result = "SPIKE_ROLLBACK_RESULT_4729"
    let input = Array("printf '\(result)\\n'\r".utf8)
    view.send(data: input[...])
    try await waitFor("held non-send") { await gate.hasEntered() }
    let journalURL = stateDirectory.appendingPathComponent("actions-\(pane.id).json")
    try await waitFor("durable attempt receipt") {
      self.journalActions(at: journalURL)?.first?.delivery == .sentUnconfirmed
    }
    let reservation = try XCTUnwrap(journalActions(at: journalURL)?.first)
    XCTAssertEqual(reservation.rawBytes, Data(input))

    try FileManager.default.setAttributes([.posixPermissions: 0o500], ofItemAtPath: stateDirectory.path)
    await gate.release()
    try await waitFor("visible rollback storage error") {
      session.snapshot.statusLine.contains("input rollback not saved")
    }
    try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: stateDirectory.path)
    session.inputDeliveryOverride = nil

    try await waitFor("real-pane result after journal recovery", timeout: .seconds(15)) {
      self.exactRowCount(view, result) == 1
    }
    XCTAssertEqual(exactRowCount(view, result), 1)
    let recovered = try XCTUnwrap(journalActions(at: journalURL)?.first)
    XCTAssertEqual(recovered.id, reservation.id)
    XCTAssertEqual(recovered.rawBytes, Data(input))
    XCTAssertEqual(recovered.delivery, .sentUnconfirmed)
    print("live non-send rollback: reservation \(recovered.id) reused; raw-bytes \(input.count); result-count 1")
  }

  @MainActor
  func testPendingRecoveryCannotReverseAnotherInputsReceipt() async throws {
    let server = try OwnedLoopbackServer.fromEnvironment()
    let directory = try makeStateDirectory()
    let pane = try await server.spawn()
    do {
      let journal = try await ActionJournal.open(directory: directory, pane: pane.id)
      _ = try await journal.reserve("A", rawBytes: Data([65]))
    }
    let bootstrap = HeldNonSend()
    let pendingRead = HeldNonSend()
    let nonSend = HeldNonSend()
    let calls = DeliveryCalls()
    let view = SpikeTerminalView()
    let sink = TerminalObservationSink(view: view)
    let session = try PaneSession(
      origin: server.origin, paneID: pane.id, stateDir: directory, useKeychain: false,
      terminalObserver: { event in
        if case .reset = event { _ = await bootstrap.wait() }
        try await sink.apply(event)
      })
    session.pendingActionsReader = { journal in
      let actions = await journal.pending()
      _ = await pendingRead.wait()
      return actions
    }
    session.inputDeliveryOverride = { bytes in
      let occurrence = await calls.record(bytes)
      if bytes == [66], occurrence == 1 { return await nonSend.wait() }
      return .sentUnconfirmed
    }
    addOwnedTeardown(server: server, pane: pane, stateDirectory: directory, session: session, gate: nonSend)
    addTeardownBlock { await bootstrap.release(); await pendingRead.release() }
    session.start()
    try await waitFor("pending snapshot held before attach") { await pendingRead.hasEntered() }
    await bootstrap.release()
    try await waitFor("attached while pending recovery is suspended") { await session.client.status().attached }
    session.send(bytes: [66])
    try await Task.sleep(for: .milliseconds(200))
    let earlyCalls = await calls.total
    XCTAssertEqual(earlyCalls, 0, "a drain overtook pending recovery")
    await pendingRead.release()
    try await waitFor("pending recovery committed") { !session.retrying }
    try await waitFor("B held as a definite non-send") { await nonSend.hasEntered() }
    await nonSend.release()
    try await waitFor("B retried after definite non-send") { await calls.count([66]) == 2 }
    let aCalls = await calls.count([65])
    XCTAssertEqual(aCalls, 1, "A's attempted receipt was made retryable by B's non-send")
    print("live recovery/drain: A attempts \(aCalls); B attempts 2 (first definite non-send)")
  }

#if DEBUG
  @MainActor
  func testRealWindowCaptureAfterCatchupAndLocalResize() async throws {
    let server = try OwnedLoopbackServer.fromEnvironment()
    let directory = try makeStateDirectory()
    let pane = try await server.spawn()
    let script = server.workspace.appendingPathComponent("v" + String(UUID().uuidString.prefix(6)))
    addTeardownBlock {
      try await server.delete(pane)
      try? FileManager.default.removeItem(at: directory)
      try? FileManager.default.removeItem(at: script)
    }
    try "#!/bin/bash\nprintf '\\033[2J\\033[H\\033[31m'\nprintf '%080d' 0\nprintf 'Y\\r\\n\\033[32mWINDOW_FIXTURE_7319\\033[0m\\r\\n'\n"
      .write(to: script, atomically: true, encoding: .utf8)
    let probe = try PaneWireClient(
      origin: server.origin, paneID: pane.id, useKeychain: false,
      checkpointKind: PaneWireClient.ansiKind)
    let probing = Task { await probe.run() }
    addTeardownBlock { await probe.close(); probing.cancel() }
    try await server.send(pane, text: "bash \(script.lastPathComponent)")
    try await waitFor("column-sensitive fixture before window attach") {
      await probe.frame().rows.contains { $0.contains("WINDOW_FIXTURE_7319") }
    }
    await probe.close()
    probing.cancel()
    await probing.value

    let controller = SpikeWindow()
    let window = try XCTUnwrap(controller.window)
    let session = try PaneSession(
      origin: server.origin, paneID: pane.id, stateDir: directory, useKeychain: false,
      terminalObserver: { @MainActor [weak controller] event in
        guard let controller else { throw SpikeWindowError.staleConnection }
        try controller.apply(event)
      })
    addTeardownBlock { @MainActor in
      controller.closeSession()
      session.stop()
      window.close()
    }
    controller.start(session: session)
    try await waitFor("native window catch-up") {
      session.snapshot.status.attached && controller.terminalView.visibleRowsText(0..<4)
        .contains { $0.contains("WINDOW_FIXTURE_7319") }
    }
    let first = try await controller.exportDebugSnapshot(to: directory)
    let current = controller.terminalView.terminalDimensions
    let optimal = controller.terminalView.getOptimalFrameSize()
    window.setContentSize(NSSize(
      width: optimal.width / CGFloat(current.cols) * 100,
      height: optimal.height / CGFloat(current.rows) * 32 + 22))
    let epoch = try XCTUnwrap(session.snapshot.status.attach?.epoch)
    try await waitFor("native window and server at 100x32") {
      guard let size = try? await server.geometry(pane, epoch: epoch) else { return false }
      let view = controller.terminalView.terminalDimensions
      return view.cols == 100 && view.rows == 32 && size.cols == 100 && size.rows == 32
    }
    let second = try await controller.exportDebugSnapshot(to: directory)
    let root = ProcessInfo.processInfo.environment["PHI_TEST_CAPTURE_DIR"]
      .map { URL(fileURLWithPath: $0, isDirectory: true) } ?? server.workspace
    let evidence = root.appendingPathComponent("native-window-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(
      at: evidence, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    try FileManager.default.copyItem(at: first, to: evidence.appendingPathComponent("first"))
    try FileManager.default.copyItem(at: second, to: evidence.appendingPathComponent("second"))
    print("real native window: fixture observed before attach; local resize view/server 100x32; exports \(evidence.path)")
  }
#endif

  @MainActor
  func testConnectedRecoveryDefersLocalResizeUntilRecordedBytesFinish() async throws {
    let server = try OwnedLoopbackServer.fromEnvironment()
    let directory = try makeStateDirectory()
    let pane = try await server.spawn()
    let controller = SpikeWindow()
    let window = try XCTUnwrap(controller.window)
    let gate = HeldNonSend()
    let session = try PaneSession(
      origin: server.origin, paneID: pane.id, stateDir: directory, useKeychain: false,
      terminalObserver: { @MainActor [weak controller] event in
        guard let controller else { throw SpikeWindowError.staleConnection }
        try controller.apply(event)
        if case .resize = event { await gate.waitIfArmed() }
      })
    addOwnedTeardown(server: server, pane: pane, stateDirectory: directory, session: session, gate: gate)
    addTeardownBlock { @MainActor in controller.closeSession(); window.close() }
    controller.start(session: session)
    try await waitFor("live window before recovery") { session.snapshot.status.attached }
    let epoch = try XCTUnwrap(session.snapshot.status.attach?.epoch)
    try await waitFor("original viewport applied to server") {
      guard let size = try? await server.geometry(pane, epoch: epoch) else { return false }
      return size.cols == 125 && size.rows == 37
    }
    let remote = try await session.client.fetchState(kind: PaneWireClient.ansiKind)
    XCTAssertEqual(remote.oldest, 0)
    let status = await session.client.status()
    let connection = try XCTUnwrap(status.connectionID)
    var wire = Phi_Websocket_Terminal_V1_TerminalAttach()
    wire.epoch = epoch
    wire.oldest = 0
    wire.head = remote.head
    var checkpoint = Phi_Websocket_Terminal_V1_TerminalCheckpoint()
    checkpoint.kind = PaneWireClient.ansiKind
    checkpoint.through = 0
    checkpoint.cols = 80
    checkpoint.rows = 24
    wire.checkpoint = checkpoint
    _ = try await session.client.applyAttach(wire, connection: connection)
    await gate.arm()
    let recovery = Task {
      try await session.client.recover(
        from: 0, through: remote.head, historical: true, afterEventCursor: nil, connection: connection)
    }
    addTeardownBlock { await gate.release(); _ = try? await recovery.value }
    try await waitFor("connected recovery geometry held") { await gate.hasEntered() }
    window.setContentSize(NSSize(width: 800, height: 534))
    let resized = await session.client.sendResize(cols: 100, rows: 32)
    XCTAssertFalse(resized, "resize was sent during recorded-byte recovery")
    try await waitFor("recovery status reached window") { session.snapshot.status.recovering }
    XCTAssertEqual(controller.terminalView.terminalDimensions, TerminalDimensions(cols: 80, rows: 24))
    let during = try await server.geometry(pane, epoch: epoch)
    XCTAssertEqual(during.cols, 125)
    XCTAssertEqual(during.rows, 37)
    await gate.release()
    try await recovery.value
    try await waitFor("latest size applied after connected recovery") {
      guard let size = try? await server.geometry(pane, epoch: epoch) else { return false }
      let view = controller.terminalView.terminalDimensions
      return !session.snapshot.status.recovering && size.cols == 100 && size.rows == 32
        && view.cols == 100 && view.rows == 32
    }
  }

  @MainActor
  func testSupersededResizeCannotCommit() async throws {
    try await checkLateResize(reconnect: false)
  }

  @MainActor
  func testOldConnectionResizeCannotCommit() async throws {
    try await checkLateResize(reconnect: true)
  }

  @MainActor
  private func checkLateResize(reconnect: Bool) async throws {
    let server = try OwnedLoopbackServer.fromEnvironment()
    let pane = try await server.spawn()
    let client = try PaneWireClient(
      origin: server.origin, paneID: pane.id, useKeychain: false,
      checkpointKind: PaneWireClient.ansiKind)
    let held = HeldNonSend()
    await client.setResizeCompletionHook { cols, _ in
      if cols == 100 { _ = await held.wait() }
    }
    let running = Task { await client.run() }
    addTeardownBlock {
      await held.release()
      await client.close()
      running.cancel()
      try await server.delete(pane)
    }
    try await waitFor("initial resize attachment") { await client.status().attached }
    _ = await client.sendResize(cols: 80, rows: 24)
    let original = await client.status().connectionID
    let old = Task { await client.sendResize(cols: 100, rows: 30) }
    try await waitFor("old resize held after transport") { await held.hasEntered() }
    _ = await client.sendResize(cols: 80, rows: 24)
    if reconnect {
      await client.reconnectForTesting()
      try await waitFor("new socket attached") {
        let status = await client.status()
        return status.attached && status.connectionID != original
      }
      _ = await client.sendResize(cols: 80, rows: 24)
    }
    await held.release()
    let oldCommitted = await old.value
    XCTAssertFalse(oldCommitted, "late resize committed over the current request")
    let frame = await client.readFrame()
    XCTAssertEqual(frame?.cols, 80)
    XCTAssertEqual(frame?.rows, 24)
    let status = await client.status()
    let epoch = try XCTUnwrap(status.attach?.epoch)
    try await waitFor("latest server geometry") {
      guard let size = try? await server.geometry(pane, epoch: epoch) else { return false }
      return size.cols == 80 && size.rows == 24
    }
  }

  @MainActor
  private func connect(_ view: SpikeTerminalView, to session: PaneSession) {
    view.onInput = { [weak session] bytes in session?.send(bytes: bytes) }
    view.onGridResize = { [weak session] cols, rows in session?.resize(cols: cols, rows: rows) }
  }

  @MainActor
  private func addOwnedTeardown(
    server: OwnedLoopbackServer, pane: OwnedLoopbackServer.Pane,
    stateDirectory: URL, session: PaneSession, gate: HeldNonSend? = nil
  ) {
    addTeardownBlock {
      await gate?.release()
      try? FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: stateDirectory.path)
      await MainActor.run {
        session.inputDeliveryOverride = nil
        session.stop()
      }
      try await server.delete(pane)
      try? FileManager.default.removeItem(at: stateDirectory)
    }
  }

  @MainActor
  private func makeStateDirectory() throws -> URL {
    let directory = FileManager.default.temporaryDirectory
      .appendingPathComponent("phi-spike-live-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: directory.path)
    return directory
  }

  @MainActor
  private func waitFor(
    _ label: String, timeout: Duration = .seconds(10),
    condition: @escaping @MainActor () async -> Bool
  ) async throws {
    let deadline = ContinuousClock.now + timeout
    while ContinuousClock.now < deadline {
      if await condition() { return }
      try await Task.sleep(for: .milliseconds(50))
    }
    XCTFail("\(label) was not reached within \(timeout)")
  }

  @MainActor
  private func visibleRows(_ view: SpikeTerminalView) -> [String] {
    view.visibleRowsText(0..<view.terminalDimensions.rows)
  }

  @MainActor
  private func exactRowCount(_ view: SpikeTerminalView, _ value: String) -> Int {
    visibleRows(view).filter { $0.trimmingCharacters(in: .whitespacesAndNewlines) == value }.count
  }

  private func journalActions(at url: URL) -> [ActionJournal.Action]? {
    guard let data = try? Data(contentsOf: url),
          let snapshot = try? JSONDecoder().decode(ActionJournal.Snapshot.self, from: data) else {
      return nil
    }
    return snapshot.actions
  }
}

@MainActor
private final class TerminalObservationSink: @unchecked Sendable {
  private let view: SpikeTerminalView

  init(view: SpikeTerminalView) { self.view = view }

  func apply(_ event: TerminalObservation) throws {
    try view.apply(event)
  }
}

private actor DeliveryCalls {
  private var values: [[UInt8]: Int] = [:]
  var total: Int { values.values.reduce(0, +) }
  func record(_ bytes: [UInt8]) -> Int {
    values[bytes, default: 0] += 1
    return values[bytes]!
  }
  func count(_ bytes: [UInt8]) -> Int { values[bytes, default: 0] }
}

private actor HeldNonSend {
  private var armed = false
  func arm() { armed = true }
  func waitIfArmed() async {
    if armed { _ = await wait() }
  }
  private var entered = false
  private var released = false
  private var continuation: CheckedContinuation<Void, Never>?

  func wait() async -> InputDelivery {
    entered = true
    guard !released else { return .neverSent }
    await withCheckedContinuation { continuation = $0 }
    return .neverSent
  }

  func release() {
    released = true
    continuation?.resume()
    continuation = nil
  }

  func hasEntered() -> Bool { entered }
}
