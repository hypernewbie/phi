package ws

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/hypernewbie/phi/internal/termstate"
)

const stateAnchorInterval = 2 << 20
const stateAnchorBudget = 32 << 20
const stateAnchorCount = 32
const historyCheckpointRows = 1024

// ErrStatePositionMismatch distinguishes a different lifetime/frontier from
// a retryable recording or parser reconstruction failure.
var ErrStatePositionMismatch = errors.New("archive position mismatch")

type stateAnchor struct {
	through    uint64
	compressed []byte
	path       string
}

func (ph *PaneHub) addStateAnchorLocked() error {
	if ph.state == nil {
		return fmt.Errorf("live state unavailable")
	}
	snapshot, err := ph.state.Ready()
	if err != nil {
		return err
	}
	var buffer bytes.Buffer
	writer, _ := gzip.NewWriterLevel(&buffer, gzip.BestSpeed)
	if _, err = writer.Write(snapshot); err != nil {
		return err
	}
	if err = writer.Close(); err != nil {
		return err
	}
	if n := len(ph.stateAnchors); n > 0 && ph.stateAnchors[n-1].through == ph.stateHead {
		ph.stateAnchorBytes -= len(ph.stateAnchors[n-1].compressed)
		ph.stateAnchors = ph.stateAnchors[:n-1]
	}
	ph.stateAnchors = append(ph.stateAnchors, stateAnchor{through: ph.stateHead, compressed: append([]byte(nil), buffer.Bytes()...)})
	ph.stateAnchorBytes += len(buffer.Bytes())
	for len(ph.stateAnchors) > stateAnchorCount || ph.stateAnchorBytes > stateAnchorBudget {
		ph.stateAnchorBytes -= len(ph.stateAnchors[0].compressed)
		ph.stateAnchors[0] = stateAnchor{} // Release evicted payloads, not just the slice view.
		ph.stateAnchors = ph.stateAnchors[1:]
	}
	if ph.statePath != "" {
		_ = saveAnchorFile(filepath.Join(ph.statePath+".d", fmt.Sprintf("%020d.state", ph.stateHead)), buffer.Bytes())
		_ = saveStateAnchors(ph.statePath, ph.stateAnchors)
	}
	return nil
}
func (ph *PaneHub) nearestStateAnchor(through uint64) (stateAnchor, bool) {
	var best stateAnchor
	found := false
	for i := range ph.stateAnchors {
		if ph.stateAnchors[i].through <= through && (!found || ph.stateAnchors[i].through > best.through) {
			best = ph.stateAnchors[i]
			found = true
		}
	}
	if found {
		return best, true
	}
	if ph.statePath == "" {
		return stateAnchor{}, false
	}
	dir := ph.statePath + ".d"
	entries, err := os.ReadDir(dir)
	if err != nil {
		return stateAnchor{}, false
	}
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		name := strings.TrimSuffix(entry.Name(), ".state")
		sequence, e := strconv.ParseUint(name, 10, 64)
		if e == nil && sequence <= through && (!found || sequence > best.through) {
			best = stateAnchor{through: sequence, path: filepath.Join(dir, entry.Name())}
			found = true
		}
	}
	if !found {
		return stateAnchor{}, false
	}
	// Acceleration files are not source authority. Ignore corrupt/oversized
	// entries instead of allowing a metadata file to exhaust server memory.
	info, err := os.Stat(best.path)
	if err != nil || !info.Mode().IsRegular() || info.Size() <= 0 || info.Size() > stateAnchorBudget {
		return stateAnchor{}, false
	}
	data, err := os.ReadFile(best.path)
	if err != nil {
		return stateAnchor{}, false
	}
	best.compressed = data
	return best, true
}
func (ph *PaneHub) loadStateAnchorsLocked() {
	if ph.stateAnchorsLoaded || ph.statePath == "" {
		return
	}
	ph.stateAnchors, ph.stateAnchorBytes, _ = loadStateAnchors(ph.statePath)
	ph.stateAnchorsLoaded = true
}

func restoreAnchor(data []byte) ([]byte, error) {
	r, err := gzip.NewReader(bytes.NewReader(data))
	if err != nil {
		return nil, err
	}
	defer r.Close()
	return io.ReadAll(io.LimitReader(r, 64<<20))
}

func encodeStateAnchors(anchors []stateAnchor) []byte {
	size := 8
	for _, a := range anchors {
		size += 12 + len(a.compressed)
	}
	out := make([]byte, size)
	copy(out, "PHI1")
	binary.LittleEndian.PutUint32(out[4:8], uint32(len(anchors)))
	at := 8
	for _, a := range anchors {
		binary.LittleEndian.PutUint64(out[at:at+8], a.through)
		binary.LittleEndian.PutUint32(out[at+8:at+12], uint32(len(a.compressed)))
		copy(out[at+12:], a.compressed)
		at += 12 + len(a.compressed)
	}
	return out
}
func decodeStateAnchors(data []byte) ([]stateAnchor, int, error) {
	if len(data) < 8 || string(data[:4]) != "PHI1" {
		return nil, 0, fmt.Errorf("invalid parser checkpoint file")
	}
	count := int(binary.LittleEndian.Uint32(data[4:8]))
	if count > stateAnchorCount {
		return nil, 0, fmt.Errorf("too many parser checkpoints")
	}
	at, total := 8, 0
	anchors := make([]stateAnchor, 0, count)
	for range count {
		if at+12 > len(data) {
			return nil, 0, io.ErrUnexpectedEOF
		}
		through := binary.LittleEndian.Uint64(data[at : at+8])
		n := int(binary.LittleEndian.Uint32(data[at+8 : at+12]))
		at += 12
		if n < 0 || at+n > len(data) || total+n > stateAnchorBudget {
			return nil, 0, fmt.Errorf("invalid parser checkpoint length")
		}
		anchors = append(anchors, stateAnchor{through: through, compressed: append([]byte(nil), data[at:at+n]...)})
		total += n
		at += n
	}
	if at != len(data) {
		return nil, 0, fmt.Errorf("trailing parser checkpoint bytes")
	}
	return anchors, total, nil
}
func loadStateAnchors(path string) ([]stateAnchor, int, error) {
	info, err := os.Stat(path)
	if err != nil {
		return nil, 0, err
	}
	if info.Size() < 8 || info.Size() > stateAnchorBudget+stateAnchorCount*12+8 {
		return nil, 0, fmt.Errorf("invalid parser checkpoint size")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, 0, err
	}
	return decodeStateAnchors(data)
}
func saveAnchorFile(path string, data []byte) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	if err := os.Chmod(dir, 0700); err != nil {
		return err
	}
	file, err := os.CreateTemp(dir, ".phi-anchor-*")
	if err != nil {
		return err
	}
	name := file.Name()
	defer os.Remove(name)
	if err = file.Chmod(0600); err != nil {
		file.Close()
		return err
	}
	if _, err = file.Write(data); err != nil {
		file.Close()
		return err
	}
	if err = file.Sync(); err != nil {
		file.Close()
		return err
	}
	if err = file.Close(); err != nil {
		return err
	}
	if err = os.Rename(name, path); err != nil {
		return err
	}
	if d, e := os.Open(dir); e == nil {
		_ = d.Sync()
		_ = d.Close()
	}
	return nil
}
func saveStateAnchors(path string, anchors []stateAnchor) error {
	data := encodeStateAnchors(anchors)
	dir := filepath.Dir(path)
	file, err := os.CreateTemp(dir, ".phi-state-*")
	if err != nil {
		return err
	}
	name := file.Name()
	defer os.Remove(name)
	if err = file.Chmod(0600); err != nil {
		file.Close()
		return err
	}
	if _, err = file.Write(data); err != nil {
		file.Close()
		return err
	}
	if err = file.Sync(); err != nil {
		file.Close()
		return err
	}
	if err = file.Close(); err != nil {
		return err
	}
	if err = os.Rename(name, path); err != nil {
		return err
	}
	if d, e := os.Open(dir); e == nil {
		_ = d.Sync()
		_ = d.Close()
	}
	return nil
}

// prepareStateLocked parses retained bytes on the server, never on attach's
// wire. New panes start this parser on their first output; attach sends state.
func (ph *PaneHub) prepareStateLocked() error {
	ph.loadStateAnchorsLocked()
	if ph.stateErr != nil {
		return ph.stateErr
	}
	if ph.state != nil && ph.stateHead == ph.total {
		return nil
	}
	if ph.state == nil {
		state, err := termstate.New(context.Background(), 80, 24)
		if err != nil {
			ph.stateErr = err
			return err
		}
		ph.state = state
		ph.stateHead = 0
		if anchor, ok := ph.nearestStateAnchor(ph.total); ok {
			snapshot, e := restoreAnchor(anchor.compressed)
			if e == nil {
				e = state.Restore(snapshot)
			}
			if e == nil {
				ph.stateHead = anchor.through
			} else {
				_ = state.Close()
				state, e = termstate.New(context.Background(), 80, 24)
				if e != nil {
					ph.stateErr = e
					return e
				}
				ph.state = state
				ph.stateAnchors = nil
				ph.stateAnchorBytes = 0
				ph.stateHead = 0
			}
		}
	}
	for ph.stateHead < ph.total {
		end := min(ph.total, ph.stateHead+(256<<10))
		data, resizes, err := ph.recording.read(ph.stateHead, end)
		if err != nil {
			return err
		}
		at := ph.stateHead
		for _, resize := range resizes {
			offset := max(at, resize.AtSeq)
			if offset > at {
				if err = ph.state.Feed(data[at-ph.stateHead : offset-ph.stateHead]); err != nil {
					return err
				}
				at = offset
			}
			if err = ph.state.Resize(int(resize.Cols), int(resize.Rows)); err != nil {
				return err
			}
		}
		if err = ph.state.Feed(data[at-ph.stateHead:]); err != nil {
			return err
		}
		ph.stateHead = end
	}
	if len(ph.stateAnchors) == 0 || ph.total-ph.stateAnchors[len(ph.stateAnchors)-1].through >= stateAnchorInterval {
		if err := ph.addStateAnchorLocked(); err != nil {
			return err
		}
	}
	return nil
}

// HistoricalState rebuilds only from the nearest persisted parser checkpoint.
// The append-only recording remains the source of every requested byte.
func (h *Hub) HistoricalState(paneID string, epoch, through uint64) (PanePosition, []byte, int, int, error) {
	return h.HistoricalStateContext(context.Background(), paneID, epoch, through)
}

// Historical reconstruction has its own parser. Hold the pane lock only for
// bounded journal reads, never for VT replay or snapshot formatting, so a
// history request cannot stall live ingestion. Request cancellation also
// cancels its WASM work; disposing the parser stays on this owner.
func (h *Hub) HistoricalStateContext(ctx context.Context, paneID string, epoch, through uint64) (PanePosition, []byte, int, int, error) {
	return h.historicalStateContext(ctx, paneID, epoch, through, false)
}

// HistoricalANSIStateContext exports the same exact parser position for xterm.
// It includes both screens and continuation, never the recording library.
func (h *Hub) HistoricalANSIStateContext(ctx context.Context, paneID string, epoch, through uint64) (PanePosition, []byte, int, int, error) {
	return h.historicalStateContext(ctx, paneID, epoch, through, true)
}

func (h *Hub) historicalStateContext(ctx context.Context, paneID string, epoch, through uint64, ansi bool) (PanePosition, []byte, int, int, error) {
	ph := h.recordingForRead(paneID)
	if ph == nil {
		return PanePosition{}, nil, 0, 0, fmt.Errorf("pane recording unavailable")
	}
	if err := ctx.Err(); err != nil {
		return PanePosition{}, nil, 0, 0, err
	}
	ph.mu.Lock()
	ph.loadStateAnchorsLocked()
	pos := ph.positionLocked()
	if epoch != pos.Epoch || through > pos.Head {
		ph.mu.Unlock()
		return pos, nil, 0, 0, ErrStatePositionMismatch
	}
	anchor, haveAnchor := ph.nearestStateAnchor(through)
	ph.mu.Unlock()
	state, err := termstate.New(ctx, 80, 24)
	if err != nil {
		return pos, nil, 0, 0, err
	}
	defer func() {
		if state != nil {
			_ = state.Close()
		}
	}()
	from := uint64(0)
	if haveAnchor {
		snapshot, e := restoreAnchor(anchor.compressed)
		if e == nil {
			e = state.Restore(snapshot)
		}
		if e == nil {
			from = anchor.through
		} else {
			_ = state.Close()
			state, err = termstate.New(ctx, 80, 24)
			if err != nil {
				return pos, nil, 0, 0, err
			}
			from = 0
		}
	}
	for from < through {
		if err := ctx.Err(); err != nil {
			return pos, nil, 0, 0, err
		}
		end := min(through, from+(256<<10))
		ph.mu.Lock()
		if ph.epoch != epoch {
			ph.mu.Unlock()
			return pos, nil, 0, 0, ErrStatePositionMismatch
		}
		data, resizes, e := ph.recording.read(from, end)
		ph.mu.Unlock()
		if e != nil {
			return pos, nil, 0, 0, e
		}
		at := from
		for _, r := range resizes {
			offset := max(at, r.AtSeq)
			if offset > at {
				if err = state.Feed(data[at-from : offset-from]); err != nil {
					return pos, nil, 0, 0, err
				}
				at = offset
			}
			cols, rows := state.Geometry()
			if cols != int(r.Cols) || rows != int(r.Rows) {
				if err = state.Resize(int(r.Cols), int(r.Rows)); err != nil {
					return pos, nil, 0, 0, err
				}
			}
		}
		if err = state.Feed(data[at-from:]); err != nil {
			return pos, nil, 0, 0, err
		}
		from = end
	}
	var snapshot []byte
	if ansi {
		snapshot, err = state.FormatVTState()
	} else {
		snapshot, err = state.ReadyWindow(historyCheckpointRows)
	}
	cols, rows := state.Geometry()
	ph.mu.Lock()
	currentEpoch := ph.epoch
	ph.mu.Unlock()
	if currentEpoch != epoch {
		return pos, nil, 0, 0, ErrStatePositionMismatch
	}
	pos.Head = through
	return pos, snapshot, cols, rows, err
}

// LiveANSIState returns an atomic current screen/continuation frontier for
// xterm returning from an archive. It does not replay the time spent browsing.
func (h *Hub) LiveANSIState(paneID string, epoch uint64) (PanePosition, []byte, int, int, error) {
	ph := h.recordingForRead(paneID)
	if ph == nil {
		return PanePosition{}, nil, 0, 0, fmt.Errorf("pane recording unavailable")
	}
	ph.mu.Lock()
	defer ph.mu.Unlock()
	pos := ph.positionLocked()
	if pos.Epoch != epoch {
		return pos, nil, 0, 0, ErrStatePositionMismatch
	}
	if err := ph.prepareStateLocked(); err != nil {
		return pos, nil, 0, 0, err
	}
	data, err := ph.state.FormatVTState()
	cols, rows := ph.state.Geometry()
	return pos, data, cols, rows, err
}

// State returns a bounded live snapshot, not recording bytes.
func (h *Hub) State(paneID string) (PanePosition, []byte, int, int, error) {
	ph := h.recordingForRead(paneID)
	if ph == nil {
		return PanePosition{}, nil, 0, 0, fmt.Errorf("pane recording unavailable")
	}
	ph.mu.Lock()
	defer ph.mu.Unlock()
	if err := ph.prepareStateLocked(); err != nil {
		return PanePosition{}, nil, 0, 0, err
	}
	snapshot, err := ph.state.Ready()
	cols, rows := ph.state.Geometry()
	return ph.positionLocked(), snapshot, cols, rows, err
}
