import AppKit
import PhiKit
import PhiTerminal

/// Server entry and pane catalog in one window.
///
/// The password is used once to derive a verifier for this connection and is
/// never stored. Panes come from the same `/api/terminals` reply the probe and
/// the shared core already use, through the shared access-password path.
@MainActor
final class SpikeCatalogWindow: NSWindowController, NSWindowDelegate,
  NSTableViewDataSource, NSTableViewDelegate
{
  private static let originDefaultsKey = "phi.spike.origin"

  private let stateDirectory: URL
  /// Returns a message when the pane could not be opened, or nil on success.
  private let onAttach: (URL, PaneCatalog.Pane, AccessAuth.PasswordProvider?) -> String?

  private let originField = NSTextField()
  private let passwordField = NSSecureTextField()
  private let connectButton = NSButton()
  private let statusLabel = PhiTheme.label("", size: 11, color: PhiTheme.textMuted, monospaced: true)
  private let tableView = NSTableView()
  private let scrollView = NSScrollView()
  private let attachButton = NSButton()
  private let refreshButton = NSButton()

  private var panes: [PaneCatalog.Pane] = []
  private var loading = false
  /// The origin whose list is on screen, so a failed refresh can keep it.
  private var listedOrigin: URL?

  /// Runs the pane listing. Replaceable so the failure rules are testable.
  var paneLoader: @MainActor (URL, AccessAuth.PasswordProvider?) async throws -> [PaneCatalog.Pane] = {
    origin, password in
    try await PaneCatalog.panes(origin: origin, password: password, useKeychain: false)
  }

  init(
    stateDirectory: URL,
    onAttach: @escaping (URL, PaneCatalog.Pane, AccessAuth.PasswordProvider?) -> String?
  ) {
    self.stateDirectory = stateDirectory
    self.onAttach = onAttach
    let window = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 560, height: 470),
      styleMask: [.titled, .closable, .miniaturizable, .resizable],
      backing: .buffered, defer: false)
    super.init(window: window)
    window.title = "Phi"
    window.delegate = self
    window.isReleasedWhenClosed = false
    window.minSize = NSSize(width: 460, height: 320)
    window.appearance = NSAppearance(named: .darkAqua)
    window.backgroundColor = PhiTheme.base
    buildContent()
    setStatus("Enter a server address, then press Connect.", isError: false)
    window.center()
    window.makeFirstResponder(originField)
  }

  required init?(coder: NSCoder) {
    fatalError("init(coder:) has not been implemented")
  }

  // MARK: layout

  private func buildContent() {
    let width: CGFloat = 560
    let height: CGFloat = 470
    let inset: CGFloat = 18
    let labelWidth: CGFloat = 74
    let fieldX = inset + labelWidth + 10
    let fieldWidth = width - fieldX - inset

    let root = PhiBackgroundView(frame: NSRect(x: 0, y: 0, width: width, height: height))
    root.wantsLayer = true
    root.autoresizingMask = [.width, .height]
    root.fillColor = PhiTheme.base
    window?.contentView = root

    var top: CGFloat = height - inset - 24

    let originLabel = PhiTheme.label("Server", size: 11, color: PhiTheme.textMuted)
    originLabel.frame = NSRect(x: inset, y: top + 5, width: labelWidth, height: 16)
    originLabel.autoresizingMask = [.minYMargin]
    root.addSubview(originLabel)

    originField.frame = NSRect(x: fieldX, y: top, width: fieldWidth, height: 26)
    originField.autoresizingMask = [.width, .minYMargin]
    originField.placeholderString = "http://host:7070"
    originField.stringValue =
      UserDefaults.standard.string(forKey: Self.originDefaultsKey) ?? "http://localhost:7070"
    originField.target = self
    originField.action = #selector(connect)
    PhiTheme.styleField(originField, monospaced: true)
    root.addSubview(originField)

    top -= 10 + 26
    let passwordLabel = PhiTheme.label("Password", size: 11, color: PhiTheme.textMuted)
    passwordLabel.frame = NSRect(x: inset, y: top + 5, width: labelWidth, height: 16)
    passwordLabel.autoresizingMask = [.minYMargin]
    root.addSubview(passwordLabel)

    passwordField.frame = NSRect(x: fieldX, y: top, width: fieldWidth, height: 26)
    passwordField.autoresizingMask = [.width, .minYMargin]
    passwordField.placeholderString = "Leave empty when the server has none"
    passwordField.target = self
    passwordField.action = #selector(connect)
    PhiTheme.styleField(passwordField)
    root.addSubview(passwordField)

    originField.nextKeyView = passwordField
    passwordField.nextKeyView = connectButton

    top -= 14 + 30
    connectButton.frame = NSRect(x: fieldX, y: top, width: 104, height: 30)
    connectButton.autoresizingMask = [.minYMargin]
    connectButton.keyEquivalent = "\r"
    connectButton.target = self
    connectButton.action = #selector(connect)
    PhiTheme.styleAccentButton(connectButton, title: "Connect")
    root.addSubview(connectButton)

    top -= 10 + 18
    statusLabel.frame = NSRect(x: inset, y: top, width: width - 2 * inset, height: 18)
    statusLabel.autoresizingMask = [.width, .minYMargin]
    root.addSubview(statusLabel)

    let tableTop = top - 10
    let tableHeight = tableTop - 60
    scrollView.frame = NSRect(x: inset, y: 60, width: width - 2 * inset, height: tableHeight)
    scrollView.autoresizingMask = [.width, .height]
    scrollView.hasVerticalScroller = true
    scrollView.scrollerStyle = .overlay
    scrollView.autohidesScrollers = true
    scrollView.borderType = .noBorder
    scrollView.drawsBackground = true
    scrollView.backgroundColor = PhiTheme.panel
    scrollView.wantsLayer = true
    scrollView.layer?.cornerRadius = 10
    scrollView.layer?.borderWidth = 1
    scrollView.layer?.borderColor = PhiTheme.border.cgColor
    scrollView.layer?.masksToBounds = true

    let paneColumn = NSTableColumn(identifier: .init("pane"))
    paneColumn.title = "Pane"
    paneColumn.width = 500
    tableView.addTableColumn(paneColumn)
    tableView.headerView = nil
    tableView.backgroundColor = PhiTheme.panel
    tableView.usesAlternatingRowBackgroundColors = false
    tableView.gridStyleMask = []
    tableView.rowHeight = 32
    tableView.intercellSpacing = .zero
    tableView.allowsMultipleSelection = false
    tableView.dataSource = self
    tableView.delegate = self
    tableView.target = self
    tableView.doubleAction = #selector(attachSelected)
    scrollView.documentView = tableView
    root.addSubview(scrollView)

    attachButton.frame = NSRect(x: inset, y: 18, width: 96, height: 28)
    attachButton.autoresizingMask = [.maxYMargin]
    attachButton.target = self
    attachButton.action = #selector(attachSelected)
    attachButton.isEnabled = false
    PhiTheme.styleAccentButton(attachButton, title: "Attach")
    root.addSubview(attachButton)

    refreshButton.frame = NSRect(x: inset + 104, y: 18, width: 96, height: 28)
    refreshButton.autoresizingMask = [.maxYMargin]
    refreshButton.target = self
    refreshButton.action = #selector(refresh)
    PhiTheme.styleQuietButton(refreshButton, title: "Refresh")
    root.addSubview(refreshButton)

    let stateLabel = PhiTheme.label(
      "state \(stateDirectory.path)", size: 10, color: PhiTheme.textDim, monospaced: true)
    stateLabel.frame = NSRect(x: inset + 210, y: 24, width: width - 210 - inset - 8, height: 14)
    stateLabel.autoresizingMask = [.width, .maxYMargin]
    stateLabel.lineBreakMode = .byTruncatingMiddle
    stateLabel.alignment = .right
    root.addSubview(stateLabel)
  }

  // MARK: actions

  /// The typed password as a one-shot provider. It never reaches the Keychain.
  private var passwordProvider: AccessAuth.PasswordProvider? {
    let secret = passwordField.stringValue
    return secret.isEmpty ? nil : { @Sendable in secret }
  }

  private func enteredOrigin() -> URL? {
    let text = originField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
    return SpikeOptions.origin(from: text)
  }

  @objc private func connect() {
    guard !loading else { return }
    guard let origin = enteredOrigin() else {
      setStatus("Enter an http(s) server address, with no path or credentials.", isError: true)
      return
    }
    Task { await loadPanes(origin: origin) }
  }

  @objc private func refresh() {
    guard let origin = enteredOrigin() else {
      setStatus("Enter an http(s) server address, with no path or credentials.", isError: true)
      return
    }
    Task { await loadPanes(origin: origin) }
  }

  @objc private func attachSelected() {
    _ = attachRow(tableView.selectedRow)
  }

  /// Loads the catalog for `origin`. Also used by the DEBUG self-capture.
  ///
  /// A failure keeps the list that is already on screen when it belongs to the
  /// same origin: a broken refresh must never blank a rendered catalog.
  func loadPanes(origin: URL) async {
    guard !loading else { return }
    loading = true
    updateControls()
    setStatus("Connecting to \(origin.host() ?? origin.absoluteString)…", isError: false)
    let provider = passwordProvider
    let showsTheSameServer = listedOrigin == origin
    do {
      let listed = try await paneLoader(origin, provider)
      panes = listed
      listedOrigin = origin
      remember(origin)
      pruneDrafts(keeping: listed)
      tableView.reloadData()
      setStatus(
        listed.isEmpty
          ? "Connected · no panes on this server"
          : "Connected · \(listed.count) pane\(listed.count == 1 ? "" : "s")",
        isError: false)
    } catch {
      if !showsTheSameServer {
        panes = []
        listedOrigin = nil
        tableView.reloadData()
      }
      let kept = showsTheSameServer && !panes.isEmpty ? " · showing the last list" : ""
      setStatus(describe(error) + kept, isError: true)
    }
    loading = false
    updateControls()
  }

  /// Drops saved drafts for panes this server no longer has, so an abandoned
  /// prompt does not sit in the preferences file forever.
  private func pruneDrafts(keeping panes: [PaneCatalog.Pane]) {
    let live = Set(panes.map { PhiComposerView.draftKey(paneID: $0.id) })
    let defaults = UserDefaults.standard
    for key in defaults.dictionaryRepresentation().keys
    where key.hasPrefix(PhiComposerView.draftKeyPrefix) && !live.contains(key) {
      defaults.removeObject(forKey: key)
    }
  }

  /// Attaches one catalog row. Returns false for a row that holds no pane.
  @discardableResult
  func attachRow(_ row: Int) -> Bool {
    guard row >= 0, row < panes.count, let origin = enteredOrigin() else { return false }
    let pane = panes[row]
    tableView.selectRowIndexes(IndexSet(integer: row), byExtendingSelection: false)
    if let failure = onAttach(origin, pane, passwordProvider) {
      // Report the real outcome: nothing is shown as opened unless it opened.
      setStatus("Could not open \(name(of: pane)) · \(failure)", isError: true)
      return false
    }
    setStatus("Opened \(name(of: pane)).", isError: false)
    return true
  }

  /// A pane is identified by its title when it has one; the coder is the fallback.
  private func name(of pane: PaneCatalog.Pane) -> String {
    Self.displayName(title: pane.title, coder: pane.coder)
  }

  /// The server sends an empty title for an unnamed pane; show the coder instead.
  static func displayName(title: String?, coder: String) -> String {
    guard let title, !title.isEmpty else { return coder }
    return title
  }

  var catalogSummary: (panes: Int, status: String) {
    (panes.count, statusLabel.stringValue)
  }

  func setOriginText(_ origin: URL) {
    originField.stringValue = origin.absoluteString
  }

  /// Only a working server becomes the next launch's default, and a DEBUG
  /// capture run leaves the real preferences alone.
  private func remember(_ origin: URL) {
    guard !capturesSelfDump else { return }
    UserDefaults.standard.set(origin.absoluteString, forKey: Self.originDefaultsKey)
  }

  private var capturesSelfDump: Bool {
#if DEBUG
    return SpikeUIDump.Request.fromEnvironment() != nil
#else
    return false
#endif
  }

  private func describe(_ error: Error) -> String {
    if let failure = error as? AccessAuth.Failure {
      switch failure {
      case .noPassword: return "This server needs an access password."
      case .wrongPassword: return "Wrong password."
      case .rateLimited: return "Too many attempts; wait a few seconds."
      case .badStatus: return "The server answered with unexpected auth settings."
      case .server(let message): return message
      }
    }
    if let wireError = error as? PaneWireError, case .http(401) = wireError {
      return "This server needs an access password."
    }
    return error.localizedDescription
  }

  private func setStatus(_ text: String, isError: Bool) {
    statusLabel.stringValue = text
    statusLabel.textColor = isError ? PhiTheme.danger : PhiTheme.textMuted
  }

  private func updateControls() {
    connectButton.isEnabled = !loading
    refreshButton.isEnabled = !loading
    attachButton.isEnabled = !loading && tableView.selectedRow >= 0
    let title = loading ? "Connecting…" : "Connect"
    PhiTheme.styleAccentButton(connectButton, title: title)
    PhiTheme.refreshButton(connectButton, usesAccent: true)
    PhiTheme.refreshButton(refreshButton, usesAccent: false)
    PhiTheme.refreshButton(attachButton, usesAccent: true)
  }

  // MARK: table

  func numberOfRows(in tableView: NSTableView) -> Int { panes.count }

  func tableView(
    _ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int
  ) -> NSView? {
    guard row < panes.count else { return nil }
    let pane = panes[row]
    let identifier = NSUserInterfaceItemIdentifier("pane-row")
    let cell: PaneRowCellView
    if let reused = tableView.makeView(withIdentifier: identifier, owner: self) as? PaneRowCellView {
      cell = reused
    } else {
      cell = PaneRowCellView()
      cell.identifier = identifier
    }
    cell.configure(name: name(of: pane), id: pane.id)
    return cell
  }

  func tableView(_ tableView: NSTableView, rowViewForRow row: Int) -> NSTableRowView? {
    PaneRowView()
  }

  func tableViewSelectionDidChange(_ notification: Notification) {
    updateControls()
  }
}

/// One catalog row: the pane name, then its id in the dim monospace voice.
/// Phi's session list has no table header and no column rules, so neither does
/// this one.
@MainActor
final class PaneRowCellView: NSView {
  private let nameLabel = PhiTheme.label("", size: 12, color: PhiTheme.textPrimary)
  private let idLabel = PhiTheme.label("", size: 11, color: PhiTheme.textMuted, monospaced: true)

  override init(frame frameRect: NSRect) {
    super.init(frame: frameRect)
    nameLabel.lineBreakMode = .byTruncatingTail
    idLabel.lineBreakMode = .byTruncatingMiddle
    addSubview(nameLabel)
    addSubview(idLabel)
  }

  required init?(coder: NSCoder) {
    fatalError("init(coder:) has not been implemented")
  }

  func configure(name: String, id: String) {
    nameLabel.stringValue = name
    idLabel.stringValue = id
  }

  override func layout() {
    super.layout()
    let inset: CGFloat = 12
    let nameWidth = max(60, bounds.width * 0.34)
    let height: CGFloat = 16
    let y = (bounds.height - height) / 2
    nameLabel.frame = NSRect(x: inset, y: y, width: nameWidth - inset - 8, height: height)
    idLabel.frame = NSRect(
      x: nameWidth, y: y, width: max(40, bounds.width - nameWidth - inset), height: height)
  }
}

/// Accent-wash selection instead of the system highlight, which fights a dark list.
@MainActor
final class PaneRowView: NSTableRowView {
  override func drawSelection(in dirtyRect: NSRect) {
    guard selectionHighlightStyle != .none else { return }
    PhiTheme.accent.withAlphaComponent(0.15).setFill()
    NSBezierPath(roundedRect: bounds.insetBy(dx: 2, dy: 2), xRadius: 6, yRadius: 6).fill()
  }
}
