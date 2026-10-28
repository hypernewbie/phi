import AppKit
import PhiKit
import PhiTerminal

/// One window over one live pane. All ordering, journal and reconnect logic
/// lives in `PaneSession`; this type only draws and forwards input.
@MainActor
final class PaneWindowController {
  private let session: PaneSession
  private let window: NSWindow
  private let grid: TerminalGridView

  init(session: PaneSession, cols: UInt16, rows: UInt16) {
    self.session = session
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
    grid.onGridSizeChange = { [weak self] cols, rows in
      self?.session.resize(cols: cols, rows: rows)
    }
    grid.onInput = { [weak self] bytes in self?.session.send(bytes: bytes) }
    grid.updateGridSize()
    session.onUpdate = { [weak self] snapshot in
      guard let self else { return }
      grid.apply(
        paneFrame: snapshot.frame, cursor: snapshot.cursor, status: snapshot.statusLine)
    }
    window.makeKeyAndOrderFront(nil)
    window.makeFirstResponder(grid)
    NSApp.activate()
    session.start()
  }

  func stop() {
    session.stop()
  }
}
