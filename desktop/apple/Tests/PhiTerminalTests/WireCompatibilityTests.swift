import Foundation
import PhiWire
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

  /// A hole in the live stream must be healed from the recording, never skipped
  /// (`internal/phic/tui_pane.go:652–700`). The frame is injected because a real
  /// socket delivers every span in order, so a real gap needs a real stall.
  func testRealServerHealsAMidStreamGapFromTheRecording() async throws {
    let target = try realServer()
    let client = try PaneWireClient(origin: target.origin, paneID: target.pane)
    addTeardownBlock { await client.close() }
    let run = Task { await client.run() }
    addTeardownBlock { run.cancel() }

    try await waitFor("attach") { await client.status().attached }
    let delivery = await client.sendInput(Array("echo gapheal\r".utf8))
    XCTAssertEqual(delivery, .sentUnconfirmed)
    try await waitFor("live echo") { await client.frame().rows.contains { $0.contains("gapheal") } }

    // Stop reading, then make the server produce bytes this client never sees.
    await client.stop()
    try await Task.sleep(for: .milliseconds(200))
    let before = await client.status()
    try await postInput("echo gapsrc\r", to: target)
    var head = before.frontier
    try await waitFor("server head ahead of the frontier") {
      guard let state = try? await client.fetchState() else { return false }
      head = state.head
      return head > before.frontier
    }

    var output = Phi_Websocket_Terminal_V1_TerminalOutput()
    output.start = head
    output.data = Data("x".utf8)
    try await client.applyOutput(output)

    let after = await client.status()
    XCTAssertEqual(after.gaps, [PaneWireClient.OutputGap(from: before.frontier, to: head)])
    XCTAssertEqual(after.frontier, head + 1, "the hole and this frame must both be applied")
    let healed = await client.frame()
    XCTAssertTrue(
      healed.rows.contains { $0.contains("gapsrc") },
      "the healed span must be the recording's bytes")
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

  /// Input straight over HTTP, so bytes reach the pane while the socket client
  /// is deliberately not reading.
  private func postInput(_ text: String, to target: (origin: URL, pane: String)) async throws {
    var comps = URLComponents(url: target.origin, resolvingAgainstBaseURL: false)
    comps?.path = "/api/terminals/\(target.pane)/input"
    var request = URLRequest(url: try XCTUnwrap(comps?.url))
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "content-type")
    request.httpBody = try JSONSerialization.data(withJSONObject: ["text": text])
    let (_, response) = try await URLSession.shared.data(for: request)
    let status = (response as? HTTPURLResponse)?.statusCode ?? 0
    XCTAssertTrue((200...299).contains(status), "fixture input answered \(status)")
  }

  private func realServer() throws -> (origin: URL, pane: String) {
    let env = ProcessInfo.processInfo.environment
    guard let origin = env["PHI_TEST_ORIGIN"].flatMap({ URL(string: $0) }),
          let pane = env["PHI_TEST_PANE"], !pane.isEmpty else {
      throw XCTSkip("set PHI_TEST_ORIGIN and PHI_TEST_PANE against the isolated server to run this test")
    }
    return (origin, pane)
  }

  private func waitFor(
    _ label: String = "condition", timeout: TimeInterval = 10, _ condition: () async -> Bool
  ) async throws {
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
      if await condition() { return }
      try await Task.sleep(for: .milliseconds(50))
    }
    XCTFail("\(label) not reached within \(timeout)s")
  }

  /// A password-protected server must be reachable, and an unauthenticated
  /// client must fail with a named reason instead of an unexplained 401.
  func testRealServerAccessPasswordLoginsAttaches() async throws {
    let target = try realServer()
    guard let password = ProcessInfo.processInfo.environment["PHI_TEST_PASSWORD"],
          !password.isEmpty else {
      throw XCTSkip("set PHI_TEST_PASSWORD to exercise access-password login")
    }
    let service = "phi-access-test"
    let account = "access-\(target.origin.absoluteString)"
    addTeardownBlock { Keychain.delete(service: service, account: account) }

    let salt = (0..<AccessAuth.saltBytes).map { _ in UInt8.random(in: 0...255) }
    let verifier = try XCTUnwrap(AccessAuth.pbkdf2SHA256(
      password: Array(password.utf8), salt: salt, iterations: AccessAuth.iterations))
    let hash = AccessAuth.passwordHash(
      verifier: verifier, salt: salt, iterations: AccessAuth.iterations)
    let enabled = await Self.post(
      target.origin, "/api/auth/password", ["password_hash": hash], cookie: nil)
    XCTAssertEqual(enabled, 200, "enabling the access password on the isolated server failed")

    // The session token is fetched first so cleanup can disable the password
    // even if a later assertion fails, instead of breaking every later test.
    let auth = AccessAuth(origin: target.origin, useKeychain: false, password: { password })
    let session = try await auth.token(force: true)
    let sessionToken = try XCTUnwrap(session, "password was not enabled")
    addTeardownBlock {
      _ = await Self.post(
        target.origin, "/api/auth/password", ["password_hash": ""],
        cookie: "\(AccessAuth.cookieName)=\(sessionToken)")
    }

    let client = try PaneWireClient(
      origin: target.origin, paneID: target.pane, useKeychain: true,
      keychainService: service, password: { password })
    addTeardownBlock { await client.close() }
    let run = Task { await client.run() }
    addTeardownBlock { run.cancel() }
    try await waitFor { await client.status().attached }

    let delivery = await client.sendInput(Array("echo pwe\r".utf8))
    XCTAssertEqual(delivery, .sentUnconfirmed)
    try await waitFor { await client.frame().rows.contains { $0.contains("pwe") } }

    // The verifier, not the password, is what a later launch reuses.
    if Keychain.read(service: service, account: account) != nil {
      let relaunched = try PaneWireClient(
        origin: target.origin, paneID: target.pane, useKeychain: true,
        keychainService: service, password: nil)
      addTeardownBlock { await relaunched.close() }
      let relaunchRun = Task { await relaunched.run() }
      addTeardownBlock { relaunchRun.cancel() }
      try await waitFor { await relaunched.status().attached }
    } else {
      throw XCTSkip("keychain unavailable; verifier reuse not exercised")
    }

    let anonymous = try PaneWireClient(
      origin: target.origin, paneID: target.pane, useKeychain: false, password: nil)
    addTeardownBlock { await anonymous.close() }
    let anonymousRun = Task { await anonymous.run() }
    addTeardownBlock { anonymousRun.cancel() }
    try await waitFor { await anonymous.status().lastError != nil }
    let anonymousStatus = await anonymous.status()
    XCTAssertFalse(anonymousStatus.attached, "an anonymous client must not attach")
    let reason = anonymousStatus.lastError ?? ""
    XCTAssertTrue(
      reason.contains("accessDenied") || reason.contains("noPassword"),
      "unexpected refusal: \(reason)")
  }

  private static func post(
    _ origin: URL, _ path: String, _ body: [String: String], cookie: String?
  ) async -> Int {
    var comps = URLComponents(url: origin, resolvingAgainstBaseURL: false)
    comps?.path = path
    guard let url = comps?.url else { return 0 }
    var request = URLRequest(url: url)
    request.httpMethod = "POST"
    request.timeoutInterval = 15
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    if let cookie { request.setValue(cookie, forHTTPHeaderField: "Cookie") }
    request.httpBody = try? JSONSerialization.data(withJSONObject: body)
    guard let (_, response) = try? await URLSession.shared.data(for: request) else { return 0 }
    return (response as? HTTPURLResponse)?.statusCode ?? 0
  }

  private func rows(of terminal: TerminalSession) -> [String] {
    (0..<terminal.rowCount()).map { row in
      terminal.cells(inRow: row).map(\.text).joined()
    }
  }
}
