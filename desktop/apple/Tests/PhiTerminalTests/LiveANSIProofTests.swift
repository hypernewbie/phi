import Foundation
import XCTest
@testable import PhiKit
@testable import PhiTerminal

/// M1 live gate (§9.2): six owned fixture panes on the isolated server, each
/// captured at an exact frontier, replayed into a fresh terminal and decoded by
/// the Go oracle. Text equality alone is not proof: cells, cursor and geometry
/// must match too. The test creates, feeds and deletes its own panes.
final class LiveANSIProofTests: XCTestCase {
  struct Fixture {
    let name: String
    /// Short file name in the workspace: stock macOS bash 3.2 mangles a
    /// compose-wrapped payload, and only a short one-line command avoids it
    /// (§9.1).
    let script: String
    let seed: String
    let marker: String
  }

  static let fixtures: [Fixture] = [
    Fixture(name: "ascii", script: "a", seed: "printf 'alpha\\nbeta\\n'", marker: "beta"),
    Fixture(name: "sgr", script: "s", seed: "printf '\\033[31mred\\033[0m\\n'", marker: "red"),
    Fixture(
      name: "flags", script: "f",
      seed: "printf '\\033[2mf\\033[3mi\\033[9ms\\033[7mv\\033[8mh\\033[53mo\\033[4;58;5;196mc\\033[0m FLAGS\\n'",
      marker: "FLAGS"),
    Fixture(
      name: "wrap", script: "w",
      seed: "head -c 100 /dev/zero | tr '\\0' 'W'; echo",
      marker: String(repeating: "W", count: 20)),
    Fixture(
      name: "pending", script: "p",
      seed: "head -c 80 /dev/zero | tr '\\0' 'W'",
      marker: String(repeating: "W", count: 20)),
    Fixture(name: "alt", script: "l", seed: "printf '\\033[?1049hALT'", marker: "ALT"),
  ]

  func testSixFixturePanesMatchLiveReplayAndGoOracle() async throws {
    let server = try isolatedServer()
    let oracle = try OracleRunner.build()
    let directory = FileManager.default.temporaryDirectory
      .appendingPathComponent("phi-ansi-proof-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }

    for (index, fixture) in Self.fixtures.enumerated() {
      let script = server.workspace.appendingPathComponent(fixture.script)
      try Data("\(fixture.seed)\n".utf8).write(to: script, options: .atomic)
      addTeardownBlock { try? FileManager.default.removeItem(at: script) }

      let pane = try await server.spawn(coder: "bash", cols: 80, rows: 24)
      addTeardownBlock { await server.delete(pane) }
      let accepted = await server.send(pane, "sh \(fixture.script)\r")
      XCTAssertEqual(accepted, 204, "\(fixture.name): input was rejected")

      let client = try PaneWireClient(
        origin: server.origin, paneID: pane, cols: 80, rows: 24,
        useKeychain: false, password: server.password)
      addTeardownBlock { await client.close() }
      let wire = Task { await client.run() }
      addTeardownBlock { wire.cancel() }
      let reached = await server.waitFor(10) {
        guard let frame = await client.readFrame() else { return false }
        return frame.canonicalText().contains(fixture.marker)
      }
      XCTAssertTrue(reached, "\(fixture.name): marker never appeared")
      guard reached else { continue }

      let capture = try await ANSIProof.capture(from: client)
      let root = directory.appendingPathComponent("\(index)-\(fixture.name)")
      try ANSIProof.write(capture, to: root)
      XCTAssertNil(capture.firstDifference(), "\(fixture.name) live versus replay")
      XCTAssertTrue(
        capture.replayed.text.contains(fixture.marker),
        "\(fixture.name): captured frame lost the marker")
      XCTAssertEqual(
        capture.replayed.cols * capture.replayed.rows,
        capture.replayed.cells.reduce(0) { $0 + $1.count },
        "\(fixture.name): frame is not a full cell grid")

      // Same body, independent decoder: framing, geometry and every cell.
      let oracleFrame = try oracle.decodeCapture(root)
      XCTAssertNil(
        capture.replayed.firstDifference(against: oracleFrame, label: "swift-vs-go \(fixture.name)"))
      XCTAssertEqual(capture.replayed.text, oracleFrame.text, fixture.name)
      print("proof \(fixture.name): epoch \(capture.epoch) through \(capture.through)"
        + " cursor \(capture.replayed.cursorX),\(capture.replayed.cursorY)"
        + " text \(capture.replayed.text.utf8.count) bytes"
        + " cells \(capture.replayed.cells.reduce(0) { $0 + $1.count })")
    }
  }
}

/// The isolated server named by PHI_TEST_ORIGIN, with an optional access
/// password in PHI_TEST_PASSWORD.
struct IsolatedServer: Sendable {
  let origin: URL
  let password: AccessAuth.PasswordProvider?
  let workspace: URL

  static func passwordProvider(_ value: String?) -> AccessAuth.PasswordProvider? {
    guard let value, !value.isEmpty else { return nil }
    return { value }
  }

  func spawn(coder: String, cols: UInt16, rows: UInt16) async throws -> String {
    let body: [String: Any] = [
      "coder": coder, "cols": Int(cols), "rows": Int(rows), "cwd": workspace.path,
    ]
    let (status, data) = try await request("POST", "/api/terminals", body: body)
    guard status == 200, let pane = Self.paneID(data) else {
      throw OracleRunner.Failure(message: "spawn returned \(status): \(String(decoding: data, as: UTF8.self))")
    }
    return pane
  }

  func send(_ pane: String, _ text: String) async -> Int {
    let (status, _) = (try? await request(
      "POST", "/api/terminals/\(pane)/input", body: ["text": text])) ?? (0, Data())
    return status
  }

  func delete(_ pane: String) async {
    _ = try? await request("DELETE", "/api/terminals/\(pane)", body: nil)
  }

  func waitFor(_ timeout: TimeInterval, _ condition: () async -> Bool) async -> Bool {
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
      if await condition() { return true }
      try? await Task.sleep(for: .milliseconds(50))
    }
    return false
  }

  private func request(
    _ method: String, _ path: String, body: [String: Any]?
  ) async throws -> (Int, Data) {
    var comps = URLComponents(url: origin, resolvingAgainstBaseURL: false)
    comps?.path = path
    guard let url = comps?.url else { throw OracleRunner.Failure(message: "bad origin \(origin)") }
    var request = URLRequest(url: url)
    request.httpMethod = method
    request.timeoutInterval = 15
    if let body {
      request.setValue("application/json", forHTTPHeaderField: "Content-Type")
      request.httpBody = try JSONSerialization.data(withJSONObject: body)
    }
    if let password {
      let token = try await AccessAuth(
        origin: origin, useKeychain: false, password: password).token()
      if let token {
        request.setValue("\(AccessAuth.cookieName)=\(token)", forHTTPHeaderField: "Cookie")
      }
    }
    let (data, response) = try await URLSession.shared.data(for: request)
    return ((response as? HTTPURLResponse)?.statusCode ?? 0, data)
  }

  private static func paneID(_ data: Data) -> String? {
    guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
      return nil
    }
    return object["pane_id"] as? String
  }
}

private func isolatedServer() throws -> IsolatedServer {
  let env = ProcessInfo.processInfo.environment
  guard let origin = env["PHI_TEST_ORIGIN"].flatMap({ URL(string: $0) }) else {
    throw XCTSkip("set PHI_TEST_ORIGIN to the isolated server")
  }
  guard let workspace = env["PHI_TEST_WORKSPACE"], !workspace.isEmpty else {
    throw XCTSkip("set PHI_TEST_WORKSPACE to an owned fixture directory")
  }
  return IsolatedServer(
    origin: origin, password: IsolatedServer.passwordProvider(env["PHI_TEST_PASSWORD"]),
    workspace: URL(fileURLWithPath: workspace))
}
