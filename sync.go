package main

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/hypernewbie/phi/pkg/system"
)

type SyncMessage struct {
	Key       string    `json:"key"`
	Value     string    `json:"value"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

var (
	syncMu    sync.RWMutex
	syncStore = make(map[string]*SyncMessage)

	testSyncPath string
	saveTimer    *time.Timer
	saveMu       sync.Mutex
)

func syncFilePath() string {
	if testSyncPath != "" {
		return testSyncPath
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "syncboard.json"
	}
	return filepath.Join(home, ".phi", "syncboard.json")
}

func TriggerSaveSyncStore() {
	saveMu.Lock()
	defer saveMu.Unlock()

	if saveTimer != nil {
		saveTimer.Stop()
	}

	// Resolve the path now, on the caller's goroutine, instead of inside
	// the timer callback. Tests swap testSyncPath out from under
	// syncFilePath() between cases (api_health_test.go, main_test.go); a
	// timer that re-read it 500ms later could fire while a later test was
	// writing that var, which is exactly the data race this avoids.
	path := syncFilePath()
	saveTimer = time.AfterFunc(500*time.Millisecond, func() {
		_ = flushSyncStoreTo(path)
	})
}

func FlushSyncStore() error {
	saveMu.Lock()
	if saveTimer != nil {
		saveTimer.Stop()
		saveTimer = nil
	}
	saveMu.Unlock()

	return flushSyncStoreTo(syncFilePath())
}

// flushSyncStoreTo writes the current in-memory sync store to path.
// FlushSyncStore and the debounced timer scheduled by TriggerSaveSyncStore
// both funnel through here, each having resolved path at its own call time.
func flushSyncStoreTo(path string) error {
	syncMu.RLock()
	list := make([]SyncMessage, 0, len(syncStore))
	for _, msg := range syncStore {
		list = append(list, *msg)
	}
	syncMu.RUnlock()

	b, err := json.MarshalIndent(list, "", "  ")
	if err != nil {
		return err
	}

	return system.WriteFileAtomic(path, b, 0644)
}

func LoadSyncStore() error {
	path := syncFilePath()
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

	syncMu.Lock()
	defer syncMu.Unlock()
	for _, msg := range list {
		m := msg
		syncStore[msg.Key] = &m
	}
	return nil
}

func handleSyncMessages(w http.ResponseWriter, r *http.Request) {
	path := strings.TrimPrefix(r.URL.Path, "/api/sync/messages")
	key := strings.TrimPrefix(path, "/")
	key = strings.TrimSpace(key)

	switch r.Method {
	case http.MethodGet:
		if key == "" {
			// List all messages
			syncMu.RLock()
			list := make([]SyncMessage, 0, len(syncStore))
			for _, msg := range syncStore {
				list = append(list, *msg)
			}
			syncMu.RUnlock()

			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(list)
			return
		}

		// Get single message
		syncMu.RLock()
		msg, exists := syncStore[key]
		syncMu.RUnlock()

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
			Key   string `json:"key"`
			Value string `json:"value"`
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

		syncMu.Lock()
		now := time.Now()
		if existing, exists := syncStore[req.Key]; exists {
			existing.Value = req.Value
			existing.UpdatedAt = now
		} else {
			syncStore[req.Key] = &SyncMessage{
				Key:       req.Key,
				Value:     req.Value,
				CreatedAt: now,
				UpdatedAt: now,
			}
		}
		msg := *syncStore[req.Key]
		syncMu.Unlock()
		TriggerSaveSyncStore()

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(msg)

	case http.MethodDelete:
		if key == "" {
			http.Error(w, "Key is required in URL path", http.StatusBadRequest)
			return
		}

		syncMu.Lock()
		_, exists := syncStore[key]
		if exists {
			delete(syncStore, key)
		}
		syncMu.Unlock()
		if exists {
			TriggerSaveSyncStore()
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

func handleSyncCoordinator(w http.ResponseWriter, r *http.Request) {
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
	cfg := loadConfig()
	cfg.SyncCoordinator = strings.TrimSpace(req.SyncCoordinator)
	saveConfig(cfg)
	w.WriteHeader(http.StatusOK)
}
