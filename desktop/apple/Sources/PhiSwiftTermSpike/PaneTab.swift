import AppKit
import PhiKit
import PhiTerminal

/// One pane: its session, its terminal, and the state that reconciles the two.
///
/// This is the model behind one tab. It knows nothing about windows, the tab
/// strip, or the composer: it reports what changed through closures and the
/// window decides what to show.
@MainActor
final class PaneTab {
  /// What the footer shows for this pane.
  struct Status: Equatable {
    let text: String
    let attached: Bool
    let recovering: Bool
  }

  let paneID: String
  var title: String
  private(set) var session: PaneSession?
  private(set) var terminalView: SpikeTerminalView
  private(set) var closed = false
  /// The last status the session reported, for the DEBUG snapshot record.
  private(set) var lastSnapshot: PaneSession.Snapshot?

  /// Called when the footer text for this pane changes.
  var onStatus: ((Status) -> Void)?
  /// Called when a new connection replaced the terminal view: (old, new).
  var onTerminalReplaced: ((SpikeTerminalView, SpikeTerminalView) -> Void)?
  /// Called when the pane is attached at the current geometry and the view may
  /// fill the available space.
  var onReadyToFit: (() -> Void)?

  /// Test seam: reports whether a terminal view released its GPU resources.
  var closeTerminalView: (SpikeTerminalView) -> Bool = { $0.updateUiClosed() }

  private var liveConnection: UUID?
  private var geometryRevision: UInt64 = 0
  private(set) var retiringViews: [SpikeTerminalView] = []
  private var retirementTask: Task<Void, Never>?
  private var retirementBlocked = false
  /// Set while a retired view never released, so the footer explains the leak.
  private(set) var teardownStalled = false

  init(paneID: String, title: String, terminalView: SpikeTerminalView) {
    self.paneID = paneID
    self.title = title
    self.terminalView = terminalView
  }

  var draftKey: String { PhiComposerView.draftKey(paneID: paneID) }

  func start(session: PaneSession) {
    guard !closed else { return }
    self.session = session
    configure(terminalView)
    session.onUpdate = { [weak self] snapshot in
      self?.updateStatus(snapshot)
    }
    session.resize(
      cols: terminalView.terminalDimensions.cols, rows: terminalView.terminalDimensions.rows)
    session.start()
  }

  func apply(_ event: TerminalObservation) throws {
    guard !closed, !retirementBlocked else { throw SpikeWindowError.staleConnection }
    switch event {
    case .reset(let connection, let epoch, let frontier, let cols, let rows, _):
      guard retiringViews.isEmpty else { throw SpikeWindowError.staleConnection }
      let replacesConnection = terminalView.connectionID != connection
      guard cols >= 2, rows >= 1 else { throw SpikeWindowError.unsupportedGeometry }
      let replacement = SpikeTerminalView(cols: cols, rows: rows)
      configure(replacement)
      do {
        try replacement.apply(event)
        guard !closed, replacement.connectionID == connection else {
          throw SpikeWindowError.staleConnection
        }
      } catch {
        retire(replacement)
        throw error
      }
      liveConnection = nil
      let retired = terminalView
      retire(retired)
      retired.removeFromSuperview()
      terminalView = replacement
      onTerminalReplaced?(retired, replacement)
      geometryRevision = replacesConnection ? 1 : geometryRevision &+ 1
      // Waiting for the session to confirm this connection: grey, not red.
      publish(Status(
        text: "epoch \(epoch) · frontier \(frontier) · \(cols)×\(rows)",
        attached: false, recovering: true))

    case .bytes, .resize:
      try terminalView.apply(event)
      if case .resize = event {
        geometryRevision &+= 1
        liveConnection = nil
      }
    }
  }

  func send(bytes: [UInt8]) {
    session?.send(bytes: bytes)
  }

  func resize(cols: Int, rows: Int) {
    session?.resize(cols: cols, rows: rows)
  }

  /// Whether the visible terminal may fill the available area: either nothing
  /// has attached yet, or the live connection is the one this view drew.
  var allowsFit: Bool {
    terminalView.connectionID == nil || liveConnection == terminalView.connectionID
  }

  func updateStatus(_ snapshot: PaneSession.Snapshot) {
    lastSnapshot = snapshot
    guard !closed else { return }
    guard !retirementBlocked else {
      publish(Status(text: "terminal teardown timed out; views retained", attached: false, recovering: false))
      teardownStalled = true
      return
    }
    if snapshot.status.attached, !snapshot.status.recovering,
       snapshot.status.geometryRevision == geometryRevision,
       let connection = terminalView.connectionID,
       snapshot.status.connectionID == connection, liveConnection != connection {
      liveConnection = connection
      onReadyToFit?()
    }
    let dimensions = terminalView.terminalDimensions
    publish(Status(
      text: "\(snapshot.statusLine) · view \(dimensions.cols)×\(dimensions.rows)",
      attached: snapshot.status.attached,
      recovering: snapshot.status.recovering))
  }

  func close() {
    guard !closed else { return }
    closed = true
    retire(terminalView)
    session?.stop()
    session = nil
  }

  private func publish(_ status: Status) {
    onStatus?(status)
  }

  private func configure(_ view: SpikeTerminalView) {
    view.onInput = { [weak self] bytes in self?.session?.send(bytes: bytes) }
    view.onGridResize = { [weak self] cols, rows in self?.session?.resize(cols: cols, rows: rows) }
  }

  private func retire(_ view: SpikeTerminalView) {
    view.onInput = nil
    view.onGridResize = nil
    view.terminalDelegate = nil
    guard !closeTerminalView(view) else { return }
    retiringViews.append(view)
    // shortcut: stalled GPU graphs stay retained until process exit; add recovery only when enabling Metal.
    guard retirementTask == nil else { return }
    retirementTask = Task { [weak self] in
      defer { self?.retirementTask = nil }
      let deadline = ContinuousClock.now + .seconds(5)
      while !(self?.retiringViews.isEmpty ?? true) {
        self?.retiringViews.removeAll { self?.closeTerminalView($0) ?? true }
        if self?.retiringViews.isEmpty == true { return }
        guard ContinuousClock.now < deadline else {
          self?.retirementBlocked = true
          if let tab = self, !tab.closed {
            tab.publish(Status(
              text: "terminal teardown timed out; views retained", attached: false,
              recovering: false))
          }
          return
        }
        do { try await Task.sleep(for: .milliseconds(10)) } catch {
          self?.retirementBlocked = true
          return
        }
      }
    }
  }
}
