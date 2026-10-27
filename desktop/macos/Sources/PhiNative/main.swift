import AppKit
import Foundation
import PhiTerminal

// M0 step 2b: one native window over one live Phi pane. No session browser.
struct Options {
  var server: URL
  var pane: String
  var cols: UInt16 = 80
  var rows: UInt16 = 24
  var stateDir: URL
  // M0 stores no secrets; the flag keeps one CLI for the milestones that do.
  var noKeychain = false
}

let usageLine = """
usage: PhiNative --server <origin> --pane <id> --state-dir <path> \
[--cols 80] [--rows 24] [--no-keychain]
"""

func fail(_ message: String) -> Never {
  FileHandle.standardError.write(Data("PhiNative: \(message)\n\(usageLine)\n".utf8))
  exit(2)
}

func parse(_ arguments: [String]) -> Options {
  var server: URL?
  var pane: String?
  var stateDir: URL?
  var cols: UInt16 = 80
  var rows: UInt16 = 24
  var noKeychain = false
  var index = 0
  while index < arguments.count {
    let flag = arguments[index]
    if flag == "--no-keychain" {
      noKeychain = true
      index += 1
      continue
    }
    guard index + 1 < arguments.count else { fail("\(flag) needs a value") }
    let value = arguments[index + 1]
    switch flag {
    case "--server":
      guard let url = URL(string: value), let scheme = url.scheme?.lowercased(),
            scheme == "http" || scheme == "https", url.host != nil else {
        fail("--server must be an http(s) origin")
      }
      server = url
    case "--pane":
      guard !value.isEmpty else { fail("--pane must not be empty") }
      pane = value
    case "--state-dir":
      guard !value.isEmpty else { fail("--state-dir must not be empty") }
      stateDir = URL(fileURLWithPath: value, isDirectory: true)
    case "--cols":
      guard let parsed = UInt16(value), parsed >= 1 else { fail("--cols must be 1...65535") }
      cols = parsed
    case "--rows":
      guard let parsed = UInt16(value), parsed >= 1 else { fail("--rows must be 1...65535") }
      rows = parsed
    default:
      fail("unknown flag \(flag)")
    }
    index += 2
  }
  guard let server else { fail("--server is required") }
  // No pane id means no window at all: there is nothing to guess.
  guard let pane else { fail("--pane is required") }
  guard let stateDir else { fail("--state-dir is required") }
  return Options(
    server: server, pane: pane, cols: cols, rows: rows, stateDir: stateDir,
    noKeychain: noKeychain)
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
  private let controller: PaneWindowController

  init(controller: PaneWindowController) {
    self.controller = controller
  }

  func applicationDidFinishLaunching(_ notification: Notification) {
    controller.start()
  }

  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
    true
  }
}

let options = parse(Array(CommandLine.arguments.dropFirst()))
let client: PaneWireClient
do {
  client = try PaneWireClient(
    origin: options.server, paneID: options.pane, cols: options.cols, rows: options.rows)
} catch {
  fail("cannot attach: \(error)")
}

let app = NSApplication.shared
let controller = PaneWindowController(
  client: client, paneID: options.pane, stateDir: options.stateDir,
  cols: options.cols, rows: options.rows)
let delegate = AppDelegate(controller: controller)
app.delegate = delegate

let menu = NSMenu()
let appMenuItem = NSMenuItem()
menu.addItem(appMenuItem)
let appMenu = NSMenu()
appMenu.addItem(
  withTitle: "Quit Phi", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
appMenuItem.submenu = appMenu
app.mainMenu = menu

app.setActivationPolicy(.regular)
app.run()
