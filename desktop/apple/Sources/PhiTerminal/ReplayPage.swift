import Foundation

/// `v1.<epoch>.<seq>.<ordinal>`: the position the server names for one byte
/// frontier and the geometry event that belongs to it (`internal/phic/replay.go`).
public struct ReplayPosition: Equatable, Sendable, CustomStringConvertible {
  public var epoch: UInt64
  public var seq: UInt64
  public var ordinal: UInt64

  public init(epoch: UInt64, seq: UInt64, ordinal: UInt64 = 0) {
    self.epoch = epoch
    self.seq = seq
    self.ordinal = ordinal
  }

  public init?(_ text: String) {
    let parts = text.split(separator: ".", omittingEmptySubsequences: false)
    guard text.utf8.count <= 128, parts.count == 4, parts[0] == "v1",
          let epoch = UInt64(parts[1]), let seq = UInt64(parts[2]),
          let ordinal = UInt64(parts[3]) else { return nil }
    self.init(epoch: epoch, seq: seq, ordinal: ordinal)
  }

  public var description: String { "v1.\(epoch).\(seq).\(ordinal)" }
}

/// One page of the pane's raw PTY history, which replaced the server-side
/// terminal snapshots (§ raw replay). The server answers
/// `[u32 big-endian header length][JSON header][raw bytes]` and every field is
/// checked before a byte reaches a terminal.
public struct ReplayPage: Equatable, Sendable {
  public struct Resize: Equatable, Sendable {
    /// Byte position the size takes effect at.
    public var at: UInt64
    public var cols: UInt16
    public var rows: UInt16

    public init(at: UInt64, cols: UInt16, rows: UInt16) {
      self.at = at
      self.cols = cols
      self.rows = rows
    }
  }

  public var epoch: UInt64
  public var start: UInt64
  public var end: UInt64
  /// Geometry the journal began with: a cold replay starts the parser here.
  public var initialCols: UInt16
  public var initialRows: UInt16
  public var resizes: [Resize]
  /// Position after the last applied geometry event; continues marker filtering.
  public var eventCursor: ReplayPosition
  /// The fence this page belongs to, so a later page never follows a moving head.
  public var through: UInt64
  public var throughCursor: ReplayPosition
  /// The journal could not keep every byte before this page (`history_incomplete`).
  public var historyIncomplete: Bool
  /// The pane records no durable history (`ephemeral`).
  public var ephemeral: Bool
  public var data: Data

  /// One page is at most 2 MiB of raw output (`replayPageMaxBytes`).
  public static let maxPageBytes = 2 << 20
  public static let maxHeaderBytes = 64 << 10
  public static let maxBodyBytes = 4 + maxHeaderBytes + maxPageBytes
  public static let maxResizes = 256

  public init(
    epoch: UInt64, start: UInt64, end: UInt64, initialCols: UInt16, initialRows: UInt16,
    resizes: [Resize], eventCursor: ReplayPosition, through: UInt64,
    throughCursor: ReplayPosition, historyIncomplete: Bool = false,
    ephemeral: Bool = false, data: Data
  ) {
    self.epoch = epoch
    self.start = start
    self.end = end
    self.initialCols = initialCols
    self.initialRows = initialRows
    self.resizes = resizes
    self.eventCursor = eventCursor
    self.through = through
    self.throughCursor = throughCursor
    self.historyIncomplete = historyIncomplete
    self.ephemeral = ephemeral
    self.data = data
  }

  /// Decodes one reply for the span this client asked for. The rules mirror
  /// `(*apiClient).replay` in the Go client: a page that disagrees with its
  /// request is malformed, not something to render.
  public static func decode(
    _ body: Data, epoch: UInt64, from: UInt64, through: UInt64?, fence: String?,
    after: ReplayPosition
  ) throws -> ReplayPage {
    guard body.count >= 4, body.count <= maxBodyBytes else {
      throw ReplayError.invalid("replay body out of bounds")
    }
    let headerLength = body.prefix(4).reduce(0) { $0 << 8 | Int($1) }
    guard headerLength > 0, headerLength <= maxHeaderBytes, 4 + headerLength <= body.count else {
      throw ReplayError.invalid("replay header length out of range")
    }
    guard let header = try? JSONDecoder().decode(Header.self, from: body[4..<(4 + headerLength)])
    else {
      throw ReplayError.invalid("replay header decode failed")
    }
    let data = Data(body[(4 + headerLength)...])
    guard let cursor = ReplayPosition(header.eventCursor),
          let throughCursor = ReplayPosition(header.throughCursor) else {
      throw ReplayError.invalid("replay cursor is malformed")
    }
    guard header.epoch == epoch, header.start == from, header.end >= from,
          header.end - from == UInt64(data.count), data.count <= maxPageBytes,
          cursor.epoch == epoch, cursor.seq == header.end, cursor.ordinal >= after.ordinal,
          throughCursor.epoch == epoch, throughCursor.seq == header.through,
          header.end <= throughCursor.seq, cursor.ordinal <= throughCursor.ordinal,
          through.map { header.through == $0 } ?? true,
          fence.map { header.throughCursor == $0 } ?? true,
          (1...65535).contains(header.initCols), (1...65535).contains(header.initRows),
          header.resizes.count <= maxResizes,
          cursor.ordinal - after.ordinal == UInt64(header.resizes.count),
          !(cursor == after && cursor != throughCursor) else {
      throw ReplayError.invalid("replay header does not describe the requested span")
    }
    var resizes: [Resize] = []
    resizes.reserveCapacity(header.resizes.count)
    var last: UInt64 = 0
    for marker in header.resizes {
      guard marker.count == 3, marker[0] >= last, marker[0] <= header.end,
            (1...65535).contains(marker[1]), (1...65535).contains(marker[2]) else {
        throw ReplayError.invalid("replay resize marker out of range")
      }
      last = marker[0]
      resizes.append(Resize(at: marker[0], cols: UInt16(marker[1]), rows: UInt16(marker[2])))
    }
    return ReplayPage(
      epoch: header.epoch, start: header.start, end: header.end,
      initialCols: UInt16(header.initCols), initialRows: UInt16(header.initRows),
      resizes: resizes, eventCursor: cursor, through: header.through,
      throughCursor: throughCursor, historyIncomplete: header.historyIncomplete ?? false,
      ephemeral: header.ephemeral ?? false, data: data)
  }

  /// Splits one page so bytes and geometry reach the parser in stream order.
  public func segments(from frontier: UInt64) -> [RecordingSegment] {
    guard frontier <= end else { return [] }
    var result: [RecordingSegment] = []
    var at = frontier
    for marker in resizes {
      guard marker.at >= frontier else { continue }
      if marker.at > at {
        result.append(.bytes(
          start: at, end: marker.at, data: data[Int(at - start)..<Int(marker.at - start)]))
        at = marker.at
      }
      result.append(.resize(position: marker.at, cols: marker.cols, rows: marker.rows))
    }
    if at < end {
      result.append(.bytes(start: at, end: end, data: data[Int(at - start)..<Int(end - start)]))
    }
    return result
  }

  private struct Header: Decodable {
    var epoch: UInt64
    var start: UInt64
    var end: UInt64
    var initCols: UInt16
    var initRows: UInt16
    var resizes: [[UInt64]]
    var eventCursor: String
    var through: UInt64
    var throughCursor: String
    var historyIncomplete: Bool?
    var ephemeral: Bool?

    enum CodingKeys: String, CodingKey {
      case epoch, start, end, resizes, through, ephemeral
      case initCols = "initial_cols"
      case initRows = "initial_rows"
      case eventCursor = "event_cursor"
      case throughCursor = "through_event_cursor"
      case historyIncomplete = "history_incomplete"
    }
  }
}

public enum ReplayError: Error, Equatable {
  case invalid(String)
}
