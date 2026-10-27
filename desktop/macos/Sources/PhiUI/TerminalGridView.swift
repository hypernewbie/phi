import AppKit
import CoreText
import PhiTerminal

/// One pane's terminal grid. Draws a copied `PaneWireClient.Frame` with Core
/// Text and encodes key events; it never touches the wire client.
public final class TerminalGridView: NSView {
  /// Single font constant so M2 can swap JetBrains Mono in before first chunk.
  public static let terminalFontName = "Menlo"
  static let terminalFontSize: CGFloat = 12
  public static let statusHeight: CGFloat = 22

  private let font: CTFont
  private let cellWidth: CGFloat
  private let cellHeight: CGFloat
  private let baseline: CGFloat

  private var paneFrame = PaneWireClient.Frame(cols: 0, rows: [], colored: [])
  private var coloredByRow: [Int: [PaneWireClient.ColoredCell]] = [:]
  private var cursor: (x: Int, y: Int)?
  private var statusText = "connecting…"
  public private(set) var gridCols = 80
  public private(set) var gridRows = 24

  public var onGridSizeChange: ((Int, Int) -> Void)?
  public var onInput: (([UInt8]) -> Void)?

  public var cellSize: NSSize { NSSize(width: cellWidth, height: cellHeight) }

  public override init(frame frameRect: NSRect) {
    let created = CTFontCreateWithName(Self.terminalFontName as CFString, Self.terminalFontSize, nil)
    font = created
    var glyph = CTFontGetGlyphWithName(created, "M" as CFString)
    var advance = CGSize.zero
    CTFontGetAdvancesForGlyphs(created, .horizontal, &glyph, &advance, 1)
    // Fractional, not rounded up: a drawn row advances by exactly this width,
    // so glyphs and styled cells land on the same columns.
    cellWidth = max(1, advance.width)
    let descent = ceil(CTFontGetDescent(created))
    cellHeight = ceil(CTFontGetAscent(created) + descent)
    baseline = descent
    super.init(frame: frameRect)
  }

  @available(*, unavailable)
  public required init?(coder: NSCoder) { fatalError("no nib") }

  public override var acceptsFirstResponder: Bool { true }
  public override var isOpaque: Bool { true }

  /// Called by the poll loop with the actor's copied frame; equal frames skip
  /// the redraw so a quiet pane costs nothing.
  public func apply(paneFrame next: PaneWireClient.Frame, cursor: (x: Int, y: Int)?, status: String) {
    let frameChanged = next != paneFrame
    if frameChanged {
      paneFrame = next
      coloredByRow = Dictionary(grouping: next.colored, by: \.row)
    }
    let changed = frameChanged || cursor?.x != self.cursor?.x || cursor?.y != self.cursor?.y
      || status != statusText
    self.cursor = cursor
    statusText = status
    if changed { needsDisplay = true }
  }

  public override func setFrameSize(_ newSize: NSSize) {
    super.setFrameSize(newSize)
    updateGridSize()
  }

  public func updateGridSize() {
    // Half-point tolerance keeps AppKit's integral frame rounding from
    // dropping a column.
    let cols = max(1, Int((bounds.width + 0.5) / cellWidth))
    let rows = max(1, Int((bounds.height - Self.statusHeight + 0.5) / cellHeight))
    guard cols != gridCols || rows != gridRows else { return }
    gridCols = cols
    gridRows = rows
    needsDisplay = true
    onGridSizeChange?(cols, rows)
  }

  public override func draw(_ dirtyRect: NSRect) {
    guard let ctx = NSGraphicsContext.current?.cgContext else { return }
    NSColor.textBackgroundColor.setFill()
    bounds.fill()

    let textColor = NSColor.textColor
    let background = NSColor.textBackgroundColor
    for (row, text) in paneFrame.rows.enumerated() where row < gridRows {
      draw(text, at: cellOrigin(row: row, column: 0), colour: textColor, in: ctx)
      // Overdraw styled cells in their real foreground colour.
      for cell in coloredByRow[row] ?? [] where cell.column < gridCols {
        let rect = cellRect(row: row, column: cell.column)
        background.setFill()
        rect.fill()
        draw(cell.text, at: rect.origin, colour: NSColor(
          srgbRed: CGFloat(cell.red) / 255, green: CGFloat(cell.green) / 255,
          blue: CGFloat(cell.blue) / 255, alpha: 1), in: ctx)
      }
    }

    if let cursor, cursor.y < gridRows, cursor.x < gridCols {
      let rect = cellRect(row: cursor.y, column: cursor.x)
      textColor.setFill()
      rect.fill()
      if let glyph = character(row: cursor.y, column: cursor.x) {
        draw(glyph, at: rect.origin, colour: background, in: ctx)
      }
    }

    let attributes: [NSAttributedString.Key: Any] = [
      .font: NSFont.systemFont(ofSize: NSFont.smallSystemFontSize),
      .foregroundColor: NSColor.secondaryLabelColor,
    ]
    NSAttributedString(string: statusText, attributes: attributes)
      .draw(at: NSPoint(x: 8, y: 4))
  }

  public override func keyDown(with event: NSEvent) {
    guard let bytes = Self.encode(event) else {
      super.keyDown(with: event)
      return
    }
    onInput?(bytes)
  }

  /// Bytes a PTY expects, or nil for anything unproven so the key falls through
  /// instead of sending a wrong sequence.
  static func encode(_ event: NSEvent) -> [UInt8]? {
    let flags = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
    if flags.contains(.command) { return nil }
    // Shift-Tab shares Ctrl-Y's byte; the CSI Z form is not encoded yet.
    if flags.contains(.shift), event.keyCode == 48 { return nil }
    guard let characters = event.characters, !characters.isEmpty else { return nil }
    // Keypad Enter reports ETX, which would read as Ctrl-C.
    if event.keyCode == 76 { return Array("\r".utf8) }
    var bytes: [UInt8] = []
    for scalar in characters.unicodeScalars {
      switch scalar.value {
      case 0xF700...0xF8FF:
        guard let arrow = arrows[scalar.value] else { return nil }
        bytes += arrow
      case 0x01...0x1F:
        bytes.append(UInt8(scalar.value))
      case 0x7F:
        bytes.append(0x7F)
      default:
        guard scalar.value >= 0x20 else { return nil }
        bytes += Array(String(scalar).utf8)
      }
    }
    return bytes.isEmpty ? nil : bytes
  }

  private static let arrows: [UInt32: [UInt8]] = [
    0xF700: Array("\u{1b}[A".utf8),
    0xF701: Array("\u{1b}[B".utf8),
    0xF702: Array("\u{1b}[D".utf8),
    0xF703: Array("\u{1b}[C".utf8),
  ]

  private func cellRect(row: Int, column: Int) -> CGRect {
    let top = bounds.height - CGFloat(row + 1) * cellHeight
    return CGRect(
      x: CGFloat(column) * cellWidth, y: top, width: cellWidth, height: cellHeight)
  }

  private func cellOrigin(row: Int, column: Int) -> CGPoint {
    let rect = cellRect(row: row, column: column)
    return CGPoint(x: rect.minX, y: rect.minY + baseline)
  }

  private func character(row: Int, column: Int) -> String? {
    guard row < paneFrame.rows.count else { return nil }
    let cells = Array(paneFrame.rows[row])
    return column < cells.count ? String(cells[column]) : nil
  }

  /// Core Text paints with the string's own foreground attribute; without it
  /// the glyphs ignore the colour the row asks for.
  private func draw(_ text: String, at origin: CGPoint, colour: NSColor, in ctx: CGContext) {
    guard !text.isEmpty,
          let attributed = CFAttributedStringCreate(
            nil, text as CFString,
            [kCTFontAttributeName: font, kCTForegroundColorAttributeName: colour.cgColor] as CFDictionary)
    else { return }
    let line = CTLineCreateWithAttributedString(attributed)
    ctx.textPosition = origin
    CTLineDraw(line, ctx)
  }
}
