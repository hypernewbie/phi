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
  private let onAttach: (URL, String, AccessAuth.PasswordProvider?) -> Void

  private let originField = NSTextField()
  private let passwordField = NSSecureTextField()
  private let connectButton = NSButton()
  private let statusLabel = NSTextField(labelWithString: "")
  private let tableView = NSTableView()
  private let scrollView = NSScrollView()
  private let attachButton = NSButton()
  private let refreshButton = NSButton()

  private var panes: [PaneCatalog.Pane] = []
  private var loading = false

  init(
    stateDirectory: URL,
    onAttach: @escaping (URL, String, AccessAuth.PasswordProvider?) -> Void
  ) {
    self.stateDirectory = stateDirectory
    self.onAttach = onAttach
    let window = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 560, height: 460),
      styleMask: [.titled, .closable, .miniaturizable, .resizable],
      backing: .buffered, defer: false)
    super.init(window: window)
    window.title = "Phi"
    window.delegate = self
    window.isReleasedWhenClosed = false
    window.minSize = NSSize(width: 460, height: 320)
    buildContent()
    window.center()
    window.makeFirstResponder(originField)
  }

  required init?(coder: NSCoder) {
    fatalError("init(coder:) has not been implemented")
  }

  // MARK: layout

  private func buildContent() {
    let width: CGFloat = 560
    let inset: CGFloat = 16
    let labelWidth: CGFloat = 78
    let fieldX = inset + labelWidth + 8
    let fieldWidth = width - fieldX - inset

    let root = NSView(frame: NSRect(x: 0, y: 0, width: width, height: 460))
    root.autoresizingMask = [.width, .height]
    window?.contentView = root

    var top: CGFloat = 460 - inset - 24

    let originLabel = NSTextField(labelWithString: "Server")
    originLabel.frame = NSRect(x: inset, y: top + 4, width: labelWidth, height: 18)
    originLabel.autoresizingMask = [.minYMargin]
    root.addSubview(originLabel)

    originField.frame = NSRect(x: fieldX, y: top, width: fieldWidth, height: 24)
    originField.autoresizingMask = [.width, .minYMargin]
    originField.placeholderString = "http://host:7070"
    originField.stringValue =
      UserDefaults.standard.string(forKey: Self.originDefaultsKey) ?? "http://localhost:7070"
    originField.target = self
    originField.action = #selector(connect)
    root.addSubview(originField)

    top -= 8 + 24
    let passwordLabel = NSTextField(labelWithString: "Password")
    passwordLabel.frame = NSRect(x: inset, y: top + 4, width: labelWidth, height: 18)
    passwordLabel.autoresizingMask = [.minYMargin]
    root.addSubview(passwordLabel)

    passwordField.frame = NSRect(x: fieldX, y: top, width: fieldWidth, height: 24)
    passwordField.autoresizingMask = [.width, .minYMargin]
    passwordField.placeholderString = "Leave empty when the server has none"
    passwordField.target = self
    passwordField.action = #selector(connect)
    root.addSubview(passwordField)

    originField.nextKeyView = passwordField
    passwordField.nextKeyView = connectButton

    top -= 12 + 28
    connectButton.frame = NSRect(x: fieldX, y: top, width: 110, height: 28)
    connectButton.autoresizingMask = [.minYMargin]
    connectButton.title = "Connect"
    connectButton.bezelStyle = .rounded
    connectButton.keyEquivalent = "\r"
    connectButton.target = self
    connectButton.action = #selector(connect)
    root.addSubview(connectButton)

    top -= 8 + 18
    statusLabel.frame = NSRect(x: inset, y: top, width: width - 2 * inset, height: 18)
    statusLabel.autoresizingMask = [.width, .minYMargin]
    statusLabel.font = .systemFont(ofSize: 11)
    statusLabel.textColor = .secondaryLabelColor
    statusLabel.lineBreakMode = .byTruncatingTail
    root.addSubview(statusLabel)

    let tableHeight = top - 8 - 52
    scrollView.frame = NSRect(x: inset, y: 52, width: width - 2 * inset, height: tableHeight)
    scrollView.autoresizingMask = [.width, .height]
    scrollView.hasVerticalScroller = true
    scrollView.borderType = .bezelBorder

    let paneColumn = NSTableColumn(identifier: .init("pane"))
    paneColumn.title = "Pane"
    paneColumn.width = 280
    let idColumn = NSTableColumn(identifier: .init("id"))
    idColumn.title = "ID"
    idColumn.width = 200
    tableView.addTableColumn(paneColumn)
    tableView.addTableColumn(idColumn)
    tableView.usesAlternatingRowBackgroundColors = true
    tableView.allowsMultipleSelection = false
    tableView.dataSource = self
    tableView.delegate = self
    tableView.target = self
    tableView.doubleAction = #selector(attachSelected)
    scrollView.documentView = tableView
    root.addSubview(scrollView)

    attachButton.frame = NSRect(x: inset, y: 14, width: 100, height: 26)
    attachButton.autoresizingMask = [.maxYMargin]
    attachButton.title = "Attach"
    attachButton.bezelStyle = .rounded
    attachButton.isEnabled = false
    attachButton.target = self
    attachButton.action = #selector(attachSelected)
    root.addSubview(attachButton)

    refreshButton.frame = NSRect(x: inset + 108, y: 14, width: 100, height: 26)
    refreshButton.autoresizingMask = [.maxYMargin]
    refreshButton.title = "Refresh"
    refreshButton.bezelStyle = .rounded
    refreshButton.target = self
    refreshButton.action = #selector(refresh)
    root.addSubview(refreshButton)

    let stateLabel = NSTextField(labelWithString: "State: \(stateDirectory.path)")
    stateLabel.frame = NSRect(x: inset + 216, y: 18, width: width - 216 - inset, height: 16)
    stateLabel.autoresizingMask = [.width, .maxYMargin]
    stateLabel.font = .systemFont(ofSize: 10)
    stateLabel.textColor = .tertiaryLabelColor
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
    UserDefaults.standard.set(origin.absoluteString, forKey: Self.originDefaultsKey)
    Task { await load(origin: origin) }
  }

  @objc private func refresh() {
    guard let origin = enteredOrigin() else {
      setStatus("Enter an http(s) server address, with no path or credentials.", isError: true)
      return
    }
    Task { await load(origin: origin) }
  }

  @objc private func attachSelected() {
    let row = tableView.selectedRow
    guard row >= 0, row < panes.count, let origin = enteredOrigin() else { return }
    let pane = panes[row]
    onAttach(origin, pane.id, passwordProvider)
    setStatus("Opened \(pane.title ?? pane.coder).", isError: false)
  }

  private func load(origin: URL) async {
    loading = true
    updateControls()
    setStatus("Connecting…", isError: false)
    let provider = passwordProvider
    do {
      panes = try await PaneCatalog.panes(origin: origin, password: provider, useKeychain: false)
      tableView.reloadData()
      setStatus(
        panes.isEmpty
          ? "Connected. No panes on this server."
          : "Connected. \(panes.count) pane\(panes.count == 1 ? "" : "s").",
        isError: false)
    } catch {
      panes = []
      tableView.reloadData()
      setStatus(describe(error), isError: true)
    }
    loading = false
    updateControls()
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
    statusLabel.textColor = isError ? .systemRed : .secondaryLabelColor
  }

  private func updateControls() {
    connectButton.isEnabled = !loading
    refreshButton.isEnabled = !loading
    attachButton.isEnabled = !loading && tableView.selectedRow >= 0
    if loading { connectButton.title = "Connecting…" } else { connectButton.title = "Connect" }
  }

  // MARK: table

  func numberOfRows(in tableView: NSTableView) -> Int { panes.count }

  func tableView(
    _ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int
  ) -> NSView? {
    guard row < panes.count, let tableColumn else { return nil }
    let pane = panes[row]
    let identifier = tableColumn.identifier
    let cell: NSTextField
    if let reused = tableView.makeView(withIdentifier: identifier, owner: self) as? NSTextField {
      cell = reused
    } else {
      cell = NSTextField(labelWithString: "")
      cell.identifier = identifier
      cell.lineBreakMode = .byTruncatingTail
      cell.font = .systemFont(ofSize: 12)
    }
    cell.stringValue = identifier.rawValue == "pane" ? (pane.title ?? pane.coder) : pane.coder
    return cell
  }

  func tableViewSelectionDidChange(_ notification: Notification) {
    updateControls()
  }
}
