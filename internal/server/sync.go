package server

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/hypernewbie/phi/pkg/system"
	wspb "github.com/hypernewbie/phi/pkg/ws/pb"
	"google.golang.org/protobuf/proto"
)

type SyncMessage struct {
	Key       string    `json:"key"`
	Value     string    `json:"value"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

// setSyncPathForTest overrides the syncboard file for the caller's test and
// returns a restore function.
func (app *Server) setSyncPathForTest(path string) func() {
	previous := app.testSyncPath
	app.testSyncPath = path
	return func() { app.testSyncPath = previous }
}

// SyncFilePath reports the syncboard file path for the current data dir.
func (app *Server) SyncFilePath() string { return app.syncFilePath() }

func (app *Server) syncFilePath() string {
	if app.testSyncPath != "" {
		return app.testSyncPath
	}
	return filepath.Join(app.stateDir(), "syncboard.json")
}

func (app *Server) triggerSaveSyncStore() {
	app.saveMu.Lock()
	defer app.saveMu.Unlock()

	if app.saveTimer != nil {
		app.saveTimer.Stop()
	}

	// Resolve the path now, on the caller's goroutine, instead of inside
	// the timer callback. Tests swap testSyncPath out from under
	// syncFilePath() between cases (api_health_test.go, main_test.go); a
	// timer that re-read it 500ms later could fire while a later test was
	// writing that var, which is exactly the data race this avoids.
	path := app.syncFilePath()
	app.saveTimer = time.AfterFunc(500*time.Millisecond, func() {
		_ = app.flushSyncStoreTo(path)
	})
}

func (app *Server) flushSyncStore() error {
	app.saveMu.Lock()
	if app.saveTimer != nil {
		app.saveTimer.Stop()
		app.saveTimer = nil
	}
	app.saveMu.Unlock()

	return app.flushSyncStoreTo(app.syncFilePath())
}

// flushSyncStoreTo writes the current in-memory sync store to path.
// flushSyncStore and the debounced timer scheduled by triggerSaveSyncStore
// both funnel through here, each having resolved path at its own call time.
func (app *Server) flushSyncStoreTo(path string) error {
	app.syncMu.RLock()
	list := make([]SyncMessage, 0, len(app.syncStore))
	for _, msg := range app.syncStore {
		list = append(list, *msg)
	}
	app.syncMu.RUnlock()

	b, err := json.MarshalIndent(list, "", "  ")
	if err != nil {
		return err
	}

	return system.WriteFileAtomic(path, b, 0644)
}

func (app *Server) loadSyncStore() error {
	path := app.syncFilePath()
	b, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}

	var list []SyncMessage
	if err := json.Unmarshal(b, &list); err != nil {
		return err
	}

	app.syncMu.Lock()
	defer app.syncMu.Unlock()
	for _, msg := range list {
		m := msg
		app.syncStore[msg.Key] = &m
	}
	return nil
}

func (app *Server) handleSyncMessages(w http.ResponseWriter, r *http.Request) {
	path := strings.TrimPrefix(r.URL.Path, "/api/sync/messages")
	key := strings.TrimPrefix(path, "/")
	key = strings.TrimSpace(key)

	switch r.Method {
	case http.MethodGet:
		if key == "" {
			// List all messages
			app.syncMu.RLock()
			list := make([]SyncMessage, 0, len(app.syncStore))
			for _, msg := range app.syncStore {
				list = append(list, *msg)
			}
			app.syncMu.RUnlock()

			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(list)
			return
		}

		// Get single message
		app.syncMu.RLock()
		msg, exists := app.syncStore[key]
		app.syncMu.RUnlock()

		if !exists {
			http.Error(w, "Message not found", http.StatusNotFound)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(msg)

	case http.MethodPost:
		if key != "" {
			http.Error(w, "Key should be supplied in body, not in URL path for POST", http.StatusBadRequest)
			return
		}

		var req struct {
			Key   string          `json:"key"`
			Value json.RawMessage `json:"value"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}

		req.Key = strings.TrimSpace(req.Key)
		if req.Key == "" {
			http.Error(w, "Key is required", http.StatusBadRequest)
			return
		}

		var valStr string
		if len(req.Value) > 0 {
			var s string
			if err := json.Unmarshal(req.Value, &s); err == nil {
				valStr = s
			} else {
				valStr = string(req.Value)
			}
		}

		app.syncMu.Lock()
		now := time.Now()
		if existing, exists := app.syncStore[req.Key]; exists {
			existing.Value = valStr
			existing.UpdatedAt = now
		} else {
			app.syncStore[req.Key] = &SyncMessage{
				Key:       req.Key,
				Value:     valStr,
				CreatedAt: now,
				UpdatedAt: now,
			}
		}
		msg := *app.syncStore[req.Key]
		app.syncMu.Unlock()
		app.triggerSaveSyncStore()

		if app.hub != nil {
			app.hub.BroadcastNotification(&wspb.Notification{
				Kind: &wspb.Notification_SyncChanged{SyncChanged: &wspb.SyncChanged{
					Action: proto.String("upsert"),
					Key:    proto.String(msg.Key),
					Msg: &wspb.SyncMessageState{
						Key:             proto.String(msg.Key),
						Value:           proto.String(msg.Value),
						CreatedAtUnixMs: proto.Int64(msg.CreatedAt.UnixMilli()),
						UpdatedAtUnixMs: proto.Int64(msg.UpdatedAt.UnixMilli()),
					},
				}},
			})
		}

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(msg)

	case http.MethodDelete:
		if key == "" {
			http.Error(w, "Key is required in URL path", http.StatusBadRequest)
			return
		}

		app.syncMu.Lock()
		_, exists := app.syncStore[key]
		if exists {
			delete(app.syncStore, key)
		}
		app.syncMu.Unlock()
		if exists {
			app.triggerSaveSyncStore()
			if app.hub != nil {
				app.hub.BroadcastNotification(&wspb.Notification{
					Kind: &wspb.Notification_SyncChanged{SyncChanged: &wspb.SyncChanged{
						Action: proto.String("delete"),
						Key:    proto.String(key),
					}},
				})
			}
		}

		if !exists {
			http.Error(w, "Message not found", http.StatusNotFound)
			return
		}

		w.WriteHeader(http.StatusOK)

	default:
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
	}
}

func (app *Server) handleSyncCoordinator(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var req struct {
		SyncCoordinator string `json:"sync_coordinator"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	cfg := app.loadConfig()
	cfg.SyncCoordinator = strings.TrimSpace(req.SyncCoordinator)
	app.saveConfig(cfg)
	w.WriteHeader(http.StatusOK)
}
