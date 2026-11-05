package ws

// replayWindow is the RAM-only retained-output authority for one pane.
//
// It holds at most capBytes of recent output plus the resize markers that
// order that output. Nothing here touches disk: a restart loses the
// window, which is the accepted contract.
//
// Positions are absolute byte sequences over the pane lifetime. Head is
// the count of bytes ever admitted; a retained byte at position p lives
// in the ring at p-floor(). Both floors only move forward.
type replayWindow struct {
	ring *RingBuffer

	// head is one past the newest admitted byte.
	head uint64

	// resizes holds retained markers in ascending AtSeq order. Marker
	// absolute ordinals are 1-based: resizes[0] has ordinal floorOrd+1.
	resizes []ResizeMarker

	// floorOrd counts markers dropped from the front. Any marker still
	// in resizes has an ordinal above it.
	floorOrd uint64

	// metaFloor is the first byte whose geometry is still certified. It
	// is zero unless marker-cap eviction dropped markers whose geometry
	// covered later bytes; then replay starts at the oldest retained
	// marker so no byte is replayed under the wrong grid.
	metaFloor uint64

	// baseCols/baseRows are the geometry in effect at the current floor,
	// so a replay that starts at the floor knows its starting grid
	// without any marker before it.
	baseCols uint16
	baseRows uint16
}

const (
	// replayWindowMaxBytes is the hard ceiling for one pane's retained
	// output, independent of configuration.
	replayWindowMaxBytes = 32 << 20

	// replayWindowResizeCap bounds retained resize markers. Crossing it
	// drops down to replayWindowResizeKeep, and the floor rises to the
	// oldest retained marker so no byte is replayed under wrong geometry.
	replayWindowResizeCap  = 16384
	replayWindowResizeKeep = 8192
)

// newReplayWindow creates a window with the given retained-byte capacity
// and spawn geometry. A nonpositive capacity disables retention but keeps
// geometry bookkeeping; the pane still produces correct live output.
func newReplayWindow(capacity int, cols, rows uint16) *replayWindow {
	if capacity > replayWindowMaxBytes {
		capacity = replayWindowMaxBytes
	}
	if capacity < 0 {
		capacity = 0
	}
	w := &replayWindow{baseCols: cols, baseRows: rows}
	if capacity > 0 {
		w.ring = NewRingBuffer(capacity)
	}
	return w
}

// capacity reports the ring capacity in bytes, zero when disabled.
func (w *replayWindow) capacity() int {
	if w == nil || w.ring == nil {
		return 0
	}
	_, capBytes := w.ring.Stats()
	return capBytes
}

// used reports the number of retained bytes.
func (w *replayWindow) used() int {
	if w == nil || w.ring == nil {
		return 0
	}
	used, _ := w.ring.Stats()
	return used
}

// physicalFloor is the first byte the ring still holds. With retention
// disabled every byte has expired, so the floor equals head.
func (w *replayWindow) physicalFloor() uint64 {
	used := uint64(w.used())
	if used >= w.head {
		return 0
	}
	return w.head - used
}

// floor is the first byte a replay can serve. It is the physical floor,
// raised to the oldest retained marker when marker eviction would
// otherwise replay bytes under unknown geometry.
func (w *replayWindow) floor() uint64 {
	floor := w.physicalFloor()
	if w.metaFloor > floor {
		return w.metaFloor
	}
	return floor
}

// write admits output bytes. Callers hold the pane lock.
func (w *replayWindow) write(p []byte) {
	if w == nil || len(p) == 0 {
		return
	}
	if w.ring != nil {
		w.ring.Write(p)
	}
	w.head += uint64(len(p))
	w.dropExpiredMarkers()
}

// dropExpiredMarkers raises the base geometry past bytes the ring has
// already released and forgets the corresponding markers.
func (w *replayWindow) dropExpiredMarkers() {
	floor := w.physicalFloor()
	drop := 0
	for drop < len(w.resizes) && w.resizes[drop].AtSeq < floor {
		drop++
	}
	if drop == 0 {
		return
	}
	last := w.resizes[drop-1]
	w.baseCols, w.baseRows = last.Cols, last.Rows
	w.floorOrd += uint64(drop)
	w.resizes = w.resizes[drop:]
	w.compactMarkers()
}

// compactMarkers moves the retained tail back to the start of the slice
// so repeated rollover does not grow the backing array.
func (w *replayWindow) compactMarkers() {
	if len(w.resizes) == 0 || cap(w.resizes) <= replayWindowResizeCap {
		return
	}
	retained := make([]ResizeMarker, len(w.resizes))
	copy(retained, w.resizes)
	w.resizes = retained
}

// appendResize records a backend resize at the current head. A repeat of
// the geometry already in effect records nothing and returns changed
// false. When marker capacity is exceeded, the oldest markers are dropped
// and the floor rises to the oldest retained marker.
func (w *replayWindow) appendResize(cols, rows uint16) (ResizeMarker, uint64, bool) {
	pos := w.head
	if len(w.resizes) > 0 {
		last := w.resizes[len(w.resizes)-1]
		if last.Cols == cols && last.Rows == rows {
			return ResizeMarker{AtSeq: pos, Cols: cols, Rows: rows}, w.floorOrd + uint64(len(w.resizes)), false
		}
	} else if w.baseCols == cols && w.baseRows == rows {
		return ResizeMarker{AtSeq: pos, Cols: cols, Rows: rows}, w.floorOrd, false
	}
	marker := ResizeMarker{AtSeq: pos, Cols: cols, Rows: rows}
	w.resizes = append(w.resizes, marker)
	if len(w.resizes) > replayWindowResizeCap {
		drop := len(w.resizes) - replayWindowResizeKeep
		// The oldest retained marker defines the certified floor and its
		// own geometry, so bytes below it are not replayed under a grid
		// the server can no longer certify.
		w.metaFloor = w.resizes[drop].AtSeq
		w.baseCols, w.baseRows = w.resizes[drop].Cols, w.resizes[drop].Rows
		w.floorOrd += uint64(drop)
		w.resizes = w.resizes[drop:]
		w.compactMarkers()
	}
	return marker, w.floorOrd + uint64(len(w.resizes)), true
}

// initialGeometry is the grid in effect at the replay floor.
func (w *replayWindow) initialGeometry() (uint16, uint16) {
	return w.baseCols, w.baseRows
}

// geometryAt reports the grid in effect at pos.
func (w *replayWindow) geometryAt(pos uint64) (uint16, uint16) {
	cols, rows := w.baseCols, w.baseRows
	for _, m := range w.resizes {
		if m.AtSeq > pos {
			break
		}
		cols, rows = m.Cols, m.Rows
	}
	return cols, rows
}

// lastOrdinal is the ordinal of the newest recorded marker.
func (w *replayWindow) lastOrdinal() uint64 {
	return w.floorOrd + uint64(len(w.resizes))
}

// ordinalAt reports how many markers had taken effect at pos.
func (w *replayWindow) ordinalAt(pos uint64) uint64 {
	ord := w.floorOrd
	for _, m := range w.resizes {
		if m.AtSeq > pos {
			break
		}
		ord++
	}
	return ord
}

// validFence reports whether ord is a boundary a position can certify:
// it must include every marker before pos and may exclude markers that
// land exactly at pos, never one from an earlier position.
func (w *replayWindow) validFence(pos, ord uint64) bool {
	before := w.floorOrd
	atOrBefore := w.floorOrd
	for _, m := range w.resizes {
		if m.AtSeq < pos {
			before++
			atOrBefore++
			continue
		}
		if m.AtSeq == pos {
			atOrBefore++
		}
	}
	return ord >= before && ord <= atOrBefore
}

// rangeView returns the retained bytes [from, through). The caller holds
// the pane lock and has already checked the floor.
func (w *replayWindow) rangeView(from, through uint64) []byte {
	if through <= from || w.ring == nil {
		return nil
	}
	floor := w.physicalFloor()
	if from < floor {
		return nil
	}
	return w.ring.RangeView(int(from-floor), int(through-floor))
}

// markersBetween returns retained markers in [from, through] whose
// ordinal is above afterOrdinal and at or below throughOrdinal, plus the
// last applied ordinal.
func (w *replayWindow) markersBetween(from, through, afterOrdinal, throughOrdinal uint64) ([]ResizeMarker, uint64) {
	endOrdinal := afterOrdinal
	var out []ResizeMarker
	for i, m := range w.resizes {
		ordinal := w.floorOrd + uint64(i) + 1
		if ordinal <= afterOrdinal {
			continue
		}
		if ordinal > throughOrdinal || m.AtSeq > through {
			break
		}
		if m.AtSeq < from {
			// A marker before the page start only establishes the
			// starting grid; report it so the client applies the same
			// geometry the server certified.
			out = append(out, m)
			endOrdinal = ordinal
			continue
		}
		out = append(out, m)
		endOrdinal = ordinal
	}
	return out, endOrdinal
}
