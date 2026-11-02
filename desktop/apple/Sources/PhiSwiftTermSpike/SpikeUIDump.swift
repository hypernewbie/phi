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
    /// How many listed panes to attach before capturing; 0 captures the
    /// catalog alone.
    let attachPanes: Int

    /// Reads the environment, or returns nil when no capture was requested.
    static func fromEnvironment(
      _ environment: [String: String] = ProcessInfo.processInfo.environment
    ) -> Request? {
      guard let path = environment["PHI_SPIKE_UI_DUMP"], path.hasPrefix("/") else { return nil }
      let origin = environment["PHI_SPIKE_UI_CONNECT"].flatMap(SpikeOptions.origin(from:))
      return Request(
        imagePath: URL(fileURLWithPath: path),
        connectOrigin: origin,
        attachPanes: Int(environment["PHI_SPIKE_UI_ATTACH"] ?? "") ?? 0)
    }
  }

  static func run(
    _ request: Request, on catalog: SpikeCatalogWindow,
    terminalWindows: () -> [SpikeWindow] = { [] }
  ) async throws {
    if let origin = request.connectOrigin {
      catalog.setOriginText(origin)
      await catalog.loadPanes(origin: origin)
    }
    if request.attachPanes > 0 {
      for row in 0..<request.attachPanes {
        catalog.attachRow(row)
        // Let the new session attach before anything is captured.
        try await Task.sleep(nanoseconds: 3_000_000_000)
      }
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
    for (index, controller) in terminals.enumerated() {
      let path = request.imagePath.deletingPathExtension()
        .appendingPathExtension("terminal-\(index)").appendingPathExtension("png")
      let capture = try await controller.writeUIDumpPNG(to: path)
      terminalRecords.append([
        "window": controller.window?.title ?? "", "file": path.lastPathComponent,
        "width": capture.width, "height": capture.height,
        "pngBytes": capture.bytes, "statusText": controller.statusText, "firstResponder": controller.window?.firstResponder.map { String(describing: type(of: $0)) } ?? "",
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
  /// A window's layers are rendered, then any child that hosts its pixels in a
  /// layer of its own, such as the terminal view, is drawn in at its frame.
  /// A view without a window falls back to AppKit's cached display, which is
  /// what the views a test builds need.
  static func writePNG(of view: NSView, compositing overlays: [NSView] = [], to path: URL) throws -> Int {
    view.layoutSubtreeIfNeeded()
    // Layers only carry pixels after a display pass, and a view that has
    // never drawn keeps an empty layer until it is marked dirty.
    markDirty(view)
    view.displayIfNeeded()
    view.window?.displayIfNeeded()
    if view.wantsLayer, view.layer != nil, view.window != nil {
      let data = try renderLayer(of: view, compositing: overlays)
      try data.write(to: path, options: .atomic)
      return data.count
    }
    guard let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds) else {
      throw Failure.noBitmap
    }
    NSGraphicsContext.saveGraphicsState()
    if let context = NSGraphicsContext(bitmapImageRep: rep) {
      NSGraphicsContext.current = context
      PhiTheme.base.setFill()
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

  private static func markDirty(_ view: NSView) {
    // A layer-backed view keeps whatever it last drew, so a capture taken
    // after the text changed shows the old pixels unless the layer is told to
    // redraw from the view.
    view.needsDisplay = true
    for subview in view.subviews { markDirty(subview) }
  }

  /// Renders one view's layer alone, at its own backing scale.
  private static func renderImage(of view: NSView) throws -> CGImage {
    let scale = view.window?.backingScaleFactor ?? 2
    let width = Int((view.bounds.width * scale).rounded())
    let height = Int((view.bounds.height * scale).rounded())
    guard width > 0, height > 0,
          let space = CGColorSpace(name: CGColorSpace.sRGB),
          let context = CGContext(
            data: nil, width: width, height: height, bitsPerComponent: 8,
            bytesPerRow: 0, space: space,
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue),
          let layer = view.layer
    else { throw Failure.noBitmap }
    context.scaleBy(x: scale, y: scale)
    layer.render(in: context)
    guard let image = context.makeImage() else { throw Failure.noImageData }
    return image
  }

  /// Renders `view`'s layer tree, then draws each overlay's own layer at its
  /// frame. A layer that hosts its content itself, such as the terminal, does
  /// not come through an ancestor render, so it is drawn explicitly.
  private static func renderLayer(of view: NSView, compositing overlays: [NSView]) throws -> Data {
    let scale = view.window?.backingScaleFactor ?? 2
    let width = Int((view.bounds.width * scale).rounded())
    let height = Int((view.bounds.height * scale).rounded())
    guard width > 0, height > 0,
          let space = CGColorSpace(name: CGColorSpace.sRGB),
          let context = CGContext(
            data: nil, width: width, height: height, bitsPerComponent: 8,
            bytesPerRow: 0, space: space,
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue),
          let layer = view.layer
    else { throw Failure.noBitmap }
    context.setFillColor(
      (PhiTheme.base.usingColorSpace(.sRGB) ?? .black).cgColor)
    context.fill(CGRect(x: 0, y: 0, width: width, height: height))
    context.saveGState()
    context.scaleBy(x: scale, y: scale)
    layer.render(in: context)
    context.restoreGState()
    for overlay in overlays {
      guard let overlayImage = try? renderImage(of: overlay) else { continue }
      let frame = overlay.convert(overlay.bounds, to: view)
      // The overlay carries its own pixel scale; place it by its pixel size.
      let rect = CGRect(
        x: frame.minX * scale,
        y: frame.minY * scale,
        width: CGFloat(overlayImage.width),
        height: CGFloat(overlayImage.height))
      context.draw(overlayImage, in: rect)
    }
    guard let image = context.makeImage(),
          let data = NSBitmapImageRep(cgImage: image).representation(
            using: .png, properties: [: ])
    else { throw Failure.noImageData }
    return data
  }

  enum Failure: Error {
    case noWindow
    case noBitmap
    case noImageData
  }
}
#endif
