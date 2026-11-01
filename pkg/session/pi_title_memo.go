package session

import (
	"os"
	"path/filepath"
	"strings"
	"sync"
)

// The listing memo short-circuits the full-file title scan for the session
// sidebar, which re-reads every listed session on each refresh. It is separate
// from PiTitleCache: that one streams one exact session for a caller, this one
// remembers finished titles for many files.
const (
	piTitleMemoCap      = 256
	piTitleMemoMaxBytes = 4096
)

type piTitleMemoEntry struct {
	info  os.FileInfo
	title string
}

var (
	piTitleMemoMu sync.Mutex
	piTitleMemo   = map[string]piTitleMemoEntry{}
)

// lookupPiTitleMemo returns a remembered title while the file metadata still
// matches the snapshot that produced it.
func lookupPiTitleMemo(path string, info os.FileInfo) (string, bool) {
	if info == nil || !regularPiTitleFile(info) {
		return "", false
	}
	piTitleMemoMu.Lock()
	entry, ok := piTitleMemo[filepath.Clean(path)]
	piTitleMemoMu.Unlock()
	if !ok || !samePiTitleMetadata(entry.info, info) {
		return "", false
	}
	return entry.title, true
}

// storePiTitleMemo remembers an error-free title. Oversized titles are still
// returned to the caller but are not retained.
func storePiTitleMemo(path string, info os.FileInfo, title string) {
	if info == nil || !regularPiTitleFile(info) || len(title) > piTitleMemoMaxBytes {
		return
	}
	piTitleMemoMu.Lock()
	defer piTitleMemoMu.Unlock()
	key := filepath.Clean(path)
	if _, exists := piTitleMemo[key]; !exists && len(piTitleMemo) >= piTitleMemoCap {
		clear(piTitleMemo)
	}
	piTitleMemo[key] = piTitleMemoEntry{info: info, title: strings.Clone(title)}
}

// piSessionTitle returns the title for a validated session file, reusing a
// memoized result while the metadata captured by validation still matches.
// Only results a later read would reproduce are stored: warnings and errors
// bypass the memo so they log and retry on every listing.
func piSessionTitle(filePath string, before os.FileInfo) string {
	return piSessionTitleWithLoader(filePath, before, extractPiSessionTitleResult)
}

func piSessionTitleWithLoader(filePath string, before os.FileInfo, load func(string) (string, bool)) string {
	if title, ok := lookupPiTitleMemo(filePath, before); ok {
		return title
	}
	title, cacheable := load(filePath)
	if !cacheable || before == nil {
		return title
	}
	if after, err := os.Lstat(filePath); err == nil && samePiTitleMetadata(before, after) {
		storePiTitleMemo(filePath, after, title)
	}
	return title
}
