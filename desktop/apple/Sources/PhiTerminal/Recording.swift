import Foundation

/// One ordered input for both the emulator and the terminal-view observer.
public enum RecordingSegment: Equatable, Sendable {
  case bytes(start: UInt64, end: UInt64, data: Data)
  case resize(position: UInt64, cols: UInt16, rows: UInt16)
}

/// Events applied to a shadow terminal view in source order.
public enum TerminalObservation: Equatable, Sendable {
  case reset(
    connection: UUID, epoch: UInt64, frontier: UInt64, cols: UInt16, rows: UInt16, bytes: Data)
  case bytes(connection: UUID, epoch: UInt64, start: UInt64, end: UInt64, data: Data)
  case resize(connection: UUID, epoch: UInt64, position: UInt64, cols: UInt16, rows: UInt16)
}

public typealias TerminalObserver = @Sendable (TerminalObservation) async throws -> Void

/// One page of the pane's recorded byte stream, with the resize markers that
/// must be applied in order while the page is fed (§7.2).
///
/// Wire shape and validation mirror the Go client's
/// `(*apiClient).recording` (`internal/phic/recording.go:47–97`): the reply is
/// `[u32 big-endian header length][JSON header][raw span]`, and every field is
/// checked before a byte reaches the terminal.
public struct RecordingPage: Equatable, Sendable {
  public struct Resize: Equatable, Sendable {
    /// Source position the size takes effect at, in the same units as `start`.
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
  public var resizes: [Resize]
  /// Continues marker filtering on the next page; absent on older servers.
  public var eventCursor: String?
  public var data: Data

  public static let maxPage = 2 << 20
  /// `[u32 length][JSON header]` with both halves bounded independently (§7.1).
  public static let maxBody = 4 + (2 << 20) + (2 << 20)
  public static let maxHeader = 2 << 20
  public static let maxCursor = 128

  public init(
    epoch: UInt64, start: UInt64, end: UInt64, resizes: [Resize],
    eventCursor: String? = nil, data: Data
  ) {
    self.epoch = epoch
    self.start = start
    self.end = end
    self.resizes = resizes
    self.eventCursor = eventCursor
    self.data = data
  }

  /// Decodes one recording reply for the span this client asked for.
  public static func decode(
    _ body: Data, epoch: UInt64, from: UInt64, through: UInt64
  ) throws -> RecordingPage {
    guard through >= from, through - from <= UInt64(maxPage) else {
      throw RecordingError.invalid("requested span is not one bounded page")
    }
    guard body.count >= 4 else {
      throw RecordingError.invalid("recording shorter than its length prefix")
    }
    let headerLength = body.prefix(4).reduce(0) { $0 << 8 | Int($1) }
    guard headerLength > 0, headerLength <= maxHeader,
          body.count >= 4 + headerLength else {
      throw RecordingError.invalid("recording header length out of range")
    }
    guard let header = try? JSONDecoder().decode(Header.self, from: body[4..<(4 + headerLength)])
    else {
      throw RecordingError.invalid("recording header decode failed")
    }
    // A start above the requested frontier means the prefix was evicted, which
    // an authoritative live checkpoint can heal. Anything else is malformed.
    guard header.start <= from else { throw RecordingError.expired }
    guard header.epoch == epoch, header.start == from,
          header.end >= header.start, header.end <= through,
          (header.eventCursor?.utf8.count ?? 0) <= maxCursor else {
      throw RecordingError.invalid("recording header does not describe the requested span")
    }
    let data = Data(body[(4 + headerLength)...])
    guard header.end - header.start == UInt64(data.count) else {
      throw RecordingError.invalid("recording data does not match its span")
    }
    var resizes: [Resize] = []
    // Absent or null markers are an old server with no recorded resizes.
    let markers = header.resizes ?? []
    resizes.reserveCapacity(markers.count)
    var previous: UInt64 = 0
    for (index, marker) in markers.enumerated() {
      guard marker.count == 3 else {
        throw RecordingError.invalid("resize marker is not a triple")
      }
      let at = marker[0]
      let cols = marker[1]
      let rows = marker[2]
      guard at <= header.end, index == 0 || at >= previous,
            cols >= 1, cols <= 65535, rows >= 1, rows <= 65535 else {
        throw RecordingError.invalid("resize marker out of range")
      }
      previous = at
      resizes.append(Resize(at: at, cols: UInt16(cols), rows: UInt16(rows)))
    }
    return RecordingPage(
      epoch: header.epoch, start: header.start, end: header.end, resizes: resizes,
      eventCursor: header.eventCursor, data: data)
  }

  /// Splits one page once so emulator and view consume the same byte/resize order.
  public func segments(from sourceFrontier: UInt64? = nil) -> [RecordingSegment] {
    let lower = max(start, sourceFrontier ?? start)
    guard lower <= end else { return [] }
    var result: [RecordingSegment] = []
    var at = lower
    for marker in resizes {
      let position = max(start, marker.at)
      guard position >= lower else { continue }
      if position > at {
        result.append(.bytes(
          start: at, end: position,
          data: data[Int(at - start)..<Int(position - start)]))
        at = position
      }
      result.append(.resize(position: marker.at, cols: marker.cols, rows: marker.rows))
    }
    if at < end {
      result.append(.bytes(
        start: at, end: end, data: data[Int(at - start)..<Int(end - start)]))
    }
    return result
  }

  /// Feeds the bytes up to each marker, then resizes, then feeds the rest.
  public func apply(to terminal: TerminalSession, source: FeedSource) {
    for segment in segments() {
      switch segment {
      case .bytes(_, _, let data):
        terminal.feed([UInt8](data), source: source)
      case .resize(_, let cols, let rows):
        terminal.resize(cols: cols, rows: rows)
      }
    }
  }

  private struct Header: Decodable {
    var epoch: UInt64
    var start: UInt64
    var end: UInt64
    var resizes: [[UInt64]]?
    var eventCursor: String?

    enum CodingKeys: String, CodingKey {
      case epoch, start, end, resizes
      case eventCursor = "event_cursor"
    }
  }
}

public enum RecordingError: Error, Equatable {
  /// The recorded prefix is gone: an authoritative checkpoint supersedes it.
  case expired
  case invalid(String)
}
