// Phi's read-only bounded ANSI export. Do not feed synthetic screen switches
// into the source parser: they clear alternate content and interrupt UTF-8/VT.
const std = @import("std");
const lib = @import("../lib.zig");
const terminal_c = @import("terminal.zig");
const formatter = @import("../formatter.zig");
const CAllocator = lib.alloc.Allocator;
const Result = @import("result.zig").Result;

pub fn state_alloc(
    terminal_: terminal_c.Terminal,
    alloc_: ?*const CAllocator,
    out_ptr_: ?*?[*]u8,
    out_len_: ?*usize,
) callconv(lib.calling_conv) Result {
    const out_ptr = out_ptr_ orelse return .invalid_value;
    const out_len = out_len_ orelse return .invalid_value;
    out_ptr.* = null;
    out_len.* = 0;
    const terminal = terminal_c.zigTerminal(terminal_) orelse return .invalid_value;
    const alloc = lib.alloc.default(alloc_);
    var writer: std.Io.Writer.Allocating = .init(alloc);
    defer writer.deinit();
    writeState(terminal, &writer.writer) catch return .out_of_memory;
    const bytes = writer.toOwnedSlice() catch return .out_of_memory;
    out_ptr.* = bytes.ptr;
    out_len.* = bytes.len;
    return .success;
}

fn writeState(terminal: *const @import("../Terminal.zig"), writer: *std.Io.Writer) !void {
    const opts: formatter.Options = .{ .emit = .vt, .unwrap = false, .trim = true };
    // This shallow copy changes only the mode values used by the formatter.
    // All screen/page pointers remain read-only; no parser or history restore.
    var copy = terminal.*;
    copy.modes.set(.alt_screen_legacy, false);
    copy.modes.set(.alt_screen, false);
    copy.modes.set(.alt_screen_save_cursor_clear_enter, false);
    var extras: formatter.TerminalFormatter = .init(&copy, opts);
    extras.content = .none;
    extras.extra = .all;
    extras.extra.palette = false;
    extras.extra.modes = false;
    extras.extra.scrolling_region = false;
    extras.extra.keyboard = false;
    extras.extra.pwd = false;
    extras.extra.screen = .none;
    // The server does not know the client's theme. Export only PTY palette
    // overrides, never Ghostty's built-in defaults over the user's colours.
    for (terminal.colors.palette.current, 0..) |rgb, i| {
        if (!terminal.colors.palette.mask.isSet(i)) continue;
        try writer.print("\x1b]4;{d};rgb:{x:0>2}/{x:0>2}/{x:0>2}\x1b\\", .{ i, rgb.r, rgb.g, rgb.b });
    }
    inline for (.{ .{ 10, terminal.colors.foreground }, .{ 11, terminal.colors.background }, .{ 12, terminal.colors.cursor } }) |entry| {
        if (entry[1].override) |rgb| try writer.print("\x1b]{d};rgb:{x:0>2}/{x:0>2}/{x:0>2}\x1b\\", .{ entry[0], rgb.r, rgb.g, rgb.b });
    }
    try extras.format(writer);

    // The destination is reset before attach; paint both screens before modes
    // and scrolling margins can change the meaning of the emitted cells.
    try writeScreen(terminal.screens.get(.primary).?, opts, writer);
    if (terminal.screens.get(.alternate)) |alternate| {
        if (terminal.screens.active_key == .alternate) {
            if (terminal.modes.get(.alt_screen_save_cursor_clear_enter)) {
                const primary = terminal.screens.get(.primary).?;
                if (primary.saved_cursor) |saved| try writeSavedCursor(primary, saved, opts, writer);
                try writer.writeAll("\x1b[?1049h");
            } else if (terminal.modes.get(.alt_screen)) {
                try writer.writeAll("\x1b[?1047h");
            } else {
                try writer.writeAll("\x1b[?47h");
            }
        } else {
            try writer.writeAll("\x1b[?47h");
        }
        try writeScreen(alternate, opts, writer);
        if (terminal.screens.active_key == .primary) try writer.writeAll("\x1b[?47l");
    }
    extras.extra = .all;
    extras.extra.palette = false;
    extras.extra.tabstops = false;
    extras.extra.screen = .none;
    // Alternate selection was restored before content. Re-emitting 1049 here
    // would clear that content, so it is suppressed only in the shallow copy.
    try extras.format(writer);
    var active = terminal.screens.active.*;
    if (terminal.modes.get(.origin)) {
        active.cursor.y -|= terminal.scrolling_region.top;
        if (terminal.modes.get(.enable_left_and_right_margin)) active.cursor.x -|= terminal.scrolling_region.left;
    }
    var cursor: formatter.ScreenFormatter = .init(&active, opts);
    cursor.content = .none;
    cursor.extra = .all;
    try cursor.format(writer);
}

fn writeScreen(screen: *const @import("../Screen.zig"), opts: formatter.Options, writer: *std.Io.Writer) !void {
    const top = screen.pages.getTopLeft(.active);
    const bottom = screen.pages.getBottomRight(.active) orelse top;
    var output: formatter.ScreenFormatter = .init(screen, opts);
    output.content = .{ .selection = @import("../Selection.zig").init(top, bottom, false) };
    output.extra = .none;
    try writer.writeAll("\x1b[?6l\x1b[H\x1b[0m\x1b[0\"q");
    try output.format(writer);
    if (screen.saved_cursor) |saved| {
        try writeSavedCursor(screen, saved, opts, writer);
        try writer.writeAll("\x1b[?6l\x1b[0\"q");
    }
    output.content = .none;
    output.extra = .all;
    try output.format(writer);
}

fn writeSavedCursor(screen: *const @import("../Screen.zig"), saved: @import("../Screen.zig").SavedCursor, opts: formatter.Options, writer: *std.Io.Writer) !void {
    // The destination margins are still full-screen, so saved coordinates
    // are physical even when the saved origin mode is enabled.
    var copy = screen.*;
    var pin = screen.pages.pin(.{ .active = .{ .x = saved.x, .y = saved.y } }).?;
    const rac = pin.rowAndCell();
    copy.cursor.x = saved.x;
    copy.cursor.y = saved.y;
    copy.cursor.style = saved.style;
    copy.cursor.protected = saved.protected;
    copy.cursor.pending_wrap = saved.pending_wrap;
    copy.cursor.page_pin = &pin;
    copy.cursor.page_row = rac.row;
    copy.cursor.page_cell = rac.cell;
    copy.charset = saved.charset;
    try writer.writeAll(if (saved.origin) "\x1b[?6h" else "\x1b[?6l");
    var output: formatter.ScreenFormatter = .init(&copy, opts);
    output.content = .none;
    output.extra = .all;
    try output.format(writer);
    try writer.writeAll("\x1b7");
}
