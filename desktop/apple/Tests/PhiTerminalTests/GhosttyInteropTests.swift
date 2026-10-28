import XCTest
@testable import PhiTerminal

/// M0 gate: the committed arm64 archive links, runs, and tears down cleanly.
/// One test, no skips. A failure here stops M0.
final class GhosttyInteropTests: XCTestCase {
  func testArm64ArchiveLinkAndReadyRestore() throws {
    setvbuf(stdout, nil, _IONBF, 0)

    // LP64 arm64 ABI assumptions that the Swift adapter relies on.
    XCTAssertEqual(MemoryLayout<Int>.size, 8)
    XCTAssertEqual(MemoryLayout<UInt16>.size, 2)

    let term = try XCTUnwrap(TerminalSession(cols: 80, rows: 24), "terminal_new failed")
    XCTAssertEqual(term.columnCount(), 80)
    XCTAssertEqual(term.rowCount(), 24)

    term.feed(Array("hi".utf8))
    term.feed(Array("\u{1b}[31m".utf8))
    term.feed(Array("界".utf8))

    let row0 = term.cells(inRow: 0)
    XCTAssertEqual(row0.map(\.text), ["h", "i", "界"], "row 0 cells")

    // Wide-character advance: h(1) + i(1) + 界(2) = cursor at column 4.
    let cursor = try XCTUnwrap(term.readCursor(), "cursor not visible")
    XCTAssertEqual(cursor.y, 0)
    XCTAssertEqual(cursor.x, 4, "wide character must advance two columns")

    // The 界 cell carries palette index 1 (red), not the default foreground.
    let wide = try XCTUnwrap(row0.last)
    let red = try XCTUnwrap(term.paletteEntry(1), "palette unavailable")
    let defaultFg = try XCTUnwrap(term.paletteEntry(7))
    let wideFg = try XCTUnwrap(wide.foreground, "wide cell has no explicit foreground")
    XCTAssertEqual(wideFg.0, red.0, "wide cell red channel")
    XCTAssertEqual(wideFg.1, red.1, "wide cell green channel")
    XCTAssertEqual(wideFg.2, red.2, "wide cell blue channel")
    XCTAssertNotEqual(wideFg.0, defaultFg.0, "SGR 31 must not resolve to default fg")

    // Snapshot encode, then READY-only restore into a fresh terminal.
    let snapshot = try XCTUnwrap(term.snapshotBytes(), "snapshot encode failed")
    XCTAssertGreaterThan(snapshot.count, 0)

    let restored = try XCTUnwrap(TerminalSession(restoring: snapshot), "READY restore failed")
    XCTAssertEqual(restored.cells(inRow: 0).map(\.text), ["h", "i", "界"], "restored row 0 cells")

    // Encoders attach to the live terminal state and free cleanly.
    XCTAssertTrue(term.exerciseEncoders(), "key/mouse encoder setup failed")

    // RIS then DSR: the write-PTY callback must answer synchronously.
    term.feed(Array("\u{1b}c".utf8))
    term.feed(Array("\u{1b}[6n".utf8))
    XCTAssertEqual(Array("\u{1b}[1;1R".utf8), term.takePtyReplies(), "DSR reply")
    XCTAssertEqual(term.cells(inRow: 0).map(\.text), [], "RIS must clear the screen")

    // Both terminals are released before the balance check.
    restored.free()
    term.free()
    XCTAssertGreaterThan(term.counters.allocs, 0, "allocator never exercised")
    XCTAssertEqual(term.counters.live, 0, "allocator leak: \(term.counters.live) bytes")
    XCTAssertEqual(restored.counters.live, 0, "restored allocator leak: \(restored.counters.live) bytes")
  }

  /// Blocker regression: a corrupt or truncated snapshot must fail closed
  /// without leaking the engine, and a hidden cursor must not render.
  func testTruncatedSnapshotFailsClosedAndHiddenCursorReadsNil() throws {
    let term = try XCTUnwrap(TerminalSession(cols: 20, rows: 4), "terminal_new failed")
    term.feed(Array("ab".utf8))
    term.feed(Array("\u{1b}[?25l".utf8))
    XCTAssertNil(term.readCursor(), "a hidden cursor must not be drawn")

    let snapshot = try XCTUnwrap(term.snapshotBytes(), "snapshot encode failed")
    XCTAssertNil(
      TerminalSession(restoring: Array(snapshot.prefix(snapshot.count / 2))),
      "a truncated snapshot must not restore")

    term.free()
    XCTAssertEqual(term.counters.live, 0, "allocator leak: \(term.counters.live) bytes")
  }
}
