import Foundation
import PhiWire
import SwiftProtobuf

/// One pane's live wire: attach, restore, ordered output, input, resize, ping.
///
/// Nothing here runs on the MainActor: the client is an actor, so its network
/// calls, decode work and terminal writes all stay off the UI's context.
public actor PaneWireClient {
  static let subprotocol = "phi.terminal.protobuf.v1"
  public static let readyKind = "ghostty-ready-v1"
  public static let ansiKind = "ansi-v1"
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
    /// A reply burst exceeded the 64 KiB cap; bytes were dropped, not grown.
    public var replyOverflow = false
    public var connectionID: UUID?
    public var recovering = false
    /// Geometry-event ordinal; byte traffic does not delay viewport readiness.
    public var geometryRevision: UInt64 = 0

    public init(
      attach: Attach? = nil, frontier: UInt64 = 0, attached: Bool = false,
      reconnects: Int = 0, gaps: [OutputGap] = [], dropNotices: Int = 0,
      exitCode: Int32? = nil, title: String? = nil, lastError: String? = nil,
      replyOverflow: Bool = false, connectionID: UUID? = nil, recovering: Bool = false,
      geometryRevision: UInt64 = 0
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
      self.replyOverflow = replyOverflow
      self.connectionID = connectionID
      self.recovering = recovering
      self.geometryRevision = geometryRevision
    }
  }

  /// Pure attach decision: which terminal the attach produces, from which
  /// source position the recording delta replays, and whether the recorded
  /// prefix is gone. Free of I/O so the epoch and retention rules are gated
  /// without a socket (§7.2).
  struct AttachPlan: Equatable {
    var epoch: UInt64
    var oldest: UInt64
    var head: UInt64
    var checkpoint: Checkpoint?
    var restoreBytes: Data
    /// A different epoch invalidates every old frontier and the display.
    var replacesEpoch: Bool
    /// The recorded prefix below `restoredFrontier` was evicted.
    var healFromLive: Bool
    var restoredFrontier: UInt64
    var replayFrom: UInt64?

    init(
      wire: Phi_Websocket_Terminal_V1_TerminalAttach, currentEpoch: UInt64?,
      checkpointKind: String = PaneWireClient.readyKind
    ) throws {
      guard wire.hasEpoch, wire.hasOldest, wire.hasHead, wire.oldest <= wire.head else {
        throw PaneWireError.protocolViolation("attach lacks a usable frontier")
      }
      // This endpoint's base screen rides in the attach frame; replay_from alone
      // is not renderable, so a missing checkpoint is a resync, not a blank screen.
      guard wire.hasCheckpoint else {
        throw PaneWireError.protocolViolation("attach without checkpoint")
      }
      let ckpt = wire.checkpoint
      // The checkpoint may sit below the retention floor: the server sends the
      // state it still holds, and recovery then heals from the live screen
      // (`internal/phic/tui_pane.go:520–540`). Only its shape is validated here.
      guard ckpt.hasThrough, ckpt.through <= wire.head,
            ckpt.cols >= 1, ckpt.cols <= 65535, ckpt.rows >= 1, ckpt.rows <= 65535,
            ckpt.data.count <= PaneWireClient.maxSpan else {
        throw PaneWireError.protocolViolation("attach checkpoint rejected")
      }
      let kindMatches = checkpointKind == PaneWireClient.ansiKind
        ? ckpt.kind == PaneWireClient.ansiKind
        : (ckpt.kind.isEmpty || ckpt.kind == PaneWireClient.readyKind)
      guard kindMatches else {
        throw PaneWireError.protocolViolation("attach did not contain the requested \(checkpointKind) checkpoint")
      }
      epoch = wire.epoch
      oldest = wire.oldest
      head = wire.head
      restoreBytes = ckpt.data
      restoredFrontier = ckpt.through
      replacesEpoch = currentEpoch != nil && currentEpoch != wire.epoch
      healFromLive = wire.oldest > ckpt.through
      replayFrom = wire.hasReplayFrom ? wire.replayFrom : nil
      checkpoint = Checkpoint(
        kind: ckpt.kind, through: ckpt.through, cols: UInt16(ckpt.cols), rows: UInt16(ckpt.rows),
        eventCursor: ckpt.hasEventCursor ? ckpt.eventCursor : nil)
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
    /// The exact reply body `[u32 length][JSON header][raw span]`, kept so a
    /// capture can hand the framing to an independent decoder.
    public var body: Data = Data()
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
  private var cols: UInt16
  private var rows: UInt16
  private let gate = WebSocketGate()
  private var terminal: TerminalSession
  private var session: URLSession?
  private var socket: URLSessionWebSocketTask?
  private var attach: Attach?
  private var frontier: UInt64 = 0
  /// Geometry the server has been told about; zero until the first resize.
  private var sentCols: UInt16 = 0
  private var sentRows: UInt16 = 0
  private var resizeGeneration: UInt64 = 0
  private var recoveryDepth = 0
  private var geometryConnectionID: UUID?
  private var geometryRevision: UInt64 = 0
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
  private let checkpointKind: String
  private let observer: TerminalObserver?
  private var currentConnectionID: UUID?
  private var resizeCompletionHook: (@Sendable (UInt16, UInt16) async -> Void)?

  func setResizeCompletionHook(_ hook: (@Sendable (UInt16, UInt16) async -> Void)?) {
    resizeCompletionHook = hook
  }

  func reconnectForTesting() {
    socket?.cancel(with: .goingAway, reason: nil)
  }
  /// Session cookie for the current origin, refreshed before every attempt.
  private var accessToken: String?

  public init(
    origin: URL, paneID: String, cols: UInt16 = 80, rows: UInt16 = 24,
    useKeychain: Bool = true, keychainService: String = "phi-access",
    password: AccessAuth.PasswordProvider? = nil,
    checkpointKind: String = PaneWireClient.readyKind, observer: TerminalObserver? = nil
  ) throws {
    guard let scheme = origin.scheme?.lowercased(), scheme == "http" || scheme == "https",
          origin.host != nil, cols >= 1, rows >= 1,
          checkpointKind == Self.readyKind || checkpointKind == Self.ansiKind else {
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
    self.checkpointKind = checkpointKind
    self.observer = observer
  }

  /// Attach and read until `stop()`/`close()`, re-attaching with backoff. Each
  /// attempt resyncs from a fresh attach checkpoint, never from stale state.
  public func run() async {
    while !stopped {
      do {
        try await connect()
      } catch {
        lastError = String(describing: error)
        switch error as? PaneWireError {
        case .observerFailure, .staleConnection:
          break
        default:
          // A rejected session must not be retried as-is; the next attempt logs
          // in again from the cached verifier, which needs no password.
          await auth.invalidate()
        }
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
    currentConnectionID = nil
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
      lastError: lastError,
      replyOverflow: terminal.replyOverflowed,
      connectionID: currentConnectionID,
      recovering: recoveryDepth > 0,
      geometryRevision: geometryRevision
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

  /// Frozen comparison point: the frontier and the full styled frame read in
  /// one actor hop, so output arriving between the two reads cannot be raced
  /// by an oracle capture (§9.2).
  public func freeze() -> (status: Status, frame: TerminalFrame?) {
    (status(), terminal.readFrame())
  }

  /// Full styled frame of the terminal this client owns.
  public func readFrame() -> TerminalFrame? {
    terminal.readFrame()
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
    guard newCols >= 1, newRows >= 1, !stopped, !Task.isCancelled else { return false }
    cols = newCols
    rows = newRows
    guard attached, recoveryDepth == 0, let socket else { return false }
    if newCols == sentCols, newRows == sentRows { return true }
    resizeGeneration &+= 1
    let generation = resizeGeneration
    let connection = currentConnectionID
    var frame = Phi_Websocket_Terminal_V1_TerminalClientFrame()
    var resize = Phi_Websocket_Terminal_V1_TerminalResize()
    resize.cols = UInt32(newCols)
    resize.rows = UInt32(newRows)
    frame.payload = .resize(resize)
    guard let encoded = try? frame.serializedData() else { return false }
    // An in-flight write makes the previous size unsafe for deduplication.
    sentCols = 0
    sentRows = 0
    do {
      try await socket.send(.data(encoded))
    } catch {
      return false
    }
    await resizeCompletionHook?(newCols, newRows)
    guard !stopped, !Task.isCancelled, attached, recoveryDepth == 0, self.socket === socket,
          currentConnectionID == connection, resizeGeneration == generation else { return false }
    sentCols = newCols
    sentRows = newRows
    terminal.resize(cols: newCols, rows: newRows)
    return true
  }

  /// Fetches the authoritative screen state over HTTP for this pane's epoch.
  public func fetchState(through: UInt64? = nil, kind: String = readyKind) async throws -> RemoteState {
    guard let attach else { throw PaneWireError.notAttached }
    let body = try await get(
      path: "/api/terminals/\(escapedPaneID)/state",
      query: [
        URLQueryItem(name: "epoch", value: String(attach.epoch)),
        URLQueryItem(name: "through", value: through.map(String.init) ?? "latest"),
        URLQueryItem(name: "kind", value: kind),
      ],
      timeout: 10, maxBytes: Self.maxStateBody)
    return try Self.decodeState(body)
  }

  /// Fetches one page of the recorded byte stream with its resize markers.
  /// A 400 means the requested start is below the retention floor, which a live
  /// checkpoint heals; every other failure stops recovery.
  public func fetchRecording(
    from: UInt64, through: UInt64, afterEventCursor: String? = nil
  ) async throws -> RecordingPage {
    guard let attach else { throw PaneWireError.notAttached }
    guard through >= from, through - from <= UInt64(RecordingPage.maxPage) else {
      throw RecordingError.invalid("recording span is not one bounded page")
    }
    var query = [
      URLQueryItem(name: "from", value: String(from)),
      URLQueryItem(name: "through", value: String(through)),
      URLQueryItem(name: "epoch", value: String(attach.epoch)),
    ]
    if let afterEventCursor, !afterEventCursor.isEmpty {
      query.append(URLQueryItem(name: "after_event_cursor", value: afterEventCursor))
    }
    let body: Data
    do {
      body = try await get(
        path: "/api/terminals/\(escapedPaneID)/recording", query: query,
        timeout: 10, maxBytes: RecordingPage.maxBody)
    } catch PaneWireError.http(400) {
      throw RecordingError.expired
    }
    return try RecordingPage.decode(body, epoch: attach.epoch, from: from, through: through)
  }

  /// One authenticated binary GET. The cookie is origin-bound and only ever
  /// attached to this client's own origin (§7.4).
  private func get(
    path: String, query: [URLQueryItem], timeout: TimeInterval, maxBytes: Int
  ) async throws -> Data {
    var comps = URLComponents(url: origin, resolvingAgainstBaseURL: false)
    comps?.path = path
    comps?.queryItems = query
    guard let url = comps?.url else { throw PaneWireError.badOrigin }
    var request = URLRequest(url: url)
    request.timeoutInterval = timeout
    if let accessToken {
      request.setValue(
        "\(AccessAuth.cookieName)=\(accessToken)", forHTTPHeaderField: "Cookie")
    }
    // Identity keeps the reply body readable as the exact bytes on the wire.
    request.setValue("identity", forHTTPHeaderField: "Accept-Encoding")
    let session = currentSession()
    let (bytes, response) = try await session.bytes(for: request)
    defer { bytes.task.cancel() }
    guard let http = response as? HTTPURLResponse else {
      throw PaneWireError.protocolViolation("reply is not HTTP")
    }
    guard http.statusCode == 200 else {
      if http.statusCode == 401 { await auth.invalidate() }
      throw PaneWireError.http(http.statusCode)
    }
    return try await readBoundedHTTPBody(bytes, maxBytes: maxBytes)
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

  func webSocketURL() throws -> URL {
    var components = URLComponents(url: origin, resolvingAgainstBaseURL: false)
    components?.scheme = origin.scheme?.lowercased() == "https" ? "wss" : "ws"
    components?.path = "/ws/pane/\(escapedPaneID)"
    components?.query = "state=\(checkpointKind)"
    guard let url = components?.url else { throw PaneWireError.badOrigin }
    return url
  }

  private func connect() async throws {
    let connection = UUID()
    currentConnectionID = connection
    defer {
      if currentConnectionID == connection {
        currentConnectionID = nil
        attached = false
      }
    }
    let session = currentSession()
    do {
      accessToken = try await auth.token()
    } catch {
      throw PaneWireError.accessDenied(String(describing: error))
    }
    guard isCurrent(connection) else { throw PaneWireError.staleConnection }
    var request = URLRequest(url: try webSocketURL())
    request.setValue(Self.subprotocol, forHTTPHeaderField: "Sec-WebSocket-Protocol")
    if let accessToken {
      request.setValue(
        "\(AccessAuth.cookieName)=\(accessToken)", forHTTPHeaderField: "Cookie")
    }
    let task = session.webSocketTask(with: request)
    task.maximumMessageSize = Self.maxMessage + 1
    socket = task
    lastPong = nil
    gate.begin(task)
    task.resume()
    defer {
      task.cancel(with: .goingAway, reason: nil)
      if socket === task { socket = nil }
      if currentConnectionID == connection { attached = false }
    }

    switch await gate.opened() {
    case .failed(let reason):
      throw PaneWireError.protocolViolation(reason)
    case .opened(let selected):
      guard isCurrent(connection) else { throw PaneWireError.staleConnection }
      try validateSubprotocolSelected(selected)
    }

    let heartbeat = Task { await self.heartbeat(task) }
    defer { heartbeat.cancel() }

    let first = try await receive(task)
    guard isCurrent(connection) else { throw PaneWireError.staleConnection }
    guard case .attach(let wire) = first.payload else {
      throw PaneWireError.protocolViolation("first frame is not attach")
    }
    let cold = attach == nil
    let plan = try await applyAttach(wire, connection: connection)
    guard isCurrent(connection) else { throw PaneWireError.staleConnection }
    if plan.healFromLive {
      try await healFromLiveState(connection: connection)
    }
    if frontier < plan.head {
      try await recover(
        from: frontier, through: plan.head,
        historical: observer != nil || cold,
        afterEventCursor: plan.checkpoint?.eventCursor, connection: connection)
    }
    guard isCurrent(connection) else { throw PaneWireError.staleConnection }
    _ = terminal.takePtyReplies()
    attached = true
    _ = await sendResize(cols: cols, rows: rows)
    guard isCurrent(connection) else { throw PaneWireError.staleConnection }

    while isCurrent(connection) {
      let frame = try await receive(task)
      guard isCurrent(connection) else { throw PaneWireError.staleConnection }
      guard let payload = frame.payload else { continue }
      switch payload {
      case .output(let output):
        try await applyOutput(output, connection: connection)
        guard isCurrent(connection) else { throw PaneWireError.staleConnection }
        await flushTerminalReplies(on: task, connection: connection)
      case .pong:
        lastPong = Date()
      case .exit(let exit):
        exitCode = exit.hasCode ? exit.code : 0
        stopped = true
        currentConnectionID = nil
      case .dropNotice:
        dropNotices += 1
      case .title(let push):
        guard push.hasRevision, push.revision >= titleRevision else { continue }
        titleRevision = push.revision
        title = push.title
      case .attach, .bridgeState, .settlement, .notification:
        continue
      }
    }
  }

  /// Terminal replies (DSR, DA) belong back on the PTY. Live output only:
  /// restored snapshot bytes are history and must never answer.
  private func flushTerminalReplies(
    on task: URLSessionWebSocketTask, connection: UUID
  ) async {
    let replies = terminal.takePtyReplies()
    guard !replies.isEmpty, replies.count <= 64 << 10, attached, isCurrent(connection) else { return }
    var frame = Phi_Websocket_Terminal_V1_TerminalClientFrame()
    frame.payload = .input(Data(replies))
    guard let encoded = try? frame.serializedData(), isCurrent(connection) else { return }
    try? await task.send(.data(encoded))
  }

  private func isCurrent(_ connection: UUID) -> Bool {
    !stopped && (currentConnectionID == nil || currentConnectionID == connection)
  }

  private func emit(_ event: TerminalObservation, connection: UUID) async throws {
    guard isCurrent(connection) else { throw PaneWireError.staleConnection }
    guard let observer else { return }
    if geometryConnectionID != connection {
      geometryConnectionID = connection
      geometryRevision = 0
    }
    switch event {
    case .reset, .resize: geometryRevision &+= 1
    case .bytes: break
    }
    do {
      try await observer(event)
    } catch {
      guard isCurrent(connection) else { throw PaneWireError.staleConnection }
      throw PaneWireError.observerFailure(String(describing: error))
    }
    guard isCurrent(connection) else { throw PaneWireError.staleConnection }
  }

  /// Stages checkpoint state before notifying the view or committing its frontier.
  @discardableResult
  func applyAttach(
    _ wire: Phi_Websocket_Terminal_V1_TerminalAttach, connection: UUID? = nil
  ) async throws -> AttachPlan {
    let token = connection ?? currentConnectionID ?? UUID()
    guard isCurrent(token) else { throw PaneWireError.staleConnection }
    let plan = try AttachPlan(
      wire: wire, currentEpoch: attach?.epoch, checkpointKind: checkpointKind)
    var replacement: TerminalSession?
    if checkpointKind == Self.ansiKind {
      guard let checkpoint = plan.checkpoint,
            checkpoint.cols >= 2, checkpoint.rows >= 1 else {
        throw PaneWireError.protocolViolation("unsupported ANSI checkpoint geometry")
      }
      guard let restored = TerminalSession(cols: checkpoint.cols, rows: checkpoint.rows) else {
        throw PaneWireError.protocolViolation("could not create an ANSI checkpoint terminal")
      }
      restored.feed([UInt8](plan.restoreBytes), source: .boundary)
      _ = restored.takePtyReplies()
      replacement = restored
      do {
        try await emit(.reset(
          connection: token, epoch: plan.epoch, frontier: plan.restoredFrontier,
          cols: checkpoint.cols, rows: checkpoint.rows, bytes: plan.restoreBytes),
          connection: token)
      } catch {
        restored.free()
        throw error
      }
      guard isCurrent(token) else {
        restored.free()
        throw PaneWireError.staleConnection
      }
    } else if !plan.restoreBytes.isEmpty {
      guard let restored = TerminalSession(restoring: [UInt8](plan.restoreBytes)) else {
        throw PaneWireError.protocolViolation("ghostty-ready-v1 restore failed")
      }
      replacement = restored
    }
    if plan.replacesEpoch, replacement == nil {
      guard let fresh = TerminalSession(cols: cols, rows: rows) else {
        throw PaneWireError.protocolViolation("could not start a terminal for the new epoch")
      }
      replacement = fresh
    }
    if let replacement {
      terminal.free()
      terminal = replacement
    }
    if plan.replacesEpoch {
      frontier = 0
      gaps.removeAll()
      exitCode = nil
      dropNotices = 0
      title = nil
      titleRevision = 0
    }
    attach = Attach(
      epoch: plan.epoch,
      oldest: plan.oldest,
      head: plan.head,
      checkpoint: plan.checkpoint,
      replayFrom: plan.replayFrom)
    frontier = plan.restoredFrontier
    sentCols = 0
    sentRows = 0
    backoff = Self.initialBackoff
    return plan
  }

  /// Fetches the recorded span in bounded pages and applies each page with its
  /// resize markers in place.
  ///
  /// An evicted prefix heals from the authoritative live screen instead of
  /// skipping bytes (`internal/phic/tui_pane.go:751–800`). The Go loop's
  /// empty-delta skip is deliberately not copied: a page that reports no
  /// progress stops the stream rather than silently dropping the span.
  func recover(
    from: UInt64, through: UInt64, historical: Bool, afterEventCursor: String?,
    connection: UUID
  ) async throws {
    recoveryDepth += 1
    resizeGeneration &+= 1
    sentCols = 0
    sentRows = 0
    defer { recoveryDepth -= 1 }
    if observer != nil {
      // Reassert geometry before suspended recovery can race a local resize.
      try await emit(.resize(
        connection: connection, epoch: attach?.epoch ?? 0, position: frontier,
        cols: UInt16(clamping: terminal.columnCount()), rows: UInt16(clamping: terminal.rowCount())),
        connection: connection)
    }
    let source: FeedSource = observer != nil && historical
      ? .boundary : (historical ? .replay : .live)
    var at = from
    var cursor = afterEventCursor
    var heals = 0
    while at < through {
      guard isCurrent(connection) else { throw PaneWireError.staleConnection }
      let remaining = through - at
      let end = remaining > UInt64(RecordingPage.maxPage)
        ? at + UInt64(RecordingPage.maxPage) : through
      let page: RecordingPage
      do {
        page = try await fetchRecording(from: at, through: end, afterEventCursor: cursor)
        guard isCurrent(connection) else { throw PaneWireError.staleConnection }
      } catch RecordingError.expired {
        heals += 1
        guard heals <= 2 else {
          throw PaneWireError.protocolViolation("recovery kept losing its prefix")
        }
        try await healFromLiveState(connection: connection)
        at = frontier
        cursor = nil
        continue
      }
      guard page.end > at else {
        throw PaneWireError.protocolViolation("recording page made no progress")
      }
      try await apply(page, source: source, connection: connection)
      at = page.end
      cursor = page.eventCursor
    }
  }

  func applyRecordedPage(
    _ page: RecordingPage, source: FeedSource, connection: UUID? = nil
  ) async throws {
    let token = connection ?? currentConnectionID ?? UUID()
    try await apply(page, source: source, connection: token)
  }

  private func apply(
    _ page: RecordingPage, source: FeedSource, connection: UUID
  ) async throws {
    let segments = page.segments(from: frontier)
    if observer != nil, segments.contains(where: { segment in
      if case .resize(_, let cols, let rows) = segment { return cols < 2 || rows < 1 }
      return false
    }) {
      throw PaneWireError.protocolViolation("unsupported recorded geometry")
    }
    for segment in segments {
      guard isCurrent(connection) else { throw PaneWireError.staleConnection }
      switch segment {
      case .bytes(let start, let end, let data):
        terminal.feed([UInt8](data), source: source)
        try await emit(.bytes(
          connection: connection, epoch: attach?.epoch ?? page.epoch,
          start: start, end: end, data: data), connection: connection)
        frontier = max(frontier, end)
      case .resize(let position, let cols, let rows):
        terminal.resize(cols: cols, rows: rows)
        try await emit(.resize(
          connection: connection, epoch: attach?.epoch ?? page.epoch,
          position: position, cols: cols, rows: rows), connection: connection)
        frontier = max(frontier, position)
      }
    }
    frontier = max(frontier, page.end)
  }

  /// Adopts the authoritative live screen when the recorded prefix is gone.
  private func healFromLiveState(connection: UUID) async throws {
    recoveryDepth += 1
    resizeGeneration &+= 1
    sentCols = 0
    sentRows = 0
    defer { recoveryDepth -= 1 }
    guard let current = attach else { throw PaneWireError.notAttached }
    let remote = try await fetchState(through: nil, kind: checkpointKind)
    guard isCurrent(connection) else { throw PaneWireError.staleConnection }
    guard remote.epoch == current.epoch else {
      throw PaneWireError.protocolViolation("live state belongs to another epoch")
    }
    guard let checkpoint = remote.checkpoint, !remote.data.isEmpty else {
      throw PaneWireError.protocolViolation("live state has no restorable checkpoint")
    }

    let restored: TerminalSession
    let restoredFrontier: UInt64
    if checkpointKind == Self.ansiKind {
      guard checkpoint.kind == Self.ansiKind, checkpoint.cols >= 2, checkpoint.rows >= 1 else {
        throw PaneWireError.protocolViolation("unsupported live checkpoint geometry")
      }
      guard let fresh = TerminalSession(cols: checkpoint.cols, rows: checkpoint.rows) else {
        throw PaneWireError.protocolViolation("live ANSI terminal creation failed")
      }
      fresh.feed([UInt8](remote.data), source: .boundary)
      _ = fresh.takePtyReplies()
      do {
        try await emit(.reset(
          connection: connection, epoch: remote.epoch, frontier: checkpoint.through,
          cols: checkpoint.cols, rows: checkpoint.rows, bytes: remote.data), connection: connection)
      } catch {
        fresh.free()
        throw error
      }
      guard isCurrent(connection) else {
        fresh.free()
        throw PaneWireError.staleConnection
      }
      restored = fresh
      restoredFrontier = checkpoint.through
    } else {
      guard let snapshot = TerminalSession(restoring: [UInt8](remote.data)) else {
        throw PaneWireError.protocolViolation("live state restore failed")
      }
      restored = snapshot
      restoredFrontier = remote.head
    }
    terminal.free()
    terminal = restored
    _ = terminal.takePtyReplies()
    frontier = restoredFrontier
    var updated = current
    updated.head = max(current.head, remote.head)
    attach = updated
  }

  /// Applies one live output frame, healing a hole from the recording first.
  func applyOutput(
    _ output: Phi_Websocket_Terminal_V1_TerminalOutput, connection: UUID? = nil
  ) async throws {
    let token = connection ?? currentConnectionID ?? UUID()
    guard isCurrent(token) else { throw PaneWireError.staleConnection }
    guard output.hasStart else {
      throw PaneWireError.protocolViolation("output without start")
    }
    guard output.data.count <= Self.maxSpan else {
      throw PaneWireError.protocolViolation("output span exceeds 2 MiB")
    }
    if output.start > frontier {
      gaps.append(OutputGap(from: frontier, to: output.start))
      if gaps.count > 8 { gaps.removeFirst() }
      try await recover(
        from: frontier, through: output.start, historical: false,
        afterEventCursor: nil, connection: token)
    }
    let (end, overflowed) = output.start.addingReportingOverflow(UInt64(output.data.count))
    guard !overflowed else {
      throw PaneWireError.protocolViolation("output span overflows the frontier")
    }
    guard end > frontier else { return }
    guard case .deliver(_, let skip) = Continuity.step(
      start: output.start, length: output.data.count, frontier: frontier) else { return }
    let bytes = Data(output.data.dropFirst(skip))
    let page = RecordingPage(
      epoch: attach?.epoch ?? 0, start: frontier, end: end, resizes: [], data: bytes)
    try await apply(page, source: .live, connection: token)
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
            kind.isEmpty || kind == readyKind || kind == ansiKind else {
        throw PaneWireError.protocolViolation("state checkpoint rejected")
      }
      checkpoint = Checkpoint(
        kind: kind, through: ckpt.through, cols: ckpt.cols, rows: ckpt.rows,
        eventCursor: ckpt.event_cursor
      )
    }
    return RemoteState(
      epoch: header.epoch, oldest: header.oldest, head: header.head,
      checkpoint: checkpoint, data: data, body: body
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
  case observerFailure(String)
  case staleConnection
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
