// Package termstate keeps the server's bounded live terminal state. The
// append-only recording, not this presentation state, owns all source bytes.
package termstate

import (
	"context"
	_ "embed"
	"encoding/binary"
	"fmt"
	"sync"

	"github.com/tetratelabs/wazero"
	"github.com/tetratelabs/wazero/api"
)

// Same libghostty-vt pin as the native client, compiled for wasm32-freestanding.
// No host imports, subprocesses, CGO, or client-side transcript replay.
//
//go:embed ghostty-vt.wasm
var engine []byte
var shared struct {
	sync.Once
	runtime  wazero.Runtime
	compiled wazero.CompiledModule
	err      error
}

func compile() {
	ctx := context.Background()
	shared.runtime = wazero.NewRuntimeWithConfig(ctx, wazero.NewRuntimeConfigCompiler().WithCloseOnContextDone(true))
	shared.compiled, shared.err = shared.runtime.CompileModule(ctx, engine)
}

type Terminal struct {
	ctx        context.Context
	module     api.Module
	handle     uint32
	cols, rows int
}

func New(ctx context.Context, cols, rows int) (*Terminal, error) {
	if cols < 1 || rows < 1 || cols > 65535 || rows > 65535 {
		return nil, fmt.Errorf("invalid terminal geometry")
	}
	shared.Do(compile)
	if shared.err != nil {
		return nil, shared.err
	}
	m, err := shared.runtime.InstantiateModule(ctx, shared.compiled, wazero.NewModuleConfig().WithName(""))
	if err != nil {
		return nil, err
	}
	t := &Terminal{ctx: ctx, module: m, cols: cols, rows: rows}
	slot, err := t.alloc(4)
	if err != nil {
		t.Close()
		return nil, err
	}
	defer t.free(slot, 4)
	if err = t.ok("ghostty_terminal_new", 0, uint64(slot), uint64(cols), uint64(rows)); err != nil {
		t.Close()
		return nil, err
	}
	t.handle, _ = m.Memory().ReadUint32Le(slot)
	for _, setting := range [][2]uint32{{27, 64 << 20}, {28, 10000}, {31, 65 << 20}} {
		m.Memory().WriteUint32Le(slot, setting[1])
		if err = t.ok("ghostty_terminal_set", uint64(t.handle), uint64(setting[0]), uint64(slot)); err != nil {
			t.Close()
			return nil, err
		}
	}
	return t, nil
}
func (t *Terminal) call(name string, args ...uint64) ([]uint64, error) {
	if t.module == nil {
		return nil, fmt.Errorf("terminal state is closed")
	}
	f := t.module.ExportedFunction(name)
	if f == nil {
		return nil, fmt.Errorf("missing engine export %s", name)
	}
	return f.Call(t.ctx, args...)
}
func (t *Terminal) ok(name string, args ...uint64) error {
	v, err := t.call(name, args...)
	if err != nil {
		return err
	}
	if len(v) > 0 && uint32(v[0]) != 0 {
		return fmt.Errorf("%s: engine status %d", name, int32(v[0]))
	}
	return nil
}
func (t *Terminal) alloc(n uint32) (uint32, error) {
	v, err := t.call("ghostty_wasm_alloc", uint64(n))
	if err != nil {
		return 0, err
	}
	if len(v) != 1 || v[0] == 0 {
		return 0, fmt.Errorf("engine allocation failed")
	}
	return uint32(v[0]), nil
}
func (t *Terminal) free(p, n uint32) { _, _ = t.call("ghostty_wasm_free", uint64(p), uint64(n)) }
func (t *Terminal) Feed(data []byte) error {
	for len(data) > 0 {
		n := min(len(data), 64<<10)
		p, err := t.alloc(uint32(n))
		if err != nil {
			return err
		}
		if !t.module.Memory().Write(p, data[:n]) {
			t.free(p, uint32(n))
			return fmt.Errorf("engine memory bounds")
		}
		_, err = t.call("ghostty_terminal_vt_write", uint64(t.handle), uint64(p), uint64(n))
		t.free(p, uint32(n))
		if err != nil {
			return err
		}
		data = data[n:]
	}
	return nil
}
func (t *Terminal) Resize(cols, rows int) error {
	if cols < 1 || rows < 1 || cols > 65535 || rows > 65535 {
		return fmt.Errorf("invalid terminal geometry")
	}
	if err := t.ok("ghostty_terminal_resize", uint64(t.handle), uint64(cols), uint64(rows), 1, 1); err != nil {
		return err
	}
	t.cols, t.rows = cols, rows
	return nil
}
func (t *Terminal) Geometry() (int, int) { return t.cols, t.rows }
func (t *Terminal) Continuation() ([]byte, error) {
	output, err := t.alloc(8)
	if err != nil {
		return nil, err
	}
	defer t.free(output, 8)
	if err = t.ok("ghostty_terminal_continuation_alloc", uint64(t.handle), 0, uint64(output), uint64(output+4)); err != nil {
		return nil, err
	}
	ptr, _ := t.module.Memory().ReadUint32Le(output)
	size, _ := t.module.Memory().ReadUint32Le(output + 4)
	if size == 0 {
		return nil, nil
	}
	defer t.call("ghostty_free", 0, uint64(ptr), uint64(size))
	data, ok := t.module.Memory().Read(ptr, size)
	if !ok {
		return nil, fmt.Errorf("continuation bounds")
	}
	return append([]byte(nil), data...), nil
}

func (t *Terminal) LimitScrollbackLines(lines uint32) error {
	ptr, err := t.alloc(4)
	if err != nil {
		return err
	}
	defer t.free(ptr, 4)
	t.module.Memory().WriteUint32Le(ptr, lines)
	return t.ok("ghostty_terminal_set", uint64(t.handle), 28, uint64(ptr))
}

func (t *Terminal) IsAlternate() (bool, error) {
	ptr, err := t.alloc(4)
	if err != nil {
		return false, err
	}
	defer t.free(ptr, 4)
	if err = t.ok("ghostty_terminal_get", uint64(t.handle), 6, uint64(ptr)); err != nil {
		return false, err
	}
	value, _ := t.module.Memory().ReadUint32Le(ptr)
	return value == 1, nil
}

// FormatVTState reads both screens without mutating the parser, active screen
// or live history. Synthetic screen-switch bytes exist only in its output.
func (t *Terminal) FormatVTState() ([]byte, error) {
	output, err := t.alloc(8)
	if err != nil {
		return nil, err
	}
	defer t.free(output, 8)
	if err = t.ok("ghostty_phi_state_format_alloc", uint64(t.handle), 0, uint64(output), uint64(output+4)); err != nil {
		return nil, err
	}
	ptr, _ := t.module.Memory().ReadUint32Le(output)
	size, _ := t.module.Memory().ReadUint32Le(output + 4)
	defer t.call("ghostty_free", 0, uint64(ptr), uint64(size))
	data, ok := t.module.Memory().Read(ptr, size)
	if !ok {
		return nil, fmt.Errorf("formatter state bounds")
	}
	return append([]byte(nil), data...), nil
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
	opts, err := t.alloc(40)
	if err != nil {
		return nil, err
	}
	defer t.free(opts, 40)
	mem := t.module.Memory()
	mem.Write(opts, make([]byte, 40))
	mem.WriteUint32Le(opts, 40)
	mem.WriteUint32Le(opts+4, 1)
	mem.WriteUint32Le(opts+12, 24)
	for _, off := range []uint32{16, 17, 18, 19, 20, 21} {
		mem.WriteByte(opts+off, 1)
	}
	mem.WriteUint32Le(opts+24, 16)
	for _, off := range []uint32{28, 29, 30, 31, 32, 33} {
		mem.WriteByte(opts+off, 1)
	}
	slot, err := t.alloc(4)
	if err != nil {
		return nil, err
	}
	defer t.free(slot, 4)
	if err = t.ok("ghostty_formatter_terminal_screen_new", 0, uint64(slot), uint64(t.handle), uint64(opts)); err != nil {
		return nil, err
	}
	formatter, _ := mem.ReadUint32Le(slot)
	defer t.call("ghostty_formatter_free", uint64(formatter))
	output, err := t.alloc(8)
	if err != nil {
		return nil, err
	}
	defer t.free(output, 8)
	if err = t.ok("ghostty_formatter_format_alloc", uint64(formatter), 0, uint64(output), uint64(output+4)); err != nil {
		return nil, err
	}
	ptr, _ := mem.ReadUint32Le(output)
	size, _ := mem.ReadUint32Le(output + 4)
	defer t.call("ghostty_free", 0, uint64(ptr), uint64(size))
	data, ok := mem.Read(ptr, size)
	if !ok {
		return nil, fmt.Errorf("formatter bounds")
	}
	return append([]byte(nil), data...), nil
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
	ptr, err := t.alloc(4)
	if err != nil {
		return 0, err
	}
	defer t.free(ptr, 4)
	if err = t.ok("ghostty_terminal_get", uint64(t.handle), 15, uint64(ptr)); err != nil {
		return 0, err
	}
	rows, _ := t.module.Memory().ReadUint32Le(ptr)
	return rows, nil
}

func (t *Terminal) Ready() ([]byte, error) {
	slot, err := t.alloc(8)
	if err != nil {
		return nil, err
	}
	defer t.free(slot, 8)
	if err = t.ok("ghostty_snapshot_encode_ready_alloc", uint64(t.handle), 0, uint64(slot), uint64(slot+4)); err != nil {
		return nil, err
	}
	ptr, _ := t.module.Memory().ReadUint32Le(slot)
	size, _ := t.module.Memory().ReadUint32Le(slot + 4)
	defer t.call("ghostty_free", 0, uint64(ptr), uint64(size))
	data, ok := t.module.Memory().Read(ptr, size)
	if !ok {
		return nil, fmt.Errorf("snapshot bounds")
	}
	end, err := ReadyEnd(data)
	if err != nil {
		return nil, err
	}
	return append([]byte(nil), data[:end]...), nil
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
	if _, err := ReadyEnd(data); err != nil {
		return err
	}
	ptr, err := t.alloc(uint32(len(data)))
	if err != nil {
		return err
	}
	defer t.free(ptr, uint32(len(data)))
	if !t.module.Memory().Write(ptr, data) {
		return fmt.Errorf("restore memory bounds")
	}
	slot, err := t.alloc(12)
	if err != nil {
		return err
	}
	defer t.free(slot, 12)
	if err = t.ok("ghostty_snapshot_decoder_new_buf", 0, uint64(slot), uint64(ptr), uint64(len(data))); err != nil {
		return err
	}
	decoder, _ := t.module.Memory().ReadUint32Le(slot)
	defer t.call("ghostty_snapshot_decoder_free", uint64(decoder))
	t.module.Memory().WriteUint32Le(slot+8, 1)
	if err = t.ok("ghostty_snapshot_decoder_set", uint64(decoder), 1, uint64(slot+8)); err != nil {
		return err
	}
	if err = t.ok("ghostty_snapshot_decoder_ready", uint64(decoder), uint64(slot+4)); err != nil {
		return err
	}
	replacement, _ := t.module.Memory().ReadUint32Le(slot + 4)
	_, _ = t.call("ghostty_terminal_free", uint64(t.handle))
	t.handle = replacement
	for id, target := range map[uint64]*int{1: &t.cols, 2: &t.rows} {
		if err = t.ok("ghostty_terminal_get", uint64(t.handle), id, uint64(slot+8)); err != nil {
			return err
		}
		n, _ := t.module.Memory().ReadUint16Le(slot + 8)
		*target = int(n)
	}
	return nil
}
func (t *Terminal) Close() error {
	if t.module == nil {
		return nil
	}
	_, _ = t.call("ghostty_terminal_free", uint64(t.handle))
	err := t.module.Close(context.Background())
	t.module = nil
	return err
}
