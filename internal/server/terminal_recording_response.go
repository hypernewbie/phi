package server

import (
	"compress/gzip"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
	"sync"

	"github.com/hypernewbie/phi/pkg/ws"
	"github.com/hypernewbie/phi/pkg/ws/wireproto"
)

// HTTP content encoding changes only transport bytes. Both fetch and Go's
// default HTTP transport inflate natively before decoding this envelope.
// Tiny spans stay raw; no JS decoder, hash negotiation, or new wire format.
const recordingCompressionMinimum = 1024

var recordingGzipWriters = sync.Pool{New: func() any {
	writer, err := gzip.NewWriterLevel(io.Discard, gzip.BestSpeed)
	if err != nil {
		panic(err)
	} // Constant, supported compression level.
	return writer
}}

func acceptsRecordingGzip(header string) bool {
	wildcard := false
	for _, part := range strings.Split(header, ",") {
		fields := strings.Split(part, ";")
		coding := strings.ToLower(strings.TrimSpace(fields[0]))
		if coding != "gzip" && coding != "*" {
			continue
		}
		q := 1.0
		for _, parameter := range fields[1:] {
			key, value, ok := strings.Cut(strings.TrimSpace(parameter), "=")
			if ok && strings.EqualFold(key, "q") {
				n, err := strconv.ParseFloat(value, 64)
				if err != nil || !(n >= 0 && n <= 1) {
					q = 0
				} else {
					q = n
				}
			}
		}
		if coding == "gzip" {
			return q > 0
		}
		wildcard = q > 0
	}
	return wildcard
}

// handleTerminalReplay serves one raw replay page: the journal bytes for
// [from, through] plus the geometry that orders them. Epoch and a
// through fence are required; through=latest captures the current head
// as a finite fence for the exit-tail drain. Errors map to statuses:
// malformed requests (400), stale epochs and future fences (409),
// missing history (404), unavailable storage (503).
func (app *Server) handleTerminalReplay(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	id := strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, "/api/terminals/"), "/replay")
	q := r.URL.Query()
	req := ws.ReplayRequest{ThroughCursor: q.Get("through_event_cursor"), AfterCursor: q.Get("after_event_cursor")}
	var err error
	if req.Epoch, err = strconv.ParseUint(q.Get("epoch"), 10, 64); err != nil {
		http.Error(w, "epoch is required", http.StatusBadRequest)
		return
	}
	if req.From, err = strconv.ParseUint(q.Get("from"), 10, 64); err != nil {
		http.Error(w, "from is required", http.StatusBadRequest)
		return
	}
	if q.Get("through") == "latest" {
		req.Latest = true
	} else if v := q.Get("through"); v != "" {
		if req.Through, err = strconv.ParseUint(v, 10, 64); err != nil {
			http.Error(w, "bad through", http.StatusBadRequest)
			return
		}
	} else {
		http.Error(w, "through or through=latest is required", http.StatusBadRequest)
		return
	}
	page, rerr := app.hub.Replay(id, req)
	if rerr != nil {
		switch {
		case errors.Is(rerr, ws.ErrReplayNoHistory):
			http.Error(w, rerr.Error(), http.StatusNotFound)
		case errors.Is(rerr, ws.ErrReplayExpired):
			// The client lost bytes below the floor. Send the exact window
			// it can still certify so it resumes there instead of guessing.
			if info, ok := app.hub.ReplayWindow(id); ok {
				if meta, err := json.Marshal(info); err == nil && len(meta) <= 2048 {
					w.Header().Set("X-Phi-Replay-Window", string(meta))
				}
			}
			http.Error(w, rerr.Error(), http.StatusConflict)
		case errors.Is(rerr, ws.ErrReplayEpoch), errors.Is(rerr, ws.ErrReplayFuture):
			http.Error(w, rerr.Error(), http.StatusConflict)
		case errors.Is(rerr, ws.ErrReplayUnavailable):
			http.Error(w, rerr.Error(), http.StatusServiceUnavailable)
		default:
			http.Error(w, rerr.Error(), http.StatusBadRequest)
		}
		return
	}
	resizes := make([][3]uint64, 0, len(page.Resizes))
	for _, m := range page.Resizes {
		resizes = append(resizes, [3]uint64{m.AtSeq, uint64(m.Cols), uint64(m.Rows)})
	}
	if r.Context().Err() != nil {
		return
	}
	hdr, _ := json.Marshal(wireproto.ReplayHeader{
		Through: page.Through, ThroughCursor: page.ThroughCursor,
		Epoch: page.Epoch, Start: page.Start, End: page.End, Resizes: resizes, EventCursor: page.EndCursor,
		InitCols: uint32(page.InitCols), InitRows: uint32(page.InitRows),
		HistoryIncomplete: page.Incomplete, Ephemeral: page.Ephemeral,
		FloorEventCursor: page.FloorEventCursor,
		FloorCols:        uint32(page.FloorCols), FloorRows: uint32(page.FloorRows),
		HeadCols: uint32(page.HeadCols), HeadRows: uint32(page.HeadRows),
	})
	writeRecordingResponse(w, r, hdr, page.Data)
}

func writeRecordingResponse(w http.ResponseWriter, r *http.Request, header, data []byte) {
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Add("Vary", "Accept-Encoding")
	var output io.Writer = w
	if len(data) >= recordingCompressionMinimum && acceptsRecordingGzip(r.Header.Get("Accept-Encoding")) {
		writer := recordingGzipWriters.Get().(*gzip.Writer)
		writer.Reset(w)
		defer func() {
			_ = writer.Close()
			writer.Reset(io.Discard) // Do not retain a response/client in the pool.
			recordingGzipWriters.Put(writer)
		}()
		w.Header().Set("Content-Encoding", "gzip")
		output = writer
	}
	var length [4]byte
	binary.BigEndian.PutUint32(length[:], uint32(len(header)))
	if _, err := output.Write(length[:]); err != nil {
		return
	}
	if _, err := output.Write(header); err != nil {
		return
	}
	_, _ = output.Write(data)
}
