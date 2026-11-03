package server

import (
	"encoding/json"
	"net/http"
	"strconv"
	"time"

	syncmeshb "github.com/hypernewbie/phi/internal/syncmesh/pb"
)

// SyncPushMessage is one addressed message this Phi received or published, as
// the browser sees it. It mirrors the mesh event and never carries anything
// the receiver must not see: the value is the message body, nothing more.
type SyncPushMessage struct {
	MessageID string `json:"message_id"`
	Seq       uint64 `json:"seq"`
	Sender    string `json:"sender"`
	Recipient string `json:"recipient"`
	Value     string `json:"value"`
	UpdatedAt int64  `json:"updated_at_unix_ms"`
	Truncated bool   `json:"truncated,omitempty"`
}

const (
	// maxSyncPushList bounds one response.
	maxSyncPushList = 100
	// maxSyncPushValueBytes bounds one listed value. The full body stays in
	// the store; the list marks truncation so the UI can say so.
	maxSyncPushValueBytes = 4 * 1024
)

// handleSyncPushes lists the addressed messages known to this Phi. Additive:
// it is a new path and changes nothing about /api/sync/messages.
func (app *Server) handleSyncPushes(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	limit := maxSyncPushList
	if raw := r.URL.Query().Get("limit"); raw != "" {
		if parsed, err := strconv.Atoi(raw); err == nil && parsed > 0 && parsed < limit {
			limit = parsed
		}
	}

	var events []*syncmeshb.SyncEvent
	if app.syncMesh != nil {
		events = app.syncMesh.RecentAddressed(limit)
	}
	list := make([]SyncPushMessage, 0, len(events))
	for _, ev := range events {
		value := ev.GetValue()
		truncated := len(value) > maxSyncPushValueBytes
		if truncated {
			value = value[:maxSyncPushValueBytes]
		}
		list = append(list, SyncPushMessage{
			MessageID: ev.GetMessageId(),
			Seq:       ev.GetSeq(),
			Sender:    ev.GetSender(),
			Recipient: ev.GetRecipient(),
			Value:     string(value),
			UpdatedAt: ev.GetUpdatedAtUnixMs(),
			Truncated: truncated,
		})
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"messages":  list,
		"generated": time.Now().UnixMilli(),
	})
}
