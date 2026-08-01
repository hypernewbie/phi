// Package fswatch watches a dynamic set of directories and fires a
// debounced per-directory callback when matching files are created,
// written, removed, or renamed inside one of them. Non-recursive by
// design: consumers watch flat listings (e.g. the markdown panel's
// top-level os.ReadDir), so direct children are the only thing that
// matters.
package fswatch

import (
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/fsnotify/fsnotify"
)

// Watcher tracks a caller-supplied set of desired directories with an
// fsnotify.Watcher and calls onChange (debounced, per directory) when a
// matching file is created, written, removed, or renamed within one of
// them.
type Watcher struct {
	// Debounce is the trailing quiet period per directory before
	// onChange fires. Agents save in bursts; editors do atomic-rename
	// saves (Create+Rename pairs). Tests may shorten it before Start.
	Debounce time.Duration
	// RearmInterval is the slow safety-net resync of the watch set:
	// picks up configured dirs created while unwatched (mkdir research
	// after boot) and pane spawn/exit drift. Tests may shorten it.
	RearmInterval time.Duration
	// Filter decides which file paths count as relevant events. Nil
	// matches every file. Set before Start, like Debounce. Directory
	// creations bypass it — they re-arm the watch set instead.
	Filter func(path string) bool

	getDirs  func() []string // desired absolute dirs (may not exist)
	onChange func(absDir string)

	mu        sync.Mutex
	fsw       *fsnotify.Watcher
	watched   map[string]bool        // currently armed dirs
	timers    map[string]*time.Timer // per-dir debounce timers
	done      chan struct{}
	closeOnce sync.Once
}

// New creates a Watcher backed by a fresh fsnotify.Watcher. getDirs is
// called on Start and on every rearm tick to resolve the desired watch
// set; onChange fires (off the caller's mutex) whenever a watched
// directory's matching contents change. Start must be called to begin
// watching.
func New(getDirs func() []string, onChange func(absDir string)) (*Watcher, error) {
	fsw, err := fsnotify.NewWatcher()
	if err != nil {
		return nil, err
	}
	return &Watcher{
		Debounce:      500 * time.Millisecond,
		RearmInterval: 15 * time.Second,
		getDirs:       getDirs,
		onChange:      onChange,
		fsw:           fsw,
		watched:       make(map[string]bool),
		timers:        make(map[string]*time.Timer),
		done:          make(chan struct{}),
	}, nil
}

// Start arms the initial watch set and launches the event loop. Safe to
// call once; subsequent calls are not supported (mirrors StartIdleWatcher
// in pkg/pty, which is also a fire-once background loop).
func (w *Watcher) Start() {
	w.Recompute()

	go func() {
		ticker := time.NewTicker(w.RearmInterval)
		defer ticker.Stop()

		for {
			select {
			case e, ok := <-w.fsw.Events:
				if !ok {
					return
				}
				w.handleEvent(e)
			case err, ok := <-w.fsw.Errors:
				if !ok {
					return
				}
				slog.Warn("fswatch: fsnotify error", "err", err)
			case <-ticker.C:
				w.Recompute()
			case <-w.done:
				return
			}
		}
	}()
}

// Recompute diffs the desired directory set (from getDirs) against what
// is currently armed and adds/removes fsnotify watches to match. Dirs
// that don't exist (yet) are simply left unwatched until a future
// Recompute finds them.
func (w *Watcher) Recompute() {
	desired := make(map[string]bool)
	for _, d := range w.getDirs() {
		if st, err := os.Stat(d); err == nil && st.IsDir() {
			desired[d] = true
		}
	}

	w.mu.Lock()
	defer w.mu.Unlock()

	for d := range desired {
		if !w.watched[d] {
			if err := w.fsw.Add(d); err != nil {
				slog.Warn("fswatch: failed to watch dir", "dir", d, "err", err)
				continue
			}
			w.watched[d] = true
		}
	}
	for d := range w.watched {
		if !desired[d] {
			_ = w.fsw.Remove(d) // ignore errors: fsnotify auto-drops deleted dirs
			delete(w.watched, d)
		}
	}
}

// handleEvent processes one fsnotify event: it either triggers a
// Recompute (a directory may have just been created) or, for matching
// file churn, debounces a call to onChange for the event's parent
// directory.
func (w *Watcher) handleEvent(e fsnotify.Event) {
	dir := filepath.Dir(e.Name)

	if e.Op&fsnotify.Create != 0 {
		if st, err := os.Stat(e.Name); err == nil && st.IsDir() {
			// A configured dir may have just been created (only a
			// child of an already-watched dir when the user configured
			// "." — the rearm ticker covers the rest).
			w.Recompute()
			return
		}
	}

	if w.Filter != nil && !w.Filter(e.Name) {
		return
	}

	// Write is included for consumers that track file *content*, not
	// just listings (the standalone md viewer): in-place saves emit
	// plain Write events with no Create/Rename pair.
	if e.Op&(fsnotify.Create|fsnotify.Write|fsnotify.Remove|fsnotify.Rename) == 0 {
		return
	}

	w.debounce(dir)
}

// debounce arms or resets a per-directory trailing timer so a burst of
// .md churn in one directory collapses into a single onChange call.
func (w *Watcher) debounce(dir string) {
	w.mu.Lock()
	defer w.mu.Unlock()

	if t, ok := w.timers[dir]; ok {
		t.Reset(w.Debounce)
		return
	}
	w.timers[dir] = time.AfterFunc(w.Debounce, func() {
		w.mu.Lock()
		delete(w.timers, dir)
		w.mu.Unlock()
		// Not called while holding w.mu: the caller-supplied onChange
		// (e.g. a WS broadcast) may take other locks of its own.
		w.onChange(dir)
	})
}

// Close stops the event loop and the underlying fsnotify.Watcher. Safe
// to call more than once.
func (w *Watcher) Close() {
	w.closeOnce.Do(func() {
		close(w.done)
		w.mu.Lock()
		for _, t := range w.timers {
			t.Stop()
		}
		w.mu.Unlock()
		_ = w.fsw.Close()
	})
}

// ExtFilter returns a Filter matching files whose extension equals ext,
// case-insensitively (ExtFilter(".md") matches "A.MD").
func ExtFilter(ext string) func(path string) bool {
	return func(path string) bool {
		return strings.EqualFold(filepath.Ext(path), ext)
	}
}
