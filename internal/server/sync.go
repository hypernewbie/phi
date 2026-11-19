package server

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/hypernewbie/phi/internal/pibridge"
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
	if app.forwardSyncMessages(w, r) {
		return
	}
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
			writeSyncboardAdmissionRefusal(w, http.StatusBadRequest, "invalid")
			return
		}

		var req struct {
			Key   string          `json:"key"`
			Value json.RawMessage `json:"value"`
		}
		body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxSyncTopicPostBytes))
		if err != nil {
			var tooLarge *http.MaxBytesError
			if errors.As(err, &tooLarge) {
				writeSyncboardAdmissionRefusal(w, http.StatusRequestEntityTooLarge, "too-large")
				return
			}
			writeSyncboardAdmissionRefusal(w, http.StatusBadRequest, "invalid")
			return
		}
		// Check the raw request before JSON decoding can repair invalid UTF-8
		// into replacement characters.
		if !utf8.Valid(body) {
			writeSyncboardAdmissionRefusal(w, http.StatusBadRequest, "invalid")
			return
		}
		dec := json.NewDecoder(bytes.NewReader(body))
		if err := dec.Decode(&req); err != nil {
			writeSyncboardAdmissionRefusal(w, http.StatusBadRequest, "invalid")
			return
		}
		var trailing any
		if err := dec.Decode(&trailing); err != io.EOF {
			writeSyncboardAdmissionRefusal(w, http.StatusBadRequest, "invalid")
			return
		}
		req.Key = strings.TrimSpace(req.Key)
		if req.Key == "" || len(req.Key) > maxSyncTopicKeyBytes || !utf8.ValidString(req.Key) {
			writeSyncboardAdmissionRefusal(w, http.StatusBadRequest, "invalid")
			return
		}
		if req.Value == nil {
			writeSyncboardAdmissionRefusal(w, http.StatusBadRequest, "invalid")
			return
		}
		valStr, err := normalizeSyncValue(req.Value)
		if err != nil {
			writeSyncboardAdmissionRefusal(w, http.StatusBadRequest, "invalid")
			return
		}

		app.syncMu.Lock()
		var now time.Time
		var admitted bool
		var msg SyncMessage
		err = app.withSyncTopicOwnersLocked(req.Key, func() error {
			now = time.Now()
			var admissionErr error
			admitted, admissionErr = app.syncTopics.admitPostLocked(req.Key, valStr, now)
			if admissionErr != nil {
				return admissionErr
			}
			row := &SyncMessage{Key: req.Key, Value: valStr, CreatedAt: now, UpdatedAt: now}
			if existing, exists := app.syncStore[req.Key]; exists {
				row.CreatedAt = existing.CreatedAt
			}
			// Published rows are immutable: a GET may still encode a previously
			// selected row after releasing syncMu.
			app.syncStore[req.Key] = row
			msg = *row
			return nil
		})
		app.syncMu.Unlock()
		if err != nil {
			switch {
			case errors.Is(err, errSyncTopicTooLarge):
				writeSyncboardAdmissionRefusal(w, http.StatusRequestEntityTooLarge, "too-large")
			case errors.Is(err, errSyncTopicCapacity), errors.Is(err, pibridge.ErrTopicUnavailable):
				writeSyncboardAdmissionRefusal(w, http.StatusServiceUnavailable, "capacity")
			default:
				writeSyncboardAdmissionRefusal(w, http.StatusBadRequest, "invalid")
			}
			return
		}
		app.triggerSaveSyncStore()
		if admitted {
			app.pumpSyncTopics(now)
		}

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

// writeSyncboardAdmissionRefusal sends the fixed bounded refusal body. A
// caller may treat a POST as not accepted only when both this status and this
// exact body are present; any other non-200 answer is unknown.
func writeSyncboardAdmissionRefusal(w http.ResponseWriter, status int, reason string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = fmt.Fprintf(w, `{"syncboard_admission":"refused","reason":%q}`, reason)
}

// normalizeSyncValue preserves the board's existing string semantics: a JSON
// string becomes its contents, null becomes empty, and every other JSON value
// remains its complete stored JSON text.
func normalizeSyncValue(raw json.RawMessage) (string, error) {
	if !utf8.Valid(raw) {
		return "", errors.New("Value is not valid UTF-8")
	}
	trimmed := bytes.TrimSpace(raw)
	if bytes.Equal(trimmed, []byte("null")) {
		return "", nil
	}
	var text string
	if err := json.Unmarshal(raw, &text); err == nil {
		if !utf8.ValidString(text) {
			return "", errors.New("Value is not valid UTF-8")
		}
		return text, nil
	}
	if !json.Valid(raw) {
		return "", errors.New("Invalid JSON value")
	}
	return string(raw), nil
}

// syncForwardWriteTimeout bounds one downstream read response write. It is a
// variable so tests can inject a short deadline without waiting ten seconds.
var syncForwardWriteTimeout = 10 * time.Second

// forwardSyncMessages relays follower REST board calls to the configured
// coordinator. It never forwards a request from a coordinator or a request
// already marked forwarded, so one hop cannot loop.
func (app *Server) forwardSyncMessages(w http.ResponseWriter, r *http.Request) (forwarded bool) {
	if app.configStore() == nil {
		return false
	}
	cfg, err := app.configStore().LoadWithError()
	if err != nil {
		http.Error(w, "Sync configuration unavailable", http.StatusServiceUnavailable)
		return true
	}
	if cfg.SyncCoordinator == "" {
		return false
	}
	if r.Header.Get("X-Phi-Sync-Forwarded") == "1" {
		http.Error(w, "Chained sync coordinator", http.StatusServiceUnavailable)
		return true
	}
	if app.syncCoordinatorIsSelf(cfg.SyncCoordinator) {
		http.Error(w, "Sync coordinator resolves to this server", http.StatusBadRequest)
		return true
	}
	target := strings.TrimSuffix(cfg.SyncCoordinator, "/") + r.URL.EscapedPath()
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxSyncTopicPostBytes))
	if err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			writeSyncboardAdmissionRefusal(w, http.StatusRequestEntityTooLarge, "too-large")
		} else {
			writeSyncboardAdmissionRefusal(w, http.StatusBadRequest, "invalid")
		}
		return true
	}
	req, err := http.NewRequestWithContext(r.Context(), r.Method, target, bytes.NewReader(body))
	if err != nil {
		http.Error(w, "Invalid sync coordinator", http.StatusServiceUnavailable)
		return true
	}
	if ct := r.Header.Get("Content-Type"); ct != "" {
		req.Header.Set("Content-Type", ct)
	}
	req.Header.Set("X-Phi-Sync-Forwarded", "1")
	client := &http.Client{
		Timeout: 10 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
	resp, err := client.Do(req)
	if err != nil {
		http.Error(w, "Sync coordinator unavailable", http.StatusServiceUnavailable)
		return true
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 && resp.StatusCode < 400 {
		http.Error(w, "Sync coordinator redirect refused", http.StatusBadGateway)
		return true
	}
	if ct := resp.Header.Get("Content-Type"); ct != "" {
		w.Header().Set("Content-Type", ct)
	}
	if r.Method == http.MethodGet || r.Method == http.MethodHead {
		// Reads keep the existing stream semantics: the response is not
		// size-capped by the mutation bound. A real downstream socket gets
		// a write deadline so a slow reader cannot pin the relay.
		if controller := http.NewResponseController(w); controller != nil {
			_ = controller.SetWriteDeadline(time.Now().Add(syncForwardWriteTimeout))
		}
		w.WriteHeader(resp.StatusCode)
		if r.Method != http.MethodHead {
			_, _ = io.Copy(w, resp.Body)
		}
		return true
	}
	respBody, err := io.ReadAll(io.LimitReader(resp.Body, pibridge.MaxSyncboardResponseBytes+1))
	if err != nil || len(respBody) > pibridge.MaxSyncboardResponseBytes {
		http.Error(w, "Sync coordinator response invalid", http.StatusBadGateway)
		return true
	}
	w.WriteHeader(resp.StatusCode)
	_, _ = w.Write(respBody)
	return true
}

// syncCoordinatorIsSelf rejects an explicit loopback alias for this listener.
// It only trusts literal addresses; hostname resolution is never used.
func (app *Server) syncCoordinatorIsSelf(raw string) bool {
	if app.port == 0 {
		return false
	}
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") ||
		u.User != nil || u.Host == "" || u.Path != "" || u.RawQuery != "" || u.Fragment != "" {
		return false
	}
	host := u.Hostname()
	if host == "localhost" {
		return u.Port() == fmt.Sprintf("%d", app.port)
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback() && u.Port() == fmt.Sprintf("%d", app.port)
}
