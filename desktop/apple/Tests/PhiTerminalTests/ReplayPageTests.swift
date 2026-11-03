import Foundation
import XCTest

@testable import PhiTerminal

final class ReplayPageTests: XCTestCase {
  private func body(
    epoch: UInt64 = 7, start: UInt64 = 0, end: UInt64 = 4, through: UInt64 = 4,
    cursor: String = "v1.7.4.1", throughCursor: String = "v1.7.4.1",
    initCols: Int = 80, initRows: Int = 24, resizes: [[UInt64]] = [[2, 100, 30]],
    data: String = "abcd"
  ) throws -> Data {
    let header: [String: Any] = [
      "epoch": epoch, "start": start, "end": end, "through": through,
      "event_cursor": cursor, "through_event_cursor": throughCursor,
      "initial_cols": initCols, "initial_rows": initRows, "resizes": resizes,
    ]
    let json = try JSONSerialization.data(withJSONObject: header)
    var out = Data()
    var length = UInt32(json.count).bigEndian
    withUnsafeBytes(of: &length) { out.append(contentsOf: $0) }
    out.append(json)
    out.append(Data(data.utf8))
    return out
  }

  func testOnePageCarriesItsCursorGeometryAndBytes() throws {
    let page = try ReplayPage.decode(
      try body(), epoch: 7, from: 0, through: 4, fence: "v1.7.4.1",
      after: ReplayPosition(epoch: 7, seq: 0, ordinal: 0))

    XCTAssertEqual(page.initialCols, 80)
    XCTAssertEqual(page.eventCursor, ReplayPosition(epoch: 7, seq: 4, ordinal: 1))
    XCTAssertEqual(page.segments(from: 0), [
      .bytes(start: 0, end: 2, data: Data("ab".utf8)),
      .resize(position: 2, cols: 100, rows: 30),
      .bytes(start: 2, end: 4, data: Data("cd".utf8)),
    ])
  }

  func testALatestRequestAdoptsTheServersFence() throws {
    let page = try ReplayPage.decode(
      try body(through: 9, cursor: "v1.7.4.1", throughCursor: "v1.7.9.1"),
      epoch: 7, from: 0, through: nil, fence: nil,
      after: ReplayPosition(epoch: 7, seq: 0, ordinal: 0))

    XCTAssertEqual(page.through, 9)
    XCTAssertEqual(page.throughCursor, ReplayPosition(epoch: 7, seq: 9, ordinal: 1))
  }

  func testAPageThatDisagreesWithItsRequestIsRejected() throws {
    // A fence the client never asked for would let a later page follow a head
    // that moved underneath it.
    XCTAssertThrowsError(try ReplayPage.decode(
      try body(throughCursor: "v1.7.9.1"), epoch: 7, from: 0, through: 4,
      fence: "v1.7.4.1", after: ReplayPosition(epoch: 7, seq: 0, ordinal: 0)))
    XCTAssertThrowsError(try ReplayPage.decode(
      try body(epoch: 8), epoch: 7, from: 0, through: 4, fence: "v1.7.4.1",
      after: ReplayPosition(epoch: 7, seq: 0, ordinal: 0)))
    XCTAssertThrowsError(try ReplayPage.decode(
      try body(start: 3), epoch: 7, from: 0, through: 4, fence: "v1.7.4.1",
      after: ReplayPosition(epoch: 7, seq: 0, ordinal: 0)))
    // Data length must match the span it claims.
    XCTAssertThrowsError(try ReplayPage.decode(
      try body(data: "abc"), epoch: 7, from: 0, through: 4, fence: "v1.7.4.1",
      after: ReplayPosition(epoch: 7, seq: 0, ordinal: 0)))
  }

  func testGeometryMarkersMustBeOrderedAndInRange() throws {
    XCTAssertThrowsError(try ReplayPage.decode(
      try body(cursor: "v1.7.4.2", resizes: [[3, 100, 30], [1, 100, 30]]),
      epoch: 7, from: 0, through: 4, fence: "v1.7.4.2",
      after: ReplayPosition(epoch: 7, seq: 0, ordinal: 0)))
    XCTAssertThrowsError(try ReplayPage.decode(
      try body(cursor: "v1.7.4.1", resizes: [[5, 100, 30]]),
      epoch: 7, from: 0, through: 4, fence: "v1.7.4.1",
      after: ReplayPosition(epoch: 7, seq: 0, ordinal: 0)))
    XCTAssertThrowsError(try ReplayPage.decode(
      try body(cursor: "v1.7.4.1", resizes: [[2, 0, 30]]),
      epoch: 7, from: 0, through: 4, fence: "v1.7.4.1",
      after: ReplayPosition(epoch: 7, seq: 0, ordinal: 0)))
    // The ordinal must account for exactly the markers the page carries.
    XCTAssertThrowsError(try ReplayPage.decode(
      try body(cursor: "v1.7.4.2"), epoch: 7, from: 0, through: 4,
      fence: "v1.7.4.1", after: ReplayPosition(epoch: 7, seq: 0, ordinal: 0)))
  }

  func testAReplayFromTheMiddleSkipsWhatWasAlreadyApplied() throws {
    let page = try ReplayPage.decode(
      try body(cursor: "v1.7.4.1", resizes: [[2, 100, 30]]),
      epoch: 7, from: 0, through: 4, fence: "v1.7.4.1",
      after: ReplayPosition(epoch: 7, seq: 0, ordinal: 0))

    XCTAssertEqual(page.segments(from: 3), [
      .bytes(start: 3, end: 4, data: Data("d".utf8))
    ])
  }
}

extension ReplayPageTests {
  func testAFullTwoMiBPageIsAccepted() throws {
    // The server caps one page at 2 MiB (`replayPageMaxBytes`); a client that
    // caps lower would stall on the largest legal page.
    let size = ReplayPage.maxPageBytes
    let page = try ReplayPage.decode(
      try body(
        end: UInt64(size), through: UInt64(size), cursor: "v1.7.\(size).0",
        throughCursor: "v1.7.\(size).0", resizes: [],
        data: String(repeating: "x", count: size)),
      epoch: 7, from: 0, through: UInt64(size), fence: "v1.7.\(size).0",
      after: ReplayPosition(epoch: 7, seq: 0, ordinal: 0))

    XCTAssertEqual(page.data.count, size)
    XCTAssertFalse(page.historyIncomplete)
  }

  func testAPageWithMoreGeometryEventsThanTheProtocolAllowsIsRejected() throws {
    let markers = (0..<257).map { [UInt64($0), 80, 24] }
    XCTAssertThrowsError(try ReplayPage.decode(
      try body(cursor: "v1.7.4.257", resizes: markers), epoch: 7, from: 0, through: 4,
      fence: "v1.7.4.257", after: ReplayPosition(epoch: 7, seq: 0, ordinal: 0)))
  }

  func testAnIncompleteJournalIsReportedNotRejected() throws {
    // A pane that lost bytes must still render; the caller warns, it never fails.
    let json: [String: Any] = [
      "epoch": 7, "start": 0, "end": 4, "through": 4,
      "event_cursor": "v1.7.4.0", "through_event_cursor": "v1.7.4.0",
      "initial_cols": 80, "initial_rows": 24, "resizes": [],
      "history_incomplete": true, "ephemeral": false,
    ]
    let header = try JSONSerialization.data(withJSONObject: json)
    var body = Data()
    var length = UInt32(header.count).bigEndian
    withUnsafeBytes(of: &length) { body.append(contentsOf: $0) }
    body.append(header)
    body.append(Data("abcd".utf8))

    let page = try ReplayPage.decode(
      body, epoch: 7, from: 0, through: 4, fence: "v1.7.4.0",
      after: ReplayPosition(epoch: 7, seq: 0, ordinal: 0))

    XCTAssertTrue(page.historyIncomplete)
    XCTAssertFalse(page.ephemeral)
  }

  func testAPageThatReportsNoNewEventsIsNotTheFenceItself() throws {
    // cursor == after is only legal when the page already reached the fence:
    // otherwise recovery would loop on the same span forever.
    XCTAssertThrowsError(try ReplayPage.decode(
      try body(start: 0, end: 0, through: 4, cursor: "v1.7.0.0",
                throughCursor: "v1.7.4.0", resizes: [], data: ""),
      epoch: 7, from: 0, through: 4, fence: "v1.7.4.0",
      after: ReplayPosition(epoch: 7, seq: 0, ordinal: 0)))
  }
}
