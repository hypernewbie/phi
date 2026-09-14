package ws

import (
	"crypto/rand"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"log"
	"log/slog"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

// componentLogger returns the "ws" component-tagged base logger, derived
// from whatever slog.Default() currently is. Deliberately NOT a package
// var baked in at init time: package-level vars in an imported package
// initialize before main() runs, i.e. before initLogging() installs the
// real handler (and before a test's installRecordingHandler swaps the
// default) — a cached var would permanently hold the wrong handler and
// silently stop honoring --log-level / PHI_LOG_FORMAT, or drop out of a
// test's recorder entirely. Recomputing per call is cheap (called once per
// connection/pane, never per frame) and always reflects the live default.
func componentLogger() *slog.Logger {
	return slog.Default().With("comp", "ws")
}

type Client struct {
	Ws              *websocket.Conn
	Send            chan []byte
	LastDropWarning time.Time
	FullSince       time.Time

	// Hot marks a hot-v1 terminal-protocol attachment (term_proto=hot-v1
	// on /ws/pane). Hot clients receive 0x08 ATTACH_HEAD at attach and
	// 0x09 LIVE_OUTPUT frames thereafter, instead of the legacy 1 MiB
	// replay + 0x01 frames.
	Hot bool

	// Logger carries this client's comp=ws + conn+pane fields (set by
	// HandleWS, built on componentLogger()) so every log line for its
	// lifetime — writes, overflow, frame traces — correlates back to the
	// same connection. Nil for Clients built directly in tests; logger()
	// falls back to componentLogger().
	Logger *slog.Logger
}

// logger returns c.Logger if set, else componentLogger() — nil-safe so
// tests that construct a bare &Client{} keep working unchanged.
func (c *Client) logger() *slog.Logger {
	if c != nil && c.Logger != nil {
		return c.Logger
	}
	return componentLogger()
}

// ResizeMarker records a backend resize at the output sequence where it
// took effect: every byte at seq >= AtSeq was produced under ColsxRows.
// Archive replay applies markers in order so history reflows the way the
// live terminal did.
type ResizeMarker struct {
	AtSeq uint64
	Cols  uint16
	Rows  uint16
}

// paneCheckpoint is the newest client-uploaded screen snapshot. ANSI is
// stored opaquely; the server never parses it.
type paneCheckpoint struct {
	Through uint64 // output seq the snapshot reflects (exclusive head)
	Cols    uint16
	Rows    uint16
	Ansi    []byte
}

type PaneHub struct {
	clients map[*Client]bool
	mu      sync.Mutex
	Ring    *RingBuffer

	// epoch changes identity: a fresh random value per pane creation, so
	// stale clients/caches cannot mix output from a previous PTY lifetime
	// under the same pane id.
	epoch uint64

	// total is the head output sequence: the count of bytes ever ingested
	// for this pane. Bytes carry absolute seqs [0, total); oldest retained
	// is total - retained.
	total uint64

	// resizes is a bounded FIFO of resize markers ordered by AtSeq.
	resizes []ResizeMarker

	// ckpt is the newest accepted client checkpoint, if any.
	ckpt *paneCheckpoint
}

const maxResizeMarkers = 512

type Hub struct {
	panes             map[string]*PaneHub
	mu                sync.RWMutex
	replayBufferBytes int
}

func NewHub(replayBufferBytes int) *Hub {
	return &Hub{
		panes:             make(map[string]*PaneHub),
		replayBufferBytes: replayBufferBytes,
	}
}

func (h *Hub) SetReplayBufferBytes(bytes int) {
	h.mu.Lock()
	h.replayBufferBytes = bytes
	h.mu.Unlock()
}

func (h *Hub) GetOrCreatePaneHub(paneID string) *PaneHub {
	h.mu.Lock()
	defer h.mu.Unlock()

	ph, exists := h.panes[paneID]
	if !exists {
		var ring *RingBuffer
		if h.replayBufferBytes > 0 {
			ring = NewRingBuffer(h.replayBufferBytes)
		}
		ph = &PaneHub{
			clients: make(map[*Client]bool),
			Ring:    ring,
			epoch:   randomEpoch(),
		}
		h.panes[paneID] = ph
	}
	return ph
}

func randomEpoch() uint64 {
	var b [8]byte
	if _, err := rand.Read(b[:]); err == nil {
		return binary.BigEndian.Uint64(b[:])
	}
	n := time.Now().UnixNano()
	return uint64(n)<<32 | uint64(n>>32)
}

// LookupPane returns the pane hub without creating one.
func (h *Hub) LookupPane(paneID string) (*PaneHub, bool) {
	h.mu.RLock()
	defer h.mu.RUnlock()
	ph, ok := h.panes[paneID]
	return ph, ok
}

// EpochOf exposes the pane identity epoch for diagnostics/tests.
func (ph *PaneHub) EpochOf() uint64 {
	ph.mu.Lock()
	defer ph.mu.Unlock()
	return ph.epoch
}

func (h *Hub) Register(paneID string, client *Client) {
	ph := h.GetOrCreatePaneHub(paneID)
	ph.mu.Lock()
	ph.clients[client] = true
	ph.mu.Unlock()
	log.Printf("[ws] Registered client for pane %s", paneID)
}

// PanePosition is the seq-space snapshot a hot attach or recording read
// is taken against. Oldest is the first retained byte seq, Head is one
// past the newest byte (so live output resumes at exactly Head).
type PanePosition struct {
	Epoch  uint64
	Oldest uint64
	Head   uint64
}

// positionLocked reads the pane's seq state under ph.mu.
func (ph *PaneHub) positionLocked() PanePosition {
	retained := uint64(0)
	if ph.Ring != nil {
		used, _ := ph.Ring.Stats()
		retained = uint64(used)
	}
	oldest := ph.total
	if retained > ph.total {
		retained = ph.total
	}
	oldest = ph.total - retained
	return PanePosition{Epoch: ph.epoch, Oldest: oldest, Head: ph.total}
}

// attachHeadJSON is the JSON header carried by the 0x08 ATTACH_HEAD frame
// and by the /recording HTTP response. In ATTACH_HEAD, Checkpoint is nil
// unless a usable client snapshot exists, in which case the raw ANSI bytes
// follow the JSON header in the same frame.
type attachHeadJSON struct {
	Epoch  uint64          `json:"epoch"`
	Oldest uint64          `json:"oldest"`
	Head   uint64          `json:"head"`
	Ckpt   *checkpointJSON `json:"ckpt,omitempty"`
}

type checkpointJSON struct {
	Through uint64 `json:"through"`
	Cols    uint16 `json:"cols"`
	Rows    uint16 `json:"rows"`
	Len     int    `json:"len"`
}

// RecordingHeaderJSON is the header of the /recording HTTP response; raw
// bytes follow it in the body, exactly as with ATTACH_HEAD.
type RecordingHeaderJSON struct {
	Epoch   uint64      `json:"epoch"`
	Start   uint64      `json:"start"`
	End     uint64      `json:"end"`
	Resizes [][3]uint64 `json:"resizes"` // [atSeq, cols, rows]
}

// frameFramedJSON builds [msgType][u32 jsonLen BE][json bytes][extra bytes].
func frameFramedJSON(msgType byte, v any, extra []byte) []byte {
	j, err := json.Marshal(v)
	if err != nil {
		return nil
	}
	frame := make([]byte, 1+4+len(j)+len(extra))
	frame[0] = msgType
	binary.BigEndian.PutUint32(frame[1:5], uint32(len(j)))
	copy(frame[5:], j)
	copy(frame[5+len(j):], extra)
	return frame
}

// AttachHot registers a hot-v1 client and enqueues its 0x08 ATTACH_HEAD
// frame. Registration and the head capture happen under the pane lock, so
// the client is guaranteed to receive every 0x09 LIVE_OUTPUT frame with
// startSeq >= Head: the boundary is atomic, no gap, no duplication.
// Nothing from before Head is pushed — history stays off the live path.
func (h *Hub) AttachHot(paneID string, client *Client) {
	ph := h.GetOrCreatePaneHub(paneID)
	ph.mu.Lock()
	pos := ph.positionLocked()

	hdr := attachHeadJSON{Epoch: pos.Epoch, Oldest: pos.Oldest, Head: pos.Head}
	var extra []byte
	if ph.ckpt != nil && ph.ckpt.Through <= pos.Head {
		hdr.Ckpt = &checkpointJSON{
			Through: ph.ckpt.Through,
			Cols:    ph.ckpt.Cols,
			Rows:    ph.ckpt.Rows,
			Len:     len(ph.ckpt.Ansi),
		}
		extra = ph.ckpt.Ansi
	}
	frame := frameFramedJSON(0x08, hdr, extra)
	if frame != nil {
		client.Send <- frame
	}

	client.Hot = true
	ph.clients[client] = true
	ph.mu.Unlock()
	log.Printf("[ws] Registered hot-v1 client for pane %s (epoch %d, head %d, live-only)", paneID, pos.Epoch, pos.Head)
}

// RecordResize notes a backend resize at the pane's current head seq.
// Called from ReadPump when the client resizes; the marker orders resizes
// against output for archive replay. Idempotent for consecutive
// same-size resizes (TUI redraw nudges) to keep the ring small.
func (h *Hub) RecordResize(paneID string, cols, rows uint16) {
	ph := h.GetOrCreatePaneHub(paneID)
	ph.mu.Lock()
	defer ph.mu.Unlock()
	if n := len(ph.resizes); n > 0 {
		last := ph.resizes[n-1]
		if last.Cols == cols && last.Rows == rows {
			return
		}
	}
	ph.resizes = append(ph.resizes, ResizeMarker{AtSeq: ph.total, Cols: cols, Rows: rows})
	if len(ph.resizes) > maxResizeMarkers {
		ph.resizes = ph.resizes[len(ph.resizes)-maxResizeMarkers:]
	}
}

// Recording is the server's bounded terminal recording read (plan §5):
// raw output bytes for [from, min(through, head)) plus the resize markers
// that fall inside that span. from is clamped up to oldest so a caller can
// discover truncation by comparing Start with its requested from.
type Recording struct {
	Epoch   uint64
	Start   uint64
	End     uint64
	Data    []byte
	Resizes []ResizeMarker
}

func (h *Hub) Recording(paneID string, from, through uint64) (Recording, bool) {
	ph, ok := h.LookupPane(paneID)
	if !ok {
		return Recording{}, false
	}
	ph.mu.Lock()
	defer ph.mu.Unlock()

	pos := ph.positionLocked()
	if from > pos.Head {
		return Recording{}, false
	}
	if from < pos.Oldest {
		from = pos.Oldest
	}
	end := through
	if end > pos.Head {
		end = pos.Head
	}
	rec := Recording{Epoch: pos.Epoch, Start: from, End: end}
	if end > from && ph.Ring != nil {
		rec.Data = ph.Ring.RangeView(int(from-pos.Oldest), int(end-pos.Oldest))
	}
	for _, m := range ph.resizes {
		if m.AtSeq >= from && m.AtSeq <= end {
			rec.Resizes = append(rec.Resizes, m)
		}
	}
	return rec, true
}

// MaxCheckpointBytes bounds client-uploaded screen snapshots.
const MaxCheckpointBytes = 128 * 1024

// StoreCheckpoint validates and stores the newest client screen snapshot.
// Rules (plan §3): epoch must match the live pane, Through must not exceed
// the head, payloads are size-bounded, and only the newest valid
// checkpoint is kept. The ANSI bytes are stored opaquely.
type CheckpointUpload struct {
	Epoch   uint64
	Through uint64
	Cols    uint16
	Rows    uint16
	Ansi    []byte
}

func (h *Hub) StoreCheckpoint(paneID string, up CheckpointUpload) bool {
	ph, ok := h.LookupPane(paneID)
	if !ok {
		return false
	}
	ph.mu.Lock()
	defer ph.mu.Unlock()

	if up.Epoch != ph.epoch {
		return false
	}
	if up.Through > ph.total {
		return false
	}
	if up.Cols == 0 || up.Rows == 0 || len(up.Ansi) == 0 || len(up.Ansi) > MaxCheckpointBytes {
		return false
	}
	if ph.ckpt != nil && up.Through <= ph.ckpt.Through {
		// Stale or duplicate upload; keep the newer snapshot.
		return true
	}
	ans := make([]byte, len(up.Ansi))
	copy(ans, up.Ansi)
	ph.ckpt = &paneCheckpoint{Through: up.Through, Cols: up.Cols, Rows: up.Rows, Ansi: ans}
	return true
}

func (h *Hub) AttachWithReplay(paneID string, client *Client) {
	ph := h.GetOrCreatePaneHub(paneID)
	ph.mu.Lock()
	defer ph.mu.Unlock()

	// 1. Snapshot and replay history
	if ph.Ring != nil {
		snap := ph.Ring.Snapshot()
		if len(snap) > 0 {
			const chunkSize = 32 * 1024
			for i := 0; i < len(snap); i += chunkSize {
				end := i + chunkSize
				if end > len(snap) {
					end = len(snap)
				}
				chunk := snap[i:end]
				frame := make([]byte, len(chunk)+1)
				frame[0] = 0x01 // PTY Output Stdout
				copy(frame[1:], chunk)
				client.Send <- frame
			}
		}
	}

	// 2. Send 0x06 replay-complete frame
	client.Send <- []byte{0x06}

	// 3. Register for live updates
	ph.clients[client] = true
	log.Printf("[ws] Registered client for pane %s (with history replay)", paneID)
}

func (h *Hub) Unregister(paneID string, client *Client) {
	h.mu.RLock()
	ph, exists := h.panes[paneID]
	h.mu.RUnlock()

	if !exists {
		return
	}

	ph.mu.Lock()
	if _, ok := ph.clients[client]; ok {
		delete(ph.clients, client)
		close(client.Send)
	}
	ph.mu.Unlock()
	log.Printf("[ws] Unregistered client from pane %s", paneID)
}

// CloseAllClients closes every live WebSocket without deleting pane state.
// Callers use this when a security boundary changes (for example, Phi access
// password rotation) so connections authorized at handshake cannot outlive
// the session that authorized them. ReadPump performs normal unregistering.
func (h *Hub) CloseAllClients() {
	h.mu.RLock()
	defer h.mu.RUnlock()

	var clients []*Client
	for _, ph := range h.panes {
		ph.mu.Lock()
		for client := range ph.clients {
			clients = append(clients, client)
		}
		ph.mu.Unlock()
	}
	for _, client := range clients {
		if client.Ws != nil {
			_ = client.Ws.Close()
		}
	}
}

func (h *Hub) ClosePane(paneID string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	delete(h.panes, paneID)
	log.Printf("[ws] Closed pane %s and deleted its ring buffer", paneID)
}

// deliverOrDrop pushes msg to client's Send channel. If the channel is
// full, it drops the oldest queued frame(s) to make room (bounded to
// 100), injects a one-shot 5s-rate-limited "[phi: output dropped]" warning,
// and keeps the connection alive. Only after 30s of sustained fullness
// does it close the connection as a last resort. The PaneHub mu must be
// held when calling this (caller-side invariant: see Ingest/Broadcast).
func (h *Hub) deliverOrDrop(client *Client, msg []byte) {
	select {
	case client.Send <- msg:
		client.FullSince = time.Time{}
		return
	default:
	}

	now := time.Now()
	if client.FullSince.IsZero() {
		client.FullSince = now
	} else if now.Sub(client.FullSince) > 30*time.Second {
		client.logger().Warn("ws send buffer full for 30s+, closing connection")
		if client.Ws != nil {
			_ = client.Ws.Close()
		}
		return
	}

	dropped := 0
	for dropped < 100 {
		select {
		case <-client.Send:
			dropped++
		default:
		}
		select {
		case client.Send <- msg:
			client.FullSince = time.Time{}
			if dropped > 0 {
				client.logger().Warn("ws dropped stale frames for slow client, kept connection alive", "dropped", dropped)
			}
			return
		default:
			dropped++
		}
	}

	// Could not reclaim space in 100 drops: log and move on, will retry next tick.
	client.logger().Warn("ws send buffer still full after 100 drops, deferring frame")
	h.injectDropWarning(client, now)
}

// injectDropWarning delivers the rate-limited slow-client notice. Hot
// clients account for every byte by seq, so injecting warning text into
// the 0x09 stream would corrupt that accounting — they get a 0x02
// control frame the client renders itself, off the byte stream. Legacy
// clients keep the historical inline 0x01 text.
func (h *Hub) injectDropWarning(client *Client, now time.Time) {
	if now.Sub(client.LastDropWarning) <= 5*time.Second {
		return
	}
	client.LastDropWarning = now
	if client.Hot {
		warnCtl := frameFramedJSON(0x02, map[string]string{"type": "output-dropped"}, nil)
		if warnCtl != nil {
			select {
			case client.Send <- warnCtl:
			default:
			}
		}
		return
	}
	warningStr := "\r\n\x1b[33m[phi: output dropped — slow client]\x1b[0m\r\n"
	warningMsg := make([]byte, 1+len(warningStr))
	warningMsg[0] = 0x01
	copy(warningMsg[1:], warningStr)
	select {
	case client.Send <- warningMsg:
	default:
	}
}

func (h *Hub) Ingest(paneID string, payload []byte) {
	ph := h.GetOrCreatePaneHub(paneID)
	ph.mu.Lock()
	defer ph.mu.Unlock()

	// 1. Write to ring buffer and assign the absolute seq range
	start := ph.total
	if ph.Ring != nil {
		ph.Ring.Write(payload)
	}
	ph.total += uint64(len(payload))

	// 2. Broadcast to clients. Hot clients receive 0x09 LIVE_OUTPUT frames
	// with the seq prefix; legacy clients keep the bare 0x01 replay framing
	// so old cached pages keep working during migration.
	var legacyMsg, hotMsg []byte
	for client := range ph.clients {
		if client.Hot {
			if hotMsg == nil {
				hotMsg = make([]byte, 9+len(payload))
				hotMsg[0] = 0x09
				binary.BigEndian.PutUint64(hotMsg[1:9], start)
				copy(hotMsg[9:], payload)
			}
			h.deliverOrDrop(client, hotMsg)
		} else {
			if legacyMsg == nil {
				legacyMsg = make([]byte, len(payload)+1)
				legacyMsg[0] = 0x01
				copy(legacyMsg[1:], payload)
			}
			h.deliverOrDrop(client, legacyMsg)
		}
	}
}

func (h *Hub) Broadcast(paneID string, msgType byte, payload []byte) {
	h.mu.RLock()
	ph, exists := h.panes[paneID]
	h.mu.RUnlock()

	if !exists {
		return
	}

	msg := make([]byte, len(payload)+1)
	msg[0] = msgType
	copy(msg[1:], payload)

	ph.mu.Lock()
	defer ph.mu.Unlock()

	for client := range ph.clients {
		h.deliverOrDrop(client, msg)
	}
}

// BroadcastAll pushes a typed frame to every client of every pane.
// Best-effort: full client send channels drop the frame rather than
// block (same contract as BroadcastShutdown, which now delegates here).
func (h *Hub) BroadcastAll(msgType byte, payload []byte) {
	msg := make([]byte, 1+len(payload))
	msg[0] = msgType
	copy(msg[1:], payload)

	h.mu.RLock()
	defer h.mu.RUnlock()

	for _, ph := range h.panes {
		ph.mu.Lock()
		for client := range ph.clients {
			select {
			case client.Send <- msg:
			default:
			}
		}
		ph.mu.Unlock()
	}
}

// BroadcastShutdown announces server shutdown to every connected client.
// The payload is the JSON envelope {"reason":"restart"|"update"|"shutdown"}
// per WS protocol v2 §3.1, so the UI can render a distinct state and arm
// the post-restart auto-reload poller. Best-effort: if a client's send
// channel is full the message is dropped silently rather than blocking
// the shutdown path.
func (h *Hub) BroadcastShutdown(reason string) {
	if reason == "" {
		reason = "shutdown"
	}
	payload := []byte(fmt.Sprintf(`{"reason":%q}`, reason))
	h.BroadcastAll(0x05, payload)
}

// PaneStats returns (client count, ring bytes used, ring capacity) for
// a given pane. Returns (0,0,0) if the pane is unknown. Used by the
// /api/diag endpoint.
func (h *Hub) PaneStats(paneID string) (int, int, int) {
	h.mu.RLock()
	ph, exists := h.panes[paneID]
	h.mu.RUnlock()
	if !exists {
		return 0, 0, 0
	}
	ph.mu.Lock()
	defer ph.mu.Unlock()
	clients := len(ph.clients)
	var used, cap int
	if ph.Ring != nil {
		used, cap = ph.Ring.Stats()
	}
	return clients, used, cap
}
