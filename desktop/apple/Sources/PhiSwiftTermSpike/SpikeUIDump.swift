#if DEBUG
import AppKit
import Foundation

/// Opt-in DEBUG-only capture of the app's own windows.
///
/// The terminal window has always been able to export its pixels on `SIGINFO`.
/// The catalog window needs the same evidence without a screen-recording
/// permission, so this writes a PNG of the window the app itself drew.
///
/// `PHI_SPIKE_UI_DUMP=<absolute .png path>` requests the capture.
/// `PHI_SPIKE_UI_CONNECT=<http(s) origin>` loads the pane catalog first.
/// `PHI_SPIKE_UI_ATTACH=1` attaches the first listed pane afterwards.
///
/// Nothing is uploaded, logged, or retried. The capture is written once and the
/// process exits, so an unattended check can read the result.
@MainActor
enum SpikeUIDump {
  struct Request {
    let imagePath: URL
    let connectOrigin: URL?
    let attachFirstPane: Bool

    /// Reads the environment, or returns nil when no capture was requested.
    static func fromEnvironment(
      _ environment: [String: String] = ProcessInfo.processInfo.environment
    ) -> Request? {
      guard let path = environment["PHI_SPIKE_UI_DUMP"], path.hasPrefix("/") else { return nil }
      let origin = environment["PHI_SPIKE_UI_CONNECT"].flatMap(SpikeOptions.origin(from:))
      return Request(
        imagePath: URL(fileURLWithPath: path),
        connectOrigin: origin,
        attachFirstPane: environment["PHI_SPIKE_UI_ATTACH"] == "1")
    }
  }

  static func run(
    _ request: Request, on catalog: SpikeCatalogWindow,
    terminalWindows: () -> [NSWindow] = { [] }
  ) async throws {
    if let origin = request.connectOrigin {
      catalog.setOriginText(origin)
      await catalog.loadPanes(origin: origin)
    }
    if request.attachFirstPane {
      catalog.attachRow(0)
      // Let the new session attach before anything is captured.
      try await Task.sleep(nanoseconds: 2_000_000_000)
    }
    // Let the layout and any row views settle before reading the pixels.
    for _ in 0..<3 {
      await Task.yield()
      catalog.window?.displayIfNeeded()
    }
    guard let view = catalog.window?.contentView else { throw Failure.noWindow }
    let bytes = try writePNG(of: view, to: request.imagePath)
    let summary = catalog.catalogSummary
    var record: [String: Any] = [
      "window": catalog.window?.title ?? "",
      "width": Int(view.bounds.width),
      "height": Int(view.bounds.height),
      "panes": summary.panes,
      "status": summary.status,
      "pngBytes": bytes,
    ]
    let terminals = terminalWindows()
    var terminalRecords: [[String: Any]] = []
    for (index, window) in terminals.enumerated() {
      guard let content = window.contentView else { continue }
      window.displayIfNeeded()
      let path = request.imagePath.deletingPathExtension()
        .appendingPathExtension("terminal-\(index)").appendingPathExtension("png")
      let size = try writePNG(of: content, to: path)
      terminalRecords.append([
        "window": window.title, "file": path.lastPathComponent,
        "width": Int(content.bounds.width), "height": Int(content.bounds.height),
        "pngBytes": size,
      ])
    }
    record["terminals"] = terminalRecords
    let json = try JSONSerialization.data(withJSONObject: record, options: [.sortedKeys])
    try json.write(
      to: request.imagePath.deletingPathExtension().appendingPathExtension("json"),
      options: .atomic)
  }

  /// Writes `view`'s current pixels as PNG and returns the byte count.
  ///
  /// The window background is painted into the bitmap first: a plain content
  /// view draws nothing behind its labels, so a bare cache would leave transparent
  /// pixels that read as black and hide dark text.
  static func writePNG(of view: NSView, to path: URL) throws -> Int {
    view.layoutSubtreeIfNeeded()
    guard let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds) else {
      throw Failure.noBitmap
    }
    NSGraphicsContext.saveGraphicsState()
    if let context = NSGraphicsContext(bitmapImageRep: rep) {
      NSGraphicsContext.current = context
      NSColor.windowBackgroundColor.setFill()
      NSRect(origin: .zero, size: view.bounds.size).fill()
      context.flushGraphics()
    }
    NSGraphicsContext.restoreGraphicsState()
    view.cacheDisplay(in: view.bounds, to: rep)
    guard let data = rep.representation(using: .png, properties: [:]) else {
      throw Failure.noImageData
    }
    try data.write(to: path, options: .atomic)
    return data.count
  }

  enum Failure: Error {
    case noWindow
    case noBitmap
    case noImageData
  }
}
#endif
