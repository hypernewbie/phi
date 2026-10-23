package main

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"

	"github.com/hypernewbie/phi/pkg/ws"
	"github.com/hypernewbie/phi/pkg/ws/wireproto"
)

func handleTerminalState(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, "/api/terminals/"), "/state")
	epoch, err := strconv.ParseUint(r.URL.Query().Get("epoch"), 10, 64)
	if err != nil {
		http.Error(w, "epoch required", http.StatusBadRequest)
		return
	}
	latest := r.URL.Query().Get("through") == "latest"
	through, err := strconv.ParseUint(r.URL.Query().Get("through"), 10, 64)
	if err != nil && !latest {
		http.Error(w, "through required", http.StatusBadRequest)
		return
	}
	kind := r.URL.Query().Get("kind")
	if kind == "" {
		kind = "ghostty-ready-v1"
	}
	if kind != "ghostty-ready-v1" && kind != "ansi-v1" {
		http.Error(w, "unsupported terminal state kind", http.StatusBadRequest)
		return
	}
	state := wsHub.HistoricalStateContext
	if kind == "ansi-v1" {
		state = wsHub.HistoricalANSIStateContext
	}
	var pos ws.PanePosition
	var data []byte
	var cols, rows int
	if latest {
		if kind != "ansi-v1" {
			http.Error(w, "latest requires ansi-v1", http.StatusBadRequest)
			return
		}
		pos, data, cols, rows, err = wsHub.LiveANSIState(id, epoch)
		through = pos.Head
	} else {
		pos, data, cols, rows, err = state(r.Context(), id, epoch, through)
	}
	if err != nil {
		code := http.StatusServiceUnavailable
		if errors.Is(err, ws.ErrStatePositionMismatch) {
			code = http.StatusConflict
		}
		http.Error(w, err.Error(), code)
		return
	}
	if len(data) > ws.MaxCheckpointBytes {
		http.Error(w, "bounded state exceeds response budget", http.StatusRequestEntityTooLarge)
		return
	}
	hdr, _ := json.Marshal(wireproto.AttachHeadHeader{Epoch: pos.Epoch, Oldest: pos.Oldest, Head: pos.Head, Ckpt: &wireproto.CheckpointHeader{Kind: kind, Through: through, Cols: uint16(cols), Rows: uint16(rows), Len: len(data)}})
	writeRecordingResponse(w, r, hdr, data)
}
