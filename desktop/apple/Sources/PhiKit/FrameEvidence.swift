import Foundation
import PhiTerminal

/// One frame written to disk so an independent adapter can be compared against
/// it (§9.2). The schema is shared with the Go oracle; text is canonical, so a
/// byte difference names the exact row and cell.
public struct FrameEvidence: Codable, Equatable, Sendable {
  public var cols: Int
  public var rows: Int
  public var cursorX: Int
  public var cursorY: Int
  public var pendingWrap: Bool
  public var cursorHidden: Bool
  public var alt: Bool
  public var history: Int
  /// Canonical text: U+0020 per empty narrow cell, no byte for a wide
  /// continuation, grapheme bytes unchanged, LF after every row.
  public var text: String
  public var cells: [[TerminalCellFrame]]

  public init(frame: TerminalFrame) {
    cols = frame.cols
    rows = frame.rows
    cursorX = frame.cursorX
    cursorY = frame.cursorY
    pendingWrap = frame.pendingWrap
    cursorHidden = frame.cursorHidden
    alt = frame.alt
    history = frame.history
    text = frame.canonicalText()
    cells = frame.cells
  }

  public func encoded() throws -> Data {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]
    return try encoder.encode(self)
  }

  public static func decode(_ data: Data) throws -> FrameEvidence {
    try JSONDecoder().decode(FrameEvidence.self, from: data)
  }

  /// First difference against another frame, as a report a human can act on.
  /// Nil means the two frames agree byte for byte and cell for cell.
  public func firstDifference(against other: FrameEvidence, label: String) -> String? {
    if cols != other.cols || rows != other.rows {
      return "\(label): geometry \(cols)x\(rows) versus \(other.cols)x\(other.rows)"
    }
    if cursorX != other.cursorX || cursorY != other.cursorY
      || pendingWrap != other.pendingWrap || cursorHidden != other.cursorHidden {
      return "\(label): cursor (\(cursorX),\(cursorY) wrap \(pendingWrap) hidden \(cursorHidden))"
        + " versus (\(other.cursorX),\(other.cursorY) wrap \(other.pendingWrap) hidden \(other.cursorHidden))"
    }
    if alt != other.alt {
      return "\(label): alternate screen \(alt) versus \(other.alt)"
    }
    if let offset = Self.firstTextDifference(text, other.text) {
      let (row, column) = Self.position(of: offset, in: text, cols: cols)
      return "\(label): text differs at byte \(offset), row \(row), column \(column):"
        + " \(Self.byteDescription(text, at: offset)) versus \(Self.byteDescription(other.text, at: offset))"
    }
    for row in 0..<min(cells.count, other.cells.count) {
      let mine = cells[row]
      let theirs = other.cells[row]
      if mine.count != theirs.count {
        return "\(label): row \(row) has \(mine.count) cells versus \(theirs.count)"
      }
      for column in 0..<mine.count where mine[column] != theirs[column] {
        return "\(label): cell differs at row \(row), column \(column):"
          + " \(Self.cellDescription(mine[column])) versus \(Self.cellDescription(theirs[column]))"
      }
    }
    return nil
  }

  private static func cellDescription(_ cell: TerminalCellFrame) -> String {
    "text \(cell.text.debugDescription) width \(cell.width) fg \(cell.fg.kind.rawValue)/\(cell.fg.value)"
      + " bg \(cell.bg.kind.rawValue)/\(cell.bg.value) bold \(cell.bold) faint \(cell.faint)"
      + " italic \(cell.italic) strike \(cell.strikethrough) inverse \(cell.inverse)"
      + " blink \(cell.blink) underline \(cell.underline)"
  }

  private static func byteDescription(_ text: String, at offset: Int) -> String {
    let bytes = Array(text.utf8)
    guard offset < bytes.count else { return "end of text" }
    return String(format: "0x%02x", bytes[offset])
  }

  private static func firstTextDifference(_ lhs: String, _ rhs: String) -> Int? {
    let left = Array(lhs.utf8)
    let right = Array(rhs.utf8)
    for index in 0..<min(left.count, right.count) where left[index] != right[index] {
      return index
    }
    return left.count == right.count ? nil : min(left.count, right.count)
  }

  /// Byte offset to a row and column. Multi-byte graphemes make columns
  /// approximate past the first cluster; the byte offset stays exact.
  private static func position(of offset: Int, in text: String, cols: Int) -> (row: Int, column: Int) {
    let bytes = Array(text.utf8)
    var row = 0
    var column = 0
    for index in 0..<min(offset, bytes.count) {
      if bytes[index] == UInt8(ascii: "\n") {
        row += 1
        column = 0
      } else {
        column += 1
      }
    }
    return (row, min(column, max(cols - 1, 0)))
  }
}
