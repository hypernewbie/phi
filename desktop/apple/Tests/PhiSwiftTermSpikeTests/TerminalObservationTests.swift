import AppKit
import PhiTerminal
import XCTest
@testable import PhiSwiftTermSpike

final class TerminalObservationTests: XCTestCase {
  @MainActor
  func testReplayAndLiveQueryHaveOneReplyOwner() throws {
    let connection = UUID()
    var sessionInputs: [[UInt8]] = []
    let checkpointPrefix = Array("\u{1B}[6".utf8)

    let checkpointView = SpikeTerminalView()
    checkpointView.onInput = { sessionInputs.append($0) }
    try checkpointView.apply(.reset(
      connection: connection, epoch: 7, frontier: 0, cols: 80, rows: 24,
      bytes: Data(checkpointPrefix)))
    let checkpointEngine = try XCTUnwrap(TerminalSession(cols: 80, rows: 24))
    defer { checkpointEngine.free() }
    checkpointEngine.feed(checkpointPrefix, source: .boundary)
    XCTAssertEqual(checkpointEngine.takePtyReplies(), [])
    try checkpointView.apply(.bytes(
      connection: connection, epoch: 7, start: 0, end: 1, data: Data("n".utf8)))
    checkpointEngine.feed(Array("n".utf8), source: .live)
    XCTAssertEqual(checkpointEngine.takePtyReplies(), [])
    XCTAssertEqual(checkpointView.discardedParserReplies.count, 1)
    XCTAssertTrue(sessionInputs.isEmpty)

    let deltaView = SpikeTerminalView()
    deltaView.onInput = { sessionInputs.append($0) }
    try deltaView.apply(.reset(
      connection: connection, epoch: 7, frontier: 0, cols: 80, rows: 24, bytes: Data()))
    let deltaEngine = try XCTUnwrap(TerminalSession(cols: 80, rows: 24))
    defer { deltaEngine.free() }
    try deltaView.apply(.bytes(
      connection: connection, epoch: 7, start: 0, end: 3, data: Data(checkpointPrefix)))
    deltaEngine.feed(checkpointPrefix, source: .boundary)
    XCTAssertEqual(deltaEngine.takePtyReplies(), [])
    try deltaView.apply(.bytes(
      connection: connection, epoch: 7, start: 3, end: 4, data: Data("n".utf8)))
    deltaEngine.feed(Array("n".utf8), source: .live)
    XCTAssertEqual(deltaEngine.takePtyReplies(), [])
    XCTAssertEqual(deltaView.discardedParserReplies.count, 1)
    XCTAssertTrue(sessionInputs.isEmpty)

    let liveQuery = Array("\u{1B}[6n".utf8)
    try deltaView.apply(.bytes(
      connection: connection, epoch: 7, start: 4, end: 8, data: Data(liveQuery)))
    deltaEngine.feed(liveQuery, source: .live)
    XCTAssertEqual(deltaEngine.takePtyReplies(), Array("\u{1B}[1;1R".utf8))
    XCTAssertEqual(deltaView.discardedParserReplies.count, 2)
    XCTAssertTrue(sessionInputs.isEmpty, "parser replies must never enter the session input delegate")
  }
}
