// Package prompt_history stores recent prompt-text submissions so the
// user can cycle back through them with Alt+Up / Alt+Down on the staged
// input bar. Persistence lives next to the rest of phi's config in
// ~/.phi/ on the user's machine — a single JSON file that survives
// process restarts.
package prompt_history

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/hypernewbie/phi/pkg/system"
)

// DefaultMaxEntries is the cap on how many entries the file keeps.
// Beyond this, oldest-first eviction kicks in on Append. 100 is wide
// enough for a typical day's worth of prompts; tighter would make
// fast cycling less useful, looser means more disk + bigger payload
// for the recent-N fetch.
const DefaultMaxEntries = 100

// Entry is one captured prompt. cwd is the project the user was in
// when they sent; we filter by cwd at recall time so projects don't
// contaminate each other. Text is the textarea value as it was sent
// (post-trim, attachments stripped — only the literal prompt).
type Entry struct {
	Timestamp string `json:"ts"`   // RFC3339, e.g. 2026-07-19T16:01:23Z
	Cwd       string `json:"cwd"`  // absolute path, used to filter at recall
	Text      string `json:"text"` // the literal prompt that was sent
}

// Load reads the prompt history file from path. A missing file yields
// an empty Store (no error) so the first-time user has no startup
// friction. A corrupt file yields an empty Store AND an error, so
// the caller can surface "your history is unreadable" without
// silently wiping it.
func Load(path string) (*Store, error) {
	s := &Store{
		path:       path,
		maxEntries: DefaultMaxEntries,
	}
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		return s, fmt.Errorf("mkdir: %w", err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return s, nil
		}
		return s, fmt.Errorf("read: %w", err)
	}
	if len(data) == 0 {
		return s, nil
	}
	if err := json.Unmarshal(data, s); err != nil {
		return s, fmt.Errorf("parse: %w (history file may be recoverable from a backup)", err)
	}
	return s, nil
}

// Store is the in-memory representation of the prompt history file.
// All operations are safe for concurrent use; the file is rewritten
// (WriteFileAtomic) on every Append so a crash mid-write can't
// truncate the file to a partial JSON.
type Store struct {
	mu         sync.Mutex
	path       string
	maxEntries int
	Entries    []Entry `json:"entries"`
}

// Append adds a new entry, stamps it with the current UTC time, and
// trims from the front if the cap is exceeded (FIFO eviction: oldest
// out first). Returns the post-Append length for the caller (used in
// tests; the HTTP handler ignores it).
func (s *Store) Append(text, cwd string) (int, error) {
	if strings.TrimSpace(text) == "" {
		// Empty prompts are not history. They come from accidental
		// Ctrl+Enter or attachments-only sends and would just clutter
		// the file. Silently skip.
		return len(s.Entries), nil
	}
	entry := Entry{
		Timestamp: time.Now().UTC().Format(time.RFC3339),
		Cwd:       cwd,
		Text:      text,
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.Entries = append(s.Entries, entry)
	if len(s.Entries) > s.maxEntries {
		// FIFO: drop oldest until under cap. maxEntries is always > 0
		// (default constructor sets it to DefaultMaxEntries), so this
		// can't loop forever.
		excess := len(s.Entries) - s.maxEntries
		s.Entries = s.Entries[excess:]
	}
	return len(s.Entries), s.persistLocked()
}

// Recent returns the most-recent N entries for the given cwd, newest
// first. n <= 0 returns everything. Sorted by timestamp DESC with
// index-order tie-break (newer index wins) so sub-millisecond appends
// — which happen on rapid Alt+Enter or programmatic tests — resolve
// deterministically to insertion order.
func (s *Store) Recent(cwd string, n int) []Entry {
	s.mu.Lock()
	defer s.mu.Unlock()
	// Build a parallel index array. We need insertion-order tie-break
	// so capture the index alongside each filtered entry.
	type idxEntry struct {
		idx   int
		entry Entry
	}
	tmp := make([]idxEntry, 0, len(s.Entries))
	for i, e := range s.Entries {
		if e.Cwd == cwd {
			tmp = append(tmp, idxEntry{idx: i, entry: e})
		}
	}
	sort.Slice(tmp, func(i, j int) bool {
		// Newer timestamp first.
		if tmp[i].entry.Timestamp != tmp[j].entry.Timestamp {
			return tmp[i].entry.Timestamp > tmp[j].entry.Timestamp
		}
		// Tie-break: later-inserted first (higher index in s.Entries).
		return tmp[i].idx > tmp[j].idx
	})
	out := make([]Entry, len(tmp))
	for i, x := range tmp {
		out[i] = x.entry
	}
	if n > 0 && len(out) > n {
		out = out[:n]
	}
	return out
}

// At returns the entry at index i in the persisted order. Used by
// the cycling logic without exposing the underlying slice.
func (s *Store) At(i int) (Entry, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if i < 0 || i >= len(s.Entries) {
		return Entry{}, false
	}
	return s.Entries[i], true
}

// Len returns the count of all entries (any cwd). Mainly for tests.
func (s *Store) Len() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.Entries)
}

// MaxEntries returns the cap. Read-only.
func (s *Store) MaxEntries() int {
	return s.maxEntries
}

// persistLocked writes the current state to disk atomically. Caller
// must hold s.mu.
func (s *Store) persistLocked() error {
	data, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return fmt.Errorf("marshal: %w", err)
	}
	return system.WriteFileAtomic(s.path, data, 0644)
}
