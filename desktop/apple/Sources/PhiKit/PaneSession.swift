import Foundation
import PhiTerminal

/// One live pane, shared by the macOS and iOS apps.
///
/// Everything a screen needs comes from here: the copied grid, the cursor, the
/// status line and the input queue. The UI layers only draw and forward keys,
/// so both apps run the same ordering, journal and reconnect rules.
@MainActor
public final class PaneSession {
  public struct Snapshot: Sendable {
    public var frame: PaneWireClient.Frame
    /// Cursor viewport position, or nil when it is hidden or off-screen.
    public var cursor: (x: Int, y: Int)?
    public var status: PaneWireClient.Status
    public var statusLine: String
  }

  public let paneID: String
  public var onUpdate: ((Snapshot) -> Void)?
  public private(set) var snapshot: Snapshot

  let client: PaneWireClient
  private let stateDir: URL
  private var journal: ActionJournal?
  private var journalError: String?
  private var queue: [Outbound] = []
  private var draining = false
  private(set) var retrying = false
  private var journalOpening = false
  private var closed = false
  private var wireTask: Task<Void, Never>?
  private var pollTask: Task<Void, Never>?
  private var journalTask: Task<Void, Never>?
  private var drainTask: Task<Void, Never>?
  private var resizeTask: Task<Void, Never>?
  private var wasAttached = false
  private var desiredSize: (cols: UInt16, rows: UInt16)

  private struct Outbound {
    var id = UUID()
    var text: String
    var bytes: [UInt8]
    var reserved: ActionJournal.Action?
    var needsReversal = false
  }

  typealias JournalOpener = @Sendable (URL, String) async throws -> ActionJournal
  var journalOpener: JournalOpener = { directory, pane in
    try await ActionJournal.open(directory: directory, pane: pane)
  }
  var inputDeliveryOverride: (@Sendable ([UInt8]) async -> InputDelivery)?
  var pendingActionsReader: @Sendable (ActionJournal) async -> [ActionJournal.Action] = {
    await $0.pending()
  }

  public init(
    origin: URL, paneID: String, stateDir: URL, cols: UInt16 = 80, rows: UInt16 = 24,
    useKeychain: Bool = true, password: AccessAuth.PasswordProvider? = nil,
    terminalObserver: TerminalObserver? = nil
  ) throws {
    client = try PaneWireClient(
      origin: origin, paneID: paneID, cols: cols, rows: rows,
      useKeychain: useKeychain, password: password,
      checkpointKind: terminalObserver == nil ? PaneWireClient.readyKind : PaneWireClient.ansiKind,
      observer: terminalObserver)
    self.paneID = paneID
    self.stateDir = stateDir
    desiredSize = (cols, rows)
    snapshot = Snapshot(
      frame: PaneWireClient.Frame(cols: Int(cols), rows: [], colored: []),
      cursor: nil,
      status: PaneWireClient.Status(),
      statusLine: "connecting")
  }

  public func start() {
    guard !closed else { return }
    wireTask = Task { await client.run() }
    pollTask = Task { await poll() }
    journalTask = Task { await openJournal() }
  }

  public func stop() {
    guard !closed else { return }
    closed = true
    onUpdate = nil
    wireTask?.cancel()
    pollTask?.cancel()
    journalTask?.cancel()
    drainTask?.cancel()
    resizeTask?.cancel()
    Task { await client.close() }
  }

  /// Keys and paste arrive here; ordering and durability are this type's job.
  public func send(bytes: [UInt8]) {
    guard !closed, !bytes.isEmpty else { return }
    queue.append(Outbound(text: String(decoding: bytes, as: UTF8.self), bytes: bytes, reserved: nil))
    startDrain()
  }

  public func resize(cols: Int, rows: Int) {
    guard !closed else { return }
    let cols = UInt16(clamping: cols)
    let rows = UInt16(clamping: rows)
    guard cols >= 1, rows >= 1 else { return }
    resizeTask?.cancel()
    // Remembered so an attach re-offers the size the view asked for, not the
    // geometry the terminal happened to have before connecting.
    desiredSize = (cols, rows)
    resizeTask = Task { [weak self, client] in
      try? await Task.sleep(for: .milliseconds(150))
      while !Task.isCancelled {
        guard let self, !self.closed else { return }
        if await client.sendResize(cols: cols, rows: rows) { return }
        do { try await Task.sleep(for: .milliseconds(500)) } catch { return }
      }
    }
  }

  // MARK: - Poll

  private func poll() async {
    var tick = 0
    while !Task.isCancelled, !closed {
      let frame = await client.frame()
      guard !Task.isCancelled, !closed else { return }
      let status = await client.status()
      guard !Task.isCancelled, !closed else { return }
      let cursor = await client.cursor()
      guard !Task.isCancelled, !closed else { return }
      let ambiguous = await journal?.attempted().count ?? 0
      guard !Task.isCancelled, !closed else { return }
      let next = Snapshot(
        frame: frame, cursor: cursor, status: status,
        statusLine: statusLine(status, ambiguous: ambiguous))
      snapshot = next
      onUpdate?(next)
      if closed { return }
      // A resize offered before attach is refused, so re-offer the size the
      // view asked for; using the terminal's own geometry here would keep a
      // stale PTY size and clip the frame.
      if status.attached, !wasAttached {
        resize(cols: Int(desiredSize.cols), rows: Int(desiredSize.rows))
      }
      wasAttached = status.attached
      tick += 1
      if tick % 10 == 0 {
        if journal == nil {
          await openJournal()
        } else {
          await retryPending()
        }
      }
      guard !Task.isCancelled, !closed else { return }
      do {
        try await Task.sleep(for: .milliseconds(50))
      } catch {
        return
      }
    }
  }

  private func openJournal() async {
    guard !closed, !journalOpening, journal == nil else { return }
    journalOpening = true
    defer { journalOpening = false }
    do {
      let opened = try await journalOpener(stateDir, paneID)
      guard !closed, !Task.isCancelled else { return }
      let recovered = await opened.pending()
      guard !closed, !Task.isCancelled else { return }
      journal = opened
      let queuedIDs = Set(queue.compactMap { $0.reserved?.id })
      let older = recovered.filter { !queuedIDs.contains($0.id) }.map { action in
        Outbound(
          text: action.text,
          bytes: action.rawBytes.map(Array.init) ?? Array(action.text.utf8),
          reserved: action)
      }
      queue.insert(contentsOf: older, at: 0)
      journalError = nil
      startDrain()
    } catch {
      guard !closed, !Task.isCancelled else { return }
      journalError = "state directory unusable: \(error.localizedDescription)"
    }
  }

  // MARK: - Durable input

  private func startDrain() {
    guard !closed, !draining, !retrying, !queue.isEmpty else { return }
    draining = true
    drainTask = Task { await drain() }
  }

  private func drain() async {
    defer {
      draining = false
      drainTask = nil
    }
    guard let journal else {
      journalError = "journal not open; draft kept"
      return
    }

    // Reserve every accepted item in FIFO order before checking connectivity.
    // A repeated offline drain therefore keeps the original reservation IDs.
    var index = 0
    while index < queue.count {
      guard !closed, !Task.isCancelled else { return }
      if queue[index].reserved == nil {
        let queuedID = queue[index].id
        do {
          let action = try await journal.reserve(
            queue[index].text, rawBytes: Data(queue[index].bytes))
          guard !closed, !Task.isCancelled else { return }
          if let current = queue.firstIndex(where: { $0.id == queuedID }) {
            queue[current].reserved = action
          }
          journalError = nil
        } catch {
          guard !closed else { return }
          journalError = "draft not saved: \(error.localizedDescription)"
          return
        }
      }
      index += 1
    }
    guard !queue.isEmpty else { return }
    if queue[0].needsReversal {
      guard let id = queue[0].reserved?.id, await reverseKnownNonSend(id, in: journal) else { return }
    }
    guard await client.status().attached, !closed, !Task.isCancelled else { return }

    while !queue.isEmpty {
      guard !closed, !Task.isCancelled else { return }
      let item = queue[0]
      guard let action = item.reserved else { return }
      if item.needsReversal {
        guard await reverseKnownNonSend(action.id, in: journal) else { return }
        continue
      }
      if action.delivery == .sentUnconfirmed {
        queue.removeFirst()
        continue
      }
      guard await client.status().attached, !closed, !Task.isCancelled else { return }
      do {
        try await journal.markAttempted(action.id)
        guard !closed, !Task.isCancelled else { return }
        queue[0].reserved?.delivery = .sentUnconfirmed
        journalError = nil
      } catch ActionJournal.JournalError.alreadyAttempted {
        guard !queue[0].needsReversal else { return }
        queue.removeFirst()
        continue
      } catch {
        guard !closed else { return }
        journalError = "attempt not saved, not sent: \(error.localizedDescription)"
        return
      }

      let result: InputDelivery
      if let inputDeliveryOverride {
        result = await inputDeliveryOverride(item.bytes)
      } else {
        result = await client.sendInput(item.bytes)
      }
      guard !closed, !Task.isCancelled else { return }
      if result == .neverSent {
        queue[0].needsReversal = true
        guard await reverseKnownNonSend(action.id, in: journal) else { return }
        return
      }
      queue.removeFirst()
    }
  }

  private func reverseKnownNonSend(_ id: String, in journal: ActionJournal) async -> Bool {
    do {
      try await journal.revertToNeverSent(id)
      guard !closed, !Task.isCancelled else { return false }
      if let index = queue.firstIndex(where: { $0.reserved?.id == id }) {
        queue[index].needsReversal = false
        queue[index].reserved?.delivery = .neverSent
      }
      journalError = nil
      return true
    } catch {
      guard !closed, !Task.isCancelled else { return false }
      journalError = "input rollback not saved; retry blocked: \(error.localizedDescription)"
      return false
    }
  }

  private func retryPending() async {
    guard !closed, let journal, !draining, !retrying else { return }
    retrying = true
    defer {
      retrying = false
      startDrain()
    }
    if queue.first?.needsReversal == true { return }
    let pending = await pendingActionsReader(journal)
    guard !closed, !Task.isCancelled else { return }
    let queued = Set(queue.compactMap { $0.reserved?.id })
    let missing = pending.filter { !queued.contains($0.id) }
    guard !missing.isEmpty else { return }
    let older = missing.map { action in
      Outbound(
        text: action.text,
        bytes: action.rawBytes.map(Array.init) ?? Array(action.text.utf8),
        reserved: action)
    }
    queue.insert(contentsOf: older, at: 0)
  }

  private func statusLine(_ status: PaneWireClient.Status, ambiguous: Int) -> String {
    var parts = [status.attached ? "attached" : "offline — last frame kept"]
    if status.attached, let attach = status.attach { parts.append("epoch \(attach.epoch)") }
    parts.append("frontier \(status.frontier)")
    if status.reconnects > 0 { parts.append("reconnects \(status.reconnects)") }
    if let exit = status.exitCode { parts.append("pane exited (\(exit))") }
    if !status.attached, let error = status.lastError { parts.append(error) }
    if let journalError { parts.append("journal: \(journalError)") }
    // Sent-but-unconfirmed input is shown, never resent.
    if ambiguous > 0 { parts.append("unconfirmed \(ambiguous)") }
    let pending = queue.filter { $0.reserved?.delivery == .neverSent }
    if !pending.isEmpty {
      let bytes = pending.reduce(0) { $0 + $1.bytes.count }
      parts.append("queued \(pending.count) (\(bytes) bytes)")
    }
    let unsavedBytes = queue.filter { $0.reserved == nil }.reduce(0) { $0 + $1.bytes.count }
    if unsavedBytes > 0 { parts.append("draft kept: \(unsavedBytes) bytes") }
    return parts.joined(separator: " · ")
  }
}

/// The pane list, fetched with the same access-password path as the terminal.
public enum PaneCatalog {
  public struct Pane: Sendable, Decodable, Identifiable, Equatable {
    public let id: String
    public let coder: String
    public let title: String?
    public let cwd: String?
  }

  public static func panes(
    origin: URL, password: AccessAuth.PasswordProvider? = nil, useKeychain: Bool = true
  ) async throws -> [Pane] {
    let auth = AccessAuth(origin: origin, useKeychain: useKeychain, password: password)
    let token = try await auth.token()
    var comps = URLComponents(url: origin, resolvingAgainstBaseURL: false)
    comps?.path = "/api/terminals"
    guard let url = comps?.url else { throw PaneWireError.badOrigin }
    var request = URLRequest(url: url)
    request.timeoutInterval = 15
    if let token {
      request.setValue("\(AccessAuth.cookieName)=\(token)", forHTTPHeaderField: "Cookie")
    }
    let (bytes, response) = try await URLSession.shared.bytes(for: request)
    defer { bytes.task.cancel() }
    guard let http = response as? HTTPURLResponse else {
      throw PaneWireError.protocolViolation("pane list is not HTTP")
    }
    guard http.statusCode == 200 else { throw PaneWireError.http(http.statusCode) }
    let data = try await readBoundedHTTPBody(bytes, maxBytes: 2 << 20)
    return try JSONDecoder().decode([Pane].self, from: data)
  }
}
