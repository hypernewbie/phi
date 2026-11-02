import AppKit

/// Phi's tab strip: a panel bar with one tab per pane, the active tab raised on
/// the window background with an accent line on top.
///
/// Mirrors `.terminal-tabs-bar` and `.tab.active` in `web/style.css`: 42-point
/// bar, tabs 38 high and 120 to 240 wide, 4-point gap, rounded top corners.
/// Each tab is made of control views, so the window composites it like any other
/// control and a capture shows what the window shows.
final class PhiTabStrip: NSView {
  static let height: CGFloat = 42
  static let tabHeight: CGFloat = 38
  static let minimumTabWidth: CGFloat = 120
  static let maximumTabWidth: CGFloat = 240
  static let gap: CGFloat = 4
  static let leadingInset: CGFloat = 8

  struct Item: Equatable {
    let id: String
    let title: String
  }

  var items: [Item] = [] {
    didSet {
      if activeID == nil || !items.contains(where: { $0.id == activeID }) {
        activeID = items.first?.id
      }
      syncTabViews()
      applyActiveState()
    }
  }

  var activeID: String? {
    didSet { applyActiveState() }
  }

  var onSelect: ((String) -> Void)?
  var onClose: ((String) -> Void)?
  var onNewTab: (() -> Void)?

  private var tabViews: [String: PhiTabView] = [:]
  private let hairline = NSView()
  private let newTabButton = NSButton(title: "＋", target: nil, action: nil)

  override init(frame frameRect: NSRect) {
    super.init(frame: frameRect)
    wantsLayer = true
    layer?.backgroundColor = PhiTheme.panel.cgColor
    // Tabs past the right edge are cut here instead of painting over the window.
    clipsToBounds = true
    hairline.wantsLayer = true
    hairline.layer?.backgroundColor = PhiTheme.border.cgColor
    addSubview(hairline)

    newTabButton.isBordered = false
    newTabButton.font = PhiTheme.ui(14)
    newTabButton.contentTintColor = PhiTheme.textMuted
    newTabButton.target = self
    newTabButton.action = #selector(newTabClicked)
    newTabButton.toolTip = "New tab"
    newTabButton.setAccessibilityLabel("New tab")
    addSubview(newTabButton)
  }

  required init?(coder: NSCoder) {
    fatalError("init(coder:) has not been implemented")
  }

  override func layout() {
    super.layout()
    hairline.frame = NSRect(x: 0, y: 0, width: bounds.width, height: 1)
    newTabButton.frame = NSRect(
      x: bounds.width - 32, y: (bounds.height - 24) / 2, width: 24, height: 24)
    var x = Self.leadingInset
    let available = max(bounds.width - Self.leadingInset - 40, Self.minimumTabWidth)
    let width = min(
      Self.maximumTabWidth,
      max(
        Self.minimumTabWidth,
        (available - CGFloat(max(items.count - 1, 0)) * Self.gap)
          / CGFloat(max(items.count, 1))))
    for item in items {
      guard let tab = tabViews[item.id] else { continue }
      tab.frame = NSRect(
        x: x, y: bounds.height - Self.tabHeight, width: width, height: Self.tabHeight)
      x += width + Self.gap
    }
  }

  /// The view for one tab, so a caller can drive it like a click would.
  func tab(_ id: String) -> PhiTabView? { tabViews[id] }

  @objc private func newTabClicked() {
    onNewTab?()
  }

  private func applyActiveState() {
    for (id, tab) in tabViews { tab.isActive = (id == activeID) }
  }

  private func syncTabViews() {
    let live = Set(items.map(\.id))
    for (id, view) in tabViews where !live.contains(id) {
      view.removeFromSuperview()
      tabViews.removeValue(forKey: id)
    }
    for item in items {
      if let existing = tabViews[item.id] {
        existing.title = item.title
        continue
      }
      let tab = PhiTabView(id: item.id, title: item.title)
      tab.onSelect = { [weak self] id in self?.onSelect?(id) }
      tab.onClose = { [weak self] in self?.onClose?(item.id) }
      addSubview(tab)
      tabViews[item.id] = tab
    }
    needsLayout = true
  }
}

/// One tab: a title, a close glyph, and the raised shape of the active tab.
final class PhiTabView: NSView {
  enum Hit: Equatable { case select, close }

  let id: String
  var title: String {
    get { label.stringValue }
    set {
      label.stringValue = newValue
      setAccessibilityLabel(newValue)
      closeButton.setAccessibilityLabel("Close \(newValue)")
    }
  }

  var isActive = false {
    didSet { applyAppearance() }
  }

  var onSelect: ((String) -> Void)?
  var onClose: (() -> Void)?

  private let label = NSTextField(labelWithString: "")
  private let closeButton = NSButton(title: "×", target: nil, action: nil)
  private let accentLine = NSView()

  init(id: String, title: String) {
    self.id = id
    super.init(frame: .zero)
    wantsLayer = true
    layer?.cornerRadius = 7
    layer?.maskedCorners = [.layerMinXMaxYCorner, .layerMaxXMaxYCorner]

    accentLine.wantsLayer = true
    accentLine.layer?.backgroundColor = PhiTheme.accent.cgColor
    addSubview(accentLine)

    label.stringValue = title
    label.font = PhiTheme.ui(13)
    label.textColor = PhiTheme.textMuted
    label.lineBreakMode = .byTruncatingTail
    label.maximumNumberOfLines = 1
    addSubview(label)

    closeButton.isBordered = false
    closeButton.font = PhiTheme.ui(13)
    closeButton.contentTintColor = PhiTheme.textMuted
    closeButton.target = self
    closeButton.action = #selector(closeClicked)
    closeButton.toolTip = "Close pane"
    addSubview(closeButton)

    setAccessibilityRole(.button)
    setAccessibilityLabel(title)
    closeButton.setAccessibilityLabel("Close \(title)")

    applyAppearance()
  }

  required init?(coder: NSCoder) {
    fatalError("init(coder:) has not been implemented")
  }

  override func layout() {
    super.layout()
    accentLine.frame = NSRect(x: 8, y: bounds.height - 2, width: max(bounds.width - 16, 0), height: 2)
    closeButton.frame = NSRect(x: bounds.width - 24, y: 5, width: 18, height: 18)
    label.frame = NSRect(
      x: 10, y: (bounds.height - 17) / 2, width: max(bounds.width - 44, 10), height: 17)
  }

  /// Which action a click at a point in this tab means.
  func hit(at point: NSPoint) -> Hit {
    closeButton.frame.contains(point) ? .close : .select
  }

  override func mouseDown(with event: NSEvent) {
    let point = convert(event.locationInWindow, from: nil)
    if hit(at: point) == .select { onSelect?(id) }
  }

  private func applyAppearance() {
    layer?.backgroundColor = (isActive ? PhiTheme.base : PhiTheme.panel).cgColor
    layer?.borderColor = PhiTheme.border.cgColor
    layer?.borderWidth = isActive ? 1 : 0
    accentLine.isHidden = !isActive
    label.textColor = isActive ? PhiTheme.textPrimary : PhiTheme.textMuted
    label.font = PhiTheme.ui(13, weight: isActive ? .medium : .regular)
  }

  @objc private func closeClicked() {
    onClose?()
  }
}
