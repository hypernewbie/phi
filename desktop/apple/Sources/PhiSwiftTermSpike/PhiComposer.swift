import AppKit

/// Turns composer text into the bytes a pane receives.
///
/// The web composer (`sendStagedInput` in `web/terminal.js`) trims the draft,
/// wraps a long or multiline prompt in bracketed paste so a TUI cannot
/// autocomplete or trickle-render it, and appends a carriage return.
enum PhiPrompt {
  static func bytes(for text: String) -> [UInt8]? {
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return nil }
    // An escape byte typed or pasted into a prompt would reach the pane as a
    // control sequence, so it becomes the visible replacement character.
    let safe = trimmed.replacingOccurrences(of: "\u{1B}", with: "\u{241B}")
    var payload = safe
    if trimmed.utf16.count > 16 || trimmed.contains("\n") {
      payload = "\u{1B}[200~\(safe)\u{1B}[201~"
    }
    return Array("\(payload)\r".utf8)
  }
}

/// The prompt composer: a field and a Send button, like the web app's
/// `#input-bar-container`.
///
/// Typing stays on this machine. Only a submitted prompt travels to the pane,
/// so a slow link costs one round trip per command instead of one per keystroke.
final class PhiComposerView: NSView, NSTextFieldDelegate {
  static let barHeight: CGFloat = 54
  /// Narrower than this and the field and the Send button collide.
  static let minimumWidth: CGFloat = 260
  static let fieldHeight: CGFloat = 38
  static let sideInset: CGFloat = 12

  let field = NSTextField()
  let sendButton = NSButton()
  /// Returns true when the prompt was accepted and the field may be cleared.
  var onSend: ((String) -> Bool)?
  /// Escape leaves the composer, the way the web app returns to the terminal.
  var onEscape: (() -> Void)?
  /// Where this pane's draft is kept across window closes, like the web app's
  /// per-tab draft. Nil keeps the draft in memory only.
  var draftKey: String? {
    didSet { restoreDraft() }
  }

  /// The preferences key for one pane's draft. The catalog uses the same
  /// prefix to drop drafts for panes the server no longer has.
  static func draftKey(paneID: String) -> String {
    "\(draftKeyPrefix)\(paneID)"
  }

  static let draftKeyPrefix = "phi.spike.draft."

  override init(frame frameRect: NSRect) {
    super.init(frame: frameRect)
    wantsLayer = true
    layer?.backgroundColor = PhiTheme.panel.cgColor
    hairline.wantsLayer = true
    hairline.layer?.backgroundColor = PhiTheme.border.cgColor
    addSubview(hairline)

    field.placeholderString = "Type a prompt…"
    field.setAccessibilityLabel("Prompt")
    PhiTheme.styleField(field)
    field.backgroundColor = PhiTheme.base
    field.font = PhiTheme.ui(13)
    field.delegate = self
    addSubview(field)

    PhiTheme.styleAccentButton(sendButton, title: "Send ↵")
    sendButton.target = self
    sendButton.action = #selector(send)
    addSubview(sendButton)
  }

  required init?(coder: NSCoder) {
    fatalError("init(coder:) has not been implemented")
  }

  var prompt: String {
    get { field.stringValue }
    set {
      field.stringValue = newValue
      saveDraft()
    }
  }

  /// The bar is filled by its layer and separated from the terminal by one
  /// hairline, so it composites like the controls inside it.
  private let hairline = NSView()

  override func layout() {
    super.layout()
    hairline.frame = NSRect(x: 0, y: bounds.height - 1, width: bounds.width, height: 1)
    let sendWidth = max(84, sendButton.intrinsicContentSize.width + 24)
    let fieldWidth = bounds.width - Self.sideInset * 2 - sendWidth - 8
    field.frame = NSRect(
      x: Self.sideInset, y: Self.sideInset, width: fieldWidth, height: Self.fieldHeight)
    sendButton.frame = NSRect(
      x: bounds.width - Self.sideInset - sendWidth, y: Self.sideInset,
      width: sendWidth, height: 32)
  }

  func focus() {
    window?.makeFirstResponder(field)
  }

  @objc func send() {
    guard PhiPrompt.bytes(for: field.stringValue) != nil else { return }
    guard onSend?(field.stringValue) ?? false else { return }
    field.stringValue = ""
    saveDraft()
  }

  func controlTextDidChange(_ notification: Notification) {
    saveDraft()
  }

  private func saveDraft() {
    guard let draftKey else { return }
    let defaults = UserDefaults.standard
    if field.stringValue.isEmpty {
      defaults.removeObject(forKey: draftKey)
    } else {
      defaults.set(field.stringValue, forKey: draftKey)
    }
  }

  private func restoreDraft() {
    guard let draftKey else { return }
    field.stringValue = UserDefaults.standard.string(forKey: draftKey) ?? ""
  }

  func control(
    _ control: NSControl, textView: NSTextView, doCommandBy commandSelector: Selector
  ) -> Bool {
    switch commandSelector {
    case #selector(NSResponder.insertNewline(_:)):
      send()
      return true
    case #selector(NSResponder.cancelOperation(_:)):
      onEscape?()
      return true
    default:
      return false
    }
  }
}
