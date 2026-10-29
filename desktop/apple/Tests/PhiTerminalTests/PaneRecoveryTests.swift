import Foundation
import PhiWire
import XCTest

@testable import PhiTerminal

/// M1 recovery gate (§8): attach epoch/retention decisions, recording-page
/// validation and resize-marker ordering, and an allocator that returns every
/// byte it took — including on the failure paths.
final class PaneRecoveryTests: XCTestCase {
  // MARK: - Attach decisions

  func testAttachRestoresAtTheCheckpointFrontier() throws {
    let plan = try PaneWireClient.AttachPlan(
      wire: attach(epoch: 7, oldest: 10, head: 60, through: 40), currentEpoch: nil)
    XCTAssertEqual(plan.restoredFrontier, 40)
    XCTAssertFalse(plan.replacesEpoch, "a first attach replaces nothing")
    XCTAssertFalse(plan.healFromLive, "the recorded prefix is retained")
    XCTAssertEqual(plan.checkpoint?.through, 40)
    XCTAssertEqual(plan.head, 60)
  }

  func testANewEpochReplacesTheDisplayAndTheFrontier() throws {
    let plan = try PaneWireClient.AttachPlan(
      wire: attach(epoch: 8, oldest: 5, head: 30, through: 20), currentEpoch: 7)
    XCTAssertTrue(plan.replacesEpoch, "an epoch change must not reuse old frontiers")
    XCTAssertEqual(plan.restoredFrontier, 20, "the new epoch restores from its own checkpoint")
  }

  func testRetentionLossHealsFromTheLiveScreen() throws {
    let retained = try PaneWireClient.AttachPlan(
      wire: attach(epoch: 7, oldest: 10, head: 60, through: 40), currentEpoch: 7)
    XCTAssertFalse(retained.replacesEpoch)
    XCTAssertFalse(retained.healFromLive, "a checkpoint above the retained floor replays")

    // The server can only send the checkpoint it still holds; once the floor has
    // moved past it, the live screen is authoritative.
    let lost = try PaneWireClient.AttachPlan(
      wire: attach(epoch: 7, oldest: 56, head: 60, through: 40), currentEpoch: 7)
    XCTAssertTrue(lost.healFromLive, "a floor above the checkpoint heals from live state")
    XCTAssertEqual(lost.restoredFrontier, 40, "the checkpoint still restores the display")
  }

  func testMalformedAttachesAreRejected() {
    var noCheckpoint = attach()
    noCheckpoint.clearCheckpoint()
    var aheadOfHead = attach(head: 30, through: 40)
    aheadOfHead.checkpoint.through = 40
    var inverted = attach(oldest: 60, head: 40, through: 50)
    inverted.checkpoint.through = 50
    var wrongKind = attach()
    wrongKind.checkpoint.kind = "ansi-v1"
    var zeroGeometry = attach()
    zeroGeometry.checkpoint.cols = 0
    var oversized = attach()
    oversized.checkpoint.data = Data(repeating: 0x41, count: (2 << 20) + 1)
    var missingEpoch = attach()
    missingEpoch.clearEpoch()

    let cases: [(String, Phi_Websocket_Terminal_V1_TerminalAttach)] = [
      ("no checkpoint", noCheckpoint),
      ("through above head", aheadOfHead),
      ("oldest above head", inverted),
      ("unknown checkpoint kind", wrongKind),
      ("zero geometry", zeroGeometry),
      ("checkpoint above the span bound", oversized),
      ("missing epoch", missingEpoch),
    ]
    for (label, wire) in cases {
      XCTAssertThrowsError(
        try PaneWireClient.AttachPlan(wire: wire, currentEpoch: nil), label
      ) { error in
        guard case PaneWireError.protocolViolation = error else {
          return XCTFail("\(label): unexpected error \(error)")
        }
      }
    }
  }

  // MARK: - Recording pages

  func testPageDecodesAndAppliesItsResizeMarkersInPlace() throws {
    let data = Data("aabbcc".utf8)
    let envelope = recording(start: 10, end: 16, resizes: "[[12,20,5],[14,10,3]]", data: data)
    let page = try RecordingPage.decode(envelope, epoch: 7, from: 10, through: 16)
    XCTAssertEqual(page.start, 10)
    XCTAssertEqual(page.end, 16)
    XCTAssertEqual(page.resizes, [
      RecordingPage.Resize(at: 12, cols: 20, rows: 5),
      RecordingPage.Resize(at: 14, cols: 10, rows: 3),
    ])
    XCTAssertEqual(page.data, data)

    let session = try XCTUnwrap(TerminalSession(cols: 80, rows: 24))
    page.apply(to: session, source: .replay)
    let frame = try XCTUnwrap(session.readFrame())
    session.free()
    // The last marker wins for the final geometry, and no byte is lost.
    XCTAssertEqual(frame.cols, 10)
    XCTAssertEqual(frame.rows, 3)
    XCTAssertEqual(Array(frame.cells[0].prefix(6)).map(\.text).joined(), "aabbcc")
  }

  func testAnEvictedPrefixIsReportedSeparatelyFromMalformedData() throws {
    let evicted = recording(start: 20, end: 24, data: Data("abcd".utf8))
    XCTAssertThrowsError(try RecordingPage.decode(evicted, epoch: 7, from: 10, through: 24)) {
      XCTAssertEqual($0 as? RecordingError, .expired, "a higher start is healable")
    }
    let malformed = recording(start: 8, end: 14, data: Data("abcdef".utf8))
    XCTAssertThrowsError(try RecordingPage.decode(malformed, epoch: 7, from: 10, through: 24)) {
      XCTAssertEqual($0 as? RecordingError, .invalid("recording header does not describe the requested span"))
    }
  }

  func testMalformedPagesAreRejected() {
    let cases: [(String, Data)] = [
      ("too short", Data([0, 0])),
      ("zero header length", Data([0, 0, 0, 0])),
      ("header length beyond the body", Data([0x10, 0, 0, 0]) + Data("{}".utf8)),
      ("header is not JSON", envelope("not json", Data())),
      ("epoch mismatch", recording(epoch: 8, start: 10, end: 12, data: Data("ab".utf8))),
      ("end beyond the request", recording(start: 10, end: 30, data: Data(repeating: 0x61, count: 20))),
      ("length does not match the span",
        envelope(json(start: 10, end: 14), Data("ab".utf8))),
      ("marker beyond the span",
        recording(start: 10, end: 12, resizes: "[[13,20,5]]", data: Data("ab".utf8))),
      ("markers out of order",
        recording(start: 10, end: 12, resizes: "[[12,20,5],[11,10,3]]", data: Data("ab".utf8))),
      ("zero columns", recording(start: 10, end: 12, resizes: "[[11,0,5]]", data: Data("ab".utf8))),
      ("marker not a triple",
        envelope(json(start: 10, end: 12, resizes: "[[11,2]]"), Data("ab".utf8))),
      ("cursor above its bound",
        envelope(
          json(start: 10, end: 12, cursor: String(repeating: "c", count: 129)), Data("ab".utf8))),
    ]
    for (label, body) in cases {
      XCTAssertThrowsError(try RecordingPage.decode(body, epoch: 7, from: 10, through: 24), label) {
        guard case .invalid? = $0 as? RecordingError else {
          return XCTFail("\(label): unexpected error \($0)")
        }
      }
    }
    // A page with absent or null markers is an older server, not malformed.
    let none = envelope(json(start: 10, end: 12, resizes: "null"), Data("ab".utf8))
    XCTAssertNoThrow(try RecordingPage.decode(none, epoch: 7, from: 10, through: 24))
  }

  func testReplayedPagesDoNotAnswerQueries() throws {
    let data = Data("x\u{1B}[6ny".utf8)
    let page = try RecordingPage.decode(
      recording(start: 0, end: UInt64(data.count), data: data), epoch: 7,
      from: 0, through: UInt64(data.count))

    let replayed = try XCTUnwrap(TerminalSession(cols: 80, rows: 24))
    page.apply(to: replayed, source: .replay)
    XCTAssertEqual(replayed.takePtyReplies(), [], "recorded history must not answer")
    replayed.free()

    let live = try XCTUnwrap(TerminalSession(cols: 80, rows: 24))
    page.apply(to: live, source: .live)
    XCTAssertFalse(live.takePtyReplies().isEmpty, "the same bytes live must answer")
    live.free()
  }

  func testPageBoundaryIsExactlyOneRecordingPage() {
    XCTAssertNoThrow(
      try RecordingPage.decode(
        recording(start: 0, end: UInt64(RecordingPage.maxPage),
          data: Data(repeating: 0x61, count: RecordingPage.maxPage)),
        epoch: 7, from: 0, through: UInt64(RecordingPage.maxPage)))
    XCTAssertThrowsError(
      try RecordingPage.decode(Data(), epoch: 7, from: 0, through: UInt64(RecordingPage.maxPage) + 1)
    ) {
      XCTAssertEqual(
        $0 as? RecordingError, .invalid("requested span is not one bounded page"))
    }
  }

  // MARK: - Teardown

  func testTeardownReturnsEveryByteToTheAllocator() throws {
    for iteration in 0..<20 {
      let session = try XCTUnwrap(TerminalSession(cols: 80, rows: 24))
      session.feed(Array("stress \(iteration)\r\n".utf8), source: .live)
      let snapshot = try XCTUnwrap(session.snapshotBytes())

      let restored = try XCTUnwrap(TerminalSession(restoring: snapshot))
      restored.feed(Array("\u{1B}[31mred".utf8), source: .replay)
      _ = restored.readFrame()
      restored.resize(cols: 100, rows: 30)
      // Leave a control sequence unfinished: teardown must still free it all.
      restored.feed(Array("\u{1B}[6".utf8), source: .boundary)
      _ = restored.readFrame()

      restored.free()
      session.free()
      XCTAssertEqual(restored.counters.live, 0, "iteration \(iteration): restored leaked")
      XCTAssertEqual(session.counters.live, 0, "iteration \(iteration): session leaked")
      XCTAssertGreaterThan(session.counters.allocs, 0)
      XCTAssertEqual(session.counters.allocs, session.counters.frees)
    }
  }

  func testAllocationFailureFailsClosedWithoutLeaking() {
    let exhausted = AllocatorCounters()
    exhausted.failAfterAllocs = 0
    XCTAssertNil(TerminalSession(cols: 80, rows: 24, counters: exhausted))
    XCTAssertEqual(exhausted.live, 0)
    XCTAssertEqual(exhausted.allocs, 0)

    // Somewhere part-way the engine either completes or unwinds; either answer
    // is fine, a leak is not.
    for limit in [1, 2, 3, 8] {
      let partial = AllocatorCounters()
      partial.failAfterAllocs = limit
      TerminalSession(cols: 80, rows: 24, counters: partial)?.free()
      XCTAssertEqual(partial.live, 0, "limit \(limit) leaked \(partial.live) bytes")
    }
  }

  func testFailedRestoreLeavesNeitherTerminalNorDecoderBehind() throws {
    let counters = AllocatorCounters()
    XCTAssertNil(TerminalSession(restoring: Array("not a snapshot".utf8), counters: counters))
    XCTAssertEqual(counters.live, 0, "a rejected restore leaked \(counters.live) bytes")

    // A truncated real snapshot must fail the same way.
    let source = try XCTUnwrap(TerminalSession(cols: 40, rows: 10))
    let snapshot = try XCTUnwrap(source.snapshotBytes())
    source.free()
    let truncated = AllocatorCounters()
    XCTAssertNil(
      TerminalSession(restoring: Array(snapshot.prefix(snapshot.count / 2)), counters: truncated))
    XCTAssertEqual(truncated.live, 0)
  }

  // MARK: - Replacement safety

  /// §7.2: a failed restore keeps the old frame. The epoch path used to free the
  /// display before the replacement existed, blanking it on a bad checkpoint.
  func testAFailedNewEpochRestoreKeepsTheOldDisplay() async throws {
    let client = try PaneWireClient(
      origin: try XCTUnwrap(URL(string: "http://127.0.0.1:1")), paneID: "pane",
      cols: 20, rows: 4, useKeychain: false)
    addTeardownBlock { await client.close() }

    // First epoch, no checkpoint bytes: the fresh terminal becomes the display.
    _ = try await client.applyAttach(attach(epoch: 1, oldest: 0, head: 10, through: 10, data: Data()))
    var output = Phi_Websocket_Terminal_V1_TerminalOutput()
    output.start = 10
    output.data = Data("OLD-SCREEN\r\n".utf8)
    try await client.applyOutput(output)
    let frame = await client.readFrame()
    let before = try XCTUnwrap(frame)
    XCTAssertTrue(before.canonicalText().contains("OLD-SCREEN"))

    // A new epoch whose checkpoint cannot be restored must not replace anything.
    let broken = attach(epoch: 2, oldest: 0, head: 20, through: 20, data: Data("not a snapshot".utf8))
    do {
      _ = try await client.applyAttach(broken)
      XCTFail("an unrestorable replacement was accepted")
    } catch {
      guard case PaneWireError.protocolViolation = error else {
        return XCTFail("unexpected error \(error)")
      }
    }
    let replaced = await client.readFrame()
    let after = try XCTUnwrap(replaced)
    XCTAssertEqual(after, before, "a rejected restore must keep the old display")
    let status = await client.status()
    XCTAssertEqual(status.frontier, 22, "the frontier only moves on a successful replacement")
  }

  // MARK: - Builders

  private func attach(
    epoch: UInt64 = 7, oldest: UInt64 = 0, head: UInt64 = 100, through: UInt64 = 40,
    data: Data = Data("snapshot".utf8), kind: String = "ghostty-ready-v1"
  ) -> Phi_Websocket_Terminal_V1_TerminalAttach {
    var wire = Phi_Websocket_Terminal_V1_TerminalAttach()
    wire.epoch = epoch
    wire.oldest = oldest
    wire.head = head
    var checkpoint = Phi_Websocket_Terminal_V1_TerminalCheckpoint()
    checkpoint.kind = kind
    checkpoint.through = through
    checkpoint.cols = 80
    checkpoint.rows = 24
    checkpoint.data = data
    wire.checkpoint = checkpoint
    return wire
  }

  private func recording(
    epoch: UInt64 = 7, start: UInt64, end: UInt64, resizes: String = "[]", data: Data
  ) -> Data {
    envelope(json(epoch: epoch, start: start, end: end, resizes: resizes), data)
  }

  private func json(
    epoch: UInt64 = 7, start: UInt64, end: UInt64, resizes: String = "[]", cursor: String? = nil
  ) -> String {
    let cursorField = cursor.map { ",\"event_cursor\":\"\($0)\"" } ?? ""
    return "{\"epoch\":\(epoch),\"start\":\(start),\"end\":\(end),\"resizes\":\(resizes)\(cursorField)}"
  }

  private func envelope(_ header: String, _ data: Data) -> Data {
    var body = withUnsafeBytes(of: UInt32(header.utf8.count).bigEndian) { Data($0) }
    body.append(contentsOf: header.utf8)
    body.append(data)
    return body
  }
}
