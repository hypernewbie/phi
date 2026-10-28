import AppKit
import PhiTerminal
import PhiUI

/// One window over one live pane: renders the copied frame, encodes keys into
/// journaled outbound actions, follows the window geometry. All disk and
/// network work stays on the wire client and the journal, never here.
@MainActor
final class PaneWindowController {
  private let client: PaneWireClient
  private let paneID: String
  private let stateDir: URL
  private let window: NSWindow
  private let grid: TerminalGridView

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

  init(client: PaneWireClient, paneID: String, stateDir: URL, cols: UInt16, rows: UInt16) {
    self.client = client
    self.paneID = paneID
    self.stateDir = stateDir
    grid = TerminalGridView(frame: .zero)
    let cell = grid.cellSize
    window = NSWindow(
      contentRect: NSRect(
        x: 0, y: 0,
        width: CGFloat(cols) * cell.width,
        height: CGFloat(rows) * cell.height + TerminalGridView.statusHeight),
      styleMask: [.titled, .closable, .miniaturizable, .resizable],
      backing: .buffered,
      defer: false)
    window.title = "Phi"
    window.contentView = grid
    window.center()
  }

  func start() {
    grid.onGridSizeChange = { [weak self] cols, rows in self?.gridDidResize(cols, rows) }
    grid.onInput = { [weak self] bytes in self?.enqueue(bytes) }
    grid.updateGridSize()
    window.makeKeyAndOrderFront(nil)
    window.makeFirstResponder(grid)
    NSApp.activate()
    wireTask = Task { await self.client.run() }
    pollTask = Task { await self.poll() }
    Task { await self.openJournal() }
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

  /// Reads the actor's copied state at a steady cadence. Each read is local
  /// rendering data; the socket and the disk never run here.
  private func poll() async {
    var tick = 0
    while !Task.isCancelled {
      let frame = await client.frame()
      let status = await client.status()
      let cursor = await client.cursor()
      let ambiguous = await journal?.attempted().count ?? 0
      grid.apply(
        paneFrame: frame, cursor: cursor, status: statusLine(status, ambiguous: ambiguous))
      // A resize offered before attach is refused, so re-offer the live geometry.
      if status.attached, !wasAttached { gridDidResize(grid.gridCols, grid.gridRows) }
      wasAttached = status.attached
      tick += 1
      if status.attached, tick % 10 == 0 { await retryPending() }
      try? await Task.sleep(for: .milliseconds(50))
    }
  }

  private func gridDidResize(_ cols: Int, _ rows: Int) {
    resizeTask?.cancel()
    let cols = UInt16(clamping: cols)
    let rows = UInt16(clamping: rows)
    resizeTask = Task { [client] in
      try? await Task.sleep(for: .milliseconds(150))
      guard !Task.isCancelled else { return }
      _ = await client.sendResize(cols: cols, rows: rows)
    }
  }

  // MARK: Input

  private func enqueue(_ bytes: [UInt8]) {
    queue.append(Outbound(text: String(decoding: bytes, as: UTF8.self), bytes: bytes, reserved: nil))
    startDrain()
  }

  /// One ordered drain for typed and retried work, so two paths never send the
  /// same action twice and keystrokes keep their order.
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

  /// Returns true when the head item is finished with and can leave the queue.
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
        // A failed write keeps the draft and blocks the send.
        journalError = "draft not saved: \(error.localizedDescription)"
        return false
      }
    }
    guard let action else { return true }
    // Ordering: hold the item at the head until the pane can take it.
    guard await client.status().attached else { return false }
    do {
      // Attempted is persisted before the bytes leave, so a restart shows it as
      // ambiguous instead of resending it.
      try await journal.markAttempted(action.id)
    } catch ActionJournal.JournalError.alreadyAttempted {
      return true  // another path already sent it; never send twice
    } catch {
      journalError = "attempt not saved, not sent: \(error.localizedDescription)"
      return false
    }
    let delivery = await client.sendInput(item.bytes)
    if delivery == .neverSent {
      // Definite non-send: nothing reached the wire, so it returns to the only
      // resendable state instead of becoming permanently ambiguous.
      try? await journal.revertToNeverSent(action.id)
      return false
    }
    return true
  }

  /// Resends never-sent work once per attach; the persisted attempt mark keeps
  /// it from ever coming back, and the queue check stops a second retry from
  /// enqueueing an action the drain is holding.
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
    parts.append("\(grid.gridCols)×\(grid.gridRows)")
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
