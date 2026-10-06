//go:build termemu_ghostty

package termemu

// Native adapter around the pinned libghostty-vt headless terminal core.
//
// The C half of this file batches cell and grapheme extraction into one call
// per frame, copies grapheme clusters through a length-checked buffer that can
// grow, and never forwards host effects the lite client denies (clipboard
// writes, desktop notifications, file-backed graphics, title-report queries).
// The terminal's own PTY replies stream back through the write callback and
// are drained by the Go side into the pane writer queue.

/*
#include <ghostty/vt.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

// Reply buffer: terminal replies are small and bounded; 64 KiB is far above
// any legitimate burst and an overflow is reported rather than silently lost.
#define PHI_REPLY_CAP (64 * 1024)
#define PHI_TITLE_CAP 1024
#define PHI_PWD_CAP   2048

typedef struct {
	GhosttyTerminal terminal;
	GhosttyRenderState render;
	GhosttyRenderStateRowIterator rows;
	GhosttyRenderStateRowCells cells;

	uint8_t replies[PHI_REPLY_CAP];
	size_t replies_len;
	int reply_overflow;

	uint8_t title[PHI_TITLE_CAP];
	size_t title_len;

	uint8_t pwd[PHI_PWD_CAP];
	size_t pwd_len;

	int bell_count;

	// reply policy state
	int suppress;        // inside a replay/boundary span
	int pending_boundary; // suppress until the parser returns to ground
} PhiTerminal;

static void phi_reply(GhosttyTerminal t, void *ud, const uint8_t *data, size_t len) {
	PhiTerminal *p = (PhiTerminal *)ud;
	if (p->suppress || p->pending_boundary) {
		return;
	}
	if (p->replies_len + len > PHI_REPLY_CAP) {
		p->reply_overflow = 1;
		return;
	}
	memcpy(p->replies + p->replies_len, data, len);
	p->replies_len += len;
}

static void phi_title_changed(GhosttyTerminal t, void *ud) {
	PhiTerminal *p = (PhiTerminal *)ud;
	GhosttyString s = {0};
	if (ghostty_terminal_get(t, GHOSTTY_TERMINAL_DATA_TITLE, &s) != GHOSTTY_SUCCESS || s.ptr == NULL) {
		return;
	}
	if (s.len > PHI_TITLE_CAP) {
		s.len = PHI_TITLE_CAP;
	}
	memcpy(p->title, s.ptr, s.len);
	p->title_len = s.len;
}

static void phi_pwd_changed(GhosttyTerminal t, void *ud) {
	PhiTerminal *p = (PhiTerminal *)ud;
	GhosttyString s = {0};
	if (ghostty_terminal_get(t, GHOSTTY_TERMINAL_DATA_PWD, &s) != GHOSTTY_SUCCESS || s.ptr == NULL) {
		return;
	}
	if (s.len > PHI_PWD_CAP) {
		s.len = PHI_PWD_CAP;
	}
	memcpy(p->pwd, s.ptr, s.len);
	p->pwd_len = s.len;
}

static void phi_bell(GhosttyTerminal t, void *ud) {
	PhiTerminal *p = (PhiTerminal *)ud;
	p->bell_count++;
}

static int phi_at_ground(PhiTerminal *p) {
	bool ground = false;
	if (ghostty_terminal_get(p->terminal, GHOSTTY_TERMINAL_DATA_VT_GROUND, &ground) != GHOSTTY_SUCCESS) {
		return 0;
	}
	return ground ? 1 : 0;
}

static PhiTerminal *phi_new(int cols, int rows, size_t max_bytes, size_t max_lines, int *err) {
	PhiTerminal *p = (PhiTerminal *)calloc(1, sizeof(PhiTerminal));
	if (p == NULL) {
		*err = GHOSTTY_OUT_OF_MEMORY;
		return NULL;
	}
	if (ghostty_terminal_new(NULL, &p->terminal, cols, rows) != GHOSTTY_SUCCESS) {
		free(p);
		*err = GHOSTTY_OUT_OF_MEMORY;
		return NULL;
	}
	ghostty_terminal_set(p->terminal, GHOSTTY_TERMINAL_OPT_USERDATA, p);
	ghostty_terminal_set(p->terminal, GHOSTTY_TERMINAL_OPT_WRITE_PTY, phi_reply);
	ghostty_terminal_set(p->terminal, GHOSTTY_TERMINAL_OPT_TITLE_CHANGED, phi_title_changed);
	ghostty_terminal_set(p->terminal, GHOSTTY_TERMINAL_OPT_PWD_CHANGED, phi_pwd_changed);
	ghostty_terminal_set(p->terminal, GHOSTTY_TERMINAL_OPT_BELL, phi_bell);
	ghostty_terminal_set(p->terminal, GHOSTTY_TERMINAL_OPT_SCROLLBACK_MAX_BYTES, &max_bytes);
	ghostty_terminal_set(p->terminal, GHOSTTY_TERMINAL_OPT_SCROLLBACK_MAX_LINES, &max_lines);
	if (ghostty_render_state_new(NULL, &p->render) != GHOSTTY_SUCCESS ||
	    ghostty_render_state_row_iterator_new(NULL, &p->rows) != GHOSTTY_SUCCESS ||
	    ghostty_render_state_row_cells_new(NULL, &p->cells) != GHOSTTY_SUCCESS) {
		if (p->render) ghostty_render_state_free(p->render);
		if (p->rows) ghostty_render_state_row_iterator_free(p->rows);
		if (p->cells) ghostty_render_state_row_cells_free(p->cells);
		ghostty_terminal_free(p->terminal);
		free(p);
		*err = GHOSTTY_OUT_OF_MEMORY;
		return NULL;
	}
	return p;
}

static void phi_free(PhiTerminal *p) {
	if (p == NULL) {
		return;
	}
	ghostty_render_state_row_cells_free(p->cells);
	ghostty_render_state_row_iterator_free(p->rows);
	ghostty_render_state_free(p->render);
	ghostty_terminal_free(p->terminal);
	free(p);
}

static int phi_resize(PhiTerminal *p, int cols, int rows) {
	return ghostty_terminal_resize(p->terminal, cols, rows, 0, 0);
}

// phi_feed writes bytes with an explicit reply policy:
//   source 0 = live, 1 = replay, 2 = boundary
// Replay and boundary spans suppress replies. If the parser is still inside a
// sequence at the end of a suppressed span, suppression continues until the
// parser reaches ground so the completion of a historical query cannot leak a
// duplicate reply into the live stream.
static void phi_feed(PhiTerminal *p, const uint8_t *data, size_t len, int source) {
	if (source != 0) {
		p->suppress = 1;
		if (source == 2) {
			p->pending_boundary = 1;
		}
	}
	if (len > 0) {
		ghostty_terminal_vt_write(p->terminal, data, len);
	}
	if (source != 0) {
		p->suppress = 0;
		if (!p->pending_boundary && !phi_at_ground(p)) {
			p->pending_boundary = 1;
		}
	}
	if (p->pending_boundary && phi_at_ground(p)) {
		p->pending_boundary = 0;
	}
}

typedef struct {
	uint16_t cols, rows, x, y;
	uint8_t alt, pending_wrap;
	uint64_t history;
	uint64_t revision;
} PhiInfo;

static int phi_info(PhiTerminal *p, PhiInfo *out) {
	memset(out, 0, sizeof(*out));
	GhosttyTerminalScreen screen = GHOSTTY_TERMINAL_SCREEN_PRIMARY;
	if (ghostty_terminal_get(p->terminal, GHOSTTY_TERMINAL_DATA_COLS, &out->cols) != GHOSTTY_SUCCESS ||
	    ghostty_terminal_get(p->terminal, GHOSTTY_TERMINAL_DATA_ROWS, &out->rows) != GHOSTTY_SUCCESS) {
		return GHOSTTY_INVALID_VALUE;
	}
	ghostty_terminal_get(p->terminal, GHOSTTY_TERMINAL_DATA_CURSOR_X, &out->x);
	ghostty_terminal_get(p->terminal, GHOSTTY_TERMINAL_DATA_CURSOR_Y, &out->y);
	ghostty_terminal_get(p->terminal, GHOSTTY_TERMINAL_DATA_CURSOR_PENDING_WRAP, &out->pending_wrap);
	ghostty_terminal_get(p->terminal, GHOSTTY_TERMINAL_DATA_ACTIVE_SCREEN, &screen);
	out->alt = (screen == GHOSTTY_TERMINAL_SCREEN_ALTERNATE) ? 1 : 0;
	ghostty_terminal_get(p->terminal, GHOSTTY_TERMINAL_DATA_SCROLLBACK_ROWS, &out->history);
	// A cheap history revision: the scrollback row count changes as pages are
	// added and pruned, which is what the renderer needs to notice a stale
	// frame. It is deliberately not a byte-exact page counter.
	out->revision = out->history;
	return GHOSTTY_SUCCESS;
}

typedef struct {
	uint32_t fg_kind, fg_value;
	uint32_t bg_kind, bg_value;
	uint8_t bold, faint, italic, underline, strike, inverse, blink, width;
	uint32_t text_off, text_len;
} PhiCellMeta;

static uint32_t phi_color_value(GhosttyStyleColor c) {
	if (c.tag == GHOSTTY_STYLE_COLOR_PALETTE) {
		return (uint32_t)c.value.palette;
	}
	if (c.tag == GHOSTTY_STYLE_COLOR_RGB) {
		return ((uint32_t)c.value.rgb.r << 16) | ((uint32_t)c.value.rgb.g << 8) | c.value.rgb.b;
	}
	return 0;
}

// phi_snapshot copies every visible cell into caller-provided buffers. On
// GHOSTTY_OUT_OF_SPACE, out_cells receives the required metadata count and
// out_text the required arena size, and the caller retries with larger
// buffers. Grapheme clusters are length-checked, never truncated silently.
static int phi_snapshot(PhiTerminal *p, PhiCellMeta *meta, size_t meta_cap, uint8_t *text, size_t text_cap, size_t *out_cells, size_t *out_text) {
	size_t idx = 0, tlen = 0;
	if (ghostty_render_state_update(p->render, p->terminal) != GHOSTTY_SUCCESS) {
		return GHOSTTY_INVALID_VALUE;
	}
	GhosttyRenderStateRowIterator rows = p->rows;
	if (ghostty_render_state_get(p->render, GHOSTTY_RENDER_STATE_DATA_ROW_ITERATOR, &rows) != GHOSTTY_SUCCESS) {
		return GHOSTTY_INVALID_VALUE;
	}
	while (ghostty_render_state_row_iterator_next(rows)) {
		GhosttyRenderStateRowCells cells = p->cells;
		if (ghostty_render_state_row_get(rows, GHOSTTY_RENDER_STATE_ROW_DATA_CELLS, &cells) != GHOSTTY_SUCCESS) {
			return GHOSTTY_INVALID_VALUE;
		}
		while (ghostty_render_state_row_cells_next(cells)) {
			if (idx >= meta_cap) {
				*out_cells = idx + 1;
				*out_text = tlen + 64;
				return GHOSTTY_OUT_OF_SPACE;
			}
			PhiCellMeta *m = &meta[idx];
			memset(m, 0, sizeof(*m));
			GhosttyBuffer b = { .ptr = NULL, .cap = 0, .len = 0 };
			if (tlen < text_cap) {
				b.ptr = text + tlen;
				b.cap = text_cap - tlen;
			}
			GhosttyResult r = ghostty_render_state_row_cells_get(cells, GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_GRAPHEMES_UTF8, &b);
			if (r == GHOSTTY_OUT_OF_SPACE) {
				*out_cells = idx + 1;
				*out_text = tlen + b.len;
				return GHOSTTY_OUT_OF_SPACE;
			}
			if (r != GHOSTTY_SUCCESS) {
				return r;
			}
			m->text_off = (uint32_t)tlen;
			m->text_len = (uint32_t)b.len;
			tlen += b.len;

			GhosttyCell raw = 0;
			GhosttyCellWide wide = GHOSTTY_CELL_WIDE_NARROW;
			if (ghostty_render_state_row_cells_get(cells, GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_RAW, &raw) == GHOSTTY_SUCCESS && raw != 0) {
				ghostty_cell_get(raw, GHOSTTY_CELL_DATA_WIDE, &wide);
			}
			if (wide == GHOSTTY_CELL_WIDE_WIDE) {
				m->width = 2;
			} else if (wide == GHOSTTY_CELL_WIDE_SPACER_TAIL) {
				m->width = 0;
			} else {
				m->width = 1;
			}

			GhosttyStyle s = GHOSTTY_INIT_SIZED(GhosttyStyle);
			if (ghostty_render_state_row_cells_get(cells, GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_STYLE, &s) == GHOSTTY_SUCCESS) {
				m->bold = s.bold ? 1 : 0;
				m->faint = s.faint ? 1 : 0;
				m->italic = s.italic ? 1 : 0;
				m->strike = s.strikethrough ? 1 : 0;
				m->inverse = s.inverse ? 1 : 0;
				m->blink = s.blink ? 1 : 0;
				m->underline = (uint8_t)s.underline;
				m->fg_kind = (uint32_t)s.fg_color.tag;
				m->fg_value = phi_color_value(s.fg_color);
				m->bg_kind = (uint32_t)s.bg_color.tag;
				m->bg_value = phi_color_value(s.bg_color);
			}
			idx++;
		}
	}
	*out_cells = idx;
	*out_text = tlen;
	return GHOSTTY_SUCCESS;
}

static size_t phi_take_replies(PhiTerminal *p, uint8_t *out, size_t cap, int *overflow) {
	size_t n = p->replies_len;
	if (n > cap) {
		n = cap;
	}
	memcpy(out, p->replies, n);
	p->replies_len = 0;
	if (overflow != NULL) {
		*overflow = p->reply_overflow;
		p->reply_overflow = 0;
	}
	return n;
}

static size_t phi_take_title(PhiTerminal *p, uint8_t *out, size_t cap) {
	size_t n = p->title_len;
	if (n > cap) {
		n = cap;
	}
	memcpy(out, p->title, n);
	return n;
}

static size_t phi_take_pwd(PhiTerminal *p, uint8_t *out, size_t cap) {
	size_t n = p->pwd_len;
	if (n > cap) {
		n = cap;
	}
	memcpy(out, p->pwd, n);
	return n;
}

static int phi_take_bell(PhiTerminal *p) {
	int n = p->bell_count;
	p->bell_count = 0;
	return n;
}

static int phi_memory(PhiTerminal *p, uint64_t *resident, uint64_t *pages) {
	GhosttyTerminalMemoryUsage mu = GHOSTTY_INIT_SIZED(GhosttyTerminalMemoryUsage);
	GhosttyResult r = ghostty_terminal_get(p->terminal, GHOSTTY_TERMINAL_DATA_MEMORY_USAGE, &mu);
	if (r != GHOSTTY_SUCCESS) {
		return r;
	}
	*resident = mu.primary_resident_bytes + mu.alternate_resident_bytes +
		mu.primary_image_bytes + mu.alternate_image_bytes;
	*pages = mu.primary_pages + mu.alternate_pages;
	return GHOSTTY_SUCCESS;
}

static int phi_mode(PhiTerminal *p, int value, int ansi, int *out) {
	GhosttyTerminalModeConfig cfg;
	cfg.mode = ghostty_mode_new((uint16_t)value, ansi != 0);
	cfg.value = false;
	GhosttyResult r = ghostty_terminal_get(p->terminal, GHOSTTY_TERMINAL_DATA_MODE, &cfg);
	if (r != GHOSTTY_SUCCESS) {
		return r;
	}
	*out = cfg.value ? 1 : 0;
	return GHOSTTY_SUCCESS;
}

static int phi_key(PhiTerminal *p, int action, int key, int mods, const char *utf8, size_t utf8_len, uint32_t unshifted, uint8_t *buf, size_t cap, size_t *written) {
	GhosttyKeyEncoder enc = NULL;
	GhosttyKeyEvent ev = NULL;
	if (ghostty_key_encoder_new(NULL, &enc) != GHOSTTY_SUCCESS) {
		return GHOSTTY_OUT_OF_MEMORY;
	}
	if (ghostty_key_event_new(NULL, &ev) != GHOSTTY_SUCCESS) {
		ghostty_key_encoder_free(enc);
		return GHOSTTY_OUT_OF_MEMORY;
	}
	ghostty_key_encoder_setopt_from_terminal(enc, p->terminal);
	ghostty_key_event_set_action(ev, (GhosttyKeyAction)action);
	ghostty_key_event_set_key(ev, (GhosttyKey)key);
	ghostty_key_event_set_mods(ev, (GhosttyMods)mods);
	if (utf8 != NULL && utf8_len > 0) {
		ghostty_key_event_set_utf8(ev, utf8, utf8_len);
	}
	if (unshifted != 0) {
		ghostty_key_event_set_unshifted_codepoint(ev, unshifted);
	}
	GhosttyResult r = ghostty_key_encoder_encode(enc, ev, (char *)buf, cap, written);
	ghostty_key_event_free(ev);
	ghostty_key_encoder_free(enc);
	return r;
}

static int phi_mouse(PhiTerminal *p, int action, int button, int mods, float x, float y, int cols, int rows, uint8_t *buf, size_t cap, size_t *written) {
	GhosttyMouseEncoder enc = NULL;
	GhosttyMouseEvent ev = NULL;
	if (ghostty_mouse_encoder_new(NULL, &enc) != GHOSTTY_SUCCESS) {
		return GHOSTTY_OUT_OF_MEMORY;
	}
	if (ghostty_mouse_event_new(NULL, &ev) != GHOSTTY_SUCCESS) {
		ghostty_mouse_encoder_free(enc);
		return GHOSTTY_OUT_OF_MEMORY;
	}
	ghostty_mouse_encoder_setopt_from_terminal(enc, p->terminal);
	GhosttyMouseEncoderSize size;
	memset(&size, 0, sizeof(size));
	size.size = sizeof(size);
	size.screen_width = (uint32_t)cols;
	size.screen_height = (uint32_t)rows;
	size.cell_width = 1;
	size.cell_height = 1;
	ghostty_mouse_encoder_setopt(enc, GHOSTTY_MOUSE_ENCODER_OPT_SIZE, &size);
	ghostty_mouse_event_set_action(ev, (GhosttyMouseAction)action);
	if (button < 0) {
		ghostty_mouse_event_clear_button(ev);
	} else {
		ghostty_mouse_event_set_button(ev, (GhosttyMouseButton)button);
	}
	ghostty_mouse_event_set_mods(ev, (GhosttyMods)mods);
	GhosttyMousePosition pos;
	pos.x = x;
	pos.y = y;
	ghostty_mouse_event_set_position(ev, pos);
	GhosttyResult r = ghostty_mouse_encoder_encode(enc, ev, (char *)buf, cap, written);
	ghostty_mouse_event_free(ev);
	ghostty_mouse_encoder_free(enc);
	return r;
}

// phi_paste encodes paste data for the pty. data is modified in place by the
// library, so the caller passes a scratch copy.
static int phi_paste(uint8_t *data, size_t len, int bracketed, uint8_t *buf, size_t cap, size_t *written) {
	return ghostty_paste_encode((char *)data, len, bracketed != 0, (char *)buf, cap, written);
}
*/
import "C"

import (
	"fmt"
	"sync"
	"unsafe"
)

type ghosttyTerminal struct {
	mu     sync.Mutex
	c      *C.PhiTerminal
	opts   Options
	closed bool
	cols   int
	rows   int
}

func newGhostty(opts Options) (Terminal, error) {
	if opts.Cols <= 0 || opts.Rows <= 0 {
		return nil, ErrInvalidGeometry
	}
	if opts.ScrollbackBytes <= 0 || opts.ScrollbackLines <= 0 {
		return nil, ErrZeroBudget
	}
	var cerr C.int
	c := C.phi_new(C.int(opts.Cols), C.int(opts.Rows), C.size_t(opts.ScrollbackBytes), C.size_t(opts.ScrollbackLines), &cerr)
	if c == nil {
		return nil, &Error{Op: "ghostty.new", Err: fmt.Sprintf("terminal allocation failed (%d)", int(cerr))}
	}
	return &ghosttyTerminal{c: c, opts: opts, cols: opts.Cols, rows: opts.Rows}, nil
}

func (g *ghosttyTerminal) Feed(b []byte, source Source) error {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.closed {
		return &Error{Op: "ghostty.feed", Err: "terminal is closed"}
	}
	if len(b) > 0 {
		C.phi_feed(g.c, (*C.uint8_t)(unsafe.Pointer(&b[0])), C.size_t(len(b)), C.int(source))
	}
	g.drainRepliesLocked()
	g.reportMetadataLocked()
	return nil
}

// drainRepliesLocked hands queued PTY replies to the callback. The callback
// is invoked with the lock released so it can enqueue without deadlocking on
// the pane's own serialization, but callers must treat each callback as
// ordered within this terminal.
func (g *ghosttyTerminal) drainRepliesLocked() {
	if g.opts.Events.OnReply == nil {
		return
	}
	var buf [8192]byte
	for {
		var overflow C.int
		n := C.phi_take_replies(g.c, (*C.uint8_t)(unsafe.Pointer(&buf[0])), C.size_t(len(buf)), &overflow)
		if n > 0 {
			out := make([]byte, int(n))
			copy(out, buf[:n])
			g.mu.Unlock()
			g.opts.Events.OnReply(out)
			g.mu.Lock()
			if g.closed {
				return
			}
		}
		if overflow != 0 {
			g.mu.Unlock()
			if g.opts.Events.OnReply != nil {
				g.opts.Events.OnReply(nil) // overflow marker; app reports, never sends
			}
			g.mu.Lock()
		}
		if n == 0 && overflow == 0 {
			return
		}
	}
}

func (g *ghosttyTerminal) reportMetadataLocked() {
	if g.opts.Events.OnTitle != nil {
		var buf [4096]byte
		if n := C.phi_take_title(g.c, (*C.uint8_t)(unsafe.Pointer(&buf[0])), C.size_t(len(buf))); n > 0 {
			title := string(buf[:n])
			g.mu.Unlock()
			g.opts.Events.OnTitle(title)
			g.mu.Lock()
			if g.closed {
				return
			}
		}
	}
	if g.opts.Events.OnPWD != nil {
		var buf [4096]byte
		if n := C.phi_take_pwd(g.c, (*C.uint8_t)(unsafe.Pointer(&buf[0])), C.size_t(len(buf))); n > 0 {
			pwd := string(buf[:n])
			g.mu.Unlock()
			g.opts.Events.OnPWD(pwd)
			g.mu.Lock()
			if g.closed {
				return
			}
		}
	}
	if g.opts.Events.OnBell != nil {
		if n := int(C.phi_take_bell(g.c)); n > 0 {
			g.mu.Unlock()
			g.opts.Events.OnBell()
			g.mu.Lock()
		}
	}
}

func (g *ghosttyTerminal) Resize(cols, rows int) error {
	if cols <= 0 || rows <= 0 {
		return ErrInvalidGeometry
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.closed {
		return &Error{Op: "ghostty.resize", Err: "terminal is closed"}
	}
	if cols == g.cols && rows == g.rows {
		return nil
	}
	if rc := C.phi_resize(g.c, C.int(cols), C.int(rows)); rc != C.GHOSTTY_SUCCESS {
		return &Error{Op: "ghostty.resize", Err: fmt.Sprintf("resize failed (%d)", int(rc))}
	}
	g.cols, g.rows = cols, rows
	return nil
}

func (g *ghosttyTerminal) Snapshot() (Frame, error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.closed {
		return Frame{}, &Error{Op: "ghostty.snapshot", Err: "terminal is closed"}
	}
	var info C.PhiInfo
	if rc := C.phi_info(g.c, &info); rc != C.GHOSTTY_SUCCESS {
		return Frame{}, &Error{Op: "ghostty.snapshot", Err: fmt.Sprintf("info failed (%d)", int(rc))}
	}
	cols, rows := int(info.cols), int(info.rows)
	if cols <= 0 || rows <= 0 {
		return Frame{}, ErrInvalidGeometry
	}
	frame := Frame{
		Cols:    cols,
		Rows:    rows,
		Cursor:  Cursor{X: int(info.x), Y: int(info.y), PendingWrap: info.pending_wrap != 0},
		Alt:     info.alt != 0,
		History: int(info.history),
		PageID:  uint64(info.revision),
	}
	cells := cols * rows
	if cells <= 0 {
		return frame, nil
	}
	meta := make([]C.PhiCellMeta, cells)
	text := make([]byte, cells*4)
	// Grow-on-demand loop: the C side reports exact required sizes instead of
	// truncating grapheme clusters.
	for attempt := 0; attempt < 8; attempt++ {
		var outCells, outText C.size_t
		rc := C.phi_snapshot(g.c,
			(*C.PhiCellMeta)(unsafe.Pointer(&meta[0])), C.size_t(len(meta)),
			(*C.uint8_t)(unsafe.Pointer(&text[0])), C.size_t(len(text)),
			&outCells, &outText)
		if rc == C.GHOSTTY_SUCCESS {
			if int(outCells) <= len(meta) && int(outText) <= len(text) {
				frame.Cells = expandCells(meta[:int(outCells)], text[:int(outText)], cols)
			}
			return frame, nil
		}
		if rc != C.GHOSTTY_OUT_OF_SPACE {
			return Frame{}, &Error{Op: "ghostty.snapshot", Err: fmt.Sprintf("cell extraction failed (%d)", int(rc))}
		}
		needCells := int(outCells)
		if needCells <= len(meta) {
			needCells = len(meta) * 2
		}
		if needCells > rows*cols*4 {
			return Frame{}, &Error{Op: "ghostty.snapshot", Err: "emulator reported more cells than the frame"}
		}
		needText := int(outText)
		if needText <= len(text) {
			needText = len(text) * 2
		}
		meta = make([]C.PhiCellMeta, needCells)
		text = make([]byte, needText)
	}
	return Frame{}, &Error{Op: "ghostty.snapshot", Err: "cell extraction did not converge"}
}

func expandCells(meta []C.PhiCellMeta, text []byte, cols int) [][]Cell {
	if cols <= 0 {
		return nil
	}
	rows := make([][]Cell, 0, (len(meta)+cols-1)/cols)
	for i := range meta {
		m := &meta[i]
		row := i / cols
		for len(rows) <= row {
			rows = append(rows, nil)
		}
		cell := Cell{
			Width:         int(m.width),
			Bold:          m.bold != 0,
			Faint:         m.faint != 0,
			Italic:        m.italic != 0,
			Underline:     underlineFromC(uint8(m.underline)),
			Strikethrough: m.strike != 0,
			Inverse:       m.inverse != 0,
			Blink:         m.blink != 0,
			Fg:            colorFromC(uint32(m.fg_kind), uint32(m.fg_value)),
			Bg:            colorFromC(uint32(m.bg_kind), uint32(m.bg_value)),
		}
		off, ln := int(m.text_off), int(m.text_len)
		if off >= 0 && ln > 0 && off+ln <= len(text) {
			cell.Text = string(text[off : off+ln])
		}
		rows[row] = append(rows[row], cell)
	}
	return rows
}

func colorFromC(kind, value uint32) Color {
	switch kind {
	case 1:
		return Color{Kind: ColorPalette, Value: value}
	case 2:
		return Color{Kind: ColorRGB, Value: value}
	default:
		return Color{Kind: ColorDefault}
	}
}

func underlineFromC(u uint8) Underline {
	switch u {
	case 1:
		return UnderlineStraight
	case 2:
		return UnderlineDouble
	case 3:
		return UnderlineCurly
	case 4:
		return UnderlineDotted
	case 5:
		return UnderlineDashed
	default:
		return UnderlineNone
	}
}

var keyToC = map[Key]C.GhosttyKey{
	KeyUnidentified: C.GHOSTTY_KEY_UNIDENTIFIED,
	KeyEnter:        C.GHOSTTY_KEY_ENTER,
	KeyEscape:       C.GHOSTTY_KEY_ESCAPE,
	KeyBackspace:    C.GHOSTTY_KEY_BACKSPACE,
	KeyTab:          C.GHOSTTY_KEY_TAB,
	KeyDelete:       C.GHOSTTY_KEY_DELETE,
	KeyInsert:       C.GHOSTTY_KEY_INSERT,
	KeyHome:         C.GHOSTTY_KEY_HOME,
	KeyEnd:          C.GHOSTTY_KEY_END,
	KeyPageUp:       C.GHOSTTY_KEY_PAGE_UP,
	KeyPageDown:     C.GHOSTTY_KEY_PAGE_DOWN,
	KeyArrowUp:      C.GHOSTTY_KEY_ARROW_UP,
	KeyArrowDown:    C.GHOSTTY_KEY_ARROW_DOWN,
	KeyArrowLeft:    C.GHOSTTY_KEY_ARROW_LEFT,
	KeyArrowRight:   C.GHOSTTY_KEY_ARROW_RIGHT,
	KeyF1:           C.GHOSTTY_KEY_F1,
	KeyF2:           C.GHOSTTY_KEY_F2,
	KeyF3:           C.GHOSTTY_KEY_F3,
	KeyF4:           C.GHOSTTY_KEY_F4,
	KeyF5:           C.GHOSTTY_KEY_F5,
	KeyF6:           C.GHOSTTY_KEY_F6,
	KeyF7:           C.GHOSTTY_KEY_F7,
	KeyF8:           C.GHOSTTY_KEY_F8,
	KeyF9:           C.GHOSTTY_KEY_F9,
	KeyF10:          C.GHOSTTY_KEY_F10,
	KeyF11:          C.GHOSTTY_KEY_F11,
	KeyF12:          C.GHOSTTY_KEY_F12,
	KeyF13:          C.GHOSTTY_KEY_F13,
	KeyF14:          C.GHOSTTY_KEY_F14,
	KeyF15:          C.GHOSTTY_KEY_F15,
	KeyF16:          C.GHOSTTY_KEY_F16,
	KeyF17:          C.GHOSTTY_KEY_F17,
	KeyF18:          C.GHOSTTY_KEY_F18,
	KeyF19:          C.GHOSTTY_KEY_F19,
	KeyF20:          C.GHOSTTY_KEY_F20,
	KeyF21:          C.GHOSTTY_KEY_F21,
	KeyF22:          C.GHOSTTY_KEY_F22,
	KeyF23:          C.GHOSTTY_KEY_F23,
	KeyF24:          C.GHOSTTY_KEY_F24,
	KeySpace:        C.GHOSTTY_KEY_SPACE,
}

// asciiKey maps a rune to the physical key the layout-independent encoder
// understands. Runes outside the ASCII writing set stay unidentified and the
// UTF-8 text carries them.
func asciiKey(r rune) (C.GhosttyKey, bool) {
	switch {
	case r >= 'a' && r <= 'z':
		return C.GhosttyKey(int(C.GHOSTTY_KEY_A) + int(r-'a')), true
	case r >= 'A' && r <= 'Z':
		return C.GhosttyKey(int(C.GHOSTTY_KEY_A) + int(r-'A')), true
	case r >= '0' && r <= '9':
		return C.GhosttyKey(int(C.GHOSTTY_KEY_DIGIT_0) + int(r-'0')), true
	}
	switch r {
	case ' ':
		return C.GHOSTTY_KEY_SPACE, true
	case '`':
		return C.GHOSTTY_KEY_BACKQUOTE, true
	case '\\':
		return C.GHOSTTY_KEY_BACKSLASH, true
	case '[':
		return C.GHOSTTY_KEY_BRACKET_LEFT, true
	case ']':
		return C.GHOSTTY_KEY_BRACKET_RIGHT, true
	case ',':
		return C.GHOSTTY_KEY_COMMA, true
	case '=':
		return C.GHOSTTY_KEY_EQUAL, true
	case '-':
		return C.GHOSTTY_KEY_MINUS, true
	case '.':
		return C.GHOSTTY_KEY_PERIOD, true
	case '\'':
		return C.GHOSTTY_KEY_QUOTE, true
	case ';':
		return C.GHOSTTY_KEY_SEMICOLON, true
	case '/':
		return C.GHOSTTY_KEY_SLASH, true
	}
	return C.GHOSTTY_KEY_UNIDENTIFIED, false
}

func (g *ghosttyTerminal) EncodeKey(ev KeyEvent) ([]byte, error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.closed {
		return nil, &Error{Op: "ghostty.key", Err: "terminal is closed"}
	}
	action := C.GHOSTTY_KEY_ACTION_PRESS
	switch ev.Action {
	case KeyRepeat:
		action = C.GHOSTTY_KEY_ACTION_REPEAT
	case KeyRelease:
		action = C.GHOSTTY_KEY_ACTION_RELEASE
	}
	var mods C.GhosttyMods
	if ev.Mods&ModShift != 0 {
		mods |= C.GHOSTTY_MODS_SHIFT
	}
	if ev.Mods&ModCtrl != 0 {
		mods |= C.GHOSTTY_MODS_CTRL
	}
	if ev.Mods&ModAlt != 0 {
		mods |= C.GHOSTTY_MODS_ALT
	}
	if ev.Mods&ModSuper != 0 {
		mods |= C.GHOSTTY_MODS_SUPER
	}
	key, ok := keyToC[ev.Key]
	textRun := ev.Unshifted
	if !ok || ev.Key == KeyRune || (ev.Key == KeyUnidentified && ev.Text != "") {
		if textRun == 0 && ev.Text != "" {
			for _, r := range ev.Text {
				textRun = r
				break
			}
		}
		if physical, mapped := asciiKey(textRun); mapped {
			key = physical
		} else {
			key = C.GHOSTTY_KEY_UNIDENTIFIED
		}
	}
	var ctext *C.char
	if ev.Text != "" {
		ctext = C.CString(ev.Text)
		defer C.free(unsafe.Pointer(ctext))
	}
	var unshifted C.uint32_t
	if ev.Unshifted != 0 {
		unshifted = C.uint32_t(ev.Unshifted)
	}
	var buf [512]byte
	var written C.size_t
	rc := C.phi_key(g.c, C.int(action), C.int(key), C.int(mods), ctext, C.size_t(len(ev.Text)), unshifted,
		(*C.uint8_t)(unsafe.Pointer(&buf[0])), C.size_t(len(buf)), &written)
	if rc == C.GHOSTTY_OUT_OF_SPACE {
		big := make([]byte, int(written)+16)
		rc = C.phi_key(g.c, C.int(action), C.int(key), C.int(mods), ctext, C.size_t(len(ev.Text)), unshifted,
			(*C.uint8_t)(unsafe.Pointer(&big[0])), C.size_t(len(big)), &written)
		if rc != C.GHOSTTY_SUCCESS {
			return nil, &Error{Op: "ghostty.key", Err: fmt.Sprintf("encode failed (%d)", int(rc))}
		}
		return big[:int(written)], nil
	}
	if rc != C.GHOSTTY_SUCCESS {
		return nil, &Error{Op: "ghostty.key", Err: fmt.Sprintf("encode failed (%d)", int(rc))}
	}
	out := make([]byte, int(written))
	copy(out, buf[:int(written)])
	return out, nil
}

func (g *ghosttyTerminal) EncodeMouse(action MouseAction, button MouseButton, mods Modifier, x, y int) ([]byte, error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.closed {
		return nil, &Error{Op: "ghostty.mouse", Err: "terminal is closed"}
	}
	var caction C.GhosttyMouseAction
	switch action {
	case MouseRelease:
		caction = C.GHOSTTY_MOUSE_ACTION_RELEASE
	case MouseMotion:
		caction = C.GHOSTTY_MOUSE_ACTION_MOTION
	default:
		caction = C.GHOSTTY_MOUSE_ACTION_PRESS
	}
	cbutton := C.int(-1)
	switch button {
	case MouseLeft:
		cbutton = C.int(C.GHOSTTY_MOUSE_BUTTON_LEFT)
	case MouseMiddle:
		cbutton = C.int(C.GHOSTTY_MOUSE_BUTTON_MIDDLE)
	case MouseRight:
		cbutton = C.int(C.GHOSTTY_MOUSE_BUTTON_RIGHT)
	}
	var cmods C.GhosttyMods
	if mods&ModShift != 0 {
		cmods |= C.GHOSTTY_MODS_SHIFT
	}
	if mods&ModCtrl != 0 {
		cmods |= C.GHOSTTY_MODS_CTRL
	}
	if mods&ModAlt != 0 {
		cmods |= C.GHOSTTY_MODS_ALT
	}
	var buf [256]byte
	var written C.size_t
	rc := C.phi_mouse(g.c, C.int(caction), cbutton, C.int(cmods), C.float(x), C.float(y), C.int(g.cols), C.int(g.rows),
		(*C.uint8_t)(unsafe.Pointer(&buf[0])), C.size_t(len(buf)), &written)
	if rc != C.GHOSTTY_SUCCESS && rc != C.GHOSTTY_OUT_OF_SPACE {
		return nil, &Error{Op: "ghostty.mouse", Err: fmt.Sprintf("encode failed (%d)", int(rc))}
	}
	out := make([]byte, int(written))
	if int(written) > len(buf) {
		out = make([]byte, int(written)+16)
		rc = C.phi_mouse(g.c, C.int(caction), cbutton, C.int(cmods), C.float(x), C.float(y), C.int(g.cols), C.int(g.rows),
			(*C.uint8_t)(unsafe.Pointer(&out[0])), C.size_t(len(out)), &written)
		if rc != C.GHOSTTY_SUCCESS {
			return nil, &Error{Op: "ghostty.mouse", Err: fmt.Sprintf("encode failed (%d)", int(rc))}
		}
		return out[:int(written)], nil
	}
	copy(out, buf[:int(written)])
	return out, nil
}

func (g *ghosttyTerminal) EncodePaste(payload []byte) ([]byte, error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.closed {
		return nil, &Error{Op: "ghostty.paste", Err: "terminal is closed"}
	}
	if len(payload) == 0 {
		return nil, nil
	}
	bracketed := 0
	if v, err := g.modeLocked(ModeBracketedPaste); err == nil && v {
		bracketed = 1
	}
	scratch := make([]byte, len(payload))
	copy(scratch, payload)
	buf := make([]byte, len(payload)+64)
	var written C.size_t
	rc := C.phi_paste((*C.uint8_t)(unsafe.Pointer(&scratch[0])), C.size_t(len(scratch)), C.int(bracketed),
		(*C.uint8_t)(unsafe.Pointer(&buf[0])), C.size_t(len(buf)), &written)
	if rc == C.GHOSTTY_OUT_OF_SPACE {
		buf = make([]byte, int(written)+16)
		scratch = make([]byte, len(payload))
		copy(scratch, payload)
		rc = C.phi_paste((*C.uint8_t)(unsafe.Pointer(&scratch[0])), C.size_t(len(scratch)), C.int(bracketed),
			(*C.uint8_t)(unsafe.Pointer(&buf[0])), C.size_t(len(buf)), &written)
	}
	if rc != C.GHOSTTY_SUCCESS {
		return nil, &Error{Op: "ghostty.paste", Err: fmt.Sprintf("encode failed (%d)", int(rc))}
	}
	out := make([]byte, int(written))
	copy(out, buf[:int(written)])
	return out, nil
}

func (g *ghosttyTerminal) modeLocked(m Mode) (bool, error) {
	var value, ansi C.int
	alternate := false
	switch m {
	case ModeApplicationCursor:
		value = 1
	case ModeApplicationKeypad:
		value = 66
	case ModeBracketedPaste:
		value = 2004
	case ModeMouseButton:
		value = 1000
	case ModeMouseMotion:
		value = 1002
	case ModeMouseAny:
		value = 1003
	case ModeMouseSgr:
		value = 1006
	case ModeMouseUrxvt:
		value = 1015
	case ModeSynchronizedOutput:
		value = 2026
	case ModeAlternateScreen:
		alternate = true
	default:
		return false, &Error{Op: "ghostty.mode", Err: fmt.Sprintf("unknown mode %d", int(m))}
	}
	if alternate {
		var info C.PhiInfo
		if rc := C.phi_info(g.c, &info); rc != C.GHOSTTY_SUCCESS {
			return false, &Error{Op: "ghostty.mode", Err: fmt.Sprintf("info failed (%d)", int(rc))}
		}
		return info.alt != 0, nil
	}
	var out C.int
	rc := C.phi_mode(g.c, value, ansi, &out)
	if rc != C.GHOSTTY_SUCCESS {
		return false, &Error{Op: "ghostty.mode", Err: fmt.Sprintf("mode query failed (%d)", int(rc))}
	}
	return out != 0, nil
}

func (g *ghosttyTerminal) Mode(m Mode) (bool, error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.closed {
		return false, &Error{Op: "ghostty.mode", Err: "terminal is closed"}
	}
	return g.modeLocked(m)
}

func (g *ghosttyTerminal) HistoryPageID() uint64 {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.closed {
		return 0
	}
	var info C.PhiInfo
	if rc := C.phi_info(g.c, &info); rc != C.GHOSTTY_SUCCESS {
		return 0
	}
	return uint64(info.revision)
}

func (g *ghosttyTerminal) NativeMemory() (uint64, error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.closed {
		return 0, &Error{Op: "ghostty.memory", Err: "terminal is closed"}
	}
	var resident, pages C.uint64_t
	if rc := C.phi_memory(g.c, &resident, &pages); rc != C.GHOSTTY_SUCCESS {
		return 0, &Error{Op: "ghostty.memory", Err: fmt.Sprintf("memory query failed (%d)", int(rc))}
	}
	return uint64(resident), nil
}

func (g *ghosttyTerminal) Close() error {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.closed {
		return nil
	}
	C.phi_free(g.c)
	g.c = nil
	g.closed = true
	return nil
}
