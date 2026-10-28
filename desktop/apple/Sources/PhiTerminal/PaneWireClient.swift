import Foundation
import PhiWire
import SwiftProtobuf

/// One pane's live wire: attach, restore, ordered output, input, resize, ping.
///
/// Nothing here runs on the MainActor: the client is an actor, so its network
/// calls, decode work and terminal writes all stay off the UI's context.
public actor PaneWireClient {
  static let subprotocol = "phi.terminal.protobuf.v1"
  static let readyKind = "ghostty-ready-v1"
  static let maxMessage = 4 << 20
  static let maxSpan = 2 << 20
  static let maxInputChunk = 1 << 20
  // 4-byte length, 4096-byte JSON header, 2 MiB raw span (§7.1).
  static let maxStateBody = 4 + 4096 + (2 << 20)
  static let initialBackoff = Duration.milliseconds(200)
  static let maxBackoff = Duration.seconds(3)
  static let pingInterval = Duration.seconds(25)
  static let pongTimeout = Duration.seconds(10)

  public struct Checkpoint: Sendable, Equatable {
    public var kind: String
    public var through: UInt64
    public var cols: UInt16
    public var rows: UInt16
    public var eventCursor: String?
  }

  public struct Attach: Sendable, Equatable {
    public var epoch: UInt64
    public var oldest: UInt64
    public var head: UInt64
    public var checkpoint: Checkpoint?
    public var replayFrom: UInt64?
  }

  public struct OutputGap: Sendable, Equatable {
    public var from: UInt64
    public var to: UInt64
  }

  public struct Status: Sendable, Equatable {
    public var attach: Attach?
    public var frontier: UInt64 = 0
    public var attached = false
    public var reconnects = 0
    public var gaps: [OutputGap] = []
    public var dropNotices = 0
    public var exitCode: Int32?
    public var title: String?
    public var lastError: String?

    public init(
      attach: Attach? = nil, frontier: UInt64 = 0, attached: Bool = false,
      reconnects: Int = 0, gaps: [OutputGap] = [], dropNotices: Int = 0,
      exitCode: Int32? = nil, title: String? = nil, lastError: String? = nil
    ) {
      self.attach = attach
      self.frontier = frontier
      self.attached = attached
      self.reconnects = reconnects
      self.gaps = gaps
      self.dropNotices = dropNotices
      self.exitCode = exitCode
      self.title = title
      self.lastError = lastError
    }
  }

  /// HTTP state fetch result: the `[u32 length][JSON][raw]` reply from
  /// `GET /api/terminals/<id>/state`.
  public struct RemoteState: Sendable, Equatable {
    public var epoch: UInt64
    public var oldest: UInt64
    public var head: UInt64
    public var checkpoint: Checkpoint?
    public var data: Data
  }

  public struct ColoredCell: Sendable, Equatable {
    public var row: Int
    public var column: Int
    public var text: String
    public var red: UInt8
    public var green: UInt8
    public var blue: UInt8
  }

  public struct Frame: Sendable, Equatable {
    public var cols: Int
    public var rows: [String]
    public var colored: [ColoredCell]

    public init(cols: Int, rows: [String], colored: [ColoredCell]) {
      self.cols = cols
      self.rows = rows
      self.colored = colored
    }
  }

  private let origin: URL
  private let paneID: String
  private let cols: UInt16
  private let rows: UInt16
  private let gate = WebSocketGate()
  private var terminal: TerminalSession
  private var session: URLSession?
  private var socket: URLSessionWebSocketTask?
  private var attach: Attach?
  private var frontier: UInt64 = 0
  /// Geometry the server has been told about; zero until the first resize.
  private var sentCols: UInt16 = 0
  private var sentRows: UInt16 = 0
  private var attached = false
  private var stopped = false
  private var backoff = PaneWireClient.initialBackoff
  private var reconnects = 0
  private var gaps: [OutputGap] = []
  private var dropNotices = 0
  private var exitCode: Int32?
  private var title: String?
  private var titleRevision: UInt64 = 0
  private var lastPong: Date?
  private var lastError: String?
  private let auth: AccessAuth
  /// Session cookie for the current origin, refreshed before every attempt.
  private var accessToken: String?

  public init(
    origin: URL, paneID: String, cols: UInt16 = 80, rows: UInt16 = 24,
    useKeychain: Bool = true, keychainService: String = "phi-access",
    password: AccessAuth.PasswordProvider? = nil
  ) throws {
    guard let scheme = origin.scheme?.lowercased(), scheme == "http" || scheme == "https",
          origin.host != nil, cols >= 1, rows >= 1 else {
      throw PaneWireError.badOrigin
    }
    guard let terminal = TerminalSession(cols: cols, rows: rows) else {
      throw PaneWireError.badOrigin
    }
    self.origin = origin
    self.paneID = paneID
    self.cols = cols
    self.rows = rows
    self.terminal = terminal
    self.auth = AccessAuth(
      origin: origin, useKeychain: useKeychain, keychainService: keychainService,
      password: password)
  }

  /// Attach and read until `stop()`/`close()`, re-attaching with backoff. Each
  /// attempt resyncs from a fresh attach checkpoint, never from stale state.
  public func run() async {
    while !stopped {
      do {
        try await connect()
      } catch {
        lastError = String(describing: error)
        // A rejected session must not be retried as-is; the next attempt logs
        // in again from the cached verifier, which needs no password.
        await auth.invalidate()
      }
      guard !stopped else { break }
      reconnects += 1
      do {
        try await Task.sleep(for: backoff)
      } catch {
        break
      }
      backoff = min(backoff * 2, Self.maxBackoff)
    }
  }

  public func stop() {
    stopped = true
    socket?.cancel(with: .goingAway, reason: nil)
    socket = nil
    attached = false
  }

  public func close() {
    stop()
    session?.invalidateAndCancel()
    session = nil
    terminal.free()
  }

  public func status() -> Status {
    Status(
      attach: attach,
      frontier: frontier,
      attached: attached && socket != nil,
      reconnects: reconnects,
      gaps: gaps,
      dropNotices: dropNotices,
      exitCode: exitCode,
      title: title,
      lastError: lastError
    )
  }

  /// Visible rows, trailing blanks trimmed, plus cells whose foreground is not
  /// the terminal's default. Byte-exact canonical text arrives with M1.
  public func frame() -> Frame {
    let width = terminal.columnCount()
    let height = terminal.rowCount()
    let defaultFg = terminal.paletteEntry(7)
    var lines: [String] = []
    var colored: [ColoredCell] = []
    for row in 0..<height {
      var cells = [String](repeating: " ", count: width)
      for cell in terminal.cells(inRow: row) where cell.x < width {
        cells[cell.x] = cell.text.isEmpty ? " " : cell.text
        if let fg = cell.foreground, !isDefault(fg, defaultFg) {
          colored.append(ColoredCell(
            row: row, column: cell.x, text: cell.text,
            red: fg.0, green: fg.1, blue: fg.2
          ))
        }
      }
      var line = cells.joined()
      while line.last == " " { line.removeLast() }
      lines.append(line)
    }
    return Frame(cols: width, rows: lines, colored: colored)
  }

  /// Live cursor in viewport cells, or nil while it is off-screen.
  public func cursor() -> (x: Int, y: Int)? {
    terminal.readCursor()
  }

  /// Sends raw bytes as ≤1 MiB frames. `.sentUnconfirmed` means bytes may have
  /// reached the server, so they must never be resent automatically.
  public func sendInput(_ bytes: [UInt8]) async -> InputDelivery {
    guard !bytes.isEmpty, attached, let socket, !stopped else { return .neverSent }
    var at = 0
    while at < bytes.count {
      let end = min(at + Self.maxInputChunk, bytes.count)
      var frame = Phi_Websocket_Terminal_V1_TerminalClientFrame()
      frame.payload = .input(Data(bytes[at..<end]))
      guard let encoded = try? frame.serializedData() else { return .sentUnconfirmed }
      do {
        try await socket.send(.data(encoded))
      } catch {
        return .sentUnconfirmed
      }
      at = end
    }
    return .sentUnconfirmed
  }

  /// Applies the geometry locally and asks the server to match it. Refused
  /// before attach so no sizing races the bootstrap. Compared against the last
  /// geometry the server was told, not against the local one: attach already
  /// applies the CLI geometry, and comparing to it would suppress the request.
  public func sendResize(cols newCols: UInt16, rows newRows: UInt16) async -> Bool {
    guard newCols >= 1, newRows >= 1, attached, let socket, !stopped else { return false }
    if newCols == sentCols, newRows == sentRows {
      return true
    }
    var frame = Phi_Websocket_Terminal_V1_TerminalClientFrame()
    var resize = Phi_Websocket_Terminal_V1_TerminalResize()
    resize.cols = UInt32(newCols)
    resize.rows = UInt32(newRows)
    frame.payload = .resize(resize)
    guard let encoded = try? frame.serializedData() else { return false }
    do {
      try await socket.send(.data(encoded))
    } catch {
      return false
    }
    sentCols = newCols
    sentRows = newRows
    terminal.resize(cols: newCols, rows: newRows)
    return true
  }

  /// Fetches the authoritative screen state over HTTP for this pane's epoch.
  public func fetchState(through: UInt64? = nil) async throws -> RemoteState {
    guard let attach else { throw PaneWireError.notAttached }
    var comps = URLComponents(url: origin, resolvingAgainstBaseURL: false)
    comps?.path = "/api/terminals/\(escapedPaneID)/state"
    comps?.queryItems = [
      URLQueryItem(name: "epoch", value: String(attach.epoch)),
      URLQueryItem(name: "through", value: through.map(String.init) ?? "latest"),
      URLQueryItem(name: "kind", value: Self.readyKind),
    ]
    guard let url = comps?.url else { throw PaneWireError.badOrigin }
    var request = URLRequest(url: url)
    request.timeoutInterval = 10
    if let accessToken {
      request.setValue(
        "\(AccessAuth.cookieName)=\(accessToken)", forHTTPHeaderField: "Cookie")
    }
    // Identity keeps the reply usable through the bounded async byte reader.
    request.setValue("identity", forHTTPHeaderField: "Accept-Encoding")
    let session = currentSession()
    let (bytes, response) = try await session.bytes(for: request)
    guard let http = response as? HTTPURLResponse else {
      throw PaneWireError.protocolViolation("state reply is not HTTP")
    }
    guard http.statusCode == 200 else {
      if http.statusCode == 401 { await auth.invalidate() }
      throw PaneWireError.http(http.statusCode)
    }
    var body = Data()
    body.reserveCapacity(1 << 16)
    for try await byte in bytes {
      body.append(byte)
      guard body.count <= Self.maxStateBody else {
        throw PaneWireError.protocolViolation("state body exceeds bound")
      }
    }
    return try Self.decodeState(body)
  }

  /// Message bound applied before protobuf decode: 4 MiB in, +1 out (§6.2).
  static func validateMessage(_ data: Data) throws {
    guard !data.isEmpty else {
      throw PaneWireError.protocolViolation("empty application message")
    }
    guard data.count <= maxMessage else {
      throw PaneWireError.protocolViolation("message exceeds the 4 MiB bound")
    }
  }

  func validateSubprotocolSelected(_ selected: String?) throws {
    guard selected == Self.subprotocol else {
      throw PaneWireError.subprotocol(selected)
    }
  }

  /// Pure continuity step so ordered delivery is testable without a socket.
  enum Continuity: Equatable {
    case deliver(start: UInt64, skip: Int)
    case duplicate
    case gap(from: UInt64, to: UInt64)

    static func step(start: UInt64, length: Int, frontier: UInt64) -> Continuity {
      if start == frontier { return .deliver(start: start, skip: 0) }
      if start > frontier { return .gap(from: frontier, to: start) }
      let overlap = frontier - start
      if overlap >= UInt64(length) { return .duplicate }
      return .deliver(start: frontier, skip: Int(overlap))
    }
  }

  private var escapedPaneID: String {
    var allowed = CharacterSet.urlPathAllowed
    allowed.remove(charactersIn: "/?#")
    return paneID.addingPercentEncoding(withAllowedCharacters: allowed) ?? paneID
  }

  private func currentSession() -> URLSession {
    if let session { return session }
    let created = URLSession(configuration: .ephemeral, delegate: gate, delegateQueue: nil)
    session = created
    return created
  }

  private func connect() async throws {
    let session = currentSession()
    do {
      accessToken = try await auth.token()
    } catch {
      throw PaneWireError.accessDenied(String(describing: error))
    }
    var comps = URLComponents(url: origin, resolvingAgainstBaseURL: false)
    comps?.scheme = origin.scheme == "https" ? "wss" : "ws"
    comps?.path = "/ws/pane/\(escapedPaneID)"
    comps?.query = "state=\(Self.readyKind)"
    guard let url = comps?.url else { throw PaneWireError.badOrigin }
    var request = URLRequest(url: url)
    request.setValue(Self.subprotocol, forHTTPHeaderField: "Sec-WebSocket-Protocol")
    if let accessToken {
      request.setValue(
        "\(AccessAuth.cookieName)=\(accessToken)", forHTTPHeaderField: "Cookie")
    }
    let task = session.webSocketTask(with: request)
    task.maximumMessageSize = Self.maxMessage + 1
    socket = task
    lastPong = nil
    // Begin before resume so the handshake result belongs to this attempt only.
    gate.begin(task)
    task.resume()
    defer {
      task.cancel(with: .goingAway, reason: nil)
      if socket === task { socket = nil }
      attached = false
    }

    switch await gate.opened() {
    case .failed(let reason):
      throw PaneWireError.protocolViolation(reason)
    case .opened(let selected):
      try validateSubprotocolSelected(selected)
    }

    let heartbeat = Task { await self.heartbeat(task) }
    defer { heartbeat.cancel() }

    let first = try await receive(task)
    guard case .attach(let wire) = first.payload else {
      throw PaneWireError.protocolViolation("first frame is not attach")
    }
    try applyAttach(wire)
    // Replies produced while replaying the checkpoint answer history, not the
    // live PTY; drop them so only live output is answered.
    _ = terminal.takePtyReplies()
    attached = true
    _ = await sendResize(cols: cols, rows: rows)

    while !stopped {
      let frame = try await receive(task)
      guard let payload = frame.payload else { continue }
      switch payload {
      case .output(let output):
        try apply(output)
        await flushTerminalReplies(on: task)
      case .pong:
        lastPong = Date()
      case .exit(let exit):
        exitCode = exit.hasCode ? exit.code : 0
        stopped = true
      case .dropNotice:
        dropNotices += 1
      case .title(let push):
        guard push.hasRevision, push.revision >= titleRevision else { continue }
        titleRevision = push.revision
        title = push.title
      case .attach, .bridgeState, .settlement, .notification:
        // attach leads the stream; the rest have no M0 consumer.
        continue
      }
    }
  }

  /// Terminal replies (DSR, DA) belong back on the PTY. Live output only:
  /// restored snapshot bytes are history and must never answer.
  // shortcut: no replay/boundary suppression yet, M1 owns the full policy.
  private func flushTerminalReplies(on task: URLSessionWebSocketTask) async {
    let replies = terminal.takePtyReplies()
    guard !replies.isEmpty, replies.count <= 64 << 10, attached, !stopped else { return }
    var frame = Phi_Websocket_Terminal_V1_TerminalClientFrame()
    frame.payload = .input(Data(replies))
    guard let encoded = try? frame.serializedData() else { return }
    try? await task.send(.data(encoded))
  }

  private func applyAttach(_ wire: Phi_Websocket_Terminal_V1_TerminalAttach) throws {
    guard wire.hasEpoch, wire.hasOldest, wire.hasHead, wire.oldest <= wire.head else {
      throw PaneWireError.protocolViolation("attach lacks a usable frontier")
    }
    // This endpoint's base screen rides in the attach frame; replay_from alone
    // is not renderable, so a missing checkpoint is a resync, not a blank screen.
    guard wire.hasCheckpoint else {
      throw PaneWireError.protocolViolation("attach without checkpoint")
    }
    let ckpt = wire.checkpoint
    guard ckpt.hasThrough, ckpt.through >= wire.oldest, ckpt.through <= wire.head,
          ckpt.cols >= 1, ckpt.cols <= 65535, ckpt.rows >= 1, ckpt.rows <= 65535,
          ckpt.data.count <= Self.maxSpan,
          ckpt.kind.isEmpty || ckpt.kind == Self.readyKind else {
      throw PaneWireError.protocolViolation("attach checkpoint rejected")
    }
    if !ckpt.data.isEmpty {
      guard let restored = TerminalSession(restoring: [UInt8](ckpt.data)) else {
        throw PaneWireError.protocolViolation("ghostty-ready-v1 restore failed")
      }
      terminal = restored
    }
    terminal.resize(cols: cols, rows: rows)
    attach = Attach(
      epoch: wire.epoch,
      oldest: wire.oldest,
      head: wire.head,
      checkpoint: Checkpoint(
        kind: ckpt.kind,
        through: ckpt.through,
        cols: UInt16(ckpt.cols),
        rows: UInt16(ckpt.rows),
        eventCursor: ckpt.hasEventCursor ? ckpt.eventCursor : nil
      ),
      replayFrom: wire.hasReplayFrom ? wire.replayFrom : nil
    )
    frontier = ckpt.through
    backoff = Self.initialBackoff
  }

  private func apply(_ output: Phi_Websocket_Terminal_V1_TerminalOutput) throws {
    guard output.hasStart else {
      throw PaneWireError.protocolViolation("output without start")
    }
    guard output.data.count <= Self.maxSpan else {
      throw PaneWireError.protocolViolation("output span exceeds 2 MiB")
    }
    switch Continuity.step(start: output.start, length: output.data.count, frontier: frontier) {
    case .duplicate:
      return
    case .gap(let from, let to):
      // Flagged and resynced, never skipped: the reconnect re-reads a checkpoint.
      gaps.append(OutputGap(from: from, to: to))
      if gaps.count > 8 { gaps.removeFirst() }
      throw PaneWireError.outputGap(from: from, to: to)
    case .deliver(let start, let skip):
      let bytes = [UInt8](output.data.dropFirst(skip))
      terminal.feed(bytes)
      frontier = start + UInt64(bytes.count)
    }
  }

  private func receive(_ task: URLSessionWebSocketTask) async throws -> Phi_Websocket_Terminal_V1_TerminalServerFrame {
    let message = try await task.receive()
    let data: Data
    switch message {
    case .data(let payload):
      data = payload
    case .string:
      throw PaneWireError.protocolViolation("text frame on the binary pane endpoint")
    @unknown default:
      throw PaneWireError.protocolViolation("unknown WebSocket message kind")
    }
    try Self.validateMessage(data)
    var options = BinaryDecodingOptions()
    options.messageDepthLimit = 100
    do {
      return try Phi_Websocket_Terminal_V1_TerminalServerFrame(serializedBytes: [UInt8](data), options: options)
    } catch {
      throw PaneWireError.protocolViolation("protobuf decode failed: \(error)")
    }
  }

  private func heartbeat(_ task: URLSessionWebSocketTask) async {
    while !Task.isCancelled {
      do {
        try await Task.sleep(for: Self.pingInterval)
      } catch {
        return
      }
      let sentAt = Date()
      do {
        try await task.send(.data(Self.pingFrame))
      } catch {
        return
      }
      do {
        try await Task.sleep(for: Self.pongTimeout)
      } catch {
        return
      }
      if (lastPong ?? .distantPast) < sentAt {
        // Silent link: drop the socket so the loop reconnects and resyncs.
        task.cancel(with: .goingAway, reason: nil)
        return
      }
    }
  }

  private func isDefault(_ fg: (UInt8, UInt8, UInt8), _ other: (UInt8, UInt8, UInt8)?) -> Bool {
    guard let other else { return false }
    return fg.0 == other.0 && fg.1 == other.1 && fg.2 == other.2
  }

  private static let pingFrame: Data = {
    var frame = Phi_Websocket_Terminal_V1_TerminalClientFrame()
    frame.payload = .ping(Phi_Websocket_Terminal_V1_TerminalPing())
    return (try? frame.serializedData()) ?? Data()
  }()

  private static func decodeState(_ body: Data) throws -> RemoteState {
    guard body.count >= 4 else {
      throw PaneWireError.protocolViolation("state reply shorter than its length prefix")
    }
    let headerLength = body.prefix(4).reduce(0) { $0 << 8 | Int($1) }
    guard headerLength > 0, headerLength <= 4096, body.count >= 4 + headerLength else {
      throw PaneWireError.protocolViolation("state header length out of range")
    }
    let header: StateHeader
    do {
      header = try JSONDecoder().decode(StateHeader.self, from: body[4..<(4 + headerLength)])
    } catch {
      throw PaneWireError.protocolViolation("state header decode failed: \(error)")
    }
    let data = Data(body[(4 + headerLength)...])
    guard header.oldest <= header.head else {
      throw PaneWireError.protocolViolation("state frontier inverted")
    }
    var checkpoint: Checkpoint?
    if let ckpt = header.ckpt {
      let kind = ckpt.kind ?? ""
      guard ckpt.len == data.count,
            ckpt.through >= header.oldest, ckpt.through <= header.head,
            ckpt.cols >= 1, ckpt.rows >= 1,
            kind.isEmpty || kind == readyKind else {
        throw PaneWireError.protocolViolation("state checkpoint rejected")
      }
      checkpoint = Checkpoint(
        kind: kind, through: ckpt.through, cols: ckpt.cols, rows: ckpt.rows,
        eventCursor: ckpt.event_cursor
      )
    }
    return RemoteState(
      epoch: header.epoch, oldest: header.oldest, head: header.head,
      checkpoint: checkpoint, data: data
    )
  }

  private struct StateHeader: Decodable {
    var epoch: UInt64
    var oldest: UInt64
    var head: UInt64
    var ckpt: StateCheckpoint?

    struct StateCheckpoint: Decodable {
      var kind: String?
      var through: UInt64
      var cols: UInt16
      var rows: UInt16
      var len: Int
      var event_cursor: String?
    }
  }
}

public enum PaneWireError: Error, Equatable {
  case badOrigin
  case notAttached
  case subprotocol(String?)
  case protocolViolation(String)
  case outputGap(from: UInt64, to: UInt64)
  case http(Int)
  /// Attaching needs an access session and none could be obtained.
  case accessDenied(String)
}

/// Whether bytes may already have reached the server. Only `.neverSent` work
/// may be retried; `.sentUnconfirmed` work is shown, never resent.
public enum InputDelivery: Sendable, Equatable {
  case neverSent
  case sentUnconfirmed
}

/// Reports the selected WebSocket subprotocol before any application data.
private final class WebSocketGate: NSObject, URLSessionWebSocketDelegate, @unchecked Sendable {
  enum OpenResult: Sendable {
    case opened(String?)
    case failed(String)
  }

  private let lock = NSLock()
  private var result: OpenResult?
  private var currentTask: URLSessionWebSocketTask?
  private var waiters: [CheckedContinuation<OpenResult, Never>] = []

  func begin(_ task: URLSessionWebSocketTask) {
    lock.lock()
    currentTask = task
    result = nil
    lock.unlock()
  }

  func opened() async -> OpenResult {
    await withCheckedContinuation { continuation in
      lock.lock()
      if let result {
        lock.unlock()
        continuation.resume(returning: result)
      } else {
        waiters.append(continuation)
        lock.unlock()
      }
    }
  }

  func urlSession(
    _ session: URLSession, webSocketTask: URLSessionWebSocketTask,
    didOpenWithProtocol `protocol`: String?
  ) {
    finish(.opened(`protocol`), from: webSocketTask)
  }

  func urlSession(
    _ session: URLSession, webSocketTask: URLSessionWebSocketTask,
    didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?
  ) {
    finish(.failed("socket closed before opening (code \(closeCode.rawValue))"), from: webSocketTask)
  }

  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    guard let error else { return }
    finish(.failed("handshake failed: \(error.localizedDescription)"), from: task)
  }

  /// Ignores events from earlier attempts and this session's HTTP tasks.
  private func finish(_ value: OpenResult, from task: URLSessionTask) {
    lock.lock()
    guard task === currentTask else {
      lock.unlock()
      return
    }
    guard result == nil else {
      lock.unlock()
      return
    }
    result = value
    let pending = waiters
    waiters = []
    lock.unlock()
    for waiter in pending { waiter.resume(returning: value) }
  }
}
