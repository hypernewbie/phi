import AppKit
import Darwin
import Foundation
import PhiKit
import PhiTerminal

@main
@MainActor
enum PhiSwiftTermSpike {
  static func main() {
    do {
      let options = try SpikeOptions.parse(Array(CommandLine.arguments.dropFirst()))
      let application = NSApplication.shared
      application.setActivationPolicy(.regular)
      let delegate = SpikeApplicationDelegate(options: options)
      application.delegate = delegate
      application.run()
      withExtendedLifetime(delegate) {}
    } catch {
      fputs("PhiSwiftTermSpike: \(error)\n", stderr)
      fputs(
        """
        Usage: PhiSwiftTermSpike --state-dir <owned-path> --server <origin> --pane <id>
               PhiSwiftTermSpike --state-dir <owned-path>    # choose the server in the window

        """, stderr)
      exit(64)
    }
  }
}

struct SpikeOptions {
  /// Where the app opens: one named pane, or the pane catalog.
  enum Launch: Equatable {
    case pane(URL, String)
    case catalog
  }

  let stateDirectory: URL
  let launch: Launch

  static func parse(_ arguments: [String]) throws -> SpikeOptions {
    var server: String?
    var pane: String?
    var statePath: String?
    var index = 0
    while index < arguments.count {
      switch arguments[index] {
      case "--server":
        guard server == nil, index + 1 < arguments.count else { throw SpikeArgumentsError.invalid }
        server = arguments[index + 1]
        index += 2
      case "--pane":
        guard pane == nil, index + 1 < arguments.count else { throw SpikeArgumentsError.invalid }
        pane = arguments[index + 1]
        index += 2
      case "--state-dir":
        guard statePath == nil, index + 1 < arguments.count else { throw SpikeArgumentsError.invalid }
        statePath = arguments[index + 1]
        index += 2
      case "--no-keychain":
        // Accepted for earlier preview instructions. This preview never uses the
        // Keychain: a password is held in memory for one connection only.
        index += 1
      default:
        throw SpikeArgumentsError.invalid
      }
    }
    guard let statePath, statePath.hasPrefix("/"), statePath != "/" else {
      throw SpikeArgumentsError.invalid
    }
    let stateDirectory = URL(fileURLWithPath: statePath, isDirectory: true).standardizedFileURL
    let attributes = try FileManager.default.attributesOfItem(atPath: stateDirectory.path)
    guard attributes[.type] as? FileAttributeType == .typeDirectory,
          (attributes[.ownerAccountID] as? NSNumber)?.uint32Value == getuid() else {
      throw SpikeArgumentsError.invalid
    }
    let launch: Launch
    switch (server, pane) {
    case (nil, nil):
      launch = .catalog
    case (let server?, let pane?):
      guard !pane.isEmpty, let origin = origin(from: server) else {
        throw SpikeArgumentsError.invalid
      }
      launch = .pane(origin, pane)
    default:
      // A named pane needs its server; either both or neither.
      throw SpikeArgumentsError.invalid
    }
    return SpikeOptions(stateDirectory: stateDirectory, launch: launch)
  }

  /// An http(s) origin with no credentials, query, fragment, or path prefix.
  static func origin(from text: String) -> URL? {
    guard let origin = URL(string: text),
          ["http", "https"].contains(origin.scheme?.lowercased() ?? ""),
          origin.host != nil, origin.user == nil, origin.password == nil,
          origin.query == nil, origin.fragment == nil,
          origin.path.isEmpty || origin.path == "/" else { return nil }
    return origin
  }
}

enum SpikeArgumentsError: Error {
  case invalid
}

@MainActor
final class SpikeApplicationDelegate: NSObject, NSApplicationDelegate {
  private let options: SpikeOptions
  private var catalog: SpikeCatalogWindow?
  private var windows: [SpikeWindow] = []

  init(options: SpikeOptions) {
    self.options = options
  }

  func applicationDidFinishLaunching(_ notification: Notification) {
    installMenu()
    switch options.launch {
    case .pane(let origin, let pane):
      _ = open(origin: origin, pane: pane, password: nil)
    case .catalog:
      showCatalog()
    }
#if DEBUG
    if let catalog { runRequestedUIDump(on: catalog) }
#endif
  }

  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

  func applicationWillTerminate(_ notification: Notification) {
    for window in windows { window.closeSession() }
  }

  @objc private func showCatalog() {
    let catalog: SpikeCatalogWindow
    if let existing = self.catalog {
      catalog = existing
    } else {
      catalog = SpikeCatalogWindow(
        stateDirectory: options.stateDirectory,
        onAttach: { [weak self] origin, pane, password in
          self?.open(origin: origin, pane: pane, password: password)
        })
      self.catalog = catalog
    }
    catalog.showWindow(nil)
    catalog.window?.makeKeyAndOrderFront(nil)
    NSApplication.shared.activate(ignoringOtherApps: true)
  }

#if DEBUG
  private func runRequestedUIDump(on catalog: SpikeCatalogWindow) {
    guard let request = SpikeUIDump.Request.fromEnvironment() else { return }
    Task {
      do {
        try await SpikeUIDump.run(
          request, on: catalog,
          terminalWindows: { [weak self] in self?.windows ?? [] })
        fputs("PhiSwiftTermSpike: wrote \(request.imagePath.path)\n", stderr)
      } catch {
        fputs("PhiSwiftTermSpike: UI dump failed: \(error)\n", stderr)
      }
      NSApplication.shared.terminate(nil)
    }
  }
#endif

  /// Opens one pane window, or brings the existing one forward.
  /// Returns a message when the pane could not be opened.
  @discardableResult
  private func open(
    origin: URL, pane: String, password: AccessAuth.PasswordProvider?
  ) -> String? {
    if let existing = windows.first(where: { $0.paneID == pane }) {
      existing.window?.makeKeyAndOrderFront(nil)
      return nil
    }
    let controller = SpikeWindow()
    controller.paneID = pane
    let session: PaneSession
    do {
      session = try PaneSession(
        origin: origin, paneID: pane, stateDir: options.stateDirectory,
        useKeychain: false, password: password,
        terminalObserver: { [weak controller] event in
          guard let controller else { throw SpikeWindowError.staleConnection }
          try await controller.apply(event)
        })
    } catch {
      return error.localizedDescription
    }
    windows.append(controller)
    controller.onClose = { [weak self] in
      self?.windows.removeAll { $0 === controller }
    }
#if DEBUG
    controller.start(session: session, stateDirectory: options.stateDirectory)
#else
    controller.start(session: session)
#endif
    return nil
  }

  // MARK: menu

  /// A native menu, so Quit, Hide, Copy/Paste, and reopening the catalog work.
  private func installMenu() {
    let mainMenu = NSMenu()

    let appItem = NSMenuItem()
    let appMenu = NSMenu(title: "Phi")
    appMenu.addItem(
      withTitle: "About Phi", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)),
      keyEquivalent: "")
    appMenu.addItem(.separator())
    appMenu.addItem(
      withTitle: "Hide Phi", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
    appMenu.addItem(
      withTitle: "Hide Others", action: #selector(NSApplication.hideOtherApplications(_:)),
      keyEquivalent: "h")
    appMenu.items.last?.keyEquivalentModifierMask = [.command, .option]
    appMenu.addItem(
      withTitle: "Show All", action: #selector(NSApplication.unhideAllApplications(_:)),
      keyEquivalent: "")
    appMenu.addItem(.separator())
    appMenu.addItem(
      withTitle: "Quit Phi", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
    appItem.submenu = appMenu
    mainMenu.addItem(appItem)

    let editItem = NSMenuItem()
    let editMenu = NSMenu(title: "Edit")
    for (title, action, key) in [
      ("Undo", #selector(UndoManager.undo), "z"),
      ("Redo", #selector(UndoManager.redo), "Z"),
      ("Cut", #selector(NSText.cut(_:)), "x"),
      ("Copy", #selector(NSText.copy(_:)), "c"),
      ("Paste", #selector(NSText.paste(_:)), "v"),
      ("Select All", #selector(NSText.selectAll(_:)), "a"),
    ] {
      editMenu.addItem(withTitle: title, action: action, keyEquivalent: key)
    }
    editItem.submenu = editMenu
    mainMenu.addItem(editItem)

    let windowItem = NSMenuItem()
    let windowMenu = NSMenu(title: "Window")
    windowMenu.addItem(
      withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)),
      keyEquivalent: "m")
    windowMenu.addItem(
      withTitle: "Zoom", action: #selector(NSWindow.performZoom(_:)), keyEquivalent: "")
    windowMenu.addItem(.separator())
    let catalogItem = windowMenu.addItem(
      withTitle: "Pane Catalog", action: #selector(openCatalogFromMenu), keyEquivalent: "0")
    catalogItem.target = self
    windowItem.submenu = windowMenu
    mainMenu.addItem(windowItem)
    NSApplication.shared.windowsMenu = windowMenu

    NSApplication.shared.mainMenu = mainMenu
  }

  @objc private func openCatalogFromMenu() {
    showCatalog()
  }
}
