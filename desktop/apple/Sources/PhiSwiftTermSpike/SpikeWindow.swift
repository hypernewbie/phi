import AppKit
import PhiKit
import PhiTerminal
#if DEBUG
import Darwin
import Dispatch
import SwiftTerm
#endif

/// The window: a tab strip, one visible terminal, a prompt bar, and a footer.
///
/// Pane state lives in `PaneTab`; this class lays out views, swaps the terminal
/// that is on screen, and forwards user actions to the active tab.
@MainActor
final class SpikeWindow: NSWindowController, NSWindowDelegate {
  private let rootView = NSView()
  private let terminalContainer = NSView()
  /// Phi insets the terminal from the window edge: `.term-container .xterm`
  /// uses an 8px padding in `web/style.css`.
  static let terminalPadding: CGFloat = 8
  private let composer = PhiComposerView()
  private let statusStrip = PhiStatusStrip()
  private let tabStrip = PhiTabStrip()

  private var tabs: [PaneTab] = []
  private(set) var activeTab: PaneTab?
  private var statuses: [String: PaneTab.Status] = [:]
  private var closed = false
  /// Shown until the first tab arrives, so layout and tests have a view.
  private let placeholder = SpikeTerminalView()
  /// The tab that exists before a session starts. Tests and callers drive a
  /// window's terminal directly, so one always exists.
  private lazy var unstartedTab = PaneTab(
    paneID: "", title: "pane", terminalView: placeholder)

  /// The pane named before the window starts. After that it mirrors the active
  /// tab, so callers can find an open window by pane.
  var paneID = ""
  /// What the active tab calls its pane: the pane title, or its coder.
  var paneTitle = "pane"

  /// Test seam: reports whether a terminal view released its GPU resources.
  var closeTerminalView: (SpikeTerminalView) -> Bool = { $0.updateUiClosed() } {
    didSet { wire(unstartedTab); for tab in tabs { tab.closeTerminalView = closeTerminalView } }
  }
  /// Called once the window closes, so the owner can release this controller.
  var onClose: (() -> Void)?
  /// Called when the user asks for another tab; the owner picks the pane.
  var onNewTab: ((SpikeWindow) -> Void)?

  /// The tab whose terminal is on screen.
  private var currentTab: PaneTab { activeTab ?? unstartedTab }
  var terminalView: SpikeTerminalView { currentTab.terminalView }
  var retiringViews: [SpikeTerminalView] { currentTab.retiringViews }

#if DEBUG
  private var debugSnapshotDirectory: URL?
  private var debugSignal: DispatchSourceSignal?
  private var debugExportTask: Task<Void, Never>?
  private var debugExportInFlight = false
#endif

  init() {
    let window = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 1000, height: 620),
      styleMask: [.titled, .closable, .miniaturizable, .resizable],
      backing: .buffered, defer: false)
    super.init(window: window)
    window.title = "Phi"
    window.backgroundColor = PhiTheme.base
    window.delegate = self
    window.isReleasedWhenClosed = false
    rootView.wantsLayer = true
    rootView.autoresizingMask = [.width, .height]
    window.contentView = rootView

    terminalContainer.frame = NSRect(
      x: 0, y: 22 + PhiComposerView.barHeight, width: 1000,
      height: 598 - PhiComposerView.barHeight - PhiTabStrip.height)
    terminalContainer.autoresizingMask = [.width, .height]
    terminalContainer.clipsToBounds = true
    rootView.addSubview(terminalContainer)

    tabStrip.frame = NSRect(
      x: 0, y: 620 - PhiTabStrip.height, width: 1000, height: PhiTabStrip.height)
    tabStrip.autoresizingMask = [.width, .minYMargin]
    tabStrip.onSelect = { [weak self] id in self?.selectTab(paneID: id) }
    tabStrip.onClose = { [weak self] id in self?.closeTab(paneID: id) }
    tabStrip.onNewTab = { [weak self] in
      guard let self else { return }
      self.onNewTab?(self)
    }
    rootView.addSubview(tabStrip)

    placeholder.frame = viewportBounds
    placeholder.autoresizingMask = [.minYMargin]
    terminalContainer.addSubview(placeholder)

    statusStrip.text = "connecting"
    statusStrip.frame = NSRect(x: 0, y: 0, width: 1000, height: PhiStatusStrip.height)
    statusStrip.autoresizingMask = [.width, .maxYMargin]

    // Phi's footer: a panel strip with a hairline above it.
    rootView.addSubview(statusStrip)

    // The prompt bar sits above the status strip, like the web app's input bar.
    composer.frame = NSRect(x: 0, y: 22, width: 1000, height: PhiComposerView.barHeight)
    composer.autoresizingMask = [.width, .maxYMargin]
    composer.onSend = { [weak self] text in self?.sendPrompt(text) ?? false }
    composer.onEscape = { [weak self] in self?.focusTerminal() }
    rootView.addSubview(composer)
    updateMinimumContentSize(for: placeholder)
    wire(unstartedTab)
  }

  required init?(coder: NSCoder) {
    fatalError("init(coder:) has not been implemented")
  }

  // MARK: tabs

  func start(session: PaneSession) {
    addTab(paneID: paneID.isEmpty ? "pane" : paneID, title: paneTitle, session: session)
#if DEBUG
    // Installed here so a test that starts a session gets the same signal.
    installDebugSnapshotSignalIfNeeded()
#endif
    showWindow(nil)
    // Typing starts in the composer: keystrokes stay local until a prompt is
    // submitted. Click the terminal, or press Escape, to type at the PTY.
    composer.focus()
    NSApplication.shared.activate(ignoringOtherApps: true)
  }

  /// Opens another pane in this window and shows it.
  @discardableResult
  func addTab(paneID: String, title: String, session: PaneSession) -> PaneTab {
    let tab = addTab(paneID: paneID, title: title)
    tab.start(session: session)
    return tab
  }

  /// Adds a tab with no session yet, for a pane that is about to be attached or
  /// for a test that only drives the window.
  @discardableResult
  func addTab(paneID: String, title: String) -> PaneTab {
    // A pane has one tab: attaching it twice picks up the tab it already has.
    if let existing = tabs.first(where: { $0.paneID == paneID }) {
      selectTab(paneID: paneID)
      return existing
    }
    let view = SpikeTerminalView()
    view.frame = viewportBounds
    view.autoresizingMask = [.minYMargin]
    let tab = PaneTab(paneID: paneID, title: title, terminalView: view)
    wire(tab)
    placeholder.removeFromSuperview()
    tabs.append(tab)
    refreshStrip()
    selectTab(paneID: paneID)
    return tab
  }

  /// Whether this window already shows a pane.
  func contains(paneID: String) -> Bool {
    tabs.contains { $0.paneID == paneID }
  }

  var tabCount: Int { tabs.count }

  func selectTab(paneID: String) {
    guard let tab = tabs.first(where: { $0.paneID == paneID }) else { return }
    if activeTab === tab {
      tabStrip.activeID = paneID
      return
    }
    // Switching tabs keeps the keyboard where the user left it: a prompt being
    // typed in the composer must not be interrupted by a tab click.
    let focusFollowsTerminal = window?.firstResponder === activeTab?.terminalView
    if let current = activeTab, current.terminalView.superview === terminalContainer {
      current.terminalView.removeFromSuperview()
    }
    activeTab = tab
    self.paneID = tab.paneID
    paneTitle = tab.title
    terminalContainer.addSubview(tab.terminalView)
    tabStrip.activeID = tab.paneID
    composer.draftKey = tab.draftKey
    renderStatus(statuses[tab.paneID])
    updateMinimumContentSize(for: tab.terminalView)
    if focusFollowsTerminal { window?.makeFirstResponder(tab.terminalView) }
  }

  func closeTab(paneID: String) {
    guard let index = tabs.firstIndex(where: { $0.paneID == paneID }) else { return }
    let tab = tabs.remove(at: index)
    tab.terminalView.removeFromSuperview()
    tab.close()
    statuses[paneID] = nil
    refreshStrip()
    if activeTab === tab {
      activeTab = nil
      if !tabs.isEmpty {
        selectTab(paneID: tabs[min(index, tabs.count - 1)].paneID)
      }
    }
    if tabs.isEmpty, !closed {
      // Nothing is unsaved, so close directly: `performClose` waits on a
      // visible window and would leave a hidden one open.
      window?.close()
    }
  }

  /// Connects one tab's callbacks to the window. Used for the tab that exists
  /// before a session starts and for every tab opened later.
  private func wire(_ tab: PaneTab) {
    tab.closeTerminalView = closeTerminalView
    tab.onStatus = { [weak self, weak tab] status in
      guard let self, let tab else { return }
      self.statuses[tab.paneID] = status
      if self.currentTab === tab { self.renderStatus(status) }
    }
    tab.onTerminalReplaced = { [weak self, weak tab] retired, replacement in
      guard let self, let tab, self.currentTab === tab else { return }
      self.swapTerminalView(retired: retired, replacement: replacement)
    }
    tab.onReadyToFit = { [weak self, weak tab] in
      guard let self, let tab, self.currentTab === tab else { return }
      self.fitTerminalToViewport()
    }
  }

  private func refreshStrip() {
    tabStrip.items = tabs.map { PhiTabStrip.Item(id: $0.paneID, title: $0.title) }
  }

  private func swapTerminalView(retired: SpikeTerminalView, replacement: SpikeTerminalView) {
    let wasFirstResponder = window?.firstResponder === retired
    retired.removeFromSuperview()
    replacement.autoresizingMask = [.minYMargin]
    terminalContainer.addSubview(replacement)
    positionTerminal()
    updateMinimumContentSize(for: replacement)
    if wasFirstResponder { window?.makeFirstResponder(replacement) }
  }

  // MARK: observations

  func apply(_ event: TerminalObservation) throws {
    guard !closed else { throw SpikeWindowError.staleConnection }
    try currentTab.apply(event)
  }

  /// Routes one pane's events, so several tabs can share this window.
  func apply(_ event: TerminalObservation, paneID: String) throws {
    guard !closed, let tab = tabs.first(where: { $0.paneID == paneID }) else {
      throw SpikeWindowError.staleConnection
    }
    try tab.apply(event)
  }

  func windowDidResize(_ notification: Notification) {
    guard !closed else { return }
    let tab = currentTab
    let current = tab.terminalView.terminalDimensions
    let optimal = tab.terminalView.getOptimalFrameSize()
    guard optimal.width > 0, optimal.height > 0 else { return }
    let cols = max(2, Int(viewportBounds.width / (optimal.width / CGFloat(current.cols))))
    let rows = max(1, Int(viewportBounds.height / (optimal.height / CGFloat(current.rows))))
    if tab.allowsFit { fitTerminalToViewport() }
    tab.resize(cols: cols, rows: rows)
  }

  func windowWillClose(_ notification: Notification) {
    closeSession()
    onClose?()
  }

  func closeSession() {
    guard !closed else { return }
    closed = true
#if DEBUG
    debugSignal?.cancel()
    debugSignal = nil
    debugExportTask?.cancel()
    debugExportTask = nil
#endif
    for tab in tabs { tab.close() }
    tabs.removeAll()
    // The tab that never got a session still holds a terminal view.
    unstartedTab.close()
    activeTab = nil
  }

  #if DEBUG
  /// Writes the terminal view as PNG for the self-capture.
  ///
  /// The view is captured directly, not through its window: SwiftTerm renders in
  /// its own layer, and a window-level capture returns the background alone.
  /// Rendering is unsuspended first, so an occluded window still yields its
  /// current screen.
  /// Captures the whole window, not only the terminal view: the view draws in
  /// its own layer, and the footer strip lives beside it, so a window-level
  /// cache would show neither. `rootView` is layer-backed for this reason.
  func writeUIDumpPNG(to path: URL) async throws -> (bytes: Int, width: Int, height: Int) {
    guard activeTab != nil else { throw SpikeWindowError.staleConnection }
    let view = terminalView
    let originalSuspension = view.suspendsRenderingWhenNotVisible
    let initialFrames = view.diagnostics.frames
    view.suspendsRenderingWhenNotVisible = false
    defer { view.suspendsRenderingWhenNotVisible = originalSuspension }
    view.requestRedraw()
    let deadline = ContinuousClock().now.advanced(by: .seconds(3))
    while view.diagnostics.frames <= initialFrames, ContinuousClock().now < deadline {
      try? await Task.sleep(for: .milliseconds(16))
    }
    // The window must really be on screen: AppKit skips drawing for a window it
    // considers hidden, and a status line set after launch would never appear.
    window?.orderFrontRegardless()
    window?.displayIfNeeded()
    rootView.layoutSubtreeIfNeeded()
    rootView.displayIfNeeded()
    let bytes = try SpikeUIDump.writePNG(of: rootView, compositing: [view], to: path)
    return (bytes, Int(rootView.bounds.width), Int(rootView.bounds.height))
  }
  #endif
#if DEBUG
  func exportDebugSnapshot(to stateDirectory: URL) async throws -> URL {
    guard !closed else { throw DebugSnapshotError.closed }
    guard !debugExportInFlight else { throw DebugSnapshotError.alreadyExporting }
    debugExportInFlight = true
    defer { debugExportInFlight = false }

    let view = terminalView
    let captured = try await captureDebugSnapshot(from: view)
    try checkDebugSnapshotRequest(for: view)
    let writer = Task.detached(priority: .utility) {
      try DebugSnapshotFile.write(captured, to: stateDirectory)
    }
    return try await withTaskCancellationHandler(operation: {
      let directory = try await writer.value
      try Task.checkCancellation()
      guard !closed else { throw DebugSnapshotError.closed }
      return directory
    }, onCancel: {
      writer.cancel()
    })
  }

  private func installDebugSnapshotSignalIfNeeded() {
    guard !closed, debugSignal == nil else { return }
    signal(SIGINFO, SIG_IGN)
    let source = DispatchSource.makeSignalSource(signal: SIGINFO, queue: .main)
    source.setEventHandler { [weak self] in
      Task { @MainActor [weak self] in
        self?.requestDebugSnapshot()
      }
    }
    source.resume()
    debugSignal = source
  }

  private func requestDebugSnapshot() {
    guard !closed, debugExportTask == nil, let stateDirectory = debugSnapshotDirectory else { return }
    debugExportTask = Task { @MainActor [weak self] in
      guard let self, !self.closed else { return }
      defer { self.debugExportTask = nil }
      do {
        let directory = try await self.exportDebugSnapshot(to: stateDirectory)
        guard !Task.isCancelled, !self.closed else { return }
        fputs("\(directory.path)\n", stderr)
      } catch let error as DebugSnapshotError {
        guard !Task.isCancelled, !self.closed else { return }
        fputs("snapshot-error:\(error.code)\n", stderr)
      } catch {
        guard !Task.isCancelled, !self.closed else { return }
        fputs("snapshot-error:storage-unavailable\n", stderr)
      }
    }
  }

  private func captureDebugSnapshot(
    from view: SpikeTerminalView
  ) async throws -> DebugSnapshotCapture {
    try checkDebugSnapshotRequest(for: view)
    guard !view.isUsingMetalRenderer else { return try makeDebugSnapshot(from: view) }

    let originalSuspension = view.suspendsRenderingWhenNotVisible
    let initialFrames = view.diagnostics.frames
    try checkDebugSnapshotRequest(for: view)
    view.suspendsRenderingWhenNotVisible = false
    defer { view.suspendsRenderingWhenNotVisible = originalSuspension }

    view.requestRedraw()
    let clock = ContinuousClock()
    let deadline = clock.now.advanced(by: .seconds(5))
    try await Task.sleep(for: .milliseconds(16))
    try checkDebugSnapshotRequest(for: view)
    while view.diagnostics.frames <= initialFrames {
      try checkDebugSnapshotRequest(for: view)
      guard clock.now < deadline else { throw DebugSnapshotError.captureUnavailable }
      try await Task.sleep(for: .milliseconds(16))
      try checkDebugSnapshotRequest(for: view)
    }

    // A frame-count delta proves scheduling only; fixture pixels prove freshness.
    return try makeDebugSnapshot(from: view)
  }

  private func checkDebugSnapshotRequest(for view: SpikeTerminalView) throws {
    try Task.checkCancellation()
    guard !closed else { throw DebugSnapshotError.closed }
    guard terminalView === view else { throw DebugSnapshotError.captureUnavailable }
  }

  private func makeDebugSnapshot(from view: SpikeTerminalView) throws -> DebugSnapshotCapture {
    try checkDebugSnapshotRequest(for: view)
    guard let terminal = view.terminalContentSnapshot(region: .viewport) else {
      throw DebugSnapshotError.captureUnavailable
    }
    var png: Data?
    var imageError: String?
    if view.isUsingMetalRenderer {
      imageError = "metal-renderer"
    } else {
      let pixelDimensions = try DebugSnapshotGeometry.pixelDimensions(
        bounds: view.bounds, scaleFactor: view.window?.backingScaleFactor ?? 1)
      if let bitmap = view.bitmapImageRepForCachingDisplay(in: view.bounds) {
        view.cacheDisplay(in: view.bounds, to: bitmap)
        let (pixelCount, overflow) =
          bitmap.pixelsWide.multipliedReportingOverflow(by: bitmap.pixelsHigh)
        guard !overflow, pixelCount <= DebugSnapshotGeometry.maximumPixels,
              bitmap.pixelsWide == pixelDimensions.width,
              bitmap.pixelsHigh == pixelDimensions.height else {
          throw DebugSnapshotError.boundsTooLarge
        }
        png = bitmap.representation(using: .png, properties: [:])
        if png == nil { imageError = "appkit-capture-unavailable" }
      } else {
        imageError = "appkit-capture-unavailable"
      }
    }
    if png?.isEmpty == true { throw DebugSnapshotError.captureUnavailable }

    let document = DebugSnapshotDocument(
      timestamp: ISO8601DateFormatter().string(from: Date()),
      status: png == nil ? "unavailable" : "success",
      source: DebugSnapshotSource(
        connectionID: view.connectionID?.uuidString,
        epoch: view.epoch.map { String($0) },
        frontier: String(view.sourceFrontier)),
      viewport: DebugSnapshotViewport(snapshot: terminal),
      modes: DebugSnapshotModes(snapshot: terminal.inputState),
      cachedSession: DebugSnapshotCachedSession(
        status: activeTab?.lastSnapshot?.status ?? PaneWireClient.Status()),
      image: DebugSnapshotImage(exists: png != nil, errorCode: imageError))
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]
    let json = try encoder.encode(document)
    guard json.count <= RecordingPage.maxPage else { throw DebugSnapshotError.snapshotTooLarge }
    return DebugSnapshotCapture(png: png, json: json)
  }
#endif

#if DEBUG
  func start(session: PaneSession, stateDirectory: URL) {
    debugSnapshotDirectory = stateDirectory
    start(session: session)
  }
#endif

  /// Sends one submitted prompt. The composer keeps the draft when this fails.
  private func sendPrompt(_ text: String) -> Bool {
    guard let tab = activeTab, let bytes = PhiPrompt.bytes(for: text) else { return false }
    tab.send(bytes: bytes)
    return true
  }

  /// The footer text, for the DEBUG capture record.
#if DEBUG
  var statusText: String { statusStrip.text }
#endif

  private func focusTerminal() {
    window?.makeFirstResponder(terminalView)
  }

  // MARK: DEBUG hooks
#if DEBUG
  /// The tab the capture reads, so a test can hand the window a session.
  var debugTab: PaneTab { currentTab }
#endif

  /// For tests and callers that drive one pane: the current tab's status.
  func updateStatus(_ snapshot: PaneSession.Snapshot) {
    currentTab.updateStatus(snapshot)
  }

  private func renderStatus(_ status: PaneTab.Status?) {
    guard let status else {
      statusStrip.text = "connecting"
      statusStrip.textColor = PhiTheme.textMuted
      return
    }
    statusStrip.text = status.text
    statusStrip.textColor =
      status.attached
      ? PhiTheme.active : (status.recovering ? PhiTheme.textMuted : PhiTheme.danger)
  }

  private func updateMinimumContentSize(for view: SpikeTerminalView) {
    let dimensions = view.terminalDimensions
    let optimal = view.getOptimalFrameSize()
    let minimum = NSSize(
      width: max(
        optimal.width / CGFloat(dimensions.cols) * 2 + Self.terminalPadding * 2,
        PhiComposerView.minimumWidth),
      height: optimal.height / CGFloat(dimensions.rows) + PhiStatusStrip.height
        + PhiComposerView.barHeight + PhiTabStrip.height)
    window?.contentMinSize = minimum
  }

  /// The area the terminal may fill, inset from the window edges the way the web
  /// app insets `.xterm`.
  private var viewportBounds: NSRect {
    let inset = terminalContainer.bounds.insetBy(
      dx: Self.terminalPadding, dy: Self.terminalPadding)
    // A window dragged below the minimum still must not produce a negative
    // frame the terminal cannot draw into.
    return NSRect(
      x: inset.minX, y: inset.minY, width: max(inset.width, 0), height: max(inset.height, 0))
  }

  private func fitTerminalToViewport() {
    terminalView.setFrameSize(viewportBounds.size)
    positionTerminal()
  }

  private func positionTerminal() {
    terminalView.setFrameOrigin(NSPoint(
      x: Self.terminalPadding,
      y: terminalContainer.bounds.height - terminalView.frame.height - Self.terminalPadding))
  }
}

#if DEBUG
struct DebugSnapshotCapture: Sendable {
  let png: Data?
  let json: Data
}

struct DebugSnapshotError: Error {
  enum Kind {
    case invalidBounds
    case boundsTooLarge
    case captureUnavailable
    case snapshotTooLarge
    case storageUnavailable
    case closed
    case alreadyExporting
  }

  let kind: Kind
  var code: String {
    switch kind {
    case .invalidBounds: "invalid-bounds"
    case .boundsTooLarge: "bounds-too-large"
    case .captureUnavailable: "capture-unavailable"
    case .snapshotTooLarge: "snapshot-too-large"
    case .storageUnavailable: "storage-unavailable"
    case .closed: "closed"
    case .alreadyExporting: "already-exporting"
    }
  }

  static let invalidBounds = Self(kind: .invalidBounds)
  static let boundsTooLarge = Self(kind: .boundsTooLarge)
  static let captureUnavailable = Self(kind: .captureUnavailable)
  static let snapshotTooLarge = Self(kind: .snapshotTooLarge)
  static let storageUnavailable = Self(kind: .storageUnavailable)
  static let closed = Self(kind: .closed)
  static let alreadyExporting = Self(kind: .alreadyExporting)
}

struct DebugSnapshotGeometry {
  struct PixelDimensions {
    let width: Int
    let height: Int
  }

  static let maximumPixels = 16_777_216

  static func pixelDimensions(bounds: NSRect, scaleFactor: CGFloat) throws -> PixelDimensions {
    guard bounds.minX.isFinite, bounds.minY.isFinite,
          bounds.maxX.isFinite, bounds.maxY.isFinite,
          bounds.width.isFinite, bounds.height.isFinite,
          scaleFactor.isFinite, scaleFactor > 0,
          bounds.width > 0, bounds.height > 0 else {
      throw DebugSnapshotError.invalidBounds
    }
    let width = ceil(Double(bounds.width) * Double(scaleFactor))
    let height = ceil(Double(bounds.height) * Double(scaleFactor))
    guard width.isFinite, height.isFinite, width > 0, height > 0,
          width <= Double(Int.max), height <= Double(Int.max) else {
      throw DebugSnapshotError.invalidBounds
    }
    let pixelWidth = Int(width)
    let pixelHeight = Int(height)
    let (pixels, overflow) = pixelWidth.multipliedReportingOverflow(by: pixelHeight)
    guard !overflow, pixels <= maximumPixels else { throw DebugSnapshotError.boundsTooLarge }
    return PixelDimensions(width: pixelWidth, height: pixelHeight)
  }
}

private struct DebugSnapshotDocument: Encodable, Sendable {
  let format = "phi-dev-snapshot-v1"
  let version = 1
  let timestamp: String
  let captureKind = "appkit-view"
  let status: String
  let source: DebugSnapshotSource
  let viewport: DebugSnapshotViewport
  let modes: DebugSnapshotModes
  let cachedSession: DebugSnapshotCachedSession
  let image: DebugSnapshotImage
}

private struct DebugSnapshotSource: Encodable, Sendable {
  let connectionID: String?
  let epoch: String?
  let frontier: String
}

private struct DebugSnapshotViewport: Encodable, Sendable {
  let cols: Int
  let rowCount: Int
  let capturedRange: [Int]
  let liveTopRow: Int
  let cursorRow: Int
  let cursorColumn: Int
  let rows: [DebugSnapshotRow]

  init(snapshot: TerminalContentSnapshot) {
    cols = snapshot.inputState.dimensions.cols
    rowCount = snapshot.inputState.dimensions.rows
    capturedRange = [snapshot.capturedRange.lowerBound, snapshot.capturedRange.upperBound]
    liveTopRow = snapshot.liveTopRow
    cursorRow = snapshot.cursorRow
    cursorColumn = snapshot.cursorColumn
    rows = snapshot.rows.map {
      DebugSnapshotRow(
        absoluteRow: $0.absoluteRow, text: $0.text,
        cellWidths: $0.cells.map(\.width), isWrapped: $0.isWrapped)
    }
  }
}

private struct DebugSnapshotRow: Encodable, Sendable {
  let absoluteRow: Int
  let text: String
  let cellWidths: [Int]
  let isWrapped: Bool
}

private struct DebugSnapshotModes: Encodable, Sendable {
  let alternateBuffer: Bool
  let applicationCursor: Bool
  let applicationKeypad: Bool
  let bracketedPaste: Bool
  let mouse: String

  init(snapshot: TerminalInputStateSnapshot) {
    alternateBuffer = snapshot.isAlternateBuffer
    applicationCursor = snapshot.applicationCursor
    applicationKeypad = snapshot.applicationKeypad
    bracketedPaste = snapshot.bracketedPasteMode
    switch snapshot.mouseMode {
    case .off: mouse = "off"
    case .x10: mouse = "x10"
    case .vt200: mouse = "vt200"
    case .buttonEventTracking: mouse = "buttonEventTracking"
    case .anyEvent: mouse = "anyEvent"
    }
  }
}

private struct DebugSnapshotCachedSession: Encodable, Sendable {
  let cached: Bool
  let attached: Bool
  let reconnects: Int
  let gaps: Int
  let dropNotices: Int

  init(status: PaneWireClient.Status = PaneWireClient.Status()) {
    cached = true
    attached = status.attached
    reconnects = status.reconnects
    gaps = status.gaps.count
    dropNotices = status.dropNotices
  }
}

private struct DebugSnapshotImage: Encodable, Sendable {
  let exists: Bool
  let errorCode: String?
}

private enum DebugSnapshotFile {
  static func write(_ capture: DebugSnapshotCapture, to stateDirectory: URL) throws -> URL {
    let fileManager = FileManager.default
    do {
      let attributes = try fileManager.attributesOfItem(atPath: stateDirectory.path)
      guard attributes[.type] as? FileAttributeType == .typeDirectory,
            (attributes[.ownerAccountID] as? NSNumber)?.uint32Value == getuid() else {
        throw DebugSnapshotError.storageUnavailable
      }
      let directory = stateDirectory.appendingPathComponent(
        "debug-snapshot-\(UUID().uuidString)", isDirectory: true)
      try fileManager.createDirectory(
        at: directory, withIntermediateDirectories: false,
        attributes: [.posixPermissions: NSNumber(value: 0o700)])
      do {
        try Task.checkCancellation()
        if let png = capture.png {
          guard fileManager.createFile(
            atPath: directory.appendingPathComponent("terminal.png").path,
            contents: png, attributes: [.posixPermissions: NSNumber(value: 0o600)]) else {
            throw DebugSnapshotError.storageUnavailable
          }
        }
        try Task.checkCancellation()
        guard fileManager.createFile(
          atPath: directory.appendingPathComponent("state.json").path,
          contents: capture.json, attributes: [.posixPermissions: NSNumber(value: 0o600)]) else {
          throw DebugSnapshotError.storageUnavailable
        }
        return directory
      } catch {
        try? fileManager.removeItem(at: directory)
        if error is CancellationError { throw CancellationError() }
        if let error = error as? DebugSnapshotError { throw error }
        throw DebugSnapshotError.storageUnavailable
      }
    } catch {
      if error is CancellationError { throw CancellationError() }
      if let error = error as? DebugSnapshotError { throw error }
      throw DebugSnapshotError.storageUnavailable
    }
  }
}
#endif
