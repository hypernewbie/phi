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
        "Usage: PhiSwiftTermSpike --server <origin> --pane <id> --state-dir <owned-path> --no-keychain\n",
        stderr)
      exit(64)
    }
  }
}

private struct SpikeOptions {
  let server: URL
  let pane: String
  let stateDirectory: URL

  static func parse(_ arguments: [String]) throws -> SpikeOptions {
    var server: String?
    var pane: String?
    var statePath: String?
    var noKeychain = false
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
        guard !noKeychain else { throw SpikeArgumentsError.invalid }
        noKeychain = true
        index += 1
      default:
        throw SpikeArgumentsError.invalid
      }
    }
    guard noKeychain, let server, let pane, !pane.isEmpty, let statePath,
          let origin = URL(string: server),
          ["http", "https"].contains(origin.scheme?.lowercased() ?? ""),
          origin.host != nil, origin.user == nil, origin.password == nil,
          origin.query == nil, origin.fragment == nil,
          origin.path.isEmpty || origin.path == "/",
          statePath.hasPrefix("/"), statePath != "/" else {
      throw SpikeArgumentsError.invalid
    }
    let stateDirectory = URL(fileURLWithPath: statePath, isDirectory: true).standardizedFileURL
    let attributes = try FileManager.default.attributesOfItem(atPath: stateDirectory.path)
    guard attributes[.type] as? FileAttributeType == .typeDirectory,
          (attributes[.ownerAccountID] as? NSNumber)?.uint32Value == getuid() else {
      throw SpikeArgumentsError.invalid
    }
    return SpikeOptions(server: origin, pane: pane, stateDirectory: stateDirectory)
  }
}

private enum SpikeArgumentsError: Error {
  case invalid
}

@MainActor
private final class SpikeApplicationDelegate: NSObject, NSApplicationDelegate {
  private let options: SpikeOptions
  private var controller: SpikeWindow?

  init(options: SpikeOptions) {
    self.options = options
  }

  func applicationDidFinishLaunching(_ notification: Notification) {
    let controller = SpikeWindow()
    self.controller = controller
    do {
      let session = try PaneSession(
        origin: options.server, paneID: options.pane, stateDir: options.stateDirectory,
        useKeychain: false, terminalObserver: { [weak controller] event in
          guard let controller else { throw SpikeWindowError.staleConnection }
          try await controller.apply(event)
        })
#if DEBUG
      controller.start(session: session, stateDirectory: options.stateDirectory)
#else
      controller.start(session: session)
#endif
    } catch {
      fputs("PhiSwiftTermSpike: failed to start the pane session\n", stderr)
      NSApp.terminate(nil)
    }
  }

  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

  func applicationWillTerminate(_ notification: Notification) {
    controller?.closeSession()
  }
}
