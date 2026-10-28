import Foundation
import PhiKit
import PhiTerminal

/// Writes one live ANSI capture: `state.bin` (the exact reply body),
/// `live-frame.json` and `native-frame.json`. The Go oracle decodes the same
/// body independently and `ANSIReplayParityTests` compares the two.
struct CaptureANSI {
  let origin: URL
  let pane: String
  let cols: UInt16
  let rows: UInt16
  let stateDir: URL
  let useKeychain: Bool
  let password: AccessAuth.PasswordProvider?

  func run() async throws {
    let client = try PaneWireClient(
      origin: origin, paneID: pane, cols: cols, rows: rows,
      useKeychain: useKeychain, password: password)
    let wire = Task { await client.run() }
    defer {
      wire.cancel()
      Task { await client.close() }
    }

    let capture = try await ANSIProof.capture(from: client)
    try ANSIProof.write(capture, to: stateDir)
    print("capture epoch \(capture.epoch) through \(capture.through)"
      + " event_cursor \(capture.eventCursor ?? "none")"
      + " geometry \(capture.replayed.cols)x\(capture.replayed.rows)"
      + " stable_frontier \(capture.frontier)")
    print("live_cursor \(capture.replayed.cursorX),\(capture.replayed.cursorY)"
      + " alt \(capture.replayed.alt) history \(capture.replayed.history)")
    print("live_vs_replay equal: \(capture.replayed.text.utf8.count) canonical bytes,"
      + " \(capture.replayed.cells.reduce(0) { $0 + $1.count }) cells")
  }
}
