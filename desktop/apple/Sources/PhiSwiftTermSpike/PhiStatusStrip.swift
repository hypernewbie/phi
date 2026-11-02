import AppKit

/// Phi's footer strip: a panel fill, one hairline, and a monospaced status line.
///
/// The fill is the layer's background and the status line is a label, so the
/// window composites the strip like any other control and a capture shows what
/// the window shows.
final class PhiStatusStrip: NSView {
  static let height: CGFloat = 22

  private let label = NSTextField(labelWithString: "")
  private let hairline = NSView()

  var text: String {
    get { label.stringValue }
    set { label.stringValue = newValue }
  }

  var textColor: NSColor {
    get { label.textColor ?? PhiTheme.textMuted }
    set { label.textColor = newValue }
  }

  override init(frame frameRect: NSRect) {
    super.init(frame: frameRect)
    wantsLayer = true
    layer?.backgroundColor = PhiTheme.panel.cgColor
    hairline.wantsLayer = true
    hairline.layer?.backgroundColor = PhiTheme.border.cgColor
    addSubview(hairline)

    label.font = PhiTheme.mono(11)
    label.textColor = PhiTheme.textMuted
    label.lineBreakMode = .byTruncatingTail
    label.maximumNumberOfLines = 1
    addSubview(label)
  }

  required init?(coder: NSCoder) {
    fatalError("init(coder:) has not been implemented")
  }

  override func layout() {
    super.layout()
    hairline.frame = NSRect(x: 0, y: bounds.height - 1, width: bounds.width, height: 1)
    label.frame = NSRect(x: 10, y: 3, width: max(bounds.width - 20, 10), height: 15)
  }
}
