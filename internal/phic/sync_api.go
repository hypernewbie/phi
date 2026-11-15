package phic

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"sort"
	"strings"
)

// Sync board API. The server holds addressed key/value messages that
// agents and clients exchange through the mesh; phic reads, upserts, and
// deletes them with the same REST surface the web Syncboard panel uses.

// SyncMessage is one addressed board message.
type SyncMessage struct {
	Key       string `json:"key"`
	Value     string `json:"value"`
	CreatedAt string `json:"created_at"`
	UpdatedAt string `json:"updated_at"`
}

// SyncMessages lists every board message, sorted by key for a stable view.
func (a *apiClient) SyncMessages(ctx context.Context) ([]SyncMessage, error) {
	var list []SyncMessage
	if err := a.getJSON(ctx, "/api/sync/messages", &list); err != nil {
		return nil, err
	}
	sort.Slice(list, func(i, j int) bool { return list[i].Key < list[j].Key })
	return list, nil
}

// SyncUpsert writes one message. An existing key is updated in place.
func (a *apiClient) SyncUpsert(ctx context.Context, key, value string) error {
	body := fmt.Sprintf(`{"key":%q,"value":%q}`, key, value)
	return a.postJSON(ctx, "/api/sync/messages", []byte(body), &struct{}{})
}

// SyncDelete removes one message; a missing key is a successful no-op.
func (a *apiClient) SyncDelete(ctx context.Context, key string) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodDelete, a.base.String()+"/api/sync/messages/"+url.PathEscape(key), nil)
	if err != nil {
		return err
	}
	resp, err := a.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusNoContent && resp.StatusCode != http.StatusNotFound {
		return &apiError{Code: resp.StatusCode, Message: "DELETE /api/sync/messages/" + key + ": " + resp.Status}
	}
	return nil
}

// syncPreview renders one list row: the key and a single-line value preview.
func syncPreview(msg SyncMessage, width int) string {
	value := strings.ReplaceAll(msg.Value, "\n", "␤")
	value = strings.TrimSpace(value)
	if len(value) > width {
		value = value[:width] + "…"
	}
	if value == "" {
		value = "∅"
	}
	return msg.Key + " — " + value
}
