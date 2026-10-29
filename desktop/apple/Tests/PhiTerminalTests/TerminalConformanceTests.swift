import Foundation
import PhiWire
import XCTest

@testable import PhiKit
@testable import PhiTerminal

/// M1 conformance gate (§8): the Swift adapter must reproduce the Go oracle cell
/// for cell on the fixtures the recording path can deliver, must survive byte
/// splits wherever they fall, and must answer a query only for live bytes.
final class TerminalConformanceTests: XCTestCase {
  struct Fixture {
    let name: String
    let cols: UInt16
    let rows: UInt16
    let bytes: [UInt8]
  }

  /// Reviewed constants, never regenerated from the oracle (§9.2).
  static let fixtures: [Fixture] = [
    Fixture(
      name: "scroll-region-up", cols: 12, rows: 4,
      bytes: Array("a\r\nb\r\nc\r\nd\u{1B}[1;2r\u{1B}[S".utf8)),
    Fixture(
      name: "scroll-region-index", cols: 12, rows: 5,
      bytes: Array("1\r\n2\r\n3\r\n4\r\n5\u{1B}[2;4r\r\n\r\nX".utf8)),
    Fixture(
      name: "erase-line-and-display", cols: 12, rows: 3,
      bytes: Array("abc\r\ndef\u{1B}[1;1H\u{1B}[K\u{1B}[2;2H\u{1B}[1K\u{1B}[3;1H'".utf8)),
    Fixture(
      name: "underline-colors", cols: 12, rows: 2,
      bytes: Array(
        "\u{1B}[4;58;5;33mu\u{1B}[0m \u{1B}[4;58;2;10;200;30mv\u{1B}[0m \u{1B}[24;59mw".utf8)),
    Fixture(
      name: "wide-emoji", cols: 20, rows: 2,
      bytes: Array("👩‍👩‍👧‍👦x\u{FE0F}\u{1F1EF}\u{1F1F5}界".utf8)),
    Fixture(
      name: "pending-wrap-then-cr", cols: 10, rows: 2,
      bytes: Array(String(repeating: "W", count: 10).utf8) + Array("\rX".utf8)),
    Fixture(
      name: "cursor-save-restore", cols: 12, rows: 3,
      bytes: Array("top\r\n\u{1B}7mid\u{1B}8!\u{1B}[3;1Hlast".utf8)),
    Fixture(
      name: "sgr-reset-and-defaults", cols: 12, rows: 2,
      bytes: Array("\u{1B}[1;2;3;4;7;9mX\u{1B}[22;23;24;27;29mY".utf8)),
  ]

  // MARK: - Oracle parity

  func testEveryFixtureMatchesTheGoOracle() throws {
    let oracle = try OracleRunner.build()
    for fixture in Self.fixtures {
      let session = try XCTUnwrap(
        TerminalSession(cols: fixture.cols, rows: fixture.rows), fixture.name)
      session.feed(fixture.bytes)
      let frame = try XCTUnwrap(session.readFrame(), fixture.name)
      session.free()

      let mine = FrameEvidence(frame: frame)
      let theirs = try oracle.decodeRaw(fixture.bytes, cols: fixture.cols, rows: fixture.rows)
      XCTAssertNil(mine.firstDifference(against: theirs, label: fixture.name))
      XCTAssertEqual(mine.text, theirs.text, fixture.name)
      XCTAssertEqual(
        mine.cells.reduce(0) { $0 + $1.count }, Int(fixture.cols) * Int(fixture.rows),
        "\(fixture.name): every visible cell must be present")
    }
  }

  // MARK: - Split feeds

  func testSplittingTheStreamAnywhereProducesTheSameFrame() throws {
    let oracle = try OracleRunner.build()
    for fixture in Self.fixtures {
      let whole = try frame(fixture.bytes, cols: fixture.cols, rows: fixture.rows, name: fixture.name)
      // Boundaries at every byte would be slow; the interesting ones are inside
      // an escape sequence, inside a grapheme and at cell edges.
      let boundaries = Set([1, 2, 3, fixture.bytes.count / 2, fixture.bytes.count - 1])
        .filter { $0 > 0 && $0 < fixture.bytes.count }
      for cut in boundaries.sorted() {
        let session = try XCTUnwrap(
          TerminalSession(cols: fixture.cols, rows: fixture.rows), fixture.name)
        session.feed(Array(fixture.bytes[..<cut]))
        session.feed(Array(fixture.bytes[cut...]))
        let split = try XCTUnwrap(session.readFrame(), fixture.name)
        session.free()
        XCTAssertEqual(
          split, whole, "\(fixture.name): a split at byte \(cut) changed the frame")
        let theirs = try oracle.decodeRaw(fixture.bytes, cols: fixture.cols, rows: fixture.rows)
        XCTAssertNil(
          FrameEvidence(frame: split).firstDifference(against: theirs, label: fixture.name))
      }
    }
  }

  func testGraphemeSplitAcrossFeedsKeepsOneCell() throws {
    let session = try XCTUnwrap(TerminalSession(cols: 4, rows: 1))
    let bytes = Array("界".utf8)
    session.feed([bytes[0]])
    session.feed(Array(bytes[1...]))
    let frame = try XCTUnwrap(session.readFrame())
    session.free()
    XCTAssertEqual(frame.cells[0][0].text, "界")
    XCTAssertEqual(frame.cells[0][0].width, 2)
    XCTAssertEqual(frame.cursorX, 2)
  }

  // MARK: - Resize

  func testResizeInsideAnUnfinishedSequenceKeepsTheSequence() throws {
    let session = try XCTUnwrap(TerminalSession(cols: 80, rows: 24))
    session.feed(Array("\u{1B}[1;3".utf8))
    session.resize(cols: 20, rows: 6)
    session.feed(Array("1mR".utf8))
    let frame = try XCTUnwrap(session.readFrame())
    session.free()
    XCTAssertEqual(frame.cols, 20)
    XCTAssertEqual(frame.rows, 6)
    let cell = frame.cells[0][0]
    XCTAssertEqual(cell.text, "R")
    XCTAssertTrue(cell.bold, "the sequence interrupted by a resize must still apply")
    XCTAssertEqual(cell.fg, TerminalColor(kind: .palette, value: 1))
  }

  func testResizeKeepsContentAndPendingWrapState() throws {
    let session = try XCTUnwrap(TerminalSession(cols: 10, rows: 2))
    session.feed(Array(String(repeating: "W", count: 10).utf8))
    XCTAssertTrue(try XCTUnwrap(session.readFrame()).pendingWrap)
    session.resize(cols: 12, rows: 3)
    let frame = try XCTUnwrap(session.readFrame())
    session.free()
    XCTAssertEqual(frame.cols, 12)
    XCTAssertEqual(frame.rows, 3)
    XCTAssertEqual(String(frame.cells[0].map(\.text).joined()).prefix(10), "WWWWWWWWWW")
  }

  // MARK: - Reply policy

  func testOnlyLiveBytesAnswerAQuery() throws {
    let session = try XCTUnwrap(TerminalSession(cols: 80, rows: 24))
    session.feed(Array("\u{1B}[6n".utf8), source: .live)
    XCTAssertEqual(Array("\u{1B}[1;1R".utf8), session.takePtyReplies(), "live DSR")

    session.feed(Array("\u{1B}[6n".utf8), source: .replay)
    XCTAssertEqual(session.takePtyReplies(), [], "replayed history must not answer")

    session.feed(Array("\u{1B}[6n".utf8), source: .boundary)
    XCTAssertEqual(session.takePtyReplies(), [], "a boundary span must not answer")
    session.free()
  }

  func testBoundarySuppressesTheCompletionOfASplitQuery() throws {
    let session = try XCTUnwrap(TerminalSession(cols: 80, rows: 24))
    // The historical span stops inside the query; live bytes continue it.
    session.feed(Array("\u{1B}[6".utf8), source: .boundary)
    XCTAssertTrue(session.awaitingBoundary)
    session.feed(Array("n".utf8), source: .live)
    XCTAssertFalse(session.awaitingBoundary, "the parser reached ground")
    XCTAssertEqual(session.takePtyReplies(), [], "the completion is history, not live")

    // Once at ground, live queries answer again.
    session.feed(Array("\u{1B}[6n".utf8), source: .live)
    XCTAssertEqual(Array("\u{1B}[1;1R".utf8), session.takePtyReplies())
    session.free()
  }

  /// The engine refuses to encode a snapshot of a half-read sequence, so a
  /// restore always starts at ground: the pending-boundary state is defence for
  /// hand-built bytes, not a reachable round trip.
  func testASnapshotCannotEndInsideASequence() throws {
    let midSequence = try XCTUnwrap(TerminalSession(cols: 80, rows: 24))
    midSequence.feed(Array("\u{1B}[6".utf8))
    XCTAssertNil(midSequence.snapshotBytes(), "a half-read query has no encodable state")
    midSequence.free()

    let source = try XCTUnwrap(TerminalSession(cols: 80, rows: 24))
    source.feed(Array("text\u{1B}[6n".utf8))
    let snapshot = try XCTUnwrap(source.snapshotBytes())
    source.takePtyReplies()
    source.free()

    let restored = try XCTUnwrap(TerminalSession(restoring: snapshot))
    XCTAssertFalse(restored.awaitingBoundary, "a restored snapshot is at ground")
    XCTAssertEqual(restored.takePtyReplies(), [], "restored bytes are history")
    restored.feed(Array("\u{1B}[6n".utf8), source: .live)
    // The restored cursor is where "text" left it: row 1, column 5.
    XCTAssertEqual(Array("\u{1B}[1;5R".utf8), restored.takePtyReplies())
    restored.free()
  }

  func testReplyBurstIsCappedAndReportedInsteadOfGrown() throws {
    let session = try XCTUnwrap(TerminalSession(cols: 80, rows: 24))
    let query = Array("\u{1B}[6n".utf8)
    let needed = (64 << 10) / 6 + 2
    for _ in 0..<needed { session.feed(query, source: .live) }
    let replies = session.takePtyReplies()
    XCTAssertLessThanOrEqual(replies.count, 64 << 10, "the reply buffer grew past its cap")
    XCTAssertTrue(session.replyOverflowed, "dropped replies must be reported, not hidden")

    // Draining makes room again; the flag stays as the record of the drop.
    session.feed(query, source: .live)
    XCTAssertFalse(session.takePtyReplies().isEmpty)
    session.free()
  }

  // MARK: - Wire presence

  func testExitCodePresenceAndNegativeCodeSurviveTheWire() throws {
    var negative = Phi_Websocket_Terminal_V1_TerminalServerFrame()
    var exit = Phi_Websocket_Terminal_V1_TerminalExit()
    exit.code = -1
    negative.payload = .exit(exit)
    let decoded = try Phi_Websocket_Terminal_V1_TerminalServerFrame(
      serializedBytes: try negative.serializedData())
    guard case .exit(let code)? = decoded.payload else {
      return XCTFail("exit payload lost")
    }
    XCTAssertTrue(code.hasCode)
    XCTAssertEqual(code.code, -1, "sint32 -1 must not read back as dimensionless")

    var absent = Phi_Websocket_Terminal_V1_TerminalServerFrame()
    absent.payload = .exit(Phi_Websocket_Terminal_V1_TerminalExit())
    let decodedAbsent = try Phi_Websocket_Terminal_V1_TerminalServerFrame(
      serializedBytes: try absent.serializedData())
    guard case .exit(let empty)? = decodedAbsent.payload else {
      return XCTFail("exit payload lost")
    }
    XCTAssertFalse(empty.hasCode, "absent is not the same as zero")
  }

  func testUnknownFieldsAreAcceptedWithoutLosingThePayload() throws {
    var frame = Phi_Websocket_Terminal_V1_TerminalServerFrame()
    frame.payload = .pong(Phi_Websocket_Terminal_V1_TerminalPong())
    var bytes = try frame.serializedData()
    // Field 99, varint 1: a newer server's addition this client must ignore.
    bytes.append(contentsOf: [0x98, 0x06, 0x01])
    let decoded = try Phi_Websocket_Terminal_V1_TerminalServerFrame(serializedBytes: bytes)
    guard case .pong? = decoded.payload else {
      return XCTFail("unknown field broke the known payload")
    }
    XCTAssertFalse(decoded.unknownFields.data.isEmpty)
  }

  private func frame(
    _ bytes: [UInt8], cols: UInt16, rows: UInt16, name: String
  ) throws -> TerminalFrame {
    let session = try XCTUnwrap(TerminalSession(cols: cols, rows: rows), name)
    session.feed(bytes)
    let frame = try XCTUnwrap(session.readFrame(), name)
    session.free()
    return frame
  }
}
