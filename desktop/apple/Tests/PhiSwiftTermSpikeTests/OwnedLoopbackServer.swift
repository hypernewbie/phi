import Darwin
import Foundation
import XCTest

struct OwnedLoopbackServer: Sendable {
  struct Pane: Sendable {
    let id: String
    fileprivate let owner: UUID
  }

  let origin: URL
  let workspace: URL
  private let processID: pid_t
  private let token = UUID()

  static func fromEnvironment() throws -> OwnedLoopbackServer {
    let environment = ProcessInfo.processInfo.environment
    guard environment["PHI_SPIKE_LIVE"] != nil else {
      throw XCTSkip("set PHI_SPIKE_LIVE=1 to run the owned native-pane tests")
    }
    guard environment["PHI_SPIKE_LIVE"] == "1",
          let rawOrigin = environment["PHI_TEST_ORIGIN"], let origin = URL(string: rawOrigin),
          origin.scheme == "http", origin.host == "127.0.0.1",
          origin.port == 17070 || origin.port == 17071,
          origin.user == nil, origin.password == nil, origin.query == nil, origin.fragment == nil,
          origin.path.isEmpty || origin.path == "/",
          let rawWorkspace = environment["PHI_TEST_WORKSPACE"], rawWorkspace.hasPrefix("/"),
          let rawPID = environment["PHI_TEST_SERVER_PID"], let processID = pid_t(rawPID), processID > 0
    else {
      throw NSError(
        domain: "OwnedLoopbackServer", code: 1,
        userInfo: [NSLocalizedDescriptionKey: "explicit live mode requires loopback origin, workspace, and server PID"])
    }
    let workspace = URL(fileURLWithPath: rawWorkspace, isDirectory: true).standardizedFileURL
    let attributes = try FileManager.default.attributesOfItem(atPath: workspace.path)
    guard attributes[.type] as? FileAttributeType == .typeDirectory,
          (attributes[.ownerAccountID] as? NSNumber)?.uint32Value == getuid() else {
      throw NSError(
        domain: "OwnedLoopbackServer", code: 2,
        userInfo: [NSLocalizedDescriptionKey: "live workspace is not an owned directory"])
    }
    let server = OwnedLoopbackServer(origin: origin, workspace: workspace, processID: processID)
    try server.assertOwned()
    return server
  }

  func assertOwned() throws {
    guard kill(processID, 0) == 0 else {
      throw NSError(
        domain: "OwnedLoopbackServer", code: 3,
        userInfo: [NSLocalizedDescriptionKey: "owned server child is not alive"])
    }
    let command = Process()
    command.executableURL = URL(fileURLWithPath: "/usr/sbin/lsof")
    command.arguments = ["-nP", "-t", "-iTCP:\(origin.port!)", "-sTCP:LISTEN"]
    let output = Pipe()
    command.standardOutput = output
    command.standardError = FileHandle.nullDevice
    try command.run()
    let data = output.fileHandleForReading.readDataToEndOfFile()
    command.waitUntilExit()
    let listeners = Set(String(decoding: data, as: UTF8.self)
      .split(whereSeparator: \.isNewline).map(String.init))
    guard command.terminationStatus == 0, listeners == [String(processID)] else {
      throw NSError(
        domain: "OwnedLoopbackServer", code: 4,
        userInfo: [NSLocalizedDescriptionKey: "listener ownership changed; fixture request omitted"])
    }
  }

  func spawn() async throws -> Pane {
    let body: [String: Any] = [
      "coder": "bash", "cols": 80, "rows": 24, "cwd": workspace.path,
    ]
    let data = try await perform("POST", "/api/terminals", body: body, expected: [200])
    guard let root = try JSONSerialization.jsonObject(with: data) as? [String: Any],
          let id = root["pane_id"] as? String, !id.isEmpty else {
      throw NSError(
        domain: "OwnedLoopbackServer", code: 5,
        userInfo: [NSLocalizedDescriptionKey: "owned pane response lacked pane_id"])
    }
    return Pane(id: id, owner: token)
  }

  func send(_ pane: Pane, text: String) async throws {
    try validate(pane)
    let data = try await perform(
      "POST", "/api/terminals/\(pane.id)/input", body: ["text": text], expected: [204])
    _ = data
  }

  func geometry(_ pane: Pane, epoch: UInt64) async throws -> (cols: UInt32, rows: UInt32) {
    try validate(pane)
    let query = [
      URLQueryItem(name: "epoch", value: String(epoch)),
      URLQueryItem(name: "through", value: "latest"),
      URLQueryItem(name: "kind", value: "ansi-v1"),
    ]
    var components = URLComponents(url: origin, resolvingAgainstBaseURL: false)
    components?.path = "/api/terminals/\(pane.id)/state"
    components?.queryItems = query
    guard let url = components?.url else { throw URLError(.badURL) }
    let body = try await sendRequest(url: url, expected: [200])
    guard body.count >= 4 else { throw URLError(.cannotParseResponse) }
    let headerLength = body.prefix(4).reduce(0) { $0 << 8 | Int($1) }
    guard headerLength > 0, body.count >= 4 + headerLength,
          let root = try JSONSerialization.jsonObject(with: body[4..<(4 + headerLength)]) as? [String: Any],
          let checkpoint = root["ckpt"] as? [String: Any],
          let cols = checkpoint["cols"] as? NSNumber,
          let rows = checkpoint["rows"] as? NSNumber else {
      throw URLError(.cannotParseResponse)
    }
    return (cols.uint32Value, rows.uint32Value)
  }

  func delete(_ pane: Pane) async throws {
    try validate(pane)
    _ = try await perform("DELETE", "/api/terminals/\(pane.id)", expected: [200, 204])
  }

  private func validate(_ pane: Pane) throws {
    guard pane.owner == token else {
      throw NSError(
        domain: "OwnedLoopbackServer", code: 6,
        userInfo: [NSLocalizedDescriptionKey: "refused to mutate a pane not created by this fixture"])
    }
  }

  private func perform(
    _ method: String, _ path: String, body: [String: Any]? = nil, expected: Set<Int>
  ) async throws -> Data {
    var components = URLComponents(url: origin, resolvingAgainstBaseURL: false)
    components?.path = path
    guard let url = components?.url else { throw URLError(.badURL) }
    var request = URLRequest(url: url)
    request.httpMethod = method
    request.timeoutInterval = 15
    if let body {
      request.setValue("application/json", forHTTPHeaderField: "Content-Type")
      request.httpBody = try JSONSerialization.data(withJSONObject: body)
    }
    return try await sendRequest(url: request.url!, request: request, expected: expected)
  }

  private func sendRequest(url: URL, expected: Set<Int>) async throws -> Data {
    var request = URLRequest(url: url)
    request.timeoutInterval = 15
    return try await sendRequest(url: url, request: request, expected: expected)
  }

  private func sendRequest(url: URL, request: URLRequest, expected: Set<Int>) async throws -> Data {
    try assertOwned()
    let (data, response) = try await URLSession.shared.data(for: request)
    try assertOwned()
    let status = (response as? HTTPURLResponse)?.statusCode ?? 0
    guard expected.contains(status) else {
      throw NSError(
        domain: "OwnedLoopbackServer", code: 7,
        userInfo: [NSLocalizedDescriptionKey: "owned fixture request returned HTTP \(status)"])
    }
    return data
  }
}
