#!/usr/bin/env python3
"""Add read-only ANSI state and READY-only snapshot exports for Phi attach."""
import pathlib
import sys

root=pathlib.Path(sys.argv[1]).resolve()
local=pathlib.Path(__file__).resolve().parent

def replace_once(path,before,after):
 p=root/path
 text=p.read_text()
 if after in text:return
 if text.count(before)!=1:raise SystemExit(f"expected one upstream patch point: {p}")
 p.write_text(text.replace(before,after))

replace_once(pathlib.Path("src/terminal/c/formatter.zig"),'''pub fn terminal_new(
    alloc_: ?*const CAllocator,
    result: *Formatter,
    terminal_: terminal_c.Terminal,
    opts: TerminalOptions,
) callconv(lib.calling_conv) Result {''','''pub fn terminal_new_screen(
    alloc_: ?*const CAllocator,
    result: *Formatter,
    terminal_: terminal_c.Terminal,
    opts: TerminalOptions,
) callconv(lib.calling_conv) Result {
    const status = terminal_new(alloc_, result, terminal_, opts);
    if (status != .success) return status;
    const terminal = terminal_c.zigTerminal(terminal_) orelse return .invalid_value;
    const screen = terminal.screens.active;
    const top = screen.pages.getTopLeft(.viewport);
    const bottom = screen.pages.getBottomRight(.viewport) orelse top;
    const selection = @import("../Selection.zig").init(top, bottom, false);
    result.*.?.kind.terminal.content = .{ .selection = selection };
    return .success;
}

pub fn terminal_new(
    alloc_: ?*const CAllocator,
    result: *Formatter,
    terminal_: terminal_c.Terminal,
    opts: TerminalOptions,
) callconv(lib.calling_conv) Result {''')
replace_once(pathlib.Path("src/terminal/c/main.zig"),"pub const formatter_terminal_new = formatter.terminal_new;","pub const formatter_terminal_new = formatter.terminal_new;\npub const formatter_terminal_new_screen = formatter.terminal_new_screen;")
(root/"src/terminal/c/phi_format.zig").write_text((local/"phi_format.zig").read_text())
replace_once(pathlib.Path("src/terminal/c/main.zig"),"pub const snapshot_encode_alloc = snapshot.encode_alloc;","pub const snapshot_encode_alloc = snapshot.encode_alloc;\npub const snapshot_encode_ready_alloc = snapshot.encode_ready_alloc;\npub const phi_state_format_alloc = @import(\"phi_format.zig\").state_alloc;")
replace_once(pathlib.Path("src/lib_vt.zig"),'''            @export(&c.formatter_terminal_new, .{ .name = "ghostty_formatter_terminal_new" });''','''            @export(&c.formatter_terminal_new, .{ .name = "ghostty_formatter_terminal_new" });
            @export(&c.formatter_terminal_new_screen, .{ .name = "ghostty_formatter_terminal_screen_new" });''')
replace_once(pathlib.Path("src/lib_vt.zig"),'''            @export(&c.snapshot_encode_alloc, .{ .name = "ghostty_snapshot_encode_alloc" });''','''            @export(&c.snapshot_encode_alloc, .{ .name = "ghostty_snapshot_encode_alloc" });
            @export(&c.snapshot_encode_ready_alloc, .{ .name = "ghostty_snapshot_encode_ready_alloc" });
            @export(&c.phi_state_format_alloc, .{ .name = "ghostty_phi_state_format_alloc" });''')
replace_once(pathlib.Path("src/terminal/snapshot/snapshot.zig"),'''pub const EncodeOptions = struct {
    continuation: Continuation,
};''','''pub const EncodeOptions = struct {
    continuation: Continuation,
    ready_only: bool = false,
};''')
replace_once(pathlib.Path("src/terminal/snapshot/snapshot.zig"),'''    try checkpoint.encode(.ready, &stream);

    // 6. History''','''    try checkpoint.encode(.ready, &stream);
    if (options.ready_only) return;

    // 6. History''')
replace_once(pathlib.Path("src/terminal/c/snapshot.zig"),'''pub fn encode_alloc(
    terminal: terminal_c.Terminal,
    alloc_: ?*const CAllocator,
    out_ptr_: ?*?[*]u8,
    out_len_: ?*usize,
) callconv(lib.calling_conv) Result {''','''pub fn encode_alloc(
    terminal: terminal_c.Terminal,
    alloc_: ?*const CAllocator,
    out_ptr_: ?*?[*]u8,
    out_len_: ?*usize,
) callconv(lib.calling_conv) Result {
    return encodeAlloc(terminal, alloc_, out_ptr_, out_len_, false);
}

pub fn encode_ready_alloc(
    terminal: terminal_c.Terminal,
    alloc_: ?*const CAllocator,
    out_ptr_: ?*?[*]u8,
    out_len_: ?*usize,
) callconv(lib.calling_conv) Result {
    return encodeAlloc(terminal, alloc_, out_ptr_, out_len_, true);
}

fn encodeAlloc(
    terminal: terminal_c.Terminal,
    alloc_: ?*const CAllocator,
    out_ptr_: ?*?[*]u8,
    out_len_: ?*usize,
    ready_only: bool,
) Result {''')
replace_once(pathlib.Path("src/terminal/c/snapshot.zig"),'''        .{ .continuation = continuationValue(continuation.bytes) },
    ) catch |err| return mapEncodeError(err, null);
    const bytes = writer.toOwnedSlice()''','''        .{ .continuation = continuationValue(continuation.bytes), .ready_only = ready_only },
    ) catch |err| return mapEncodeError(err, null);
    const bytes = writer.toOwnedSlice()''')
replace_once(pathlib.Path("include/ghostty/vt/formatter.h"),'''#ifdef __cplusplus
}''','''GHOSTTY_API GhosttyResult ghostty_phi_state_format_alloc(
    GhosttyTerminal terminal, const GhosttyAllocator* allocator,
    uint8_t** out_ptr, size_t* out_len);

#ifdef __cplusplus
}''')
replace_once(pathlib.Path("include/ghostty/vt/snapshot.h"),'''#ifdef __cplusplus
}''','''GHOSTTY_API GhosttyResult ghostty_snapshot_encode_ready_alloc(
    GhosttyTerminal terminal, const GhosttyAllocator* allocator,
    uint8_t** out_ptr, size_t* out_len);

#ifdef __cplusplus
}''')
