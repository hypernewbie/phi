import AppKit

/// Phi's footer strip: a panel fill, one hairline, and a monospaced status line.
///
/// It draws all three itself. Separate label and hairline views were invisible
/// in a layer-backed window: their drawing landed under the opaque fill of the
/// view behind them.
final class PhiStatusStrip: NSView {
  static let height: CGFloat = 22

  var text: String = "" {
    didSet { needsDisplay = true }
  }

  var textColor: NSColor = PhiTheme.textMuted {
    didSet { needsDisplay = true }
  }

  override var isOpaque: Bool { true }

  /// Flipped so the hairline sits on the top edge and the status text draws
  /// inside the strip instead of above it.
  override var isFlipped: Bool { true }

  override func draw(_ dirtyRect: NSRect) {
    PhiTheme.panel.setFill()
    dirtyRect.fill()
    PhiTheme.border.setFill()
    NSRect(x: 0, y: 0, width: bounds.width, height: 1).fill()
    guard !text.isEmpty else { return }
    let attributes: [NSAttributedString.Key: Any] = [
      .font: PhiTheme.mono(11),
      .foregroundColor: textColor,
    ]
    let line = NSAttributedString(string: text, attributes: attributes)
    line.draw(
      with: NSRect(x: 10, y: 3, width: bounds.width - 20, height: 16),
      options: [.usesLineFragmentOrigin, .truncatesLastVisibleLine])
  }
}
