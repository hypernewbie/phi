import Foundation
import PhiTerminal

/// The exact probe contract of §9.2: freeze one live frame, fetch the ANSI
/// checkpoint at that byte frontier, replay it into a fresh terminal, and report
/// the first difference instead of a pass.
public enum ANSIProof {
  public struct Capture: Sendable {
    public var epoch: UInt64
    public var through: UInt64
    public var eventCursor: String?
    public var frontier: UInt64
    /// Frame the attached terminal drew at the frozen frontier.
    public var live: FrameEvidence
    /// Frame a fresh terminal produced by replaying the checkpoint.
    public var replayed: FrameEvidence
    /// The exact reply body, so an independent decoder can read the framing.
    public var body: Data

    public func firstDifference() -> String? {
      live.firstDifference(against: replayed, label: "live-vs-replay")
    }
  }

  public enum Failure: Error, CustomStringConvertible {
    case notAttached
    case unsettled(frontier: UInt64)
    case checkpoint(String)
    case replay(String)
    case mismatch(String)

    public var description: String {
      switch self {
      case .notAttached: return "attach timed out"
      case .unsettled(let frontier): return "frontier \(frontier) never settled within 10s"
      case .checkpoint(let text): return "checkpoint rejected: \(text)"
      case .replay(let text): return "replay failed: \(text)"
      case .mismatch(let text): return "live and replayed frames disagree — \(text)"
      }
    }
  }

  /// Waits for the pane to attach, settles the frontier, then captures. A
  /// checkpoint that no longer matches the frozen frontier is retried: one
  /// unlucky sample must not fail a live capture (§9.2).
  public static func capture(from client: PaneWireClient) async throws -> Capture {
    let deadline = Date().addingTimeInterval(10)
    while await !client.status().attached {
      if Date() > deadline { throw Failure.notAttached }
      try? await Task.sleep(for: .milliseconds(50))
    }

    for attempt in 0..<3 {
      do {
        return try await captureOnce(from: client, deadline: deadline)
      } catch {
        guard attempt < 2, Date() < deadline else { throw error }
        switch error {
        case Failure.checkpoint, Failure.mismatch: continue
        default: throw error
        }
      }
    }
    throw Failure.checkpoint("capture did not settle")
  }

  private static func captureOnce(
    from client: PaneWireClient, deadline: Date
  ) async throws -> Capture {
    // A quiet frontier is what puts the frozen frame and the fetched span at
    // the same instant; 200 ms helps, the exact-through fetch proves it.
    var frozen = await client.freeze()
    while true {
      try? await Task.sleep(for: .milliseconds(200))
      let again = await client.freeze()
      let settled = again.status.frontier == frozen.status.frontier
      frozen = again
      if settled, again.frame != nil { break }
      if Date() > deadline { throw Failure.unsettled(frontier: again.status.frontier) }
    }

    guard let live = frozen.frame else { throw Failure.replay("frozen frame unreadable") }
    let expected = frozen.status.frontier
    let state = try await client.fetchState(
      through: expected, kind: PaneWireClient.ansiKind)
    guard state.epoch == frozen.status.attach?.epoch else {
      throw Failure.checkpoint("epoch \(state.epoch) for frozen frontier \(expected)")
    }
    let checkpoint = try unwrap(state, live: live, expected: expected)

    // A fresh terminal at the envelope geometry is the independent restore
    // path: live bytes versus a replayed checkpoint (§7.2).
    guard let fresh = TerminalSession(
      cols: UInt16(checkpoint.cols), rows: UInt16(checkpoint.rows)) else {
      throw Failure.replay("fresh terminal rejected geometry")
    }
    fresh.feed([UInt8](state.data))
    let frame = fresh.readFrame()
    fresh.free()
    guard let frame else { throw Failure.replay("replayed frame unreadable") }

    let capture = Capture(
      epoch: state.epoch, through: checkpoint.through, eventCursor: checkpoint.eventCursor,
      frontier: frozen.status.frontier, live: FrameEvidence(frame: live),
      replayed: FrameEvidence(frame: frame), body: state.body)
    if let difference = capture.firstDifference() { throw Failure.mismatch(difference) }
    return capture
  }

  public static func write(_ capture: Capture, to directory: URL) throws {
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    try capture.body.write(to: directory.appendingPathComponent("state.bin"), options: .atomic)
    try capture.live.encoded()
      .write(to: directory.appendingPathComponent("live-frame.json"), options: .atomic)
    try capture.replayed.encoded()
      .write(to: directory.appendingPathComponent("native-frame.json"), options: .atomic)
  }

  private static func unwrap(
    _ state: PaneWireClient.RemoteState, live: TerminalFrame, expected: UInt64
  ) throws -> PaneWireClient.Checkpoint {
    guard let checkpoint = state.checkpoint else {
      throw Failure.checkpoint("reply carried no checkpoint")
    }
    guard checkpoint.kind == PaneWireClient.ansiKind else {
      throw Failure.checkpoint("kind \(checkpoint.kind)")
    }
    // The server echoes our own request into head/through, so the frozen
    // frontier is the only value that proves the frame and the span are the
    // same instant (§9.2).
    guard checkpoint.through == expected, state.head == expected else {
      throw Failure.checkpoint(
        "checkpoint through \(checkpoint.through), head \(state.head),"
          + " frozen frontier \(expected)")
    }
    guard let cursor = checkpoint.eventCursor,
      let at = eventCursorPosition(cursor),
      at.epoch == state.epoch, at.through == expected else {
      throw Failure.checkpoint(
        "event cursor \(checkpoint.eventCursor ?? "none") for epoch \(state.epoch)"
          + " through \(expected)")
    }
    guard Int(checkpoint.cols) == live.cols, Int(checkpoint.rows) == live.rows else {
      throw Failure.checkpoint(
        "live \(live.cols)x\(live.rows) envelope \(checkpoint.cols)x\(checkpoint.rows)")
    }
    return checkpoint
  }

  /// `v1.<epoch>.<through>.<ordinal>`: the cursor must pin the same epoch and
  /// frontier as the checkpoint it travelled with (§9.2).
  private static func eventCursorPosition(
    _ cursor: String
  ) -> (epoch: UInt64, through: UInt64)? {
    let parts = cursor.split(separator: ".")
    guard parts.count == 4, parts[0] == "v1",
      let epoch = UInt64(parts[1]), let through = UInt64(parts[2]) else { return nil }
    return (epoch, through)
  }
}
