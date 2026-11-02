package server

import (
	"encoding/json"
	"log"
	"net/http"
	"path/filepath"
	"strconv"
	"sync"

	"github.com/hypernewbie/phi/pkg/prompt_history"
	"github.com/hypernewbie/phi/pkg/system"
)

// ---------- prompt_history handlers ----------

// promptHistoryStoreMu serializes lazyInit against concurrent first-call
// initialization. After init succeeds, the *Store itself is goroutine-safe
// (Store.mu protects every mutator). On corrupt-file init we cache a
// sentinel empty store with no path — writes fail with "no path
// configured", reads return []. That surfaces the persistence failure
// (500 on append, [] on recent) without panicking.
var (
	promptHistoryStoreMu sync.Mutex
	promptHistoryStore   *prompt_history.Store
	promptHistoryLoadErr error
)

// PromptHistoryPath reports the history file for the current data dir.
func PromptHistoryPath() string {
	return filepath.Join(system.PhiDataDir(), "prompt_history.json")
}

func promptHistoryLazyStore() (*prompt_history.Store, error) {
	promptHistoryStoreMu.Lock()
	defer promptHistoryStoreMu.Unlock()
	if promptHistoryStore != nil || promptHistoryLoadErr != nil {
		// Already initialized (success or recorded failure). Reuse.
		if promptHistoryStore == nil {
			// Empty sentinel store, plus the recorded error so the
			// handlers can surface it.
			return &prompt_history.Store{}, promptHistoryLoadErr
		}
		return promptHistoryStore, nil
	}
	s, err := prompt_history.Load(PromptHistoryPath())
	if err != nil {
		log.Printf("[prompt_history] failed to load %s: %v", PromptHistoryPath(), err)
		promptHistoryLoadErr = err
		// Cache a path-less empty store. Appends to this will fail at
		// persist time, signalling the corrupt state to the caller.
		return &prompt_history.Store{}, err
	}
	promptHistoryStore = s
	return s, nil
}

// HandlePromptHistoryAppend records a submitted prompt.
func HandlePromptHistoryAppend(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var req struct {
		Text string `json:"text"`
		Cwd  string `json:"cwd"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "bad request: "+err.Error(), http.StatusBadRequest)
		return
	}
	s, err := promptHistoryLazyStore()
	if err != nil {
		http.Error(w, "history load: "+err.Error(), http.StatusInternalServerError)
		return
	}
	if _, err := s.Append(req.Text, req.Cwd); err != nil {
		http.Error(w, "history persist: "+err.Error(), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "count": s.Len()})
}

// HandlePromptHistoryRecent lists recent prompts for a working directory.
func HandlePromptHistoryRecent(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	cwd := r.URL.Query().Get("cwd")
	n := 20
	if v := r.URL.Query().Get("n"); v != "" {
		if parsed, perr := strconv.Atoi(v); perr == nil && parsed > 0 && parsed <= 200 {
			n = parsed
		}
	}
	s, _ := promptHistoryLazyStore() // error ignored here; Recent on empty store returns []
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(s.Recent(cwd, n))
}
