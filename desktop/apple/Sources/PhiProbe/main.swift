import Foundation
import PhiKit
import PhiTerminal

// Evidence tool for M0: attach to one pane, render its grid, print the wire
// state. Not app UI.
struct Options {
  var server: URL
  var pane: String
  var cols: UInt16 = 80
  var rows: UInt16 = 24
  var seconds = 5
  var listPanes = false
  var captureANSI = false
  var stateDir = ""
  var useKeychain = true
}

func usage() -> Never {
  FileHandle.standardError.write(Data(
    """
    usage: PhiProbe --server <origin> --pane <id> [--cols 80] [--rows 24] [--seconds 5]\n       \
    PhiProbe --server <origin> --pane <id> --capture-ansi --state-dir <dir> [--no-keychain]\n       \
    PhiProbe --server <origin> --list-panes\n    An access password is read from PHI_ACCESS_PASSWORD or stdin.\n
    """.utf8))
  exit(2)
}

func parse(_ arguments: [String]) -> Options {
  var server: URL?
  var pane: String?
  var stateDir: String?
  var options = Options(server: URL(string: "http://127.0.0.1")!, pane: "")
  var index = 0
  while index < arguments.count {
    let flag = arguments[index]
    if flag == "--list-panes" {
      options.listPanes = true
      index += 1
      continue
    }
    if flag == "--capture-ansi" {
      options.captureANSI = true
      index += 1
      continue
    }
    if flag == "--no-keychain" {
      options.useKeychain = false
      index += 1
      continue
    }
    guard index + 1 < arguments.count else { usage() }
    let value = arguments[index + 1]
    switch flag {
    case "--server":
      guard let url = URL(string: value) else { usage() }
      server = url
    case "--pane":
      pane = value
    case "--cols":
      guard let parsed = UInt16(value), parsed >= 1 else { usage() }
      options.cols = parsed
    case "--rows":
      guard let parsed = UInt16(value), parsed >= 1 else { usage() }
      options.rows = parsed
    case "--seconds":
      guard let parsed = Int(value), parsed > 0 else { usage() }
      options.seconds = parsed
    case "--state-dir":
      stateDir = value
    default:
      usage()
    }
    index += 2
  }
  guard let server else { usage() }
  options.server = server
  if options.listPanes { return options }
  guard let pane, !pane.isEmpty else { usage() }
  options.pane = pane
  if options.captureANSI {
    guard let stateDir, !stateDir.isEmpty else { usage() }
    options.stateDir = stateDir
  }
  return options
}

let environmentPassword = ProcessInfo.processInfo.environment["PHI_ACCESS_PASSWORD"]
let password: AccessAuth.PasswordProvider? = {
  if let environmentPassword, !environmentPassword.isEmpty { return { environmentPassword } }
  return { readLine() }
}()

let options = parse(Array(CommandLine.arguments.dropFirst()))

if options.listPanes {
  do {
    for pane in try await PaneCatalog.panes(origin: options.server, password: password) {
      print("\(pane.id)\t\(pane.coder)\t\(pane.title ?? "")\t\(pane.cwd ?? "")")
    }
  } catch {
    FileHandle.standardError.write(Data("PhiProbe: \(error)\n".utf8))
    exit(1)
  }
  exit(0)
}

if options.captureANSI {
  do {
    try await CaptureANSI(
      origin: options.server, pane: options.pane, cols: options.cols, rows: options.rows,
      stateDir: URL(fileURLWithPath: options.stateDir), useKeychain: options.useKeychain,
      password: password
    ).run()
  } catch {
    FileHandle.standardError.write(Data("PhiProbe: \(error)\n".utf8))
    exit(1)
  }
  exit(0)
}

let client = try PaneWireClient(
  origin: options.server, paneID: options.pane, cols: options.cols, rows: options.rows,
  useKeychain: options.useKeychain, password: password)
let wire = Task { await client.run() }

let attachDeadline = Date().addingTimeInterval(10)
while await !client.status().attached {
  if Date() > attachDeadline {
    FileHandle.standardError.write(Data("PhiProbe: attach timed out\n".utf8))
    await client.close()
    exit(1)
  }
  try? await Task.sleep(for: .milliseconds(50))
}

try? await Task.sleep(for: .seconds(options.seconds))

let status = await client.status()
let rendered = await client.frame()
print("pane \(options.pane) \(options.server.absoluteString)")
if let attach = status.attach {
  let ckpt = attach.checkpoint
  print("epoch \(attach.epoch) oldest \(attach.oldest) head \(attach.head) frontier \(status.frontier)"
    + " replay_from \(attach.replayFrom.map(String.init) ?? "none")")
  print("checkpoint kind \(ckpt?.kind ?? "none") through \(ckpt?.through ?? 0)"
    + " cols \(ckpt?.cols ?? 0) rows \(ckpt?.rows ?? 0)"
    + " event_cursor \(ckpt?.eventCursor ?? "none")")
} else {
  print("epoch none frontier \(status.frontier)")
}
print("attached \(status.attached) reconnects \(status.reconnects) gaps \(status.gaps.count)"
  + " drop_notices \(status.dropNotices) exit \(status.exitCode.map(String.init) ?? "none")"
  + " title \(status.title ?? "none")")
if let error = status.lastError { print("last_error \(error)") }
print("grid \(rendered.cols)x\(rendered.rows.count)")
for (row, text) in rendered.rows.enumerated() where !text.isEmpty {
  print(String(format: "%02d| %@", row, text))
}
for cell in rendered.colored.prefix(40) {
  print(String(format: "fg %02d,%02d %@ #%02x%02x%02x",
               cell.row, cell.column, cell.text, cell.red, cell.green, cell.blue))
}

await client.close()
wire.cancel()
