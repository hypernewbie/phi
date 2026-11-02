import AppKit

/// Phi's design tokens, mirrored from `web/style.css`.
///
/// The native client keeps native AppKit controls but wears the same palette,
/// radii, and monospace treatment as the web app, so a pane looks like Phi
/// rather than like a generic macOS window.
enum PhiTheme {
  static let base = NSColor(hex: 0x0808_0A)
  static let panel = NSColor(hex: 0x0D0D_10)
  static let elevated = NSColor(hex: 0x1414_18)
  static let border = NSColor(hex: 0x1F1F_26)

  static let accent = NSColor(hex: 0x7C6A_F7)
  static let accentBright = NSColor(hex: 0x9A8D_FA)

  static let textPrimary = NSColor(hex: 0xE4E3_E9)
  static let textMuted = NSColor(hex: 0x7876_8A)
  static let textDim = NSColor(hex: 0x4240_52)

  /// Phi's "active" colour; the token is called `--green` in the stylesheet.
  static let active = NSColor(hex: 0x38BD_F8)
  static let danger = NSColor(hex: 0xEF44_44)

  static let cornerRadius: CGFloat = 8

  static func ui(_ size: CGFloat, weight: NSFont.Weight = .regular) -> NSFont {
    .systemFont(ofSize: size, weight: weight)
  }

  static func mono(_ size: CGFloat, weight: NSFont.Weight = .regular) -> NSFont {
    .monospacedSystemFont(ofSize: size, weight: weight)
  }

  /// A flat field on `--bg-elevated`, like the web app's inputs.
  @MainActor
  static func styleField(_ field: NSTextField, monospaced: Bool = false) {
    field.isBezeled = false
    field.isBordered = false
    field.drawsBackground = true
    field.backgroundColor = elevated
    field.textColor = textPrimary
    field.font = monospaced ? mono(12) : ui(12)
    field.focusRingType = .none
    field.wantsLayer = true
    field.layer?.cornerRadius = cornerRadius
    field.layer?.borderWidth = 1
    field.layer?.borderColor = border.cgColor
    field.layer?.masksToBounds = true
    if let placeholder = field.placeholderString {
      field.placeholderAttributedString = NSAttributedString(
        string: placeholder,
        attributes: [.foregroundColor: textDim, .font: field.font as Any])
    }
  }

  /// An accent button: wash background, accent edge, bright label.
  @MainActor
  static func styleAccentButton(_ button: NSButton, title: String) {
    button.title = title
    button.isBordered = false
    button.wantsLayer = true
    button.layer?.cornerRadius = cornerRadius
    button.layer?.backgroundColor = accent.withAlphaComponent(0.15).cgColor
    button.layer?.borderWidth = 1
    button.layer?.borderColor = accent.withAlphaComponent(0.35).cgColor
    button.attributedTitle = NSAttributedString(
      string: title,
      attributes: [.foregroundColor: accentBright, .font: ui(12, weight: .medium)])
  }

  /// A quiet button for secondary actions.
  @MainActor
  static func styleQuietButton(_ button: NSButton, title: String) {
    button.title = title
    button.isBordered = false
    button.wantsLayer = true
    button.layer?.cornerRadius = cornerRadius
    button.layer?.backgroundColor = elevated.cgColor
    button.layer?.borderWidth = 1
    button.layer?.borderColor = border.cgColor
    button.attributedTitle = NSAttributedString(
      string: title, attributes: [.foregroundColor: textMuted, .font: ui(12)])
  }

  /// Keeps a button's look in step with its enabled state.
  @MainActor
  static func refreshButton(_ button: NSButton, usesAccent: Bool) {
    button.layer?.opacity = button.isEnabled ? 1 : 0.45
    button.layer?.backgroundColor =
      (usesAccent ? accent.withAlphaComponent(0.15) : elevated).cgColor
  }

  @MainActor
  static func label(
    _ text: String, size: CGFloat, color: NSColor, monospaced: Bool = false
  ) -> NSTextField {
    let label = NSTextField(labelWithString: text)
    label.font = monospaced ? mono(size) : ui(size)
    label.textColor = color
    label.lineBreakMode = .byTruncatingTail
    return label
  }
}

/// A flat background in one of Phi's surface colours.
final class PhiBackgroundView: NSView {
  var fillColor: NSColor = PhiTheme.base {
    didSet { needsDisplay = true }
  }

  override var isOpaque: Bool { true }

  override func draw(_ dirtyRect: NSRect) {
    fillColor.setFill()
    dirtyRect.fill()
  }
}

extension NSColor {
  convenience init(hex: UInt32) {
    self.init(
      srgbRed: CGFloat((hex >> 16) & 0xFF) / 255,
      green: CGFloat((hex >> 8) & 0xFF) / 255,
      blue: CGFloat(hex & 0xFF) / 255,
      alpha: 1)
  }
}
