package main

import (
	"encoding/json"
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
	through, err := strconv.ParseUint(r.URL.Query().Get("through"), 10, 64)
	if err != nil {
		http.Error(w, "through required", http.StatusBadRequest)
		return
	}
	pos, data, cols, rows, err := wsHub.HistoricalStateContext(r.Context(), id, epoch, through)
	if err != nil {
		http.Error(w, err.Error(), http.StatusConflict)
		return
	}
	if len(data) > ws.MaxCheckpointBytes {
		http.Error(w, "bounded state exceeds response budget", http.StatusRequestEntityTooLarge)
		return
	}
	hdr, _ := json.Marshal(wireproto.AttachHeadHeader{Epoch: pos.Epoch, Oldest: pos.Oldest, Head: pos.Head, Ckpt: &wireproto.CheckpointHeader{Kind: "ghostty-ready-v1", Through: through, Cols: uint16(cols), Rows: uint16(rows), Len: len(data)}})
	writeRecordingResponse(w, r, hdr, data)
}
