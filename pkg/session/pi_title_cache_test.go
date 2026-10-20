package session

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

type piTitleIOCounts struct {
	mu             sync.Mutex
	statDirCalls   int
	lstatCalls     int
	openedDirs     int
	closedDirs     int
	dirReadCalls   int
	dirReadEntries int
	dirReadLimits  []int
	openedFiles    map[string]int
	closedFiles    int
	readBytes      map[string]int64
	totalReadBytes int64
}

type countedPiTitleDirectory struct {
	piTitleDirectory
	counts *piTitleIOCounts
}

type countedPiTitleFile struct {
	piTitleFile
	path   string
	counts *piTitleIOCounts
}

func newCountedPiTitleCache() (*PiTitleCache, *piTitleIOCounts) {
	counts := &piTitleIOCounts{
		openedFiles: make(map[string]int),
		readBytes:   make(map[string]int64),
	}
	ops := defaultPiTitleFSOps()
	ops.statDir = func(path string) (os.FileInfo, error) {
		counts.mu.Lock()
		counts.statDirCalls++
		counts.mu.Unlock()
		return os.Stat(path)
	}
	ops.lstat = func(path string) (os.FileInfo, error) {
		counts.mu.Lock()
		counts.lstatCalls++
		counts.mu.Unlock()
		return os.Lstat(path)
	}
	ops.openDir = func(path string) (piTitleDirectory, error) {
		file, err := os.Open(path)
		if err != nil {
			return nil, err
		}
		counts.mu.Lock()
		counts.openedDirs++
		counts.mu.Unlock()
		return &countedPiTitleDirectory{piTitleDirectory: file, counts: counts}, nil
	}
	ops.openFile = func(path string) (piTitleFile, error) {
		file, err := os.Open(path)
		if err != nil {
			return nil, err
		}
		counts.mu.Lock()
		counts.openedFiles[path]++
		counts.mu.Unlock()
		return &countedPiTitleFile{piTitleFile: file, path: path, counts: counts}, nil
	}
	return newPiTitleCacheWithOps(ops), counts
}

func (d *countedPiTitleDirectory) ReadDir(n int) ([]os.DirEntry, error) {
	entries, err := d.piTitleDirectory.ReadDir(n)
	d.counts.mu.Lock()
	d.counts.dirReadCalls++
	d.counts.dirReadEntries += len(entries)
	d.counts.dirReadLimits = append(d.counts.dirReadLimits, n)
	d.counts.mu.Unlock()
	return entries, err
}

func (d *countedPiTitleDirectory) Close() error {
	d.counts.mu.Lock()
	d.counts.closedDirs++
	d.counts.mu.Unlock()
	return d.piTitleDirectory.Close()
}

func (f *countedPiTitleFile) ReadAt(data []byte, offset int64) (int, error) {
	n, err := f.piTitleFile.ReadAt(data, offset)
	f.counts.mu.Lock()
	f.counts.readBytes[f.path] += int64(n)
	f.counts.totalReadBytes += int64(n)
	f.counts.mu.Unlock()
	return n, err
}

func (f *countedPiTitleFile) Close() error {
	f.counts.mu.Lock()
	f.counts.closedFiles++
	f.counts.mu.Unlock()
	return f.piTitleFile.Close()
}

func (c *piTitleIOCounts) reset() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.statDirCalls = 0
	c.lstatCalls = 0
	c.openedDirs = 0
	c.closedDirs = 0
	c.dirReadCalls = 0
	c.dirReadEntries = 0
	c.dirReadLimits = nil
	c.openedFiles = make(map[string]int)
	c.closedFiles = 0
	c.readBytes = make(map[string]int64)
	c.totalReadBytes = 0
}

func (c *piTitleIOCounts) fileOpens(path string) int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.openedFiles[path]
}

func (c *piTitleIOCounts) totalFileOpens() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	total := 0
	for _, count := range c.openedFiles {
		total += count
	}
	return total
}

func (c *piTitleIOCounts) bytesFor(path string) int64 {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.readBytes[path]
}

func (c *piTitleIOCounts) totalBytes() int64 {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.totalReadBytes
}

func (c *piTitleIOCounts) listingSnapshot() (calls, entries int, limits []int) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.dirReadCalls, c.dirReadEntries, append([]int(nil), c.dirReadLimits...)
}

func (c *piTitleIOCounts) openSnapshot() (dirs, closedDirs, closedFiles int) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.openedDirs, c.closedDirs, c.closedFiles
}

func titleCacheFixture(t *testing.T, id string) (string, string, string, *PiTitleCache, *piTitleIOCounts, *PiTitleReader) {
	t.Helper()
	cwd, sessionsDir := setupPiTestSessions(t)
	cache, counts := newCountedPiTitleCache()
	reader, err := cache.Acquire(cwd, id)
	if err != nil {
		t.Fatalf("Acquire: %v", err)
	}
	return cwd, sessionsDir, id, cache, counts, reader
}

func titleSessionContent(id, cwd string, records ...string) []byte {
	parts := append([]string{piSessionHeader(id, cwd)}, records...)
	return []byte(strings.Join(parts, "\n") + "\n")
}

func writeTitleSession(t *testing.T, directory, filename, id, cwd string, records ...string) (string, []byte) {
	t.Helper()
	content := titleSessionContent(id, cwd, records...)
	path := filepath.Join(directory, filename)
	if err := os.MkdirAll(directory, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, content, 0644); err != nil {
		t.Fatal(err)
	}
	return path, content
}

func titleNameRecord(name string) string {
	return fmt.Sprintf(`{"type":"session_info","name":%q}`, name)
}

func refreshPiTitleToStable(t *testing.T, reader *PiTitleReader) PiTitleResult {
	t.Helper()
	for step := 0; step < 1000; step++ {
		result, err := reader.RefreshStep()
		if err != nil {
			t.Fatalf("RefreshStep %d: %v", step, err)
		}
		if !result.More {
			return result
		}
	}
	t.Fatal("Pi title reader did not reach a stable step")
	return PiTitleResult{}
}

func TestPiTitleCacheAcquireAndDirectoryDoNoDiskIO(t *testing.T) {
	cwd, _ := setupPiTestSessions(t)
	cache, counts := newCountedPiTitleCache()
	first, err := cache.Acquire(cwd, "same-id")
	if err != nil {
		t.Fatal(err)
	}
	second, err := cache.Acquire(filepath.Join(cwd, "..", filepath.Base(cwd)), "same-id")
	if err != nil {
		t.Fatal(err)
	}
	if first != second {
		t.Fatal("canonical CWD/ID did not share a reader")
	}
	if got := first.Directory(); got == "" {
		t.Fatal("Directory returned an empty path")
	}
	counts.mu.Lock()
	defer counts.mu.Unlock()
	if counts.statDirCalls != 0 || counts.lstatCalls != 0 || counts.openedDirs != 0 || len(counts.openedFiles) != 0 || counts.totalReadBytes != 0 {
		t.Fatalf("Acquire or Directory performed disk I/O: %+v", counts)
	}
	cache.Release(first)
	cache.Release(second)
}

func TestPiTitleCacheTenConsumersShareDiscoveryAndColdRead(t *testing.T) {
	cwd, sessionsDir := setupPiTestSessions(t)
	id := "shared-cold-id"
	path, content := writeTitleSession(t, sessionsDir, "not-a-timestamp-name.jsonl", id, cwd, titleNameRecord("Shared title"))
	cache, counts := newCountedPiTitleCache()
	readers := make([]*PiTitleReader, 10)
	for i := range readers {
		reader, err := cache.Acquire(cwd, id)
		if err != nil {
			t.Fatal(err)
		}
		readers[i] = reader
		if reader != readers[0] {
			t.Fatal("consumers did not share one reader")
		}
	}

	var wg sync.WaitGroup
	errCh := make(chan error, len(readers))
	for range readers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for step := 0; step < 20; step++ {
				result, err := readers[0].RefreshStep()
				if err != nil {
					errCh <- err
					return
				}
				if result.Ready && !result.More {
					return
				}
			}
			errCh <- fmt.Errorf("shared reader did not become ready")
		}()
	}
	wg.Wait()
	close(errCh)
	for err := range errCh {
		t.Fatal(err)
	}
	result, err := readers[0].RefreshStep()
	if err != nil || !result.Ready || result.Title != "Shared title" {
		t.Fatalf("shared cold result = %+v, err=%v", result, err)
	}
	if got := counts.fileOpens(path); got != 2 {
		t.Fatalf("cold discovery/target opens = %d, want one header plus one cold read", got)
	}
	headerBytes := int64(strings.IndexByte(string(content), '\n') + 1)
	if got, want := counts.bytesFor(path), int64(len(content))+headerBytes; got != want {
		t.Fatalf("shared file bytes read = %d, want %d (one header + one cold pass)", got, want)
	}
	calls, entries, _ := counts.listingSnapshot()
	dirs, closedDirs, _ := counts.openSnapshot()
	if calls < 1 || calls > 2 || entries != 1 || dirs != 1 || closedDirs != 1 {
		t.Fatalf("shared discovery calls=%d entries=%d directory handles=%d/%d", calls, entries, dirs, closedDirs)
	}
	for range readers {
		cache.Release(readers[0])
	}
}

func TestPiTitleCacheTwentyUnchangedEOFRefreshesDoNoJSONLWork(t *testing.T) {
	cwd, sessionsDir := setupPiTestSessions(t)
	id := "unchanged-eof"
	path, _ := writeTitleSession(t, sessionsDir, "session.jsonl", id, cwd, titleNameRecord("Stable"))
	cache, counts := newCountedPiTitleCache()
	reader, err := cache.Acquire(cwd, id)
	if err != nil {
		t.Fatal(err)
	}
	defer cache.Release(reader)
	result := refreshPiTitleToStable(t, reader)
	if !result.Ready || result.Title != "Stable" {
		t.Fatalf("cold title = %+v", result)
	}

	counts.reset()
	for i := 0; i < 20; i++ {
		result, err = reader.RefreshStep()
		if err != nil || !result.Ready || result.More || result.Title != "Stable" {
			t.Fatalf("unchanged refresh %d = %+v, err=%v", i, result, err)
		}
	}
	calls, entries, _ := counts.listingSnapshot()
	if counts.totalFileOpens() != 0 || counts.bytesFor(path) != 0 || counts.totalBytes() != 0 || calls != 0 || entries != 0 {
		t.Fatalf("warm EOF work: opens=%d bytes=%d listings=%d entries=%d", counts.totalFileOpens(), counts.totalBytes(), calls, entries)
	}
}

func TestPiTitleCacheTwentyNegativeRefreshesDoNotRelist(t *testing.T) {
	cwd, sessionsDir := setupPiTestSessions(t)
	if err := os.MkdirAll(sessionsDir, 0755); err != nil {
		t.Fatal(err)
	}
	cache, counts := newCountedPiTitleCache()
	reader, err := cache.Acquire(cwd, "valid-negative")
	if err != nil {
		t.Fatal(err)
	}
	defer cache.Release(reader)
	result := refreshPiTitleToStable(t, reader)
	if result.Ready {
		t.Fatalf("empty history unexpectedly ready: %+v", result)
	}
	counts.reset()
	for i := 0; i < 20; i++ {
		result, err = reader.RefreshStep()
		if err != nil || result.Ready || result.More {
			t.Fatalf("negative refresh %d = %+v, err=%v", i, result, err)
		}
	}
	calls, entries, _ := counts.listingSnapshot()
	if calls != 0 || entries != 0 || counts.totalFileOpens() != 0 || counts.totalBytes() != 0 {
		t.Fatalf("negative cache work: listings=%d entries=%d opens=%d bytes=%d", calls, entries, counts.totalFileOpens(), counts.totalBytes())
	}
}

func TestPiTitleCacheIncompleteCandidateMetadataRetryWithoutRelisting(t *testing.T) {
	cwd, sessionsDir := setupPiTestSessions(t)
	id := "delayed-candidate"
	if err := os.MkdirAll(sessionsDir, 0755); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(sessionsDir, "not-a-timestamp-name.jsonl")
	partial := []byte(fmt.Sprintf(`{"type":"session","id":%q,"cwd":%q}`, id, cwd))
	if err := os.WriteFile(path, partial, 0644); err != nil {
		t.Fatal(err)
	}
	cache, counts := newCountedPiTitleCache()
	reader, err := cache.Acquire(cwd, id)
	if err != nil {
		t.Fatal(err)
	}
	defer cache.Release(reader)
	result := refreshPiTitleToStable(t, reader)
	if result.Ready || len(reader.candidates) != 1 {
		t.Fatalf("incomplete candidate state: result=%+v candidates=%d", result, len(reader.candidates))
	}

	counts.reset()
	for i := 0; i < 20; i++ {
		result, err = reader.RefreshStep()
		if err != nil || result.Ready || result.More {
			t.Fatalf("unchanged candidate refresh %d = %+v, err=%v", i, result, err)
		}
	}
	calls, entries, _ := counts.listingSnapshot()
	if calls != 0 || entries != 0 || counts.totalFileOpens() != 0 || counts.totalBytes() != 0 {
		t.Fatalf("unchanged candidate work: listings=%d entries=%d opens=%d bytes=%d", calls, entries, counts.totalFileOpens(), counts.totalBytes())
	}

	dirBefore, err := os.Stat(sessionsDir)
	if err != nil {
		t.Fatal(err)
	}
	complete := titleSessionContent(id, cwd, titleNameRecord("Header completed"))
	if err := os.WriteFile(path, complete, 0644); err != nil {
		t.Fatal(err)
	}
	dirAfter, err := os.Stat(sessionsDir)
	if err != nil {
		t.Fatal(err)
	}
	if !samePiTitleMetadata(dirBefore, dirAfter) {
		t.Fatalf("candidate completion unexpectedly changed parent directory metadata: before=%v after=%v", dirBefore.ModTime(), dirAfter.ModTime())
	}
	counts.reset()
	result = refreshPiTitleToStable(t, reader)
	if !result.Ready || result.Title != "Header completed" {
		t.Fatalf("completed candidate result = %+v", result)
	}
	calls, entries, _ = counts.listingSnapshot()
	if calls != 0 || entries != 0 {
		t.Fatalf("candidate completion relisted parent: calls=%d entries=%d", calls, entries)
	}
	if counts.fileOpens(path) != 2 {
		t.Fatalf("candidate completion opens=%d, want header retry and bounded cold read", counts.fileOpens(path))
	}
}

func TestPiTitleCacheRetriesOnlyChangedIncompleteCandidate(t *testing.T) {
	cwd, sessionsDir := setupPiTestSessions(t)
	id := "one-candidate-changed"
	if err := os.MkdirAll(sessionsDir, 0755); err != nil {
		t.Fatal(err)
	}
	changedPath := filepath.Join(sessionsDir, "a-incomplete.jsonl")
	otherPath := filepath.Join(sessionsDir, "b-incomplete.jsonl")
	partial := []byte(fmt.Sprintf(`{"type":"session","id":%q,"cwd":%q}`, "not-ready", cwd))
	if err := os.WriteFile(changedPath, partial, 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(otherPath, partial, 0644); err != nil {
		t.Fatal(err)
	}
	cache, counts := newCountedPiTitleCache()
	reader, err := cache.Acquire(cwd, id)
	if err != nil {
		t.Fatal(err)
	}
	defer cache.Release(reader)
	if result := refreshPiTitleToStable(t, reader); result.Ready {
		t.Fatalf("partial candidates unexpectedly produced a title: %+v", result)
	}
	dirBefore, err := os.Stat(sessionsDir)
	if err != nil {
		t.Fatal(err)
	}
	content := titleSessionContent(id, cwd, titleNameRecord("Only changed candidate"))
	if err := os.WriteFile(changedPath, content, 0644); err != nil {
		t.Fatal(err)
	}
	dirAfter, err := os.Stat(sessionsDir)
	if err != nil {
		t.Fatal(err)
	}
	if !samePiTitleMetadata(dirBefore, dirAfter) {
		t.Fatal("header completion changed parent directory metadata")
	}
	counts.reset()
	result := refreshPiTitleToStable(t, reader)
	if !result.Ready || result.Title != "Only changed candidate" {
		t.Fatalf("changed candidate result = %+v", result)
	}
	calls, _, _ := counts.listingSnapshot()
	if calls != 0 || counts.fileOpens(otherPath) != 0 || counts.fileOpens(changedPath) != 2 {
		t.Fatalf("candidate retry touched unrelated paths/listing: changed opens=%d other opens=%d lists=%d", counts.fileOpens(changedPath), counts.fileOpens(otherPath), calls)
	}
}

func TestPiTitleCacheRecoverySweepIsFiniteAndRetriesLateCandidate(t *testing.T) {
	cwd, sessionsDir := setupPiTestSessions(t)
	if err := os.MkdirAll(sessionsDir, 0755); err != nil {
		t.Fatal(err)
	}
	const candidateCount = 260
	partial := []byte(`{"type":"session","id":"unfinished","cwd":`)
	paths := make([]string, candidateCount)
	for i := range paths {
		paths[i] = filepath.Join(sessionsDir, fmt.Sprintf("candidate-%03d.jsonl", i))
		if err := os.WriteFile(paths[i], partial, 0644); err != nil {
			t.Fatal(err)
		}
	}

	cache, counts := newCountedPiTitleCache()
	reader, err := cache.Acquire(cwd, "late-candidate")
	if err != nil {
		t.Fatal(err)
	}
	defer cache.Release(reader)
	result := refreshPiTitleToStable(t, reader)
	if result.Ready || len(reader.candidates) != candidateCount {
		t.Fatalf("incomplete candidate discovery: result=%+v candidates=%d", result, len(reader.candidates))
	}

	counts.reset()
	for step := 0; step < 3; step++ {
		result, err = reader.RefreshStep()
		if err != nil {
			t.Fatalf("unchanged candidate sweep step %d: %v", step, err)
		}
		if wantMore := step < 2; result.More != wantMore {
			t.Fatalf("sweep step %d More=%v, want %v", step, result.More, wantMore)
		}
	}
	calls, entries, _ := counts.listingSnapshot()
	if calls != 0 || entries != 0 || counts.totalFileOpens() != 0 || counts.totalBytes() != 0 {
		t.Fatalf("unchanged recovery sweep did I/O: listings=%d entries=%d opens=%d bytes=%d", calls, entries, counts.totalFileOpens(), counts.totalBytes())
	}

	changedPath := paths[len(paths)-1]
	dirBefore, err := os.Stat(sessionsDir)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(changedPath, titleSessionContent("late-candidate", cwd, titleNameRecord("Late candidate bound")), 0644); err != nil {
		t.Fatal(err)
	}
	dirAfter, err := os.Stat(sessionsDir)
	if err != nil {
		t.Fatal(err)
	}
	if !samePiTitleMetadata(dirBefore, dirAfter) {
		t.Fatal("candidate completion changed parent directory metadata")
	}
	counts.reset()
	for step := 0; step < 10; step++ {
		result, err = reader.RefreshStep()
		if err != nil {
			t.Fatalf("late candidate retry step %d: %v", step, err)
		}
		if result.Ready {
			break
		}
		if !result.More {
			t.Fatalf("late changed candidate was skipped at step %d: %+v", step, result)
		}
	}
	if !result.Ready || result.Title != "Late candidate bound" {
		t.Fatalf("late candidate result=%+v", result)
	}
	calls, entries, _ = counts.listingSnapshot()
	if calls != 0 || entries != 0 || counts.totalFileOpens() != 2 || counts.fileOpens(changedPath) != 2 {
		t.Fatalf("late retry did unrelated discovery/read work: lists=%d entries=%d total opens=%d changed opens=%d", calls, entries, counts.totalFileOpens(), counts.fileOpens(changedPath))
	}
	for _, path := range paths[:len(paths)-1] {
		if counts.fileOpens(path) != 0 {
			t.Fatalf("late retry reopened unchanged candidate %s", path)
		}
	}
}

func TestPiTitleCacheDiscoveryBatchesAndHeaderByteBudget(t *testing.T) {
	t.Run("directory entries", func(t *testing.T) {
		cwd, sessionsDir := setupPiTestSessions(t)
		if err := os.MkdirAll(sessionsDir, 0755); err != nil {
			t.Fatal(err)
		}
		for i := 0; i < 150; i++ {
			writeTitleSession(t, sessionsDir, fmt.Sprintf("nonmatch-%03d.jsonl", i), fmt.Sprintf("other-%d", i), cwd, titleNameRecord("unrelated"))
		}
		cache, counts := newCountedPiTitleCache()
		reader, err := cache.Acquire(cwd, "not-present")
		if err != nil {
			t.Fatal(err)
		}
		defer cache.Release(reader)
		counts.reset()
		result, err := reader.RefreshStep()
		if err != nil || !result.More {
			t.Fatalf("first discovery step = %+v, err=%v", result, err)
		}
		calls, entries, limits := counts.listingSnapshot()
		if entries > piTitleStepEntryBudget {
			t.Fatalf("first discovery examined %d entries", entries)
		}
		for _, limit := range limits {
			if limit > piTitleStepEntryBudget {
				t.Fatalf("ReadDir requested batch %d", limit)
			}
		}
		if calls != 1 || counts.totalBytes() > piTitleStepByteBudget {
			t.Fatalf("first discovery work: lists=%d bytes=%d", calls, counts.totalBytes())
		}
		counts.reset()
		result = refreshPiTitleToStable(t, reader)
		if result.Ready {
			t.Fatalf("nonmatching history unexpectedly ready: %+v", result)
		}
		_, entries, limits = counts.listingSnapshot()
		if entries > piTitleStepEntryBudget {
			t.Fatalf("second discovery examined %d entries", entries)
		}
		for _, limit := range limits {
			if limit > piTitleStepEntryBudget {
				t.Fatalf("ReadDir requested batch %d", limit)
			}
		}
	})

	t.Run("large header", func(t *testing.T) {
		cwd, sessionsDir := setupPiTestSessions(t)
		id := "large-header"
		if err := os.MkdirAll(sessionsDir, 0755); err != nil {
			t.Fatal(err)
		}
		padding := strings.Repeat("x", 300*1024)
		header := fmt.Sprintf(`{"type":"session","id":%q,"cwd":%q,"padding":%q}`+"\n", id, cwd, padding)
		path := filepath.Join(sessionsDir, "odd-header-name.jsonl")
		if err := os.WriteFile(path, []byte(header+titleNameRecord("Large header title")+"\n"), 0644); err != nil {
			t.Fatal(err)
		}
		cache, counts := newCountedPiTitleCache()
		reader, err := cache.Acquire(cwd, id)
		if err != nil {
			t.Fatal(err)
		}
		defer cache.Release(reader)
		result, err := reader.RefreshStep()
		if err != nil || !result.More || result.Ready {
			t.Fatalf("large header first step = %+v, err=%v", result, err)
		}
		if got := counts.bytesFor(path); got != piTitleStepByteBudget {
			t.Fatalf("large header first-step bytes=%d, want %d", got, piTitleStepByteBudget)
		}
		firstStepOpens := counts.fileOpens(path)
		counts.reset()
		result, err = reader.RefreshStep()
		if err != nil || !result.More || result.Ready {
			t.Fatalf("large header continuation = %+v, err=%v", result, err)
		}
		if got := counts.totalBytes(); got > piTitleStepByteBudget {
			t.Fatalf("large header continuation read %d bytes", got)
		}
		if firstStepOpens != 1 || counts.fileOpens(path) != 0 {
			t.Fatalf("large header continuation reopen count first=%d later=%d", firstStepOpens, counts.fileOpens(path))
		}
	})
}

func TestPiTitleCacheRetriesUnusableHeaderCWDWithoutRelisting(t *testing.T) {
	cases := []struct {
		name   string
		header func(string, string) string
	}{
		{
			name: "missing CWD",
			header: func(id, _ string) string {
				return fmt.Sprintf(`{"type":"session","id":%q}`, id)
			},
		},
		{
			name: "null CWD",
			header: func(id, _ string) string {
				return fmt.Sprintf(`{"type":"session","id":%q,"cwd":null}`, id)
			},
		},
		{
			name: "empty CWD",
			header: func(id, _ string) string {
				return fmt.Sprintf(`{"type":"session","id":%q,"cwd":""}`, id)
			},
		},
		{
			name: "malformed CWD field",
			header: func(id, _ string) string {
				return fmt.Sprintf(`{"type":"session","id":%q,"cwd":17}`, id)
			},
		},
		{
			name: "nonabsolute CWD",
			header: func(id, _ string) string {
				return fmt.Sprintf(`{"type":"session","id":%q,"cwd":"relative/worktree"}`, id)
			},
		},
		{
			name: "missing native type",
			header: func(id, cwd string) string {
				return fmt.Sprintf(`{"id":%q,"cwd":%q}`, id, cwd)
			},
		},
		{
			name:   "unusable header shape",
			header: func(string, string) string { return `[]` },
		},
	}

	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			cwd, sessionsDir := setupPiTestSessions(t)
			id := "incomplete-header-" + strings.ReplaceAll(test.name, " ", "-")
			if err := os.MkdirAll(sessionsDir, 0755); err != nil {
				t.Fatal(err)
			}
			path := filepath.Join(sessionsDir, "not-a-timestamp-name.jsonl")
			if err := os.WriteFile(path, []byte(test.header(id, cwd)+"\n"), 0644); err != nil {
				t.Fatal(err)
			}
			cache, counts := newCountedPiTitleCache()
			reader, err := cache.Acquire(cwd, id)
			if err != nil {
				t.Fatal(err)
			}
			defer cache.Release(reader)
			result := refreshPiTitleToStable(t, reader)
			if result.Ready || result.More || reader.negative || len(reader.candidates) != 1 {
				t.Fatalf("unusable header was treated as a miss/nonmatch: result=%+v negative=%v candidates=%d", result, reader.negative, len(reader.candidates))
			}

			counts.reset()
			for i := 0; i < 20; i++ {
				result, err = reader.RefreshStep()
				if err != nil || result.Ready || result.More {
					t.Fatalf("unchanged candidate check %d = %+v, err=%v", i, result, err)
				}
			}
			calls, entries, _ := counts.listingSnapshot()
			if calls != 0 || entries != 0 || counts.totalFileOpens() != 0 || counts.totalBytes() != 0 {
				t.Fatalf("unchanged candidate checks did I/O: listings=%d entries=%d opens=%d bytes=%d", calls, entries, counts.totalFileOpens(), counts.totalBytes())
			}

			dirBefore, err := os.Stat(sessionsDir)
			if err != nil {
				t.Fatal(err)
			}
			complete := titleSessionContent(id, cwd, titleNameRecord("Completed "+test.name))
			if err := os.WriteFile(path, complete, 0644); err != nil {
				t.Fatal(err)
			}
			changedTime := time.Now().Add(time.Second)
			if err := os.Chtimes(path, changedTime, changedTime); err != nil {
				t.Fatal(err)
			}
			dirAfter, err := os.Stat(sessionsDir)
			if err != nil {
				t.Fatal(err)
			}
			if !samePiTitleMetadata(dirBefore, dirAfter) {
				t.Fatal("in-place candidate completion changed parent directory metadata")
			}
			counts.reset()
			result = refreshPiTitleToStable(t, reader)
			if !result.Ready || result.Title != "Completed "+test.name {
				t.Fatalf("completed header failed to bind: result=%+v", result)
			}
			calls, entries, _ = counts.listingSnapshot()
			if calls != 0 || entries != 0 || counts.fileOpens(path) != 2 {
				t.Fatalf("header retry relisted or skipped exact binding: listings=%d entries=%d opens=%d", calls, entries, counts.fileOpens(path))
			}
		})
	}
}

func TestPiTitleCacheValidAbsoluteCWDMismatchIsConclusive(t *testing.T) {
	cwd, sessionsDir := setupPiTestSessions(t)
	otherCWD, err := filepath.Abs(filepath.Join(t.TempDir(), "other-worktree"))
	if err != nil {
		t.Fatal(err)
	}
	id := "same-id-wrong-absolute-cwd"
	wrongHeader := fmt.Sprintf(`{"type":"session","id":%q,"cwd":%q}`, id, otherCWD)
	conversation := strings.Repeat(`{"type":"message","message":{"role":"user","content":"unrelated"}}`+"\n", 1000)
	path := filepath.Join(sessionsDir, "wrong-cwd.jsonl")
	if err := os.MkdirAll(sessionsDir, 0755); err != nil {
		t.Fatal(err)
	}
	content := wrongHeader + "\n" + conversation
	if err := os.WriteFile(path, []byte(content), 0644); err != nil {
		t.Fatal(err)
	}
	cache, counts := newCountedPiTitleCache()
	reader, err := cache.Acquire(cwd, id)
	if err != nil {
		t.Fatal(err)
	}
	defer cache.Release(reader)
	result := refreshPiTitleToStable(t, reader)
	if result.Ready || result.More || !reader.negative || len(reader.candidates) != 0 {
		t.Fatalf("valid absolute CWD mismatch was retained: result=%+v negative=%v candidates=%d", result, reader.negative, len(reader.candidates))
	}
	wantBytes := int64(len(wrongHeader) + 1)
	if got := counts.bytesFor(path); got != wantBytes {
		t.Fatalf("mismatched session parsed %d bytes, want header only (%d)", got, wantBytes)
	}
}

func TestPiTitleCacheCompletedNonmatchingHeaderSkipsConversation(t *testing.T) {
	cwd, sessionsDir, _, cache, counts, reader := titleCacheFixture(t, "wanted-id")
	defer cache.Release(reader)
	wrong := fmt.Sprintf(`{"type":"session","id":"other-id","cwd":%q}`, cwd)
	body := strings.Repeat("unrelated conversation data", 10000)
	path := filepath.Join(sessionsDir, "not-a-timestamp-name.jsonl")
	if err := os.MkdirAll(sessionsDir, 0755); err != nil {
		t.Fatal(err)
	}
	content := wrong + "\n" + body + "\n"
	if err := os.WriteFile(path, []byte(content), 0644); err != nil {
		t.Fatal(err)
	}
	result := refreshPiTitleToStable(t, reader)
	if result.Ready || len(reader.candidates) != 0 || !reader.negative {
		t.Fatalf("nonmatching header was retained: result=%+v candidates=%d negative=%v", result, len(reader.candidates), reader.negative)
	}
	headerBytes := int64(strings.IndexByte(content, '\n') + 1)
	if got := counts.bytesFor(path); got != headerBytes {
		t.Fatalf("discovery read %d bytes including conversation; want header only (%d)", got, headerBytes)
	}
}

func TestPiTitleCacheBindingReleasesUnrelatedIncompleteCandidates(t *testing.T) {
	cwd, sessionsDir := setupPiTestSessions(t)
	id := "bound-with-incomplete-peer"
	writeTitleSession(t, sessionsDir, "matching.jsonl", id, cwd, titleNameRecord("Bound title"))
	incompletePath := filepath.Join(sessionsDir, "unrelated-incomplete.jsonl")
	if err := os.WriteFile(incompletePath, []byte(`{"type":"session","id":"other","cwd":`), 0644); err != nil {
		t.Fatal(err)
	}
	cache, counts := newCountedPiTitleCache()
	reader, err := cache.Acquire(cwd, id)
	if err != nil {
		t.Fatal(err)
	}
	defer cache.Release(reader)
	result := refreshPiTitleToStable(t, reader)
	if !result.Ready || result.Title != "Bound title" || len(reader.matches) != 1 || len(reader.candidates) != 0 {
		t.Fatalf("bound reader retained unresolved candidates: result=%+v matches=%d candidates=%d", result, len(reader.matches), len(reader.candidates))
	}

	counts.reset()
	for i := 0; i < 20; i++ {
		result, err = reader.RefreshStep()
		if err != nil || !result.Ready || result.More || result.Title != "Bound title" {
			t.Fatalf("bound warm refresh %d = %+v, err=%v", i, result, err)
		}
	}
	calls, entries, _ := counts.listingSnapshot()
	if calls != 0 || entries != 0 || counts.totalFileOpens() != 0 || counts.totalBytes() != 0 || counts.fileOpens(incompletePath) != 0 {
		t.Fatalf("bound reader retained or retried unrelated candidate: lists=%d entries=%d opens=%d bytes=%d", calls, entries, counts.totalFileOpens(), counts.totalBytes())
	}
}

func TestPiTitleCacheExactCWDIsolationAndAmbiguity(t *testing.T) {
	setupMockHome(t)
	cwdA, err := filepath.Abs(filepath.Join(t.TempDir(), "worktree-a"))
	if err != nil {
		t.Fatal(err)
	}
	cwdB, err := filepath.Abs(filepath.Join(t.TempDir(), "worktree-b"))
	if err != nil {
		t.Fatal(err)
	}
	_, dirA, err := piSessionDirectory(cwdA)
	if err != nil {
		t.Fatal(err)
	}
	_, dirB, err := piSessionDirectory(cwdB)
	if err != nil {
		t.Fatal(err)
	}
	id := "duplicate-native-id"
	writeTitleSession(t, dirA, "a.jsonl", id, cwdA, titleNameRecord("Worktree A"))
	writeTitleSession(t, dirA, "wrong-cwd.jsonl", id, cwdB, titleNameRecord("Wrong CWD"))
	writeTitleSession(t, dirB, "b.jsonl", id, cwdB, titleNameRecord("Worktree B"))
	cache := NewPiTitleCache()
	readerA, err := cache.Acquire(cwdA, id)
	if err != nil {
		t.Fatal(err)
	}
	readerB, err := cache.Acquire(cwdB, id)
	if err != nil {
		t.Fatal(err)
	}
	defer cache.Release(readerA)
	defer cache.Release(readerB)
	resultA := refreshPiTitleToStable(t, readerA)
	resultB := refreshPiTitleToStable(t, readerB)
	if !resultA.Ready || resultA.Title != "Worktree A" || !resultB.Ready || resultB.Title != "Worktree B" {
		t.Fatalf("exact CWD results: A=%+v B=%+v", resultA, resultB)
	}

	ambiguousCWD, err := filepath.Abs(filepath.Join(t.TempDir(), "ambiguous-project"))
	if err != nil {
		t.Fatal(err)
	}
	_, ambiguousDir, err := piSessionDirectory(ambiguousCWD)
	if err != nil {
		t.Fatal(err)
	}
	writeTitleSession(t, ambiguousDir, "first.jsonl", id, ambiguousCWD, titleNameRecord("First"))
	writeTitleSession(t, ambiguousDir, "second.jsonl", id, ambiguousCWD, titleNameRecord("Second"))
	ambiguousReader, err := cache.Acquire(ambiguousCWD, id)
	if err != nil {
		t.Fatal(err)
	}
	defer cache.Release(ambiguousReader)
	var gotAmbiguous bool
	for i := 0; i < 10; i++ {
		_, err := ambiguousReader.RefreshStep()
		if errors.Is(err, errPiTitleAmbiguous) {
			gotAmbiguous = true
			break
		}
		if err != nil {
			t.Fatal(err)
		}
	}
	if !gotAmbiguous {
		t.Fatal("multiple exact ID/CWD files did not report ambiguity")
	}
}

func TestPiTitleCacheAbsentDirectoryDelayedFileAndSymlinkReplacement(t *testing.T) {
	cwd, sessionsDir := setupPiTestSessions(t)
	id := "delayed-file"
	cache, counts := newCountedPiTitleCache()
	reader, err := cache.Acquire(cwd, id)
	if err != nil {
		t.Fatal(err)
	}
	defer cache.Release(reader)
	result, err := reader.RefreshStep()
	if err != nil || result.Ready || result.More {
		t.Fatalf("absent project result=%+v err=%v", result, err)
	}
	counts.reset()
	for i := 0; i < 20; i++ {
		result, err = reader.RefreshStep()
		if err != nil || result.Ready || result.More {
			t.Fatalf("absent retry %d = %+v err=%v", i, result, err)
		}
	}
	calls, _, _ := counts.listingSnapshot()
	if calls != 0 || counts.totalFileOpens() != 0 || counts.totalBytes() != 0 {
		t.Fatalf("absent-directory cache repeated disk work: lists=%d opens=%d bytes=%d", calls, counts.totalFileOpens(), counts.totalBytes())
	}

	path, _ := writeTitleSession(t, sessionsDir, "appeared.jsonl", id, cwd, titleNameRecord("Appeared"))
	result = refreshPiTitleToStable(t, reader)
	if !result.Ready || result.Title != "Appeared" {
		t.Fatalf("delayed file result=%+v", result)
	}

	linkTarget := filepath.Join(sessionsDir, "link-target.txt")
	if err := os.WriteFile(linkTarget, titleSessionContent(id, cwd, titleNameRecord("Symlink target")), 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(linkTarget, path); err != nil {
		t.Skipf("symlink unavailable: %v", err)
	}
	counts.reset()
	result = refreshPiTitleToStable(t, reader)
	if !result.Ready || result.Title != "Appeared" {
		t.Fatalf("symlink replacement erased last title: %+v", result)
	}
	if counts.fileOpens(path) != 0 {
		t.Fatalf("symlink replacement opened session path %d times", counts.fileOpens(path))
	}
}

func TestPiTitleCacheAppendBudgetAndPartialLineCompletion(t *testing.T) {
	cwd, sessionsDir := setupPiTestSessions(t)
	id := "append-budget"
	fallback := `{"type":"message","message":{"role":"user","content":"Original request"}}`
	path, _ := writeTitleSession(t, sessionsDir, "append.jsonl", id, cwd, fallback)
	cache, counts := newCountedPiTitleCache()
	reader, err := cache.Acquire(cwd, id)
	if err != nil {
		t.Fatal(err)
	}
	defer cache.Release(reader)
	result := refreshPiTitleToStable(t, reader)
	if result.Title != "Original request" {
		t.Fatalf("initial title=%+v", result)
	}
	oldOffset := reader.readOffset
	oldComplete := reader.completeOffset
	partialRecord := titleNameRecord("Completed exactly once")
	appendBytes := []byte(partialRecord)
	file, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0644)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := file.Write(appendBytes); err != nil {
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
	counts.reset()
	result, err = reader.RefreshStep()
	if err != nil || !result.Ready || result.Title != "Original request" {
		t.Fatalf("partial record refresh=%+v err=%v", result, err)
	}
	if reader.readOffset != oldOffset+int64(len(appendBytes)) || reader.completeOffset != oldComplete {
		t.Fatalf("partial offsets read=%d complete=%d, prior read=%d complete=%d", reader.readOffset, reader.completeOffset, oldOffset, oldComplete)
	}
	if got := counts.bytesFor(path); got > int64(len(appendBytes))+2*piTitleContinuitySampleMax {
		t.Fatalf("partial append cost=%d bytes, new=%d plus at most 8KiB", got, len(appendBytes))
	}

	counts.reset()
	for i := 0; i < 20; i++ {
		result, err = reader.RefreshStep()
		if err != nil || result.Title != "Original request" {
			t.Fatalf("unchanged partial refresh %d = %+v err=%v", i, result, err)
		}
	}
	if counts.totalFileOpens() != 0 || counts.totalBytes() != 0 {
		t.Fatalf("unchanged partial suffix reread: opens=%d bytes=%d", counts.totalFileOpens(), counts.totalBytes())
	}

	file, err = os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0644)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := file.Write([]byte("\n")); err != nil {
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
	counts.reset()
	result, err = reader.RefreshStep()
	if err != nil || !result.Ready || result.Title != "Completed exactly once" {
		t.Fatalf("completed record refresh=%+v err=%v", result, err)
	}
	if reader.completeOffset != reader.readOffset {
		t.Fatalf("complete offset=%d read offset=%d", reader.completeOffset, reader.readOffset)
	}
	for i := 0; i < 20; i++ {
		result, err = reader.RefreshStep()
		if err != nil || result.Title != "Completed exactly once" {
			t.Fatalf("post-completion refresh %d = %+v err=%v", i, result, err)
		}
	}
	if counts.totalFileOpens() != 1 || counts.totalBytes() > int64(1+2*piTitleContinuitySampleMax) {
		t.Fatalf("completion was not applied once/bounded: opens=%d bytes=%d", counts.totalFileOpens(), counts.totalBytes())
	}
}

func TestPiTitleCacheSampleRetainsOnlyBoundedTail(t *testing.T) {
	prior := []byte("prior sample")
	data := bytes.Repeat([]byte("x"), 32*piTitleContinuitySampleMax)
	got := appendPiTitleSample(prior, data, piTitleContinuitySampleMax)
	want := data[len(data)-piTitleContinuitySampleMax:]
	if !bytes.Equal(got, want) {
		t.Fatalf("bounded sample tail mismatch: len=%d cap=%d", len(got), cap(got))
	}
	if len(got) != piTitleContinuitySampleMax || cap(got) > piTitleContinuitySampleMax {
		t.Fatalf("sample allocation exceeds bound: len=%d cap=%d", len(got), cap(got))
	}
}

func TestPiTitleCompleteOffsetRetainsLastTerminatedRecordAcrossChunks(t *testing.T) {
	t.Run("cold read", func(t *testing.T) {
		cwd, sessionsDir := setupPiTestSessions(t)
		id := "cold-complete-offset"
		headerLine := piSessionHeader(id, cwd)
		headerEnd := int64(len(headerLine) + 1)
		largeRecord := fmt.Sprintf(`{"type":"other","padding":%q}`, strings.Repeat("c", 600*1024))
		content := []byte(headerLine + "\n" + largeRecord)
		path := filepath.Join(sessionsDir, "cold-unfinished.jsonl")
		if err := os.MkdirAll(sessionsDir, 0755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, content, 0644); err != nil {
			t.Fatal(err)
		}
		cache, counts := newCountedPiTitleCache()
		reader, err := cache.Acquire(cwd, id)
		if err != nil {
			t.Fatal(err)
		}
		defer cache.Release(reader)
		readSteps := 0
		var result PiTitleResult
		for step := 0; step < 10; step++ {
			previousOffset := int64(0)
			if reader.rebuild != nil {
				previousOffset = reader.rebuild.readOffset
			}
			counts.reset()
			result, err = reader.RefreshStep()
			if err != nil {
				t.Fatalf("cold offset step %d: %v", step, err)
			}
			currentOffset := reader.readOffset
			currentCompleteOffset := reader.completeOffset
			if reader.rebuild != nil {
				currentOffset = reader.rebuild.readOffset
				currentCompleteOffset = reader.rebuild.completeOffset
			}
			newBytes := currentOffset - previousOffset
			if newBytes > piTitleStepByteBudget || counts.bytesFor(path) > piTitleStepByteBudget+headerEnd {
				t.Fatalf("cold offset step %d exceeded byte budget: new=%d read=%d", step, newBytes, counts.bytesFor(path))
			}
			if newBytes > 0 {
				readSteps++
				if currentCompleteOffset != headerEnd {
					t.Fatalf("cold partial record advanced complete frontier to %d, want %d", currentCompleteOffset, headerEnd)
				}
			}
			if reader.ready && reader.completeOffset != headerEnd {
				t.Fatalf("cold EOF complete frontier=%d, want %d", reader.completeOffset, headerEnd)
			}
			if result.Ready && !result.More {
				break
			}
		}
		if !result.Ready || reader.readOffset != int64(len(content)) || reader.completeOffset != headerEnd || readSteps < 3 {
			t.Fatalf("cold unfinished-record offsets/result: result=%+v read=%d complete=%d steps=%d", result, reader.readOffset, reader.completeOffset, readSteps)
		}
	})

	t.Run("append read", func(t *testing.T) {
		cwd, sessionsDir := setupPiTestSessions(t)
		id := "append-complete-offset"
		path, _ := writeTitleSession(t, sessionsDir, "append-unfinished.jsonl", id, cwd, titleNameRecord("Baseline"))
		cache, counts := newCountedPiTitleCache()
		reader, err := cache.Acquire(cwd, id)
		if err != nil {
			t.Fatal(err)
		}
		defer cache.Release(reader)
		if result := refreshPiTitleToStable(t, reader); !result.Ready || result.Title != "Baseline" {
			t.Fatalf("append offset baseline=%+v", result)
		}
		oldOffset := reader.readOffset
		oldComplete := reader.completeOffset
		largeRecord := fmt.Sprintf(`{"type":"other","padding":%q}`, strings.Repeat("a", 600*1024))
		file, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0644)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := file.Write([]byte(largeRecord)); err != nil {
			t.Fatal(err)
		}
		if err := file.Close(); err != nil {
			t.Fatal(err)
		}

		targetOffset := oldOffset + int64(len(largeRecord))
		readSteps := 0
		var result PiTitleResult
		for reader.readOffset < targetOffset {
			previousOffset := reader.readOffset
			counts.reset()
			result, err = reader.RefreshStep()
			if err != nil || !result.Ready {
				t.Fatalf("append offset step %d = %+v, err=%v", readSteps, result, err)
			}
			newBytes := reader.readOffset - previousOffset
			if newBytes <= 0 || newBytes > piTitleStepByteBudget || counts.bytesFor(path) > piTitleStepByteBudget+2*piTitleContinuitySampleMax {
				t.Fatalf("append offset step %d byte bounds: new=%d read=%d", readSteps, newBytes, counts.bytesFor(path))
			}
			if reader.completeOffset != oldComplete {
				t.Fatalf("append partial record advanced complete frontier to %d, want %d", reader.completeOffset, oldComplete)
			}
			readSteps++
		}
		if readSteps < 3 {
			t.Fatalf("append record crossed only %d byte-budget steps", readSteps)
		}
		file, err = os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0644)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := file.Write([]byte("\n")); err != nil {
			t.Fatal(err)
		}
		if err := file.Close(); err != nil {
			t.Fatal(err)
		}
		result = refreshPiTitleToStable(t, reader)
		if !result.Ready || result.Title != "Baseline" || reader.completeOffset != reader.readOffset {
			t.Fatalf("terminated appended record frontier/result: result=%+v read=%d complete=%d", result, reader.readOffset, reader.completeOffset)
		}
	})
}

func TestPiTitleCacheTargetReadBudgetAndColdPublication(t *testing.T) {
	cwd, sessionsDir := setupPiTestSessions(t)
	id := "large-cold-pass"
	padding := strings.Repeat("p", 600*1024)
	record := fmt.Sprintf(`{"type":"other","padding":%q}`, padding)
	path, content := writeTitleSession(t, sessionsDir, "large.jsonl", id, cwd, record)
	cache, counts := newCountedPiTitleCache()
	reader, err := cache.Acquire(cwd, id)
	if err != nil {
		t.Fatal(err)
	}
	defer cache.Release(reader)
	ready := false
	for step := 0; step < 20; step++ {
		counts.reset()
		result, err := reader.RefreshStep()
		if err != nil {
			t.Fatalf("large cold step %d: %v", step, err)
		}
		if reader.rebuild != nil {
			if got := counts.bytesFor(path); got > piTitleStepByteBudget {
				t.Fatalf("cold target step read %d bytes", got)
			}
		}
		if !result.Ready {
			if result.Title != "" {
				t.Fatalf("cold partial title published early: %q", result.Title)
			}
		} else if result.Title != "Pi session large-co" {
			t.Fatalf("empty completed file title=%q", result.Title)
		}
		if result.Ready && !result.More {
			ready = true
			break
		}
	}
	if !ready {
		t.Fatal("large cold pass did not complete")
	}
	if reader.readOffset != int64(len(content)) || reader.completeOffset != int64(len(content)) {
		t.Fatalf("large completed offsets read=%d complete=%d size=%d", reader.readOffset, reader.completeOffset, len(content))
	}
}

func TestPiTitleCacheAppendBudgetForLargeCapturedPass(t *testing.T) {
	cwd, sessionsDir := setupPiTestSessions(t)
	id := "large-append"
	path, _ := writeTitleSession(t, sessionsDir, "append-large.jsonl", id, cwd, titleNameRecord("Baseline"))
	cache, counts := newCountedPiTitleCache()
	reader, err := cache.Acquire(cwd, id)
	if err != nil {
		t.Fatal(err)
	}
	defer cache.Release(reader)
	if result := refreshPiTitleToStable(t, reader); result.Title != "Baseline" {
		t.Fatalf("initial result=%+v", result)
	}
	oldOffset := reader.readOffset
	largeOtherRecord := fmt.Sprintf(`{"type":"other","padding":%q}`+"\n", strings.Repeat("z", 300*1024))
	file, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0644)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := file.Write([]byte(largeOtherRecord)); err != nil {
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}

	remaining := int64(len(largeOtherRecord))
	for step := 0; step < 4 && remaining > 0; step++ {
		previousOffset := reader.readOffset
		counts.reset()
		result, err := reader.RefreshStep()
		if err != nil {
			t.Fatalf("append pass step %d: %v", step, err)
		}
		bytesRead := counts.bytesFor(path)
		newBytesRead := reader.readOffset - previousOffset
		if newBytesRead > piTitleStepByteBudget {
			t.Fatalf("append step %d read %d new bytes", step, newBytesRead)
		}
		if bytesRead-int64(newBytesRead) > 2*piTitleContinuitySampleMax {
			t.Fatalf("append step %d read %d continuity bytes", step, bytesRead-int64(newBytesRead))
		}
		if bytesRead > int64(piTitleStepByteBudget+2*piTitleContinuitySampleMax) {
			t.Fatalf("append step %d read %d bytes including continuity", step, bytesRead)
		}
		newBytes := bytesRead
		if step == 0 {
			if newBytes > int64(len(largeOtherRecord))+2*piTitleContinuitySampleMax {
				t.Fatalf("first append step exceeded new-byte plus continuity bound: %d", newBytes)
			}
		}
		consumed := reader.readOffset - oldOffset
		if consumed > int64(len(largeOtherRecord)) {
			consumed = int64(len(largeOtherRecord))
		}
		remaining = int64(len(largeOtherRecord)) - consumed
		if !result.Ready || result.Title != "Baseline" {
			t.Fatalf("unrelated append changed title: %+v", result)
		}
	}
	if remaining != 0 || reader.readOffset != oldOffset+int64(len(largeOtherRecord)) {
		t.Fatalf("append did not finish within bounded steps: remaining=%d offset=%d", remaining, reader.readOffset)
	}
}

func TestPiTitleCacheWarmBindingIgnoresUnrelatedDirectoryChurn(t *testing.T) {
	cwd, sessionsDir := setupPiTestSessions(t)
	id := "warm-directory-churn"
	targetPath, _ := writeTitleSession(t, sessionsDir, "z-bound.jsonl", id, cwd, titleNameRecord("Before churn"))
	cache, counts := newCountedPiTitleCache()
	reader, err := cache.Acquire(cwd, id)
	if err != nil {
		t.Fatal(err)
	}
	defer cache.Release(reader)
	if result := refreshPiTitleToStable(t, reader); !result.Ready || result.Title != "Before churn" {
		t.Fatalf("initial title=%+v", result)
	}

	oldOffset := reader.readOffset
	paddingRecord := fmt.Sprintf(`{"type":"other","padding":%q}`+"\n", strings.Repeat("p", piTitleStepByteBudget+8192))
	appendBytes := []byte(paddingRecord + titleNameRecord("Updated during directory churn") + "\n")
	file, err := os.OpenFile(targetPath, os.O_APPEND|os.O_WRONLY, 0644)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := file.Write(appendBytes); err != nil {
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}

	unrelatedPath := filepath.Join(sessionsDir, "a-unrelated-incomplete.jsonl")
	incompleteHeader := fmt.Sprintf(`{"type":"session","id":%q,"cwd":%q,"padding":"%s`, "unrelated", cwd, strings.Repeat("u", 2*piTitleStepByteBudget+1024))
	if err := os.WriteFile(unrelatedPath, []byte(incompleteHeader), 0644); err != nil {
		t.Fatal(err)
	}
	counts.reset()

	resolved := false
	steps := 0
	var result PiTitleResult
	for step := 0; step < 8; step++ {
		dirInfo, err := os.Stat(sessionsDir)
		if err != nil {
			t.Fatal(err)
		}
		changedTime := dirInfo.ModTime().Add(time.Second)
		if err := os.Chtimes(sessionsDir, changedTime, changedTime); err != nil {
			t.Fatal(err)
		}
		beforeOffset := reader.readOffset
		beforeBytes := counts.totalBytes()
		result, err = reader.RefreshStep()
		if err != nil {
			t.Fatalf("warm churn refresh %d: %v", step, err)
		}
		steps++
		newBytes := reader.readOffset - beforeOffset
		if newBytes <= 0 || newBytes > piTitleStepByteBudget {
			t.Fatalf("warm bound made no bounded append progress at step %d: old=%d new=%d result=%+v", step, beforeOffset, reader.readOffset, result)
		}
		stepBytes := counts.totalBytes() - beforeBytes
		if stepBytes > int64(piTitleStepByteBudget+2*piTitleContinuitySampleMax) {
			t.Fatalf("warm append step %d read %d bytes including continuity", step, stepBytes)
		}
		if result.Ready && result.Title == "Updated during directory churn" {
			resolved = true
			break
		}
	}
	if !resolved {
		t.Fatalf("warm append did not resolve under directory churn after %d steps: result=%+v offset=%d", steps, result, reader.readOffset)
	}
	if reader.readOffset != oldOffset+int64(len(appendBytes)) {
		t.Fatalf("warm append stopped at offset %d, want %d", reader.readOffset, oldOffset+int64(len(appendBytes)))
	}
	calls, entries, _ := counts.listingSnapshot()
	dirs, closedDirs, closedFiles := counts.openSnapshot()
	if calls != 0 || entries != 0 || dirs != 0 || closedDirs != 0 {
		t.Fatalf("valid binding rediscovered during directory churn: lists=%d entries=%d dirs=%d/%d", calls, entries, dirs, closedDirs)
	}
	if counts.fileOpens(unrelatedPath) != 0 || counts.bytesFor(unrelatedPath) != 0 {
		t.Fatalf("warm binding opened unrelated incomplete JSONL: opens=%d bytes=%d", counts.fileOpens(unrelatedPath), counts.bytesFor(unrelatedPath))
	}
	if counts.totalFileOpens() != counts.fileOpens(targetPath) || counts.totalFileOpens() != closedFiles {
		t.Fatalf("warm binding file accounting: opens=%d target=%d closed=%d", counts.totalFileOpens(), counts.fileOpens(targetPath), closedFiles)
	}
	if counts.bytesFor(targetPath) > int64(len(appendBytes)+steps*2*piTitleContinuitySampleMax) {
		t.Fatalf("warm append read %d bytes for %d appended bytes across %d steps", counts.bytesFor(targetPath), len(appendBytes), steps)
	}

	if err := os.Remove(unrelatedPath); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(targetPath); err != nil {
		t.Fatal(err)
	}
	missing, err := reader.RefreshStep()
	if err != nil || missing.More || !missing.Ready || missing.Title != "Updated during directory churn" || !reader.negative || reader.bindingPath != "" {
		t.Fatalf("disappeared exact binding did not cache a retained-title miss: result=%+v err=%v negative=%v binding=%q", missing, err, reader.negative, reader.bindingPath)
	}
	replacementPath, _ := writeTitleSession(t, sessionsDir, "delayed-replacement.jsonl", id, cwd, titleNameRecord("Delayed replacement"))
	result = refreshPiTitleToStable(t, reader)
	if !result.Ready || result.Title != "Delayed replacement" || reader.bindingPath != replacementPath {
		t.Fatalf("delayed replacement did not recover exact binding: result=%+v binding=%q", result, reader.bindingPath)
	}
}

func TestPiTitleCacheUnrelatedHistoriesDoNotOpenWarm(t *testing.T) {
	cwd, sessionsDir := setupPiTestSessions(t)
	id := "warm-bound"
	targetPath, _ := writeTitleSession(t, sessionsDir, "target.jsonl", id, cwd, titleNameRecord("Current"))
	unrelated := make([]string, 0, 12)
	for i := 0; i < 12; i++ {
		path, _ := writeTitleSession(t, sessionsDir, fmt.Sprintf("unrelated-%d.jsonl", i), fmt.Sprintf("other-%d", i), cwd,
			fmt.Sprintf(`{"type":"message","message":{"role":"user","content":"%s"}}`, strings.Repeat("history", 1000)))
		unrelated = append(unrelated, path)
	}
	cache, counts := newCountedPiTitleCache()
	reader, err := cache.Acquire(cwd, id)
	if err != nil {
		t.Fatal(err)
	}
	defer cache.Release(reader)
	if result := refreshPiTitleToStable(t, reader); !result.Ready || result.Title != "Current" {
		t.Fatalf("initial title=%+v", result)
	}
	counts.reset()
	for i := 0; i < 20; i++ {
		result, err := reader.RefreshStep()
		if err != nil || result.Title != "Current" {
			t.Fatalf("warm refresh %d = %+v err=%v", i, result, err)
		}
	}
	calls, entries, _ := counts.listingSnapshot()
	if calls != 0 || entries != 0 || counts.totalFileOpens() != 0 || counts.totalBytes() != 0 {
		t.Fatalf("warm tracked title scanned unrelated histories: lists=%d entries=%d opens=%d bytes=%d", calls, entries, counts.totalFileOpens(), counts.totalBytes())
	}
	for _, path := range unrelated {
		if counts.fileOpens(path) != 0 {
			t.Fatalf("warm refresh opened unrelated history %s", path)
		}
	}
	if targetPath == "" {
		t.Fatal("missing target fixture")
	}
}

func TestPiTitleCacheTruncationEqualAndLargerRewriteRecovery(t *testing.T) {
	tests := []struct {
		name     string
		newTitle string
		rewrite  func(t *testing.T, path string, content []byte)
	}{
		{
			name:     "truncation",
			newTitle: "Short",
			rewrite: func(t *testing.T, path string, content []byte) {
				if err := os.WriteFile(path, content, 0644); err != nil {
					t.Fatal(err)
				}
			},
		},
		{
			name:     "equal-size native rewrite",
			newTitle: "New name",
			rewrite: func(t *testing.T, path string, content []byte) {
				if err := os.WriteFile(path, content, 0644); err != nil {
					t.Fatal(err)
				}
				if err := os.Chtimes(path, time.Unix(1001, 0), time.Unix(1001, 0)); err != nil {
					t.Fatal(err)
				}
			},
		},
		{
			name:     "larger header migration rewrite",
			newTitle: "Migrated name",
			rewrite: func(t *testing.T, path string, content []byte) {
				if err := os.WriteFile(path, content, 0644); err != nil {
					t.Fatal(err)
				}
				if err := os.Chtimes(path, time.Unix(1002, 0), time.Unix(1002, 0)); err != nil {
					t.Fatal(err)
				}
			},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			cwd, sessionsDir := setupPiTestSessions(t)
			id := "rewrite-id"
			oldRecord := titleNameRecord("Old name")
			path, _ := writeTitleSession(t, sessionsDir, "native.jsonl", id, cwd, oldRecord)
			cache, _ := newCountedPiTitleCache()
			reader, err := cache.Acquire(cwd, id)
			if err != nil {
				t.Fatal(err)
			}
			defer cache.Release(reader)
			if result := refreshPiTitleToStable(t, reader); !result.Ready || result.Title != "Old name" {
				t.Fatalf("initial title=%+v", result)
			}
			if err := os.Chtimes(path, time.Unix(1000, 0), time.Unix(1000, 0)); err != nil {
				t.Fatal(err)
			}

			var newContent []byte
			switch test.name {
			case "truncation":
				newContent = titleSessionContent(id, cwd, titleNameRecord(test.newTitle))
			case "equal-size native rewrite":
				newContent = titleSessionContent(id, cwd, titleNameRecord(test.newTitle))
				oldContent := titleSessionContent(id, cwd, titleNameRecord("Old name"))
				if len(newContent) != len(oldContent) {
					t.Fatal("equal-size fixture is not equal-sized")
				}
			case "larger header migration rewrite":
				header := fmt.Sprintf(`{"type":"session","id":%q,"cwd":%q,"migrated":true,"padding":%q}`, id, cwd, strings.Repeat("m", 5000))
				newContent = []byte(header + "\n" + titleNameRecord(test.newTitle) + "\n")
			}
			test.rewrite(t, path, newContent)
			result := refreshPiTitleToStable(t, reader)
			if !result.Ready || result.Title != test.newTitle {
				t.Fatalf("rewritten title=%+v, want %q", result, test.newTitle)
			}
		})
	}
}

func TestPiTitleCacheReplacementAndSymlinkRejectPreserveTitle(t *testing.T) {
	cwd, sessionsDir := setupPiTestSessions(t)
	id := "replace-id"
	path, _ := writeTitleSession(t, sessionsDir, "replace.jsonl", id, cwd, titleNameRecord("Before replacement"))
	cache, counts := newCountedPiTitleCache()
	reader, err := cache.Acquire(cwd, id)
	if err != nil {
		t.Fatal(err)
	}
	defer cache.Release(reader)
	if result := refreshPiTitleToStable(t, reader); result.Title != "Before replacement" {
		t.Fatalf("initial title=%+v", result)
	}
	newPath := filepath.Join(sessionsDir, "new-file.tmp")
	if err := os.WriteFile(newPath, titleSessionContent(id, cwd, titleNameRecord("After replacement")), 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(newPath, path); err != nil {
		t.Fatal(err)
	}
	result := refreshPiTitleToStable(t, reader)
	if !result.Ready || result.Title != "After replacement" {
		t.Fatalf("replacement title=%+v", result)
	}

	target := filepath.Join(sessionsDir, "replacement-target.txt")
	if err := os.WriteFile(target, titleSessionContent(id, cwd, titleNameRecord("Should not apply")), 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, path); err != nil {
		t.Skipf("symlink unavailable: %v", err)
	}
	counts.reset()
	result = refreshPiTitleToStable(t, reader)
	if !result.Ready || result.Title != "After replacement" {
		t.Fatalf("symlink replacement title=%+v", result)
	}
	if counts.fileOpens(path) != 0 {
		t.Fatalf("symlink target was opened as session %d times", counts.fileOpens(path))
	}
}

func TestPiTitleCacheOversizedRecordContinuesToLaterName(t *testing.T) {
	cwd, sessionsDir := setupPiTestSessions(t)
	id := "oversized-record"
	oversized := strings.Repeat("x", maxPiTitleRecordBytes+1)
	path, _ := writeTitleSession(t, sessionsDir, "oversized.jsonl", id, cwd,
		titleNameRecord("Before oversized record"),
		oversized,
		titleNameRecord("After oversized record"),
	)
	cache, counts := newCountedPiTitleCache()
	reader, err := cache.Acquire(cwd, id)
	if err != nil {
		t.Fatal(err)
	}
	defer cache.Release(reader)
	warned := false
	var result PiTitleResult
	for step := 0; step < 100; step++ {
		result, err = reader.RefreshStep()
		if err != nil {
			t.Fatalf("oversized refresh %d: %v", step, err)
		}
		if errors.Is(result.Warning, errPiTitleRecordTooLarge) {
			warned = true
		}
		if result.Ready && !result.More {
			break
		}
	}
	if !result.Ready || result.Title != "After oversized record" || !warned {
		t.Fatalf("oversized recovery result=%+v warned=%v", result, warned)
	}
	if counts.bytesFor(path) > int64(len(titleSessionContent(id, cwd, titleNameRecord("Before oversized record"), oversized, titleNameRecord("After oversized record"))))+int64(strings.IndexByte(string(titleSessionContent(id, cwd)), '\n')+1) {
		t.Fatal("oversized recovery reread more than one cold pass plus the discovery header")
	}
}

func TestPiTitleCacheLastReleaseClosesHandlesAndDropsBuffers(t *testing.T) {
	cwd, sessionsDir := setupPiTestSessions(t)
	id := "release-active-reader"
	if err := os.MkdirAll(sessionsDir, 0755); err != nil {
		t.Fatal(err)
	}
	padding := strings.Repeat("x", 300*1024)
	header := fmt.Sprintf(`{"type":"session","id":%q,"cwd":%q,"padding":%q}`+"\n", id, cwd, padding)
	path := filepath.Join(sessionsDir, "release-candidate.jsonl")
	if err := os.WriteFile(path, []byte(header), 0644); err != nil {
		t.Fatal(err)
	}
	cache, counts := newCountedPiTitleCache()
	first, err := cache.Acquire(cwd, id)
	if err != nil {
		t.Fatal(err)
	}
	second, err := cache.Acquire(cwd, id)
	if err != nil || first != second {
		t.Fatalf("shared reader=%v err=%v", first == second, err)
	}
	result, err := first.RefreshStep()
	if err != nil || !result.More || first.headerScan == nil || first.discovery == nil {
		t.Fatalf("expected active bounded header scan: result=%+v err=%v", result, err)
	}
	if len(first.headerScan.decoder.pending) == 0 {
		t.Fatal("active header buffer was not retained for continuation")
	}
	cache.Release(first)
	if first.closed {
		t.Fatal("reader closed before last consumer released")
	}
	cache.Release(second)
	if !first.closed || first.headerScan != nil || first.discovery != nil || first.rebuild != nil || len(first.decoder.pending) != 0 || first.candidates != nil {
		t.Fatalf("last release retained reader resources: %+v", first)
	}
	dirs, closedDirs, closedFiles := counts.openSnapshot()
	if dirs != 1 || closedDirs != 1 || closedFiles != 1 {
		t.Fatalf("release handles: opened dirs=%d closed dirs=%d closed files=%d", dirs, closedDirs, closedFiles)
	}
}

type readHookPiTitleFile struct {
	piTitleFile
	once      sync.Once
	afterRead func()
}

func (f *readHookPiTitleFile) ReadAt(data []byte, offset int64) (int, error) {
	n, err := f.piTitleFile.ReadAt(data, offset)
	if n > 0 && f.afterRead != nil {
		f.once.Do(f.afterRead)
	}
	return n, err
}

type rewriteOnNthReadPiTitleFile struct {
	piTitleFile
	reads   int
	trigger int
	rewrite func()
}

func (f *rewriteOnNthReadPiTitleFile) ReadAt(data []byte, offset int64) (int, error) {
	n, err := f.piTitleFile.ReadAt(data, offset)
	if n > 0 {
		f.reads++
		if f.reads == f.trigger && f.rewrite != nil {
			f.rewrite()
		}
	}
	return n, err
}

type prematureEOFSavePiTitleFile struct {
	piTitleFile
}

func (f prematureEOFSavePiTitleFile) ReadAt([]byte, int64) (int, error) {
	return 0, io.EOF
}

type failingPiTitleFile struct {
	piTitleFile
	fail *bool
}

func (f failingPiTitleFile) ReadAt(data []byte, offset int64) (int, error) {
	if *f.fail {
		return 0, errors.New("injected Pi title read failure")
	}
	return f.piTitleFile.ReadAt(data, offset)
}

func TestPiTitleCacheHeaderTruncationRecoversWithoutRelisting(t *testing.T) {
	t.Run("between reader steps", func(t *testing.T) {
		exercisePiTitleCacheHeaderTruncationRecovery(t, false)
	})
	t.Run("during header read", func(t *testing.T) {
		exercisePiTitleCacheHeaderTruncationRecovery(t, true)
	})
}

func exercisePiTitleCacheHeaderTruncationRecovery(t *testing.T, duringRead bool) {
	t.Helper()
	cwd, sessionsDir := setupPiTestSessions(t)
	id := "header-truncate"
	path := filepath.Join(sessionsDir, "large-incomplete-header.jsonl")
	if err := os.MkdirAll(sessionsDir, 0755); err != nil {
		t.Fatal(err)
	}
	largeHeader := fmt.Sprintf(`{"type":"session","id":%q,"cwd":%q,"padding":"%s`, id, cwd, strings.Repeat("h", piTitleStepByteBudget+4096))
	if err := os.WriteFile(path, []byte(largeHeader), 0644); err != nil {
		t.Fatal(err)
	}
	shortContent := titleSessionContent(id, cwd, titleNameRecord("Recovered after truncation"))
	if len(shortContent) >= piTitleStepByteBudget {
		t.Fatal("short replacement unexpectedly exceeds the header byte budget")
	}
	dirBefore, err := os.Stat(sessionsDir)
	if err != nil {
		t.Fatal(err)
	}
	cache, counts := newCountedPiTitleCache()
	var rewriteErr error
	if duringRead {
		ops := cache.fs
		openFile := ops.openFile
		ops.openFile = func(filePath string) (piTitleFile, error) {
			file, err := openFile(filePath)
			if err != nil || filePath != path {
				return file, err
			}
			return &rewriteOnNthReadPiTitleFile{
				piTitleFile: file,
				trigger:     len(shortContent) + 32,
				rewrite: func() {
					rewriteErr = os.WriteFile(path, shortContent, 0644)
				},
			}, nil
		}
		cache.fs = ops
	}
	reader, err := cache.Acquire(cwd, id)
	if err != nil {
		t.Fatal(err)
	}
	defer cache.Release(reader)
	counts.reset()

	if !duringRead {
		result, err := reader.RefreshStep()
		if err != nil || !result.More || reader.headerScan == nil || reader.headerScan.offset != piTitleStepByteBudget || reader.headerScan.targetSize <= piTitleStepByteBudget {
			t.Fatalf("initial large-header step=%+v err=%v scan=%+v", result, err, reader.headerScan)
		}
		if got := counts.bytesFor(path); got != piTitleStepByteBudget {
			t.Fatalf("initial header step read %d bytes, want %d", got, piTitleStepByteBudget)
		}
		if err := os.WriteFile(path, shortContent, 0644); err != nil {
			t.Fatal(err)
		}
	}

	resolved := false
	var result PiTitleResult
	for step := 0; step < 12; step++ {
		beforeBytes := counts.totalBytes()
		result, err = reader.RefreshStep()
		if err != nil {
			t.Fatalf("header recovery step %d: %v", step, err)
		}
		if counts.totalBytes()-beforeBytes > int64(piTitleStepByteBudget+2*piTitleContinuitySampleMax) {
			t.Fatalf("header recovery step %d exceeded the byte bound", step)
		}
		if result.Ready && result.Title == "Recovered after truncation" && !result.More {
			resolved = true
			break
		}
	}
	if rewriteErr != nil {
		t.Fatalf("rewrite header during read: %v", rewriteErr)
	}
	if !resolved {
		scanOffset, scanTarget := int64(0), int64(0)
		if reader.headerScan != nil {
			scanOffset, scanTarget = reader.headerScan.offset, reader.headerScan.targetSize
		}
		t.Fatalf("truncated candidate did not recover finitely: result=%+v scanActive=%t offset=%d target=%d candidates=%d", result, reader.headerScan != nil, scanOffset, scanTarget, len(reader.candidates))
	}
	if reader.bindingPath != path || reader.headerScan != nil || reader.discovery != nil {
		t.Fatalf("header recovery left invalid state: binding=%q scan=%+v discovery=%+v", reader.bindingPath, reader.headerScan, reader.discovery)
	}
	dirAfter, err := os.Stat(sessionsDir)
	if err != nil {
		t.Fatal(err)
	}
	if !samePiTitleMetadata(dirBefore, dirAfter) {
		t.Fatal("in-place header truncation changed parent-directory metadata")
	}
	calls, entries, _ := counts.listingSnapshot()
	dirs, closedDirs, closedFiles := counts.openSnapshot()
	if calls > 2 || entries != 1 || dirs != 1 || closedDirs != 1 || counts.totalFileOpens() > 3 || counts.totalFileOpens() != closedFiles {
		t.Fatalf("header recovery relisted or leaked a scan handle: listings=%d entries=%d dirs=%d/%d file opens=%d closed=%d", calls, entries, dirs, closedDirs, counts.totalFileOpens(), closedFiles)
	}
	if counts.bytesFor(path) > int64(piTitleStepByteBudget+2*len(shortContent)) {
		t.Fatalf("header recovery read %d bytes for a %d-byte replacement", counts.bytesFor(path), len(shortContent))
	}
}

func TestPiTitleCachePrematureHeaderEOFWithoutMetadataChangeFinishesCandidate(t *testing.T) {
	cwd, sessionsDir := setupPiTestSessions(t)
	id := "premature-header-eof"
	path, _ := writeTitleSession(t, sessionsDir, "premature-eof.jsonl", id, cwd, titleNameRecord("Never read"))
	cache, counts := newCountedPiTitleCache()
	ops := cache.fs
	openFile := ops.openFile
	ops.openFile = func(filePath string) (piTitleFile, error) {
		file, err := openFile(filePath)
		if err != nil || filePath != path {
			return file, err
		}
		return prematureEOFSavePiTitleFile{piTitleFile: file}, nil
	}
	cache.fs = ops
	reader, err := cache.Acquire(cwd, id)
	if err != nil {
		t.Fatal(err)
	}
	defer cache.Release(reader)

	result, err := reader.RefreshStep()
	if err != nil || result.Ready || result.More || reader.headerScan != nil || reader.discovery != nil || len(reader.candidates) != 1 {
		t.Fatalf("premature unchanged EOF did not finish as inconclusive: result=%+v err=%v scan=%+v candidates=%d", result, err, reader.headerScan, len(reader.candidates))
	}
	if counts.fileOpens(path) != 1 || counts.bytesFor(path) != 0 {
		t.Fatalf("premature EOF I/O: opens=%d bytes=%d", counts.fileOpens(path), counts.bytesFor(path))
	}
	dirs, closedDirs, closedFiles := counts.openSnapshot()
	if dirs != 1 || closedDirs != 1 || closedFiles != counts.totalFileOpens() {
		t.Fatalf("premature EOF leaked handles: dirs=%d/%d files=%d/%d", dirs, closedDirs, closedFiles, counts.totalFileOpens())
	}

	counts.reset()
	for step := 0; step < 20; step++ {
		result, err = reader.RefreshStep()
		if err != nil || result.More {
			t.Fatalf("unchanged premature-EOF candidate step %d = %+v err=%v", step, result, err)
		}
	}
	calls, entries, _ := counts.listingSnapshot()
	if calls != 0 || entries != 0 || counts.totalFileOpens() != 0 || counts.totalBytes() != 0 {
		t.Fatalf("unchanged premature-EOF candidate repeated I/O: listings=%d entries=%d opens=%d bytes=%d", calls, entries, counts.totalFileOpens(), counts.totalBytes())
	}
}

func TestPiTitleCacheHeaderCompletionDuringReadRetriesWithoutRelisting(t *testing.T) {
	cwd, sessionsDir := setupPiTestSessions(t)
	id := "header-race"
	headerLine := piSessionHeader(id, cwd)
	partialEnd := strings.Index(headerLine, `,"cwd"`)
	if partialEnd < 0 {
		t.Fatal("header fixture has no CWD field")
	}
	partial := []byte(headerLine[:partialEnd])
	path := filepath.Join(sessionsDir, "incomplete-header.jsonl")
	if err := os.MkdirAll(sessionsDir, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, partial, 0644); err != nil {
		t.Fatal(err)
	}
	dirBefore, err := os.Stat(sessionsDir)
	if err != nil {
		t.Fatal(err)
	}
	complete := titleSessionContent(id, cwd, titleNameRecord("Completed during header read"))
	var writeErr error
	var completionOnce sync.Once
	cache, counts := newCountedPiTitleCache()
	ops := cache.fs
	openFile := ops.openFile
	ops.openFile = func(filePath string) (piTitleFile, error) {
		file, err := openFile(filePath)
		if err != nil || filePath != path {
			return file, err
		}
		return &readHookPiTitleFile{
			piTitleFile: file,
			afterRead: func() {
				completionOnce.Do(func() {
					writeErr = os.WriteFile(path, complete, 0644)
				})
			},
		}, nil
	}
	cache.fs = ops
	reader, err := cache.Acquire(cwd, id)
	if err != nil {
		t.Fatal(err)
	}
	defer cache.Release(reader)
	result := refreshPiTitleToStable(t, reader)
	if writeErr != nil {
		t.Fatalf("complete header from injected read hook: %v", writeErr)
	}
	if !result.Ready || result.Title != "Completed during header read" {
		t.Fatalf("header completion remained stuck against stale metadata: result=%+v binding=%q matches=%d candidates=%d needsRebuild=%v readerReady=%v opens=%d", result, reader.bindingPath, len(reader.matches), len(reader.candidates), reader.needsRebuild, reader.ready, counts.fileOpens(path))
	}
	dirAfter, err := os.Stat(sessionsDir)
	if err != nil {
		t.Fatal(err)
	}
	if !samePiTitleMetadata(dirBefore, dirAfter) {
		t.Fatal("in-place header completion changed parent directory metadata")
	}
	calls, entries, _ := counts.listingSnapshot()
	dirs, closedDirs, _ := counts.openSnapshot()
	if dirs != 1 || closedDirs != 1 || entries != 1 || calls > 2 || counts.fileOpens(path) != 3 {
		t.Fatalf("header retry relisted or failed to reread: listings=%d entries=%d dirs=%d/%d file opens=%d", calls, entries, dirs, closedDirs, counts.fileOpens(path))
	}
}

func TestPiTitleCacheReadFailureKeepsLastPublishedTitle(t *testing.T) {
	cwd, sessionsDir := setupPiTestSessions(t)
	id := "read-failure"
	path, _ := writeTitleSession(t, sessionsDir, "read-failure.jsonl", id, cwd, titleNameRecord("Published"))
	failReads := false
	ops := defaultPiTitleFSOps()
	ops.openFile = func(path string) (piTitleFile, error) {
		file, err := os.Open(path)
		if err != nil {
			return nil, err
		}
		if path == filepath.Join(sessionsDir, "read-failure.jsonl") {
			return failingPiTitleFile{piTitleFile: file, fail: &failReads}, nil
		}
		return file, nil
	}
	cache := newPiTitleCacheWithOps(ops)
	reader, err := cache.Acquire(cwd, id)
	if err != nil {
		t.Fatal(err)
	}
	defer cache.Release(reader)
	if result := refreshPiTitleToStable(t, reader); !result.Ready || result.Title != "Published" {
		t.Fatalf("initial published title=%+v", result)
	}

	padding := fmt.Sprintf(`{"type":"other","padding":%q}`, strings.Repeat("x", 300*1024))
	rewritten := titleSessionContent(id, cwd, titleNameRecord("Staged rebuild"), padding)
	if err := os.WriteFile(path, rewritten, 0644); err != nil {
		t.Fatal(err)
	}
	result, err := reader.RefreshStep()
	if err != nil || !result.Ready || result.Title != "Published" || !result.More {
		t.Fatalf("rewrite invalidation result=%+v err=%v", result, err)
	}
	result, err = reader.RefreshStep()
	if err != nil || !result.Ready || result.Title != "Published" || !result.More || reader.rebuild.state.Title() != "Staged rebuild" {
		t.Fatalf("partial rebuild was published or not staged: result=%+v err=%v staged=%+v", result, err, reader.rebuild)
	}
	failReads = true
	result, err = reader.RefreshStep()
	if err == nil || !result.Ready || result.Title != "Published" {
		t.Fatalf("read failure lost last published title: result=%+v err=%v", result, err)
	}
	failReads = false
	result = refreshPiTitleToStable(t, reader)
	if !result.Ready || result.Title != "Staged rebuild" {
		t.Fatalf("rebuild after transient failure=%+v", result)
	}
}

func TestPiTitleCacheRewriteResetsOnlyAffectedReader(t *testing.T) {
	cwd, sessionsDir := setupPiTestSessions(t)
	pathA, _ := writeTitleSession(t, sessionsDir, "a.jsonl", "reader-a", cwd, titleNameRecord("Title A"))
	pathB, _ := writeTitleSession(t, sessionsDir, "b.jsonl", "reader-b", cwd, titleNameRecord("Title B"))
	cache, counts := newCountedPiTitleCache()
	readerA, err := cache.Acquire(cwd, "reader-a")
	if err != nil {
		t.Fatal(err)
	}
	readerB, err := cache.Acquire(cwd, "reader-b")
	if err != nil {
		t.Fatal(err)
	}
	defer cache.Release(readerA)
	defer cache.Release(readerB)
	if result := refreshPiTitleToStable(t, readerA); !result.Ready || result.Title != "Title A" {
		t.Fatalf("reader A cold title=%+v", result)
	}
	if result := refreshPiTitleToStable(t, readerB); !result.Ready || result.Title != "Title B" {
		t.Fatalf("reader B cold title=%+v", result)
	}
	oldContent := titleSessionContent("reader-a", cwd, titleNameRecord("Title A"))
	newContent := titleSessionContent("reader-a", cwd, titleNameRecord("Title Z"))
	if len(oldContent) != len(newContent) {
		t.Fatal("equal-size rewrite fixture differs in size")
	}
	if err := os.WriteFile(pathA, newContent, 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(pathA, time.Unix(2000, 0), time.Unix(2000, 0)); err != nil {
		t.Fatal(err)
	}
	counts.reset()
	if result := refreshPiTitleToStable(t, readerA); !result.Ready || result.Title != "Title Z" {
		t.Fatalf("rewritten A title=%+v", result)
	}
	if counts.fileOpens(pathB) != 0 || counts.bytesFor(pathB) != 0 {
		t.Fatalf("reader A rebuild touched reader B: opens=%d bytes=%d", counts.fileOpens(pathB), counts.bytesFor(pathB))
	}
	result, err := readerB.RefreshStep()
	if err != nil || !result.Ready || result.Title != "Title B" || counts.fileOpens(pathB) != 0 {
		t.Fatalf("unchanged reader B result=%+v err=%v opens=%d", result, err, counts.fileOpens(pathB))
	}
}

func TestPiTitleCacheGenericFallbackUsesEightUnicodeCodePoints(t *testing.T) {
	cwd, sessionsDir := setupPiTestSessions(t)
	id := "abcdefg界extra"
	writeTitleSession(t, sessionsDir, "header-only.jsonl", id, cwd)
	cache := NewPiTitleCache()
	reader, err := cache.Acquire(cwd, id)
	if err != nil {
		t.Fatal(err)
	}
	defer cache.Release(reader)
	result := refreshPiTitleToStable(t, reader)
	if !result.Ready || result.Title != "Pi session abcdefg界" {
		t.Fatalf("Unicode generic fallback=%+v", result)
	}
}

func TestPiTitleCacheWaitsForNewlineBeforeCommittingLiveRecord(t *testing.T) {
	cwd, sessionsDir := setupPiTestSessions(t)
	id := "terminated-records"
	path := filepath.Join(sessionsDir, "unterminated.jsonl")
	if err := os.MkdirAll(sessionsDir, 0755); err != nil {
		t.Fatal(err)
	}
	content := piSessionHeader(id, cwd) + "\n" + titleNameRecord("Persisted after newline")
	if err := os.WriteFile(path, []byte(content), 0644); err != nil {
		t.Fatal(err)
	}
	cache := NewPiTitleCache()
	reader, err := cache.Acquire(cwd, id)
	if err != nil {
		t.Fatal(err)
	}
	defer cache.Release(reader)
	result := refreshPiTitleToStable(t, reader)
	if !result.Ready || result.Title != "Pi session terminat" || reader.completeOffset != int64(strings.IndexByte(content, '\n')+1) {
		t.Fatalf("unterminated valid JSON record was committed: result=%+v complete=%d", result, reader.completeOffset)
	}
	file, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0644)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := file.Write([]byte("\n")); err != nil {
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
	result = refreshPiTitleToStable(t, reader)
	if !result.Ready || result.Title != "Persisted after newline" {
		t.Fatalf("terminated record title=%+v", result)
	}
}

func TestPiTitleCacheColdPassUsesFiniteCapturedSize(t *testing.T) {
	cwd, sessionsDir := setupPiTestSessions(t)
	id := "finite-pass"
	other := fmt.Sprintf(`{"type":"other","padding":%q}`, strings.Repeat("p", 300*1024))
	path, _ := writeTitleSession(t, sessionsDir, "finite.jsonl", id, cwd, other)
	cache, counts := newCountedPiTitleCache()
	reader, err := cache.Acquire(cwd, id)
	if err != nil {
		t.Fatal(err)
	}
	defer cache.Release(reader)
	for step := 0; step < 10 && (reader.rebuild == nil || reader.rebuild.readOffset == 0); step++ {
		result, err := reader.RefreshStep()
		if err != nil || result.Ready {
			t.Fatalf("cold setup step=%+v err=%v", result, err)
		}
	}
	if reader.rebuild == nil || reader.rebuild.readOffset == 0 {
		t.Fatal("cold pass did not capture and begin reading its finite range")
	}
	appendRecord := titleNameRecord("Appended after capture") + "\n"
	file, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0644)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := file.Write([]byte(appendRecord)); err != nil {
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
	var result PiTitleResult
	for step := 0; step < 10; step++ {
		counts.reset()
		result, err = reader.RefreshStep()
		if err != nil {
			t.Fatalf("captured cold continuation %d: %v", step, err)
		}
		if counts.bytesFor(path) > piTitleStepByteBudget {
			t.Fatalf("cold continuation %d read %d bytes", step, counts.bytesFor(path))
		}
		if reader.rebuild == nil {
			break
		}
	}
	if !result.Ready || result.Title != "Pi session finite-p" || !result.More {
		t.Fatalf("cold pass chased later append: %+v", result)
	}
	result = refreshPiTitleToStable(t, reader)
	if !result.Ready || result.Title != "Appended after capture" {
		t.Fatalf("later append was not processed in a new pass: %+v", result)
	}
}

func TestPiTitleCacheChangedHeaderMustStillMatchExactIDAndCWD(t *testing.T) {
	cwd, sessionsDir := setupPiTestSessions(t)
	id := "header-revalidation"
	path, _ := writeTitleSession(t, sessionsDir, "header.jsonl", id, cwd, titleNameRecord("Trusted"))
	cache := NewPiTitleCache()
	reader, err := cache.Acquire(cwd, id)
	if err != nil {
		t.Fatal(err)
	}
	defer cache.Release(reader)
	if result := refreshPiTitleToStable(t, reader); !result.Ready || result.Title != "Trusted" {
		t.Fatalf("initial title=%+v", result)
	}
	wrongCWD, err := filepath.Abs(filepath.Join(t.TempDir(), "wrong-worktree"))
	if err != nil {
		t.Fatal(err)
	}
	rewritten := titleSessionContent(id, wrongCWD, titleNameRecord("Must not publish"))
	if err := os.WriteFile(path, rewritten, 0644); err != nil {
		t.Fatal(err)
	}
	var result PiTitleResult
	var foundError bool
	for step := 0; step < 10; step++ {
		result, err = reader.RefreshStep()
		if err != nil {
			foundError = true
			break
		}
	}
	if !foundError || !result.Ready || result.Title != "Trusted" {
		t.Fatalf("invalid rewritten header result=%+v err=%v", result, err)
	}
	result = refreshPiTitleToStable(t, reader)
	if !result.Ready || result.Title != "Trusted" {
		t.Fatalf("invalid header erased last published title: %+v", result)
	}
}
