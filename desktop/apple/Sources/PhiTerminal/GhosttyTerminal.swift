import GhosttyVt
import Foundation

/// Counting allocator so a gate can assert the engine's allocation balance.
public final class AllocatorCounters {
  public init() {}
  public var live = 0
  public var allocs = 0
  public var frees = 0
  /// Test seam: allocation fails once this many allocations have succeeded, so
  /// the engine's own cleanup path can be exercised.
  public var failAfterAllocs = Int.max
}

private func counters(_ ctx: UnsafeMutableRawPointer?) -> AllocatorCounters? {
  guard let ctx else { return nil }
  return Unmanaged<AllocatorCounters>.fromOpaque(ctx).takeUnretainedValue()
}

private typealias CAllocFn = @convention(c) (UnsafeMutableRawPointer?, Int, UInt8, UInt) -> UnsafeMutableRawPointer?
private typealias CResizeFn = @convention(c) (UnsafeMutableRawPointer?, UnsafeMutableRawPointer?, Int, UInt8, Int, UInt) -> Bool
private typealias CRemapFn = @convention(c) (UnsafeMutableRawPointer?, UnsafeMutableRawPointer?, Int, UInt8, Int, UInt) -> UnsafeMutableRawPointer?
private typealias CFreeFn = @convention(c) (UnsafeMutableRawPointer?, UnsafeMutableRawPointer?, Int, UInt8, UInt) -> Void

private let cAlloc: CAllocFn = { ctx, len, alignment, _ in
  guard let c = counters(ctx), c.allocs < c.failAfterAllocs else { return nil }
  // The archive passes log2 alignment (allocator.h:108–124), so `malloc`'s
  // 16-byte guarantee is not enough on its own.
  let required = 1 << min(Int(alignment), 20)
  var raw: UnsafeMutableRawPointer?
  guard posix_memalign(&raw, max(required, 16), len == 0 ? 1 : len) == 0, let raw else { return nil }
  c.live += len
  c.allocs += 1
  return raw
}

// false/NULL force alloc+copy+free so every move is visible to the accounting.
private let cResize: CResizeFn = { _, _, _, _, _, _ in false }
private let cRemap: CRemapFn = { _, _, _, _, _, _ in nil }
private let cFree: CFreeFn = { ctx, mem, len, _, _ in
  guard let mem else { return }
  if let c = counters(ctx) { c.live -= len; c.frees += 1 }
  free(mem)
}

private final class PtySink {
  /// Bounded like the Go adapter: a burst above 64 KiB is reported, not grown.
  static let capacity = 64 << 10
  var bytes: [UInt8] = []
  var overflowed = false
  /// Reply policy state (§7.3): inside a replay/boundary span, or waiting for
  /// the parser to reach ground after one ended mid-sequence.
  var suppress = false
  var pendingBoundary = false
}

private func writePtyTrampoline(_ terminal: GhosttyTerminal?, _ userdata: UnsafeMutableRawPointer?,
                                _ data: UnsafePointer<UInt8>?, _ len: Int) {
  guard let userdata, let data, len > 0 else { return }
  let sink = Unmanaged<PtySink>.fromOpaque(userdata).takeUnretainedValue()
  guard !sink.suppress, !sink.pendingBoundary else { return }
  guard sink.bytes.count + len <= PtySink.capacity else {
    sink.overflowed = true
    return
  }
  sink.bytes.append(contentsOf: UnsafeBufferPointer(start: data, count: len))
}

/// Which stream the admitted bytes came from; only live bytes answer queries.
public enum FeedSource: Sendable {
  /// Bytes arriving on the current socket.
  case live
  /// Bytes fetched from the recording: history must not answer a query.
  case replay
  /// History up to a live frontier: also suppresses a query that the span
  /// leaves unfinished, until the parser is back at ground.
  case boundary
}

/// How a cell color was declared, kept apart from its resolved RGB so a
/// comparison can prove indexed/RGB/default parity (§9.2).
public enum TerminalColorKind: String, Codable, Sendable {
  case none = "default"
  case palette
  case rgb
}

public struct TerminalColor: Codable, Equatable, Sendable {
  public var kind: TerminalColorKind
  /// Palette index, or packed 0xRRGGBB when `kind == .rgb`.
  public var value: UInt32

  public init(kind: TerminalColorKind = .none, value: UInt32 = 0) {
    self.kind = kind
    self.value = value
  }
}

public struct TerminalCellFrame: Codable, Equatable, Sendable {
  public var text: String
  /// Adapter width: 2 for a wide leader, 0 for its continuation, else 1.
  public var width: Int
  public var bold: Bool
  public var faint: Bool
  public var italic: Bool
  public var strikethrough: Bool
  public var inverse: Bool
  public var blink: Bool
  public var underline: Int
  public var invisible: Bool
  public var overline: Bool
  public var underlineColor: TerminalColor
  public var fg: TerminalColor
  public var bg: TerminalColor

  public init(
    text: String = "", width: Int = 1, bold: Bool = false, faint: Bool = false,
    italic: Bool = false, strikethrough: Bool = false, inverse: Bool = false,
    blink: Bool = false, underline: Int = 0, invisible: Bool = false,
    overline: Bool = false, underlineColor: TerminalColor = TerminalColor(),
    fg: TerminalColor = TerminalColor(), bg: TerminalColor = TerminalColor()
  ) {
    self.text = text
    self.width = width
    self.bold = bold
    self.faint = faint
    self.italic = italic
    self.strikethrough = strikethrough
    self.inverse = inverse
    self.blink = blink
    self.underline = underline
    self.invisible = invisible
    self.overline = overline
    self.underlineColor = underlineColor
    self.fg = fg
    self.bg = bg
  }
}

/// One complete visible frame: what a renderer draws and what an oracle can
/// compare cell for cell.
public struct TerminalFrame: Codable, Equatable, Sendable {
  public var cols: Int
  public var rows: Int
  public var cursorX: Int
  public var cursorY: Int
  public var pendingWrap: Bool
  public var cursorHidden: Bool
  public var alt: Bool
  public var history: Int
  public var cells: [[TerminalCellFrame]]

  public init(
    cols: Int = 0, rows: Int = 0, cursorX: Int = 0, cursorY: Int = 0,
    pendingWrap: Bool = false, cursorHidden: Bool = false, alt: Bool = false,
    history: Int = 0, cells: [[TerminalCellFrame]] = []
  ) {
    self.cols = cols
    self.rows = rows
    self.cursorX = cursorX
    self.cursorY = cursorY
    self.pendingWrap = pendingWrap
    self.cursorHidden = cursorHidden
    self.alt = alt
    self.history = history
    self.cells = cells
  }

  /// Byte-exact canonical text (§9.2): every visible row/cell in order, U+0020
  /// for an empty narrow cell, nothing extra for a wide continuation, grapheme
  /// bytes unchanged, and a LF after every row including the last.
  public func canonicalText() -> String {
    var out = ""
    out.reserveCapacity((cols + 1) * max(rows, cells.count))
    for row in cells {
      for index in 0..<cols {
        let cell = index < row.count ? row[index] : TerminalCellFrame()
        if cell.width == 0 { continue }
        out += cell.text.isEmpty ? " " : cell.text
      }
      out += "\n"
    }
    return out
  }
}

public struct TerminalCell: Equatable, Sendable {
  public let x: Int
  public let text: String
  public let foreground: (UInt8, UInt8, UInt8)?

  public static func == (lhs: TerminalCell, rhs: TerminalCell) -> Bool {
    lhs.x == rhs.x && lhs.text == rhs.text && lhs.foreground?.0 == rhs.foreground?.0
      && lhs.foreground?.1 == rhs.foreground?.1 && lhs.foreground?.2 == rhs.foreground?.2
  }
}

/// Owns exactly one Ghostty terminal and its allocator for the lifetime of the object.
public final class TerminalSession {
  public let counters: AllocatorCounters
  public private(set) var cursorPosition: (x: Int, y: Int)?

  private let allocator: UnsafeMutablePointer<GhosttyAllocator>
  // Owned so the engine never holds a pointer into Swift-only storage.
  private let vtable: UnsafeMutablePointer<GhosttyAllocatorVtable>
  private let sink = PtySink()
  private var handle: GhosttyTerminal?
  private var isFreed = false

  /// Fresh terminal.
  public convenience init?(cols: UInt16, rows: UInt16) {
    self.init(cols: cols, rows: rows, counters: AllocatorCounters())
  }

  /// Fresh terminal over a caller-supplied counter set (allocation-failure gate).
  public init?(cols: UInt16, rows: UInt16, counters: AllocatorCounters) {
    self.counters = counters
    allocator = .allocate(capacity: 1)
    vtable = .allocate(capacity: 1)
    vtable.initialize(to: GhosttyAllocatorVtable(alloc: cAlloc, resize: cResize, remap: cRemap, free: cFree))
    allocator.initialize(to: GhosttyAllocator(
      ctx: Unmanaged.passUnretained(counters).toOpaque(), vtable: UnsafePointer(vtable)))

    var t: GhosttyTerminal?
    guard ghostty_terminal_new(allocator, &t, cols, rows) == GHOSTTY_SUCCESS, let t else {
      // The object is fully initialized here, so `return nil` runs deinit.
      free()
      return nil
    }
    handle = t
    install(ptySinkOn: t)
  }

  /// Terminal restored from snapshot bytes that already contain a READY prefix.
  public convenience init?(restoring bytes: [UInt8]) {
    self.init(restoring: bytes, counters: AllocatorCounters())
  }

  public init?(restoring bytes: [UInt8], counters: AllocatorCounters) {
    self.counters = counters
    allocator = .allocate(capacity: 1)
    vtable = .allocate(capacity: 1)
    vtable.initialize(to: GhosttyAllocatorVtable(alloc: cAlloc, resize: cResize, remap: cRemap, free: cFree))
    allocator.initialize(to: GhosttyAllocator(
      ctx: Unmanaged.passUnretained(counters).toOpaque(), vtable: UnsafePointer(vtable)))

    var decoder: GhosttySnapshotDecoder?
    var restored: GhosttyTerminal?
    let created = bytes.withUnsafeBufferPointer { buf -> Bool in
      guard let base = buf.baseAddress,
            ghostty_snapshot_decoder_new_buf(allocator, &decoder, base, buf.count) == GHOSTTY_SUCCESS,
            let decoder else { return false }
      defer { ghostty_snapshot_decoder_free(decoder) }
      // Bound and retain the parser continuation so a split sequence survives
      // the restore instead of being silently completed (§7.2).
      var maxContinuation = 2 << 20
      var retain = true
      _ = ghostty_snapshot_decoder_set(
        decoder, GHOSTTY_SNAPSHOT_DECODER_OPT_MAX_CONTINUATION_BYTES, &maxContinuation)
      _ = ghostty_snapshot_decoder_set(
        decoder, GHOSTTY_SNAPSHOT_DECODER_OPT_RETAIN_CONTINUATION, &retain)
      return ghostty_snapshot_decoder_ready(decoder, &restored) == GHOSTTY_SUCCESS
    }
    guard created, let restored else {
      free()
      return nil
    }
    handle = restored
    install(ptySinkOn: restored)
    // A snapshot can end inside a sequence; its completion is history and must
    // not answer as if it were live (§7.2).
    sink.pendingBoundary = !atGround(restored)
  }

  /// Grapheme text for the selected cell; a cluster longer than the first
  /// buffer grows once instead of hiding the cell and the rest of its row.
  private func graphemeText(_ cells: GhosttyRenderStateRowCells) -> String? {
    var size = 64
    for _ in 0..<2 {
      var needed = 0
      var result = GHOSTTY_INVALID_VALUE
      var text: String?
      var buf = [UInt8](repeating: 0, count: size)
      buf.withUnsafeMutableBufferPointer { raw in
        guard let base = raw.baseAddress else { return }
        var gb = GhosttyBuffer(ptr: base, cap: raw.count, len: 0)
        result = ghostty_render_state_row_cells_get(
          cells, GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_GRAPHEMES_UTF8, &gb)
        needed = gb.len
        if result == GHOSTTY_SUCCESS, gb.len > 0 {
          let bytes = UnsafeRawBufferPointer(start: base, count: gb.len)
          text = String(decoding: bytes, as: UTF8.self)
        }
      }
      if result == GHOSTTY_SUCCESS { return text }
      guard result == GHOSTTY_OUT_OF_SPACE, needed > size, needed <= 4096 else { return nil }
      size = needed
    }
    return nil
  }

  private func install(ptySinkOn t: GhosttyTerminal) {
    _ = ghostty_terminal_set(t, GHOSTTY_TERMINAL_OPT_USERDATA, Unmanaged.passUnretained(sink).toOpaque())
    let fn = unsafeBitCast(writePtyTrampoline as GhosttyTerminalWritePtyFn, to: UnsafeRawPointer.self)
    _ = ghostty_terminal_set(t, GHOSTTY_TERMINAL_OPT_WRITE_PTY, fn)
  }

  public func resize(cols: UInt16, rows: UInt16) {
    guard let handle else { return }
    _ = ghostty_terminal_resize(handle, cols, rows, 0, 0)
  }

  /// Writes bytes under an explicit reply policy. Live bytes answer queries;
  /// replay and boundary spans do not, and a boundary span leaves a partially
  /// read query suppressed until the parser reaches ground
  /// (`internal/termemu/ghostty_native.go:176–207`).
  public func feed(_ bytes: [UInt8], source: FeedSource = .live) {
    guard let handle, !bytes.isEmpty else { return }
    bytes.withUnsafeBufferPointer { buf in
      guard let base = buf.baseAddress else { return }
      var index = 0
      if source == .live, sink.pendingBoundary {
        while index < buf.count, sink.pendingBoundary {
          ghostty_terminal_vt_write(handle, base + index, 1)
          index += 1
          if atGround(handle) { sink.pendingBoundary = false }
        }
      }
      if source != .live {
        sink.suppress = true
        if source == .boundary { sink.pendingBoundary = true }
      }
      if index < buf.count {
        ghostty_terminal_vt_write(handle, base + index, buf.count - index)
      }
      if source != .live { sink.suppress = false }
      if sink.pendingBoundary, atGround(handle) { sink.pendingBoundary = false }
    }
  }

  /// Bytes the engine wrote back to the PTY (query replies). Clears the buffer.
  public func takePtyReplies() -> [UInt8] {
    defer { sink.bytes.removeAll() }
    return sink.bytes
  }

  /// True once a reply burst exceeded the 64 KiB cap and bytes were dropped.
  public var replyOverflowed: Bool { sink.overflowed }

  /// True while a historical span has left a query unfinished: everything up
  /// to the next ground byte is suppressed.
  public var awaitingBoundary: Bool { sink.pendingBoundary }

  private func atGround(_ handle: GhosttyTerminal) -> Bool {
    var ground = false
    guard ghostty_terminal_get(handle, GHOSTTY_TERMINAL_DATA_VT_GROUND, &ground)
      == GHOSTTY_SUCCESS else { return false }
    return ground
  }

  private func withRenderState<T>(_ body: (GhosttyRenderState) -> T?) -> T? {
    guard let handle else { return nil }
    var rs: GhosttyRenderState?
    guard ghostty_render_state_new(allocator, &rs) == GHOSTTY_SUCCESS, let rs else { return nil }
    defer { ghostty_render_state_free(rs) }
    guard ghostty_render_state_update(rs, handle) == GHOSTTY_SUCCESS else { return nil }
    return body(rs)
  }

  public func rowCount() -> Int {
    withRenderState { rs in
      var rows: UInt16 = 0
      guard ghostty_render_state_get(rs, GHOSTTY_RENDER_STATE_DATA_ROWS, &rows) == GHOSTTY_SUCCESS else { return nil }
      return Int(rows)
    } ?? 0
  }

  public func columnCount() -> Int {
    withRenderState { rs in
      var cols: UInt16 = 0
      guard ghostty_render_state_get(rs, GHOSTTY_RENDER_STATE_DATA_COLS, &cols) == GHOSTTY_SUCCESS else { return nil }
      return Int(cols)
    } ?? 0
  }

  /// Cells that carry text in `row`, in column order.
  public func cells(inRow row: Int) -> [TerminalCell] {
    withRenderState { rs in
      var it: GhosttyRenderStateRowIterator?
      guard ghostty_render_state_row_iterator_new(allocator, &it) == GHOSTTY_SUCCESS,
            ghostty_render_state_get(rs, GHOSTTY_RENDER_STATE_DATA_ROW_ITERATOR, &it) == GHOSTTY_SUCCESS,
            let it else { return nil }
      defer { ghostty_render_state_row_iterator_free(it) }

      for _ in 0...row where !ghostty_render_state_row_iterator_next(it) { return nil }

      var cells: GhosttyRenderStateRowCells?
      guard ghostty_render_state_row_cells_new(allocator, &cells) == GHOSTTY_SUCCESS,
            ghostty_render_state_row_get(it, GHOSTTY_RENDER_STATE_ROW_DATA_CELLS, &cells) == GHOSTTY_SUCCESS,
            let cells else { return nil }
      defer { ghostty_render_state_row_cells_free(cells) }

      var out: [TerminalCell] = []
      var x = 0
      while ghostty_render_state_row_cells_select(cells, UInt16(x)) == GHOSTTY_SUCCESS {
        if let text = graphemeText(cells) {
          var fg: (UInt8, UInt8, UInt8)?
          var rgb = GhosttyColorRgb(r: 0, g: 0, b: 0)
          if ghostty_render_state_row_cells_get(
            cells, GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_FG_COLOR, &rgb) == GHOSTTY_SUCCESS {
            fg = (rgb.r, rgb.g, rgb.b)
          }
          out.append(TerminalCell(x: x, text: text, foreground: fg))
        }
        x += 1
      }
      return out
    } ?? []
  }

  private func terminalColor(_ color: GhosttyStyleColor) -> TerminalColor {
    if color.tag == GHOSTTY_STYLE_COLOR_PALETTE {
      return TerminalColor(kind: .palette, value: UInt32(color.value.palette))
    }
    if color.tag == GHOSTTY_STYLE_COLOR_RGB {
      let rgb = color.value.rgb
      return TerminalColor(
        kind: .rgb, value: UInt32(rgb.r) << 16 | UInt32(rgb.g) << 8 | UInt32(rgb.b))
    }
    return TerminalColor()
  }

  /// Every visible cell with its declared style, plus cursor and screen facts.
  /// Mirrors the Go adapter's snapshot so an oracle can compare cell for cell.
  public func readFrame() -> TerminalFrame? {
    guard let handle else { return nil }
    var cols: UInt16 = 0
    var rows: UInt16 = 0
    guard ghostty_terminal_get(handle, GHOSTTY_TERMINAL_DATA_COLS, &cols) == GHOSTTY_SUCCESS,
          ghostty_terminal_get(handle, GHOSTTY_TERMINAL_DATA_ROWS, &rows) == GHOSTTY_SUCCESS,
          cols > 0, rows > 0 else { return nil }
    var cursorX: UInt16 = 0
    var cursorY: UInt16 = 0
    var pendingWrap = false
    var visible = true
    var screen = GHOSTTY_TERMINAL_SCREEN_PRIMARY
    var history = 0
    _ = ghostty_terminal_get(handle, GHOSTTY_TERMINAL_DATA_CURSOR_X, &cursorX)
    _ = ghostty_terminal_get(handle, GHOSTTY_TERMINAL_DATA_CURSOR_Y, &cursorY)
    _ = ghostty_terminal_get(handle, GHOSTTY_TERMINAL_DATA_CURSOR_PENDING_WRAP, &pendingWrap)
    _ = ghostty_terminal_get(handle, GHOSTTY_TERMINAL_DATA_CURSOR_VISIBLE, &visible)
    _ = ghostty_terminal_get(handle, GHOSTTY_TERMINAL_DATA_ACTIVE_SCREEN, &screen)
    _ = ghostty_terminal_get(handle, GHOSTTY_TERMINAL_DATA_SCROLLBACK_ROWS, &history)

    return withRenderState { rs -> TerminalFrame? in
      var it: GhosttyRenderStateRowIterator?
      guard ghostty_render_state_row_iterator_new(allocator, &it) == GHOSTTY_SUCCESS,
            ghostty_render_state_get(rs, GHOSTTY_RENDER_STATE_DATA_ROW_ITERATOR, &it) == GHOSTTY_SUCCESS,
            let it else { return nil }
      defer { ghostty_render_state_row_iterator_free(it) }
      var cellsHandle: GhosttyRenderStateRowCells?
      guard ghostty_render_state_row_cells_new(allocator, &cellsHandle) == GHOSTTY_SUCCESS,
            let cells = cellsHandle else { return nil }
      defer { ghostty_render_state_row_cells_free(cells) }

      var all: [[TerminalCellFrame]] = []
      all.reserveCapacity(Int(rows))
      while ghostty_render_state_row_iterator_next(it) {
        guard ghostty_render_state_row_get(it, GHOSTTY_RENDER_STATE_ROW_DATA_CELLS, &cellsHandle)
          == GHOSTTY_SUCCESS, let cells = cellsHandle else { return nil }
        var row: [TerminalCellFrame] = []
        row.reserveCapacity(Int(cols))
        while ghostty_render_state_row_cells_next(cells) {
          var cell = TerminalCellFrame(text: graphemeText(cells) ?? "")
          var raw: GhosttyCell = 0
          var wide = GHOSTTY_CELL_WIDE_NARROW
          if ghostty_render_state_row_cells_get(
            cells, GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_RAW, &raw) == GHOSTTY_SUCCESS,
             raw != 0,
             ghostty_cell_get(raw, GHOSTTY_CELL_DATA_WIDE, &wide) == GHOSTTY_SUCCESS {
            if wide == GHOSTTY_CELL_WIDE_WIDE {
              cell.width = 2
            } else if wide == GHOSTTY_CELL_WIDE_SPACER_TAIL {
              cell.width = 0
            }
          }
          var style = GhosttyStyle()
          style.size = MemoryLayout<GhosttyStyle>.size
          if ghostty_render_state_row_cells_get(
            cells, GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_STYLE, &style) == GHOSTTY_SUCCESS {
            cell.bold = style.bold
            cell.faint = style.faint
            cell.italic = style.italic
            cell.strikethrough = style.strikethrough
            cell.inverse = style.inverse
            cell.blink = style.blink
            cell.underline = Int(style.underline)
            cell.invisible = style.invisible
            cell.overline = style.overline
            cell.underlineColor = terminalColor(style.underline_color)
            cell.fg = terminalColor(style.fg_color)
            cell.bg = terminalColor(style.bg_color)
          }
          row.append(cell)
        }
        all.append(row)
      }
      return TerminalFrame(
        cols: Int(cols), rows: Int(rows), cursorX: Int(cursorX), cursorY: Int(cursorY),
        pendingWrap: pendingWrap, cursorHidden: !visible,
        alt: screen == GHOSTTY_TERMINAL_SCREEN_ALTERNATE, history: history, cells: all)
    } ?? nil
  }

  public func paletteEntry(_ index: Int) -> (UInt8, UInt8, UInt8)? {
    withRenderState { rs in
      var colors = GhosttyRenderStateColors()
      colors.size = MemoryLayout<GhosttyRenderStateColors>.size
      guard ghostty_render_state_get(rs, GHOSTTY_RENDER_STATE_DATA_COLORS, &colors) == GHOSTTY_SUCCESS else { return nil }
      return withUnsafeBytes(of: colors.palette) { raw in
        let entry = raw.baseAddress!
          .advanced(by: index * MemoryLayout<GhosttyColorRgb>.size)
          .assumingMemoryBound(to: GhosttyColorRgb.self).pointee
        return (entry.r, entry.g, entry.b)
      }
    } ?? nil
  }

  /// Cursor viewport position, or nil when it is off-screen or the terminal
  /// is hiding it.
  public func readCursor() -> (x: Int, y: Int)? {
    let pos: (x: Int, y: Int)? = withRenderState { rs in
      var visible = true
      if ghostty_render_state_get(rs, GHOSTTY_RENDER_STATE_DATA_CURSOR_VISIBLE, &visible) == GHOSTTY_SUCCESS,
         !visible { return nil }
      var hasValue = false
      guard ghostty_render_state_get(rs, GHOSTTY_RENDER_STATE_DATA_CURSOR_VIEWPORT_HAS_VALUE, &hasValue) == GHOSTTY_SUCCESS,
            hasValue else { return nil }
      var x: UInt16 = 0
      var y: UInt16 = 0
      guard ghostty_render_state_get(rs, GHOSTTY_RENDER_STATE_DATA_CURSOR_VIEWPORT_X, &x) == GHOSTTY_SUCCESS,
            ghostty_render_state_get(rs, GHOSTTY_RENDER_STATE_DATA_CURSOR_VIEWPORT_Y, &y) == GHOSTTY_SUCCESS else { return nil }
      return (Int(x), Int(y))
    } ?? nil
    cursorPosition = pos
    return pos
  }

  /// Encoded snapshot bytes, copied out of engine-owned memory.
  public func snapshotBytes() -> [UInt8]? {
    guard let handle else { return nil }
    var ptr: UnsafeMutablePointer<UInt8>?
    var len = 0
    guard ghostty_snapshot_encode_alloc(handle, allocator, &ptr, &len) == GHOSTTY_SUCCESS,
          let ptr, len > 0 else { return nil }
    defer { ghostty_free(allocator, ptr, len) }
    return Array(UnsafeBufferPointer(start: ptr, count: len))
  }

  /// Proves the key and mouse encoders can be created from this terminal and freed.
  public func exerciseEncoders() -> Bool {
    guard let handle else { return false }
    var key: GhosttyKeyEncoder?
    guard ghostty_key_encoder_new(allocator, &key) == GHOSTTY_SUCCESS, let key else { return false }
    ghostty_key_encoder_setopt_from_terminal(key, handle)
    ghostty_key_encoder_free(key)

    var mouse: GhosttyMouseEncoder?
    guard ghostty_mouse_encoder_new(allocator, &mouse) == GHOSTTY_SUCCESS, let mouse else { return false }
    ghostty_mouse_encoder_setopt_from_terminal(mouse, handle)
    ghostty_mouse_encoder_free(mouse)
    return true
  }

  public func free() {
    guard !isFreed else { return }
    isFreed = true
    if let handle { ghostty_terminal_free(handle) }
    handle = nil
    allocator.deinitialize(count: 1)
    allocator.deallocate()
    vtable.deinitialize(count: 1)
    vtable.deallocate()
  }

  deinit { free() }
}
