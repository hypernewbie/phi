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

  private let client: PaneWireClient
  private let stateDir: URL
  private var journal: ActionJournal?
  private var journalError: String?
  private var unsavedDraft = ""
  private var queue: [Outbound] = []
  private var draining = false
  private var retrying = false
  private var wireTask: Task<Void, Never>?
  private var pollTask: Task<Void, Never>?
  private var resizeTask: Task<Void, Never>?
  private var wasAttached = false

  private struct Outbound {
    var text: String
    var bytes: [UInt8]
    var reserved: ActionJournal.Action?
  }

  public init(
    origin: URL, paneID: String, stateDir: URL, cols: UInt16 = 80, rows: UInt16 = 24,
    useKeychain: Bool = true, password: AccessAuth.PasswordProvider? = nil
  ) throws {
    client = try PaneWireClient(
      origin: origin, paneID: paneID, cols: cols, rows: rows,
      useKeychain: useKeychain, password: password)
    self.paneID = paneID
    self.stateDir = stateDir
    snapshot = Snapshot(
      frame: PaneWireClient.Frame(cols: Int(cols), rows: [], colored: []),
      cursor: nil,
      status: PaneWireClient.Status(),
      statusLine: "connecting")
  }

  public func start() {
    wireTask = Task { await client.run() }
    pollTask = Task { await poll() }
    Task { await openJournal() }
  }

  public func stop() {
    wireTask?.cancel()
    pollTask?.cancel()
    resizeTask?.cancel()
    Task { await client.close() }
  }

  /// Keys and paste arrive here; ordering and durability are this type's job.
  public func send(bytes: [UInt8]) {
    queue.append(Outbound(text: String(decoding: bytes, as: UTF8.self), bytes: bytes, reserved: nil))
    startDrain()
  }

  public func resize(cols: Int, rows: Int) {
    resizeTask?.cancel()
    let cols = UInt16(clamping: cols)
    let rows = UInt16(clamping: rows)
    resizeTask = Task { [client] in
      try? await Task.sleep(for: .milliseconds(150))
      guard !Task.isCancelled else { return }
      _ = await client.sendResize(cols: cols, rows: rows)
    }
  }

  // MARK: - Poll

  private func poll() async {
    var tick = 0
    while !Task.isCancelled {
      let frame = await client.frame()
      let status = await client.status()
      let cursor = await client.cursor()
      let ambiguous = await journal?.attempted().count ?? 0
      let line = statusLine(status, ambiguous: ambiguous)
      let next = Snapshot(frame: frame, cursor: cursor, status: status, statusLine: line)
      snapshot = next
      onUpdate?(next)
      // A resize offered before attach is refused, so re-offer the live size.
      if status.attached, !wasAttached {
        resize(cols: Int(frame.cols), rows: max(1, frame.rows.count))
      }
      wasAttached = status.attached
      tick += 1
      if status.attached, tick % 10 == 0 { await retryPending() }
      try? await Task.sleep(for: .milliseconds(50))
    }
  }

  private func openJournal() async {
    do {
      let opened = try await ActionJournal.open(directory: stateDir, pane: paneID)
      journal = opened
      // Keystrokes accepted before the journal existed are older than anything
      // queued later, so they enter at the head once they can be persisted.
      if !unsavedDraft.isEmpty {
        let text = unsavedDraft
        unsavedDraft = ""
        queue.insert(Outbound(text: text, bytes: Array(text.utf8), reserved: nil), at: 0)
      }
      startDrain()
    } catch {
      journalError = "state directory unusable: \(error.localizedDescription)"
    }
  }

  // MARK: - Durable input

  private func startDrain() {
    guard !draining else { return }
    draining = true
    Task { await drain() }
  }

  private func drain() async {
    // Stop at the first item that cannot leave: dropping it would let newer
    // keys overtake older ones and would strand the journal entry.
    while !queue.isEmpty {
      guard await deliver(queue[0]) else { break }
      queue.removeFirst()
    }
    draining = false
  }

  private func deliver(_ item: Outbound) async -> Bool {
    guard let journal else {
      journalError = "journal not open; draft kept"
      unsavedDraft += item.text
      return true
    }
    var action = item.reserved
    if action == nil {
      do {
        action = try await journal.reserve(item.text)
      } catch {
        journalError = "draft not saved: \(error.localizedDescription)"
        return false
      }
    }
    guard let action else { return true }
    guard await client.status().attached else { return false }
    do {
      try await journal.markAttempted(action.id)
    } catch ActionJournal.JournalError.alreadyAttempted {
      return true  // another path already sent it; never send twice
    } catch {
      journalError = "attempt not saved, not sent: \(error.localizedDescription)"
      return false
    }
    if await client.sendInput(item.bytes) == .neverSent {
      try? await journal.revertToNeverSent(action.id)
      return false
    }
    return true
  }

  private func retryPending() async {
    guard let journal, !draining, !retrying else { return }
    retrying = true
    defer { retrying = false }
    let queued = Set(queue.compactMap { $0.reserved?.id })
    let pending = await journal.pending().filter { !queued.contains($0.id) }
    guard !pending.isEmpty else { return }
    queue.append(contentsOf: pending.map {
      Outbound(text: $0.text, bytes: Array($0.text.utf8), reserved: $0)
    })
    startDrain()
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
    if !unsavedDraft.isEmpty { parts.append("draft kept: \(unsavedDraft.count) chars") }
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
    let (data, response) = try await URLSession.shared.data(for: request)
    guard let http = response as? HTTPURLResponse else {
      throw PaneWireError.protocolViolation("pane list is not HTTP")
    }
    guard http.statusCode == 200 else { throw PaneWireError.http(http.statusCode) }
    return try JSONDecoder().decode([Pane].self, from: data)
  }
}
