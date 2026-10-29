import AppKit
import PhiKit
import PhiTerminal
#if DEBUG
import Darwin
import Dispatch
import SwiftTerm
#endif

@MainActor
final class SpikeWindow: NSWindowController, NSWindowDelegate {
  private let rootView = NSView()
  private let terminalContainer = NSView()
  private let statusLabel = NSTextField(labelWithString: "connecting")
  private(set) var terminalView: SpikeTerminalView!
  private var session: PaneSession?
  private var closed = false
  private var liveConnection: UUID?
  private var geometryRevision: UInt64 = 0
  var closeTerminalView: (SpikeTerminalView) -> Bool = { $0.updateUiClosed() }
  private(set) var retiringViews: [SpikeTerminalView] = []
  private var retirementTask: Task<Void, Never>?
  private var retirementOwner: SpikeWindow?
  private var retirementBlocked = false
#if DEBUG
  private var debugSnapshotDirectory: URL?
  private var debugSignal: DispatchSourceSignal?
  private var debugExportTask: Task<Void, Never>?
  private var debugExportInFlight = false
  private var debugCachedSession = DebugSnapshotCachedSession()
#endif

  init() {
    let window = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 1000, height: 620),
      styleMask: [.titled, .closable, .miniaturizable, .resizable],
      backing: .buffered, defer: false)
    super.init(window: window)
    window.title = "Phi SwiftTerm Spike"
    window.delegate = self
    window.isReleasedWhenClosed = false
    rootView.autoresizingMask = [.width, .height]
    window.contentView = rootView

    terminalContainer.frame = NSRect(x: 0, y: 22, width: 1000, height: 598)
    terminalContainer.autoresizingMask = [.width, .height]
    terminalContainer.clipsToBounds = true
    rootView.addSubview(terminalContainer)
    terminalView = SpikeTerminalView()
    terminalView.frame = terminalContainer.bounds
    terminalView.autoresizingMask = [.minYMargin]
    terminalContainer.addSubview(terminalView)
    statusLabel.frame = NSRect(x: 8, y: 0, width: 984, height: 22)
    statusLabel.autoresizingMask = [.width, .maxYMargin]
    rootView.addSubview(statusLabel)
    updateMinimumContentSize(for: terminalView)
  }

  required init?(coder: NSCoder) {
    fatalError("init(coder:) has not been implemented")
  }

  func start(session: PaneSession) {
    startSession(session)
  }

#if DEBUG
  func start(session: PaneSession, stateDirectory: URL) {
    debugSnapshotDirectory = stateDirectory
    startSession(session)
    installDebugSnapshotSignal()
  }
#endif

  private func startSession(_ session: PaneSession) {
    guard !closed else { return }
    self.session = session
    configure(terminalView)
    session.onUpdate = { [weak self] snapshot in
      guard let self, !self.closed else { return }
#if DEBUG
      self.debugCachedSession = DebugSnapshotCachedSession(status: snapshot.status)
#endif
      self.updateStatus(snapshot)
    }
    session.resize(
      cols: terminalView.terminalDimensions.cols, rows: terminalView.terminalDimensions.rows)
    showWindow(nil)
    window?.makeFirstResponder(terminalView)
    NSApp.activate(ignoringOtherApps: true)
    session.start()
  }

  func apply(_ event: TerminalObservation) throws {
    guard !closed, !retirementBlocked else { throw SpikeWindowError.staleConnection }
    switch event {
    case .reset(let connection, let epoch, let frontier, let cols, let rows, _):
      guard retiringViews.isEmpty else { throw SpikeWindowError.staleConnection }
      let replacesConnection = terminalView?.connectionID != connection
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
      let wasFirstResponder = window?.firstResponder === terminalView
      retire(terminalView)
      terminalView.removeFromSuperview()
      terminalView = replacement
      replacement.autoresizingMask = [.minYMargin]
      terminalContainer.addSubview(replacement)
      positionTerminal()
      updateMinimumContentSize(for: replacement)
      if wasFirstResponder { window?.makeFirstResponder(replacement) }
      geometryRevision = replacesConnection ? 1 : geometryRevision &+ 1
      statusLabel.stringValue = "epoch \(epoch) · frontier \(frontier) · \(cols)×\(rows)"

    case .bytes, .resize:
      try terminalView.apply(event)
      if case .resize = event {
        geometryRevision &+= 1
        liveConnection = nil
        positionTerminal()
      }
    }
  }

  func windowDidResize(_ notification: Notification) {
    guard !closed, let terminalView else { return }
    let current = terminalView.terminalDimensions
    let optimal = terminalView.getOptimalFrameSize()
    guard optimal.width > 0, optimal.height > 0 else { return }
    let cols = max(2, Int(terminalContainer.bounds.width / (optimal.width / CGFloat(current.cols))))
    let rows = max(1, Int(terminalContainer.bounds.height / (optimal.height / CGFloat(current.rows))))
    if terminalView.connectionID == nil || liveConnection == terminalView.connectionID {
      fitTerminalToViewport()
    } else {
      positionTerminal()
    }
    session?.resize(cols: cols, rows: rows)
  }

  func windowWillClose(_ notification: Notification) {
    closeSession()
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
    if let terminalView { retire(terminalView) }
    session?.stop()
    session = nil
  }

  private func retire(_ view: SpikeTerminalView) {
    view.onInput = nil
    view.onGridResize = nil
    view.terminalDelegate = nil
    guard !closeTerminalView(view) else { return }
    retiringViews.append(view)
    // shortcut: stalled GPU graphs stay retained until process exit; add recovery only when enabling Metal.
    retirementOwner = self
    guard retirementTask == nil else { return }
    retirementTask = Task { [self] in
      defer {
        retirementTask = nil
        if retiringViews.isEmpty { retirementOwner = nil }
      }
      let deadline = ContinuousClock.now + .seconds(5)
      while !retiringViews.isEmpty {
        retiringViews.removeAll { closeTerminalView($0) }
        if retiringViews.isEmpty { return }
        guard ContinuousClock.now < deadline else {
          retirementBlocked = true
          if !closed { statusLabel.stringValue = "terminal teardown timed out; views retained" }
          return
        }
        do { try await Task.sleep(for: .milliseconds(10)) } catch {
          retirementBlocked = true
          return
        }
      }
    }
  }

#if DEBUG
  func exportDebugSnapshot(to stateDirectory: URL) async throws -> URL {
    guard !closed else { throw DebugSnapshotError.closed }
    guard !debugExportInFlight else { throw DebugSnapshotError.alreadyExporting }
    debugExportInFlight = true
    defer { debugExportInFlight = false }

    let view = terminalView!
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

  private func installDebugSnapshotSignal() {
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
      cachedSession: debugCachedSession,
      image: DebugSnapshotImage(exists: png != nil, errorCode: imageError))
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]
    let json = try encoder.encode(document)
    guard json.count <= RecordingPage.maxPage else { throw DebugSnapshotError.snapshotTooLarge }
    return DebugSnapshotCapture(png: png, json: json)
  }
#endif

  private func configure(_ view: SpikeTerminalView) {
    view.onInput = { [weak session] bytes in session?.send(bytes: bytes) }
    view.onGridResize = { [weak session] cols, rows in session?.resize(cols: cols, rows: rows) }
  }

  func updateStatus(_ snapshot: PaneSession.Snapshot) {
    guard !closed else { return }
    guard !retirementBlocked else {
      statusLabel.stringValue = "terminal teardown timed out; views retained"
      return
    }
    if snapshot.status.attached, !snapshot.status.recovering,
       snapshot.status.geometryRevision == geometryRevision, let connection = terminalView.connectionID,
       snapshot.status.connectionID == connection, liveConnection != connection {
      liveConnection = connection
      fitTerminalToViewport()
    }
    let dimensions = terminalView.terminalDimensions
    statusLabel.stringValue =
      "\(snapshot.statusLine) · view \(dimensions.cols)×\(dimensions.rows)"
  }

  private func updateMinimumContentSize(for view: SpikeTerminalView) {
    let dimensions = view.terminalDimensions
    let optimal = view.getOptimalFrameSize()
    let minimum = NSSize(
      width: optimal.width / CGFloat(dimensions.cols) * 2,
      height: optimal.height / CGFloat(dimensions.rows) + statusLabel.frame.height)
    window?.contentMinSize = minimum
  }

  private func fitTerminalToViewport() {
    terminalView.setFrameSize(terminalContainer.bounds.size)
    positionTerminal()
  }

  private func positionTerminal() {
    terminalView.setFrameOrigin(NSPoint(
      x: 0, y: terminalContainer.bounds.height - terminalView.frame.height))
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
