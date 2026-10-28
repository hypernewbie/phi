import Foundation
import XCTest
@testable import PhiTerminal

/// M0 wire gate: the pane endpoint's subprotocol, attach/checkpoint bootstrap,
/// ordered output, HTTP state fetch and resize, proved against a real server
/// when PHI_TEST_ORIGIN/PHI_TEST_PANE name the isolated instance.
final class WireCompatibilityTests: XCTestCase {
  func testContinuityFlagsGapsAndTrimsOverlap() {
    typealias Continuity = PaneWireClient.Continuity
    XCTAssertEqual(.deliver(start: 0, skip: 0), Continuity.step(start: 0, length: 4, frontier: 0))
    XCTAssertEqual(.deliver(start: 4, skip: 0), Continuity.step(start: 4, length: 2, frontier: 4))
    XCTAssertEqual(.deliver(start: 4, skip: 2), Continuity.step(start: 2, length: 4, frontier: 4))
    XCTAssertEqual(.duplicate, Continuity.step(start: 1, length: 3, frontier: 4))
    XCTAssertEqual(.gap(from: 4, to: 9), Continuity.step(start: 9, length: 1, frontier: 4))
  }

  func testMessageBoundAcceptsFourMiBAndRejectsOneByteMore() {
    XCTAssertNoThrow(try PaneWireClient.validateMessage(Data(count: 4 << 20)))
    XCTAssertThrowsError(try PaneWireClient.validateMessage(Data(count: (4 << 20) + 1)))
    XCTAssertThrowsError(try PaneWireClient.validateMessage(Data()))
  }

  func testSubprotocolGuardRejectsMissingAndWrongSelection() async throws {
    let client = try PaneWireClient(origin: try XCTUnwrap(URL(string: "http://127.0.0.1:1")), paneID: "p")
    addTeardownBlock { await client.close() }

    do {
      try await client.validateSubprotocolSelected(nil)
      XCTFail("a socket with no selected subprotocol was admitted")
    } catch {
      XCTAssertEqual(error as? PaneWireError, .subprotocol(nil))
    }
    do {
      try await client.validateSubprotocolSelected("phi.events.protobuf.v1")
      XCTFail("a foreign subprotocol was admitted")
    } catch {
      XCTAssertEqual(error as? PaneWireError, .subprotocol("phi.events.protobuf.v1"))
    }
    try await client.validateSubprotocolSelected("phi.terminal.protobuf.v1")
    let delivery = await client.sendInput(Array("x".utf8))
    XCTAssertEqual(delivery, .neverSent, "input must not leave before attach")
    let resized = await client.sendResize(cols: 100, rows: 30)
    XCTAssertFalse(resized, "resize must not leave before attach")
  }

  func testRealServerAttachRestoresCheckpointAndOrdersOutput() async throws {
    let target = try realServer()
    let client = try PaneWireClient(origin: target.origin, paneID: target.pane)
    addTeardownBlock { await client.close() }
    let run = Task { await client.run() }
    addTeardownBlock { run.cancel() }

    try await waitFor { await client.status().attached }
    let status = await client.status()
    let attach = try XCTUnwrap(status.attach, "no attach state")
    let checkpoint = try XCTUnwrap(attach.checkpoint, "attach carried no checkpoint")
    XCTAssertEqual(checkpoint.kind, "ghostty-ready-v1")
    XCTAssertTrue((attach.oldest...attach.head).contains(checkpoint.through), "checkpoint outside the frontier")
    XCTAssertTrue((1...65535).contains(checkpoint.cols))
    XCTAssertTrue((1...65535).contains(checkpoint.rows))
    // Live frames can land between attach and this read, so the frontier only
    // has to reach the checkpoint; the gap check below proves ordering.
    XCTAssertGreaterThanOrEqual(
      status.frontier, checkpoint.through, "frontier must reach the checkpoint")

    // A marker no checkpoint can already hold: only live input produces it.
    let delivery = await client.sendInput(Array("echo wzq\r".utf8))
    XCTAssertEqual(delivery, .sentUnconfirmed)
    try await waitFor { await client.frame().rows.contains { $0.contains("wzq") } }
    let afterOutput = await client.status()
    XCTAssertTrue(afterOutput.gaps.isEmpty, "ordered delivery reported gaps: \(afterOutput.gaps)")

    let remote = try await client.fetchState()
    XCTAssertEqual(remote.checkpoint?.through, remote.head, "latest state must be at the head")
    let restored = try XCTUnwrap(TerminalSession(restoring: [UInt8](remote.data)))
    defer { restored.free() }
    XCTAssertTrue(rows(of: restored).contains { $0.contains("wzq") }, "fetched state lost the echo")
  }

  func testRealServerResizeRoundTrip() async throws {
    let target = try realServer()
    let client = try PaneWireClient(origin: target.origin, paneID: target.pane)
    addTeardownBlock { await client.close() }
    let run = Task { await client.run() }
    addTeardownBlock { run.cancel() }
    try await waitFor { await client.status().attached }

    let resized = await client.sendResize(cols: 100, rows: 30)
    XCTAssertTrue(resized)
    try await waitFor {
      guard let state = try? await client.fetchState() else { return false }
      return state.checkpoint?.cols == 100 && state.checkpoint?.rows == 30
    }
    _ = await client.sendResize(cols: 80, rows: 24)
  }

  func testRealServerRejectsSocketWithoutSubprotocol() async throws {
    let target = try realServer()
    var comps = URLComponents(url: target.origin, resolvingAgainstBaseURL: false)
    comps?.scheme = target.origin.scheme == "https" ? "wss" : "ws"
    comps?.path = "/ws/pane/\(target.pane)"
    comps?.query = "state=ghostty-ready-v1"
    let url = try XCTUnwrap(comps?.url)
    let session = URLSession(configuration: .ephemeral)
    addTeardownBlock { session.invalidateAndCancel() }
    // No Sec-WebSocket-Protocol header: the server must refuse before upgrade.
    let task = session.webSocketTask(with: url)
    task.resume()
    do {
      _ = try await task.receive()
      XCTFail("server accepted a socket without the terminal subprotocol")
    } catch {
      return
    }
  }

  private func realServer() throws -> (origin: URL, pane: String) {
    let env = ProcessInfo.processInfo.environment
    guard let origin = env["PHI_TEST_ORIGIN"].flatMap({ URL(string: $0) }),
          let pane = env["PHI_TEST_PANE"], !pane.isEmpty else {
      throw XCTSkip("set PHI_TEST_ORIGIN and PHI_TEST_PANE against the isolated server to run this test")
    }
    return (origin, pane)
  }

  private func waitFor(timeout: TimeInterval = 10, _ condition: () async -> Bool) async throws {
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
      if await condition() { return }
      try await Task.sleep(for: .milliseconds(50))
    }
    XCTFail("condition not reached within \(timeout)s")
  }

  private func rows(of terminal: TerminalSession) -> [String] {
    (0..<terminal.rowCount()).map { row in
      terminal.cells(inRow: row).map(\.text).joined()
    }
  }
}
