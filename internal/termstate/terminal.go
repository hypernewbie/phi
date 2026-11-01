//go:build cgo && (((darwin || linux) && (amd64 || arm64)) || (windows && amd64))

// Package termstate keeps the server's bounded live terminal state. The
// append-only recording, not this presentation state, owns all source bytes.
package termstate

/*
#cgo darwin CFLAGS: -DGHOSTTY_STATIC -I${SRCDIR}/../../native/libghostty-vt/include
#cgo darwin,arm64 LDFLAGS: ${SRCDIR}/../../native/libghostty-vt/darwin-arm64/libghostty-vt.a -lm -lpthread
#cgo darwin,amd64 LDFLAGS: ${SRCDIR}/../../native/libghostty-vt/darwin-amd64/libghostty-vt.a -lm -lpthread
#cgo linux CFLAGS: -DGHOSTTY_STATIC -I${SRCDIR}/../../native/libghostty-vt/include
#cgo linux,amd64 LDFLAGS: ${SRCDIR}/../../native/libghostty-vt/linux-amd64/libghostty-vt.a -lm -lpthread -ldl
#cgo linux,arm64 LDFLAGS: ${SRCDIR}/../../native/libghostty-vt/linux-arm64/libghostty-vt.a -lm -lpthread -ldl
#cgo windows CFLAGS: -DGHOSTTY_STATIC -I${SRCDIR}/../../native/libghostty-vt/include
#cgo windows,amd64 LDFLAGS: ${SRCDIR}/../../native/libghostty-vt/windows-amd64/libghostty-vt.a
#include <ghostty/vt.h>
#include <stdint.h>
#include <stdlib.h>
*/
import "C"

import (
	"context"
	"encoding/binary"
	"fmt"
	"unsafe"
)

// Same libghostty-vt pin as the native client, linked as a static archive.
// Direct CGO calls, no subprocesses or client-side transcript replay.
type Terminal struct {
	ctx        context.Context
	handle     C.GhosttyTerminal
	cols, rows int
}

func statusErr(name string, rc C.GhosttyResult) error {
	return fmt.Errorf("%s: engine status %d", name, int32(rc))
}

func (t *Terminal) setSize(option C.GhosttyTerminalOption, value uint64) error {
	if t.handle == nil {
		return fmt.Errorf("terminal state is closed")
	}
	v := C.size_t(value)
	if rc := C.ghostty_terminal_set(t.handle, option, unsafe.Pointer(&v)); rc != C.GHOSTTY_SUCCESS {
		return statusErr("ghostty_terminal_set", rc)
	}
	return nil
}

func New(ctx context.Context, cols, rows int) (*Terminal, error) {
	if cols < 1 || rows < 1 || cols > 65535 || rows > 65535 {
		return nil, fmt.Errorf("invalid terminal geometry")
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	var handle C.GhosttyTerminal
	if rc := C.ghostty_terminal_new(nil, &handle, C.uint16_t(cols), C.uint16_t(rows)); rc != C.GHOSTTY_SUCCESS {
		return nil, statusErr("ghostty_terminal_new", rc)
	}
	t := &Terminal{ctx: ctx, handle: handle, cols: cols, rows: rows}
	for _, setting := range []struct {
		option C.GhosttyTerminalOption
		value  uint64
	}{
		{C.GHOSTTY_TERMINAL_OPT_SCROLLBACK_MAX_BYTES, 64 << 20},
		{C.GHOSTTY_TERMINAL_OPT_SCROLLBACK_MAX_LINES, 10000},
		{C.GHOSTTY_TERMINAL_OPT_CONTINUATION_MAX_BYTES, 65 << 20},
	} {
		if err := t.setSize(setting.option, setting.value); err != nil {
			t.Close()
			return nil, err
		}
	}
	if err := ctx.Err(); err != nil {
		t.Close()
		return nil, err
	}
	return t, nil
}

func (t *Terminal) processingError() error {
	var failed C.bool
	if rc := C.ghostty_terminal_get(t.handle, C.GHOSTTY_TERMINAL_DATA_VT_PROCESSING_ERROR, unsafe.Pointer(&failed)); rc != C.GHOSTTY_SUCCESS {
		return statusErr("ghostty_terminal_get", rc)
	}
	if bool(failed) {
		return fmt.Errorf("terminal VT processing error")
	}
	return nil
}

func (t *Terminal) Feed(data []byte) error {
	if t.handle == nil {
		return fmt.Errorf("terminal state is closed")
	}
	for len(data) > 0 {
		if err := t.ctx.Err(); err != nil {
			return err
		}
		n := min(len(data), 64<<10)
		chunk := data[:n]
		C.ghostty_terminal_vt_write(t.handle, (*C.uint8_t)(unsafe.Pointer(&chunk[0])), C.size_t(n))
		if err := t.processingError(); err != nil {
			return err
		}
		data = data[n:]
	}
	return t.ctx.Err()
}

func (t *Terminal) Resize(cols, rows int) error {
	if cols < 1 || rows < 1 || cols > 65535 || rows > 65535 {
		return fmt.Errorf("invalid terminal geometry")
	}
	if t.handle == nil {
		return fmt.Errorf("terminal state is closed")
	}
	if err := t.ctx.Err(); err != nil {
		return err
	}
	if rc := C.ghostty_terminal_resize(t.handle, C.uint16_t(cols), C.uint16_t(rows), 1, 1); rc != C.GHOSTTY_SUCCESS {
		return statusErr("ghostty_terminal_resize", rc)
	}
	t.cols, t.rows = cols, rows
	return t.ctx.Err()
}

func (t *Terminal) Geometry() (int, int) { return t.cols, t.rows }

func (t *Terminal) takeBytes(ptr *C.uint8_t, n C.size_t) ([]byte, error) {
	defer C.ghostty_free(nil, ptr, n)
	if err := t.ctx.Err(); err != nil {
		return nil, err
	}
	if n > 1<<31-1 {
		return nil, fmt.Errorf("engine output exceeds GoBytes limit")
	}
	return C.GoBytes(unsafe.Pointer(ptr), C.int(n)), nil
}

func (t *Terminal) Continuation() ([]byte, error) {
	if t.handle == nil {
		return nil, fmt.Errorf("terminal state is closed")
	}
	var ptr *C.uint8_t
	var n C.size_t
	if err := t.ctx.Err(); err != nil {
		return nil, err
	}
	if rc := C.ghostty_terminal_continuation_alloc(t.handle, nil, &ptr, &n); rc != C.GHOSTTY_SUCCESS {
		return nil, statusErr("ghostty_terminal_continuation_alloc", rc)
	}
	return t.takeBytes(ptr, n)
}

func (t *Terminal) LimitScrollbackLines(lines uint32) error {
	if err := t.ctx.Err(); err != nil {
		return err
	}
	return t.setSize(C.GHOSTTY_TERMINAL_OPT_SCROLLBACK_MAX_LINES, uint64(lines))
}

func (t *Terminal) IsAlternate() (bool, error) {
	if t.handle == nil {
		return false, fmt.Errorf("terminal state is closed")
	}
	if err := t.ctx.Err(); err != nil {
		return false, err
	}
	var screen C.GhosttyTerminalScreen
	if rc := C.ghostty_terminal_get(t.handle, C.GHOSTTY_TERMINAL_DATA_ACTIVE_SCREEN, unsafe.Pointer(&screen)); rc != C.GHOSTTY_SUCCESS {
		return false, statusErr("ghostty_terminal_get", rc)
	}
	return screen == C.GHOSTTY_TERMINAL_SCREEN_ALTERNATE, nil
}

// FormatVTState reads both screens without mutating the parser, active screen
// or live history. Synthetic screen-switch bytes exist only in its output.
func (t *Terminal) FormatVTState() ([]byte, error) {
	if t.handle == nil {
		return nil, fmt.Errorf("terminal state is closed")
	}
	var ptr *C.uint8_t
	var n C.size_t
	if err := t.ctx.Err(); err != nil {
		return nil, err
	}
	if rc := C.ghostty_phi_state_format_alloc(t.handle, nil, &ptr, &n); rc != C.GHOSTTY_SUCCESS {
		return nil, statusErr("ghostty_phi_state_format_alloc", rc)
	}
	return t.takeBytes(ptr, n)
}

func (t *Terminal) FormatViewportVT() ([]byte, error) {
	snapshot, err := t.Ready()
	if err != nil {
		return nil, err
	}
	cols, rows := t.Geometry()
	scratch, err := New(t.ctx, cols, rows)
	if err != nil {
		return nil, err
	}
	defer scratch.Close()
	if err = scratch.Restore(snapshot); err != nil {
		return nil, err
	}
	if err = scratch.LimitScrollbackLines(0); err != nil {
		return nil, err
	}
	return scratch.FormatVT()
}

func (t *Terminal) FormatVT() ([]byte, error) {
	if t.handle == nil {
		return nil, fmt.Errorf("terminal state is closed")
	}
	if err := t.ctx.Err(); err != nil {
		return nil, err
	}
	var opts C.GhosttyFormatterTerminalOptions
	opts.size = C.size_t(C.sizeof_GhosttyFormatterTerminalOptions)
	opts.emit = C.GHOSTTY_FORMATTER_FORMAT_VT
	opts.extra.size = C.size_t(C.sizeof_GhosttyFormatterTerminalExtra)
	opts.extra.palette = C.bool(true)
	opts.extra.modes = C.bool(true)
	opts.extra.scrolling_region = C.bool(true)
	opts.extra.tabstops = C.bool(true)
	opts.extra.pwd = C.bool(true)
	opts.extra.keyboard = C.bool(true)
	opts.extra.screen.size = C.size_t(C.sizeof_GhosttyFormatterScreenExtra)
	opts.extra.screen.cursor = C.bool(true)
	opts.extra.screen.style = C.bool(true)
	opts.extra.screen.hyperlink = C.bool(true)
	opts.extra.screen.protection = C.bool(true)
	opts.extra.screen.kitty_keyboard = C.bool(true)
	opts.extra.screen.charsets = C.bool(true)
	var formatter C.GhosttyFormatter
	if rc := C.ghostty_formatter_terminal_screen_new(nil, &formatter, t.handle, opts); rc != C.GHOSTTY_SUCCESS {
		return nil, statusErr("ghostty_formatter_terminal_screen_new", rc)
	}
	defer C.ghostty_formatter_free(formatter)
	var ptr *C.uint8_t
	var n C.size_t
	if rc := C.ghostty_formatter_format_alloc(formatter, nil, &ptr, &n); rc != C.GHOSTTY_SUCCESS {
		return nil, statusErr("ghostty_formatter_format_alloc", rc)
	}
	return t.takeBytes(ptr, n)
}

func (t *Terminal) ReadyWindow(historyRows uint32) ([]byte, error) {
	snapshot, err := t.Ready()
	if err != nil {
		return nil, err
	}
	cols, rows := t.Geometry()
	clone, err := New(t.ctx, cols, rows)
	if err != nil {
		return nil, err
	}
	defer clone.Close()
	if err = clone.Restore(snapshot); err != nil {
		return nil, err
	}
	if err = clone.LimitScrollbackLines(historyRows); err != nil {
		return nil, err
	}
	return clone.Ready()
}

func (t *Terminal) HistoryRows() (uint32, error) {
	if t.handle == nil {
		return 0, fmt.Errorf("terminal state is closed")
	}
	if err := t.ctx.Err(); err != nil {
		return 0, err
	}
	var n C.size_t
	if rc := C.ghostty_terminal_get(t.handle, C.GHOSTTY_TERMINAL_DATA_SCROLLBACK_ROWS, unsafe.Pointer(&n)); rc != C.GHOSTTY_SUCCESS {
		return 0, statusErr("ghostty_terminal_get", rc)
	}
	return uint32(n), nil
}

func (t *Terminal) Ready() ([]byte, error) {
	if t.handle == nil {
		return nil, fmt.Errorf("terminal state is closed")
	}
	var ptr *C.uint8_t
	var n C.size_t
	if err := t.ctx.Err(); err != nil {
		return nil, err
	}
	if rc := C.ghostty_snapshot_encode_ready_alloc(t.handle, nil, &ptr, &n); rc != C.GHOSTTY_SUCCESS {
		return nil, statusErr("ghostty_snapshot_encode_ready_alloc", rc)
	}
	data, err := t.takeBytes(ptr, n)
	if err != nil {
		return nil, err
	}
	end, err := ReadyEnd(data)
	if err != nil {
		return nil, err
	}
	return data[:end], nil
}

// ReadyEnd selects the complete renderable prefix, never old HISTORY pages.
func ReadyEnd(data []byte) (int, error) {
	if len(data) < 10 || string(data[:8]) != "GHOSTSNP" || binary.LittleEndian.Uint16(data[8:]) != 1 {
		return 0, fmt.Errorf("invalid snapshot envelope")
	}
	for at := 10; at+10 <= len(data); {
		tag := binary.LittleEndian.Uint16(data[at:])
		size := uint64(binary.LittleEndian.Uint32(data[at+2:]))
		end := uint64(at) + 10 + size
		if end > uint64(len(data)) {
			return 0, fmt.Errorf("truncated snapshot record")
		}
		if tag == 5 {
			if size != 0 {
				return 0, fmt.Errorf("invalid READY record")
			}
			return int(end), nil
		}
		at = int(end)
	}
	return 0, fmt.Errorf("missing READY record")
}

func (t *Terminal) Restore(data []byte) error {
	if t.handle == nil {
		return fmt.Errorf("terminal state is closed")
	}
	if err := t.ctx.Err(); err != nil {
		return err
	}
	end, err := ReadyEnd(data)
	if err != nil {
		return err
	}
	prefix := data[:end]
	buf := C.ghostty_alloc(nil, C.size_t(len(prefix)))
	if buf == nil {
		return fmt.Errorf("engine allocation failed")
	}
	defer C.ghostty_free(nil, buf, C.size_t(len(prefix)))
	copy(unsafe.Slice((*byte)(unsafe.Pointer(buf)), len(prefix)), prefix)
	var decoder C.GhosttySnapshotDecoder
	if rc := C.ghostty_snapshot_decoder_new_buf(nil, &decoder, buf, C.size_t(len(prefix))); rc != C.GHOSTTY_SUCCESS {
		return statusErr("ghostty_snapshot_decoder_new_buf", rc)
	}
	defer C.ghostty_snapshot_decoder_free(decoder)
	retain := C.bool(true)
	if rc := C.ghostty_snapshot_decoder_set(decoder, C.GHOSTTY_SNAPSHOT_DECODER_OPT_RETAIN_CONTINUATION, unsafe.Pointer(&retain)); rc != C.GHOSTTY_SUCCESS {
		return statusErr("ghostty_snapshot_decoder_set", rc)
	}
	var replacement C.GhosttyTerminal
	if rc := C.ghostty_snapshot_decoder_ready(decoder, &replacement); rc != C.GHOSTTY_SUCCESS {
		return statusErr("ghostty_snapshot_decoder_ready", rc)
	}
	if err := t.ctx.Err(); err != nil {
		C.ghostty_terminal_free(replacement)
		return err
	}
	var cols, rows C.uint16_t
	if rc := C.ghostty_terminal_get(replacement, C.GHOSTTY_TERMINAL_DATA_COLS, unsafe.Pointer(&cols)); rc != C.GHOSTTY_SUCCESS {
		C.ghostty_terminal_free(replacement)
		return statusErr("ghostty_terminal_get", rc)
	}
	if rc := C.ghostty_terminal_get(replacement, C.GHOSTTY_TERMINAL_DATA_ROWS, unsafe.Pointer(&rows)); rc != C.GHOSTTY_SUCCESS {
		C.ghostty_terminal_free(replacement)
		return statusErr("ghostty_terminal_get", rc)
	}
	C.ghostty_terminal_free(t.handle)
	t.handle = replacement
	t.cols, t.rows = int(cols), int(rows)
	return nil
}

func (t *Terminal) Close() error {
	if t.handle == nil {
		return nil
	}
	C.ghostty_terminal_free(t.handle)
	t.handle = nil
	return nil
}
