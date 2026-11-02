import AppKit
import SwiftTerm
import PhiTerminal

@MainActor
final class SpikeTerminalView: TerminalView, TerminalViewDelegate {
  private(set) var connectionID: UUID?
  private(set) var epoch: UInt64?
  private(set) var sourceFrontier: UInt64 = 0
  private var remoteGeometry: TerminalDimensions?
  var onInput: (([UInt8]) -> Void)?
  var onGridResize: ((Int, Int) -> Void)?
  nonisolated let discardedParserReplies = ParserReplyCounter()

  /// The server's terminal already answered the queries in its byte stream, so
  /// this parser's replies must not echo back. User input, paste included,
  /// arrives through the same delegate hook and is told apart by whether a
  /// server feed is in progress.
  private let feedState = FeedState()

  /// Lines kept above the viewport. The default of 500 is too short to read
  /// back through a build log.
  static let scrollbackLines = 10_000

  init(cols: UInt16 = 80, rows: UInt16 = 24) {
    super.init(
      frame: .zero,
      font: NSFont.monospacedSystemFont(ofSize: 13, weight: .regular),
      options: TerminalOptions(cols: Int(cols), rows: Int(rows)))
    scrollerStyle = .overlay
    changeScrollback(Self.scrollbackLines)
    terminalDelegate = self
  }

  required init?(coder: NSCoder) {
    fatalError("init(coder:) has not been implemented")
  }

  nonisolated override func send(source: Terminal, data: ArraySlice<UInt8>) {
    guard !feedState.isFeeding else {
      discardedParserReplies.record()
      return
    }
    // Paste, mouse reports, and focus reports reach the pane through here.
    super.send(source: source, data: data)
  }

  private func feedFromServer(_ bytes: [UInt8]) {
    feedState.beginFeed()
    defer { feedState.endFeed() }
    feed(byteArray: bytes[...])
  }

  func apply(_ event: TerminalObservation) throws {
    switch event {
    case .reset(let connection, let epoch, let frontier, let cols, let rows, let bytes):
      guard cols >= 2, rows >= 1, bytes.count <= RecordingPage.maxPage else {
        throw SpikeWindowError.unsupportedGeometry
      }
      try setFrameGeometry(cols: Int(cols), rows: Int(rows))
      connectionID = connection
      self.epoch = epoch
      sourceFrontier = frontier
      remoteGeometry = TerminalDimensions(cols: Int(cols), rows: Int(rows))
      feedFromServer(Array(bytes))

    case .bytes(let connection, let epoch, let start, let end, let bytes):
      guard connectionID == connection, self.epoch == epoch,
            end >= start, end - start == UInt64(bytes.count), start == sourceFrontier else {
        throw SpikeWindowError.outOfOrderBytes
      }
      feedFromServer(Array(bytes))
      sourceFrontier = end

    case .resize(let connection, let epoch, let position, let cols, let rows):
      guard connectionID == connection, self.epoch == epoch else {
        throw SpikeWindowError.staleConnection
      }
      guard cols >= 2, rows >= 1 else { throw SpikeWindowError.unsupportedGeometry }
      remoteGeometry = TerminalDimensions(cols: Int(cols), rows: Int(rows))
      try setFrameGeometry(cols: Int(cols), rows: Int(rows))
      sourceFrontier = max(sourceFrontier, position)
    }
  }

  func setFrameGeometry(cols: Int, rows: Int) throws {
    let current = terminalDimensions
    guard current.cols >= 2, current.rows >= 1, cols >= 2, rows >= 1 else {
      throw SpikeWindowError.unsupportedGeometry
    }
    let optimal = getOptimalFrameSize()
    let cellWidth = optimal.width / CGFloat(current.cols)
    let cellHeight = optimal.height / CGFloat(current.rows)
    remoteGeometry = TerminalDimensions(cols: cols, rows: rows)
    setFrameSize(NSSize(width: cellWidth * CGFloat(cols), height: cellHeight * CGFloat(rows)))
    guard terminalDimensions == TerminalDimensions(cols: cols, rows: rows) else {
      throw SpikeWindowError.unsupportedGeometry
    }
  }

  func sizeChanged(source: TerminalView, newCols: Int, newRows: Int) {
    let actual = source.terminalDimensions
    guard actual.cols >= 2, actual.rows >= 1, actual != remoteGeometry else { return }
    onGridResize?(actual.cols, actual.rows)
  }

  func setTerminalTitle(source: TerminalView, title: String) {}
  func hostCurrentDirectoryUpdate(source: TerminalView, directory: String?) {}

  func send(source: TerminalView, data: ArraySlice<UInt8>) {
    onInput?(Array(data))
  }

  func scrolled(source: TerminalView, position: Double) {}
  func requestOpenLink(source: TerminalView, link: String, params: [String: String]) {}
  func bell(source: TerminalView) {}
  func clipboardCopy(source: TerminalView, content: Data) {}
  func clipboardRead(source: TerminalView) -> Data? { nil }
  func iTermContent(source: TerminalView, content: ArraySlice<UInt8>) {}
  func rangeChanged(source: TerminalView, startY: Int, endY: Int) {}
}

enum SpikeWindowError: Error, Sendable {
  case staleConnection
  case unsupportedGeometry
  case outOfOrderBytes
}

final class FeedState: @unchecked Sendable {
  private let lock = NSLock()
  private var depth = 0

  func beginFeed() {
    lock.lock()
    depth += 1
    lock.unlock()
  }

  func endFeed() {
    lock.lock()
    depth = max(0, depth - 1)
    lock.unlock()
  }

  var isFeeding: Bool {
    lock.lock()
    defer { lock.unlock() }
    return depth > 0
  }
}

final class ParserReplyCounter: @unchecked Sendable {
  private let lock = NSLock()
  private var calls = 0

  func record() {
    lock.lock()
    calls += 1
    lock.unlock()
  }

  var count: Int {
    lock.lock()
    defer { lock.unlock() }
    return calls
  }
}
