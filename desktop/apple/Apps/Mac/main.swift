import AppKit
import Foundation
import PhiKit
import PhiTerminal

// One native window over one live Phi pane. Server and pane come from the
// command line, or from PHI_SERVER/PHI_PANE for an Xcode scheme.
struct Options {
  var server: URL
  var pane: String
  var cols: UInt16 = 80
  var rows: UInt16 = 24
  var stateDir: URL
  var noKeychain = false
  var passwordStdin = false
}

let usageLine = """
usage: PhiMac [--server <origin>] [--pane <id>] [--state-dir <path>] \
[--cols 80] [--rows 24] [--no-keychain] [--password-stdin]

Defaults: --server $PHI_SERVER, --pane $PHI_PANE. An access password is read
from PHI_ACCESS_PASSWORD, or from stdin with --password-stdin. After the first
login only the derived verifier is used, so the password is not asked again
until it changes.
"""

func fail(_ message: String) -> Never {
  FileHandle.standardError.write(Data("PhiMac: \(message)\n\(usageLine)\n".utf8))
  exit(2)
}

/// Reads one line with echo off when stdin is a terminal.
func readPasswordLine() -> String? {
  if isatty(STDIN_FILENO) == 1 {
    var original = termios()
    guard tcgetattr(STDIN_FILENO, &original) == 0 else { return readLine() }
    var quiet = original
    quiet.c_lflag &= ~tcflag_t(ECHO)
    FileHandle.standardError.write(Data("Phi access password: ".utf8))
    tcsetattr(STDIN_FILENO, TCSANOW, &quiet)
    defer {
      tcsetattr(STDIN_FILENO, TCSANOW, &original)
      FileHandle.standardError.write(Data("\n".utf8))
    }
    return readLine()
  }
  return readLine()
}

func defaultStateDir() -> URL {
  let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)
    .first ?? URL(fileURLWithPath: NSTemporaryDirectory())
  return base.appendingPathComponent("PhiMac", isDirectory: true)
}

func parse(_ arguments: [String]) -> Options {
  let environment = ProcessInfo.processInfo.environment
  var server = environment["PHI_SERVER"].flatMap(URL.init(string:))
  var pane = environment["PHI_PANE"]
  var stateDir: URL?
  var cols: UInt16 = 80
  var rows: UInt16 = 24
  var noKeychain = false
  var passwordStdin = false
  var index = 0
  while index < arguments.count {
    let flag = arguments[index]
    if flag == "--no-keychain" {
      noKeychain = true
      index += 1
      continue
    }
    if flag == "--password-stdin" {
      passwordStdin = true
      index += 1
      continue
    }
    if flag.hasPrefix("-"), !flag.hasPrefix("--") {
      // Xcode and AppKit pass their own defaults (for example
      // -NSTreatUnknownArgumentsAsOpen); they are not ours to parse.
      let takesValue = index + 1 < arguments.count && !arguments[index + 1].hasPrefix("-")
      index += takesValue ? 2 : 1
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
  guard let server else { fail("--server is required (or set PHI_SERVER)") }
  guard let pane else { fail("--pane is required (or set PHI_PANE)") }
  return Options(
    server: server, pane: pane, cols: cols, rows: rows,
    stateDir: stateDir ?? defaultStateDir(),
    noKeychain: noKeychain, passwordStdin: passwordStdin)
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

  func applicationWillTerminate(_ notification: Notification) {
    controller.stop()
  }
}

let app = NSApplication.shared
let menu = NSMenu()
let appMenuItem = NSMenuItem()
menu.addItem(appMenuItem)
let appMenu = NSMenu()
appMenu.addItem(
  withTitle: "Quit Phi", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
appMenuItem.submenu = appMenu
app.mainMenu = menu

// XCTest launches this bundle as its host: no server was asked for and no
// window should appear, but the AppKit views still need to load for the tests.
if ProcessInfo.processInfo.environment["XCTestConfigurationFilePath"] != nil {
  app.setActivationPolicy(.prohibited)
  app.run()
}

let options = parse(Array(CommandLine.arguments.dropFirst()))
let environmentPassword = ProcessInfo.processInfo.environment["PHI_ACCESS_PASSWORD"]
let password: AccessAuth.PasswordProvider?
if let environmentPassword, !environmentPassword.isEmpty {
  password = { environmentPassword }
} else if options.passwordStdin {
  password = { readPasswordLine() }
} else {
  password = nil
}

let session: PaneSession
do {
  session = try PaneSession(
    origin: options.server, paneID: options.pane, stateDir: options.stateDir,
    cols: options.cols, rows: options.rows,
    useKeychain: !options.noKeychain, password: password)
} catch {
  fail("cannot attach: \(error)")
}

let controller = PaneWindowController(session: session, cols: options.cols, rows: options.rows)
let delegate = AppDelegate(controller: controller)
app.delegate = delegate

app.setActivationPolicy(.regular)
app.run()
