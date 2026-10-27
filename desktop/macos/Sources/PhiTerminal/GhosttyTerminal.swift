import CGhosttyVT
import Foundation

/// Counting allocator so a gate can assert the engine's allocation balance.
public final class AllocatorCounters {
  public init() {}
  public var live = 0
  public var allocs = 0
  public var frees = 0
}

private func counters(_ ctx: UnsafeMutableRawPointer?) -> AllocatorCounters? {
  guard let ctx else { return nil }
  return Unmanaged<AllocatorCounters>.fromOpaque(ctx).takeUnretainedValue()
}

private typealias CAllocFn = @convention(c) (UnsafeMutableRawPointer?, Int, UInt8, UInt) -> UnsafeMutableRawPointer?
private typealias CResizeFn = @convention(c) (UnsafeMutableRawPointer?, UnsafeMutableRawPointer?, Int, UInt8, Int, UInt) -> Bool
private typealias CRemapFn = @convention(c) (UnsafeMutableRawPointer?, UnsafeMutableRawPointer?, Int, UInt8, Int, UInt) -> UnsafeMutableRawPointer?
private typealias CFreeFn = @convention(c) (UnsafeMutableRawPointer?, UnsafeMutableRawPointer?, Int, UInt8, UInt) -> Void

private let cAlloc: CAllocFn = { ctx, len, _, _ in
  guard let c = counters(ctx) else { return nil }
  let p = malloc(len == 0 ? 1 : len)
  if p != nil { c.live += len; c.allocs += 1 }
  return p
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
  var bytes: [UInt8] = []
}

private func writePtyTrampoline(_ terminal: GhosttyTerminal?, _ userdata: UnsafeMutableRawPointer?,
                                _ data: UnsafePointer<UInt8>?, _ len: Int) {
  guard let userdata, let data, len > 0 else { return }
  Unmanaged<PtySink>.fromOpaque(userdata).takeUnretainedValue()
    .bytes.append(contentsOf: UnsafeBufferPointer(start: data, count: len))
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
  public let counters = AllocatorCounters()
  public private(set) var cursorPosition: (x: Int, y: Int)?

  private let allocator: UnsafeMutablePointer<GhosttyAllocator>
  private var vtable: GhosttyAllocatorVtable
  private let sink = PtySink()
  private var handle: GhosttyTerminal?
  private var isFreed = false

  /// Fresh terminal.
  public init?(cols: UInt16, rows: UInt16) {
    allocator = .allocate(capacity: 1)
    vtable = GhosttyAllocatorVtable(alloc: cAlloc, resize: cResize, remap: cRemap, free: cFree)
    allocator.initialize(to: GhosttyAllocator(ctx: nil, vtable: nil))
    allocator.pointee.ctx = Unmanaged.passUnretained(counters).toOpaque()
    allocator.pointee.vtable = withUnsafePointer(to: &vtable) { $0 }
    var t: GhosttyTerminal?
    guard ghostty_terminal_new(allocator, &t, cols, rows) == GHOSTTY_SUCCESS, let t else {
      allocator.deinitialize(count: 1); allocator.deallocate()
      return nil
    }
    handle = t
    install(ptySinkOn: t)
  }

  /// Terminal restored from snapshot bytes that already contain a READY prefix.
  public init?(restoring bytes: [UInt8]) {
    allocator = .allocate(capacity: 1)
    vtable = GhosttyAllocatorVtable(alloc: cAlloc, resize: cResize, remap: cRemap, free: cFree)
    allocator.initialize(to: GhosttyAllocator(ctx: nil, vtable: nil))
    allocator.pointee.ctx = Unmanaged.passUnretained(counters).toOpaque()
    allocator.pointee.vtable = withUnsafePointer(to: &vtable) { $0 }

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
      allocator.deinitialize(count: 1); allocator.deallocate()
      return nil
    }
    handle = restored
    install(ptySinkOn: restored)
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

  public func feed(_ bytes: [UInt8]) {
    guard let handle else { return }
    bytes.withUnsafeBufferPointer { buf in
      ghostty_terminal_vt_write(handle, buf.baseAddress, buf.count)
    }
  }

  /// Bytes the engine wrote back to the PTY (query replies). Clears the buffer.
  public func takePtyReplies() -> [UInt8] {
    defer { sink.bytes.removeAll() }
    return sink.bytes
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
        var buf = [UInt8](repeating: 0, count: 64)
        var gb = GhosttyBuffer(ptr: &buf, cap: buf.count, len: 0)
        let r = ghostty_render_state_row_cells_get(
          cells, GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_GRAPHEMES_UTF8, &gb)
        if r != GHOSTTY_SUCCESS { break }

        var fg: (UInt8, UInt8, UInt8)?
        if r == GHOSTTY_SUCCESS && gb.len > 0 {
          var rgb = GhosttyColorRgb(r: 0, g: 0, b: 0)
          if ghostty_render_state_row_cells_get(
            cells, GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_FG_COLOR, &rgb) == GHOSTTY_SUCCESS {
            fg = (rgb.r, rgb.g, rgb.b)
          }
          out.append(TerminalCell(x: x, text: String(decoding: buf[0..<gb.len], as: UTF8.self), foreground: fg))
        }
        x += 1
      }
      return out
    } ?? []
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

  /// Cursor viewport position, or nil when the cursor is off-screen.
  public func readCursor() -> (x: Int, y: Int)? {
    let pos: (x: Int, y: Int)? = withRenderState { rs in
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
    allocator.pointee.vtable = nil
    allocator.deinitialize(count: 1)
    allocator.deallocate()
  }

  deinit { free() }
}
