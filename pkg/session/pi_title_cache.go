package session

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
)

const (
	piTitleStepByteBudget      = 256 * 1024
	piTitleStepEntryBudget     = 128
	piTitleContinuitySampleMax = 4 * 1024
)

var errPiTitleAmbiguous = errors.New("multiple Pi session files match the exact ID and CWD")

type piTitleDirectory interface {
	ReadDir(n int) ([]os.DirEntry, error)
	Close() error
}

type piTitleFile interface {
	ReadAt([]byte, int64) (int, error)
	Stat() (os.FileInfo, error)
	Close() error
}

type piTitleFSOps struct {
	statDir  func(string) (os.FileInfo, error)
	lstat    func(string) (os.FileInfo, error)
	openDir  func(string) (piTitleDirectory, error)
	openFile func(string) (piTitleFile, error)
}

func defaultPiTitleFSOps() piTitleFSOps {
	return piTitleFSOps{
		statDir: os.Stat,
		lstat:   os.Lstat,
		openDir: func(path string) (piTitleDirectory, error) { return os.Open(path) },
		openFile: func(path string) (piTitleFile, error) {
			return os.Open(path)
		},
	}
}

type piTitleCacheKey struct {
	cwd string
	id  string
}

type piTitleCacheEntry struct {
	reader *PiTitleReader
	refs   int
}

// PiTitleCache shares exact session-file readers among consumers.
type PiTitleCache struct {
	mu      sync.Mutex
	readers map[piTitleCacheKey]*piTitleCacheEntry
	fs      piTitleFSOps
}

// PiTitleResult is one bounded title-reader step.
type PiTitleResult struct {
	Title   string
	Ready   bool
	More    bool
	Warning error
}

// PiTitleReader holds only reduced title state and bounded file-reader state.
type PiTitleReader struct {
	key       piTitleCacheKey
	cwd       string
	id        string
	directory string
	fs        piTitleFSOps
	mu        sync.Mutex
	closed    bool

	dirExists           bool
	dirInfo             os.FileInfo
	scanInfo            os.FileInfo
	discovery           *piTitleDiscovery
	headerScan          *piTitleHeaderScan
	headerInDiscovery   bool
	candidates          map[string]os.FileInfo
	matches             map[string]os.FileInfo
	candidateSweep      []string
	candidateSweepIndex int
	negative            bool
	ambiguous           bool

	bindingPath  string
	bindingInfo  os.FileInfo
	needsRebuild bool

	ready          bool
	state          PiTitleState
	decoder        piRecordDecoder
	readOffset     int64
	completeOffset int64
	prefixSample   []byte
	endSample      []byte
	observedInfo   os.FileInfo
	appendTarget   int64
	rebuild        *piTitleRebuild
}

type piTitleDiscovery struct {
	stamp       os.FileInfo
	directory   piTitleDirectory
	entries     []os.DirEntry
	entryIndex  int
	readDirDone bool
	candidates  map[string]os.FileInfo
	matches     map[string]os.FileInfo
}

type piTitleHeaderOutcome uint8

const (
	piTitleHeaderInconclusive piTitleHeaderOutcome = iota
	piTitleHeaderNonmatch
	piTitleHeaderMatch
)

type piTitleHeaderScan struct {
	path       string
	info       os.FileInfo
	file       piTitleFile
	targetSize int64
	offset     int64
	decoder    piRecordDecoder
	outcome    piTitleHeaderOutcome
	finished   bool
	warning    error
}

type piTitleRebuild struct {
	target         int64
	readOffset     int64
	completeOffset int64
	decoder        piRecordDecoder
	state          PiTitleState
	headerVerified bool
	prefixSample   []byte
	endSample      []byte
	lastInfo       os.FileInfo
	headerErr      error
}

func NewPiTitleCache() *PiTitleCache {
	return newPiTitleCacheWithOps(defaultPiTitleFSOps())
}

func newPiTitleCacheWithOps(ops piTitleFSOps) *PiTitleCache {
	defaults := defaultPiTitleFSOps()
	if ops.statDir == nil {
		ops.statDir = defaults.statDir
	}
	if ops.lstat == nil {
		ops.lstat = defaults.lstat
	}
	if ops.openDir == nil {
		ops.openDir = defaults.openDir
	}
	if ops.openFile == nil {
		ops.openFile = defaults.openFile
	}
	return &PiTitleCache{readers: make(map[piTitleCacheKey]*piTitleCacheEntry), fs: ops}
}

// Acquire canonicalizes an exact CWD/ID binding without performing disk I/O.
func (c *PiTitleCache) Acquire(cwd, id string) (*PiTitleReader, error) {
	if strings.TrimSpace(id) == "" {
		return nil, fmt.Errorf("Pi session id must be nonempty")
	}
	canonicalCwd, directory, err := piSessionDirectory(cwd)
	if err != nil {
		return nil, err
	}
	keyCwd := canonicalCwd
	if runtime.GOOS == "windows" {
		keyCwd = strings.ToUpper(keyCwd)
	}
	key := piTitleCacheKey{cwd: keyCwd, id: id}

	c.mu.Lock()
	defer c.mu.Unlock()
	if entry := c.readers[key]; entry != nil {
		entry.refs++
		return entry.reader, nil
	}
	reader := &PiTitleReader{
		key:        key,
		cwd:        canonicalCwd,
		id:         id,
		directory:  directory,
		fs:         c.fs,
		candidates: make(map[string]os.FileInfo),
		matches:    make(map[string]os.FileInfo),
	}
	c.readers[key] = &piTitleCacheEntry{reader: reader, refs: 1}
	return reader, nil
}

// Release drops one consumer reference and frees reader resources after the last.
func (c *PiTitleCache) Release(reader *PiTitleReader) {
	if reader == nil {
		return
	}
	c.mu.Lock()
	entry := c.readers[reader.key]
	if entry == nil || entry.reader != reader {
		c.mu.Unlock()
		return
	}
	entry.refs--
	if entry.refs > 0 {
		c.mu.Unlock()
		return
	}
	delete(c.readers, reader.key)
	c.mu.Unlock()

	reader.mu.Lock()
	reader.closeLocked()
	reader.mu.Unlock()
}

// Directory returns the encoded Pi project directory without disk I/O.
func (r *PiTitleReader) Directory() string {
	return r.directory
}

// RefreshStep performs one bounded discovery or file-read step.
func (r *PiTitleReader) RefreshStep() (PiTitleResult, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.closed {
		return PiTitleResult{}, fmt.Errorf("Pi title reader is released")
	}

	dirInfo, dirExists, err := r.statProjectDirectoryLocked()
	if err != nil {
		return r.resultLocked(false, nil), err
	}
	r.dirExists = dirExists
	r.dirInfo = dirInfo
	if !dirExists {
		if r.discovery != nil {
			r.closeDiscoveryLocked()
		}
		r.closeHeaderScanLocked()
		r.clearBindingLocked()
		r.candidates = make(map[string]os.FileInfo)
		r.matches = make(map[string]os.FileInfo)
		r.scanInfo = nil
		r.negative = true
		r.ambiguous = false
		return r.resultLocked(false, nil), nil
	}

	directoryMetadataChanged := r.scanInfo == nil || !samePiTitleMetadata(r.scanInfo, dirInfo)
	if r.bindingPath != "" {
		result, boundErr := r.stepBoundFileLocked()
		if boundErr == nil {
			return result, nil
		}
		if !directoryMetadataChanged || r.bindingPath != "" || r.discovery == nil {
			return result, boundErr
		}
	}

	if r.discovery != nil && !samePiTitleObject(r.discovery.stamp, dirInfo) {
		r.closeDiscoveryLocked()
		r.closeHeaderScanLocked()
	}
	if r.discovery == nil && (r.scanInfo == nil || !samePiTitleMetadata(r.scanInfo, dirInfo)) {
		if err := r.beginDiscoveryLocked(dirInfo); err != nil {
			return r.resultLocked(false, nil), err
		}
	}
	if r.discovery != nil {
		warning, done, more, err := r.stepDiscoveryLocked()
		if err != nil {
			return r.resultLocked(more, warning), err
		}
		if !done {
			return r.resultLocked(true, warning), nil
		}
		if r.scanInfo != nil && !samePiTitleMetadata(r.scanInfo, r.dirInfo) {
			if err := r.beginDiscoveryLocked(r.dirInfo); err != nil {
				return r.resultLocked(false, warning), err
			}
			return r.resultLocked(true, warning), nil
		}
		if r.needsRebuild {
			return r.resultLocked(true, warning), nil
		}
		if len(r.matches) == 0 && len(r.candidates) == 0 {
			return r.resultLocked(false, warning), nil
		}
	}
	if r.ambiguous && r.discovery == nil {
		return r.resultLocked(false, nil), fmt.Errorf("%w: %s", errPiTitleAmbiguous, r.cwd)
	}

	warning, candidatesMore, err := r.stepCandidatesLocked()
	if err != nil {
		return r.resultLocked(candidatesMore, mergePiTitleWarnings(nil, warning)), err
	}
	if candidatesMore {
		return r.resultLocked(true, warning), nil
	}
	if r.bindingPath == "" {
		return r.resultLocked(false, warning), nil
	}

	result, err := r.stepBoundFileLocked()
	result.Warning = mergePiTitleWarnings(result.Warning, warning)
	return result, err
}

func (r *PiTitleReader) resultLocked(more bool, warning error) PiTitleResult {
	result := PiTitleResult{Ready: r.ready, More: more, Warning: warning}
	if r.ready {
		result.Title = resolvedPiTitle(r.state, r.id)
	}
	return result
}

func resolvedPiTitle(state PiTitleState, id string) string {
	if title := state.Title(); title != "" {
		return title
	}
	shortID := []rune(id)
	if len(shortID) > 8 {
		shortID = shortID[:8]
	}
	return "Pi session " + string(shortID)
}

func mergePiTitleWarnings(first, next error) error {
	if first != nil {
		return first
	}
	return next
}

func (r *PiTitleReader) statProjectDirectoryLocked() (os.FileInfo, bool, error) {
	info, err := r.fs.statDir(r.directory)
	if errors.Is(err, os.ErrNotExist) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, fmt.Errorf("stat Pi session directory: %w", err)
	}
	if !info.IsDir() {
		return nil, false, fmt.Errorf("Pi session path is not a directory: %s", r.directory)
	}
	return info, true, nil
}

func (r *PiTitleReader) beginDiscoveryLocked(info os.FileInfo) error {
	r.closeDiscoveryLocked()
	r.closeHeaderScanLocked()
	directory, err := r.fs.openDir(r.directory)
	if err != nil {
		return fmt.Errorf("open Pi session directory: %w", err)
	}
	r.discovery = &piTitleDiscovery{
		stamp:      info,
		directory:  directory,
		candidates: make(map[string]os.FileInfo),
		matches:    make(map[string]os.FileInfo),
	}
	r.negative = false
	r.ambiguous = false
	return nil
}

func (r *PiTitleReader) closeDiscoveryLocked() {
	if r.discovery != nil && r.discovery.directory != nil {
		_ = r.discovery.directory.Close()
	}
	r.discovery = nil
}

func (r *PiTitleReader) closeHeaderScanLocked() {
	if r.headerScan != nil && r.headerScan.file != nil {
		_ = r.headerScan.file.Close()
	}
	if r.headerScan != nil {
		r.headerScan.decoder.pending = nil
	}
	r.headerScan = nil
	r.headerInDiscovery = false
}

func (r *PiTitleReader) clearBindingLocked() {
	r.bindingPath = ""
	r.bindingInfo = nil
	r.needsRebuild = false
	r.rebuild = nil
	r.decoder.pending = nil
	r.readOffset = 0
	r.completeOffset = 0
	r.prefixSample = nil
	r.endSample = nil
	r.observedInfo = nil
	r.appendTarget = 0
	r.candidateSweep = nil
	r.candidateSweepIndex = 0
}

func (r *PiTitleReader) closeLocked() {
	if r.closed {
		return
	}
	r.closed = true
	r.closeDiscoveryLocked()
	r.closeHeaderScanLocked()
	r.rebuild = nil
	r.decoder.pending = nil
	r.prefixSample = nil
	r.endSample = nil
	r.state = PiTitleState{}
	r.ready = false
	r.clearBindingLocked()
	r.dirInfo = nil
	r.scanInfo = nil
	r.dirExists = false
	r.negative = false
	r.ambiguous = false
	r.candidates = nil
	r.matches = nil
	r.candidateSweep = nil
	r.candidateSweepIndex = 0
}

func (r *PiTitleReader) stepDiscoveryLocked() (warning error, done bool, more bool, err error) {
	discovery := r.discovery
	if discovery == nil {
		return nil, true, false, nil
	}
	budget := piTitleStepByteBudget
	entriesExamined := 0

	if r.headerScan != nil && r.headerInDiscovery {
		used, completed, outcome, info, scanWarning, scanErr := r.advanceHeaderScanLocked(budget)
		budget -= used
		warning = scanWarning
		if scanErr != nil {
			return warning, false, false, scanErr
		}
		if completed {
			r.recordDiscoveryHeaderLocked(r.headerScan.path, info, outcome)
			r.closeHeaderScanLocked()
		}
		if !completed {
			return warning, false, true, nil
		}
	}

	for entriesExamined < piTitleStepEntryBudget && budget > 0 {
		if discovery.entryIndex >= len(discovery.entries) {
			discovery.entries = nil
			discovery.entryIndex = 0
			if discovery.readDirDone {
				break
			}
			entries, readErr := discovery.directory.ReadDir(piTitleStepEntryBudget - entriesExamined)
			if readErr != nil && !errors.Is(readErr, io.EOF) {
				return warning, false, false, fmt.Errorf("read Pi session directory: %w", readErr)
			}
			discovery.entries = entries
			discovery.readDirDone = errors.Is(readErr, io.EOF)
			if len(entries) == 0 && discovery.readDirDone {
				break
			}
		}
		if discovery.entryIndex >= len(discovery.entries) {
			continue
		}
		entry := discovery.entries[discovery.entryIndex]
		discovery.entryIndex++
		entriesExamined++
		if filepath.Ext(entry.Name()) != ".jsonl" {
			continue
		}
		path := filepath.Join(r.directory, entry.Name())
		info, statErr := r.fs.lstat(path)
		if errors.Is(statErr, os.ErrNotExist) {
			continue
		}
		if statErr != nil {
			discovery.candidates[path] = nil
			if warning == nil {
				warning = fmt.Errorf("stat Pi title candidate %s: %w", path, statErr)
			}
			continue
		}
		if !regularPiTitleFile(info) {
			continue
		}
		scan, openErr := r.openHeaderScanLocked(path, info)
		if openErr != nil {
			discovery.candidates[path] = info
			if warning == nil {
				warning = fmt.Errorf("open Pi title header %s: %w", path, openErr)
			}
			continue
		}
		r.headerScan = scan
		r.headerInDiscovery = true
		used, completed, outcome, finalInfo, scanWarning, scanErr := r.advanceHeaderScanLocked(budget)
		budget -= used
		warning = mergePiTitleWarnings(warning, scanWarning)
		if scanErr != nil {
			return warning, false, false, scanErr
		}
		if completed {
			r.recordDiscoveryHeaderLocked(path, finalInfo, outcome)
			r.closeHeaderScanLocked()
		} else {
			return warning, false, true, nil
		}
	}

	if discovery.readDirDone && discovery.entryIndex >= len(discovery.entries) {
		r.finishDiscoveryLocked()
		if len(r.matches) > 1 {
			r.ambiguous = true
			return warning, true, false, fmt.Errorf("%w: %s", errPiTitleAmbiguous, r.cwd)
		}
		return warning, true, r.needsRebuild, nil
	}
	return warning, false, true, nil
}

func (r *PiTitleReader) recordDiscoveryHeaderLocked(path string, info os.FileInfo, outcome piTitleHeaderOutcome) {
	discovery := r.discovery
	if discovery == nil {
		return
	}
	switch outcome {
	case piTitleHeaderMatch:
		discovery.matches[path] = info
		delete(discovery.candidates, path)
	case piTitleHeaderNonmatch:
		delete(discovery.candidates, path)
	default:
		discovery.candidates[path] = info
	}
}

func (r *PiTitleReader) finishDiscoveryLocked() {
	discovery := r.discovery
	if discovery == nil {
		return
	}
	if discovery.directory != nil {
		_ = discovery.directory.Close()
		discovery.directory = nil
	}
	previousPath := r.bindingPath
	previousInfo := r.bindingInfo
	previousNeedsRebuild := r.needsRebuild
	previousRebuild := r.rebuild
	r.scanInfo = discovery.stamp
	r.candidates = discovery.candidates
	r.matches = discovery.matches
	r.candidateSweep = nil
	r.candidateSweepIndex = 0
	r.negative = len(r.matches) == 0 && len(r.candidates) == 0
	r.ambiguous = len(r.matches) > 1
	switch len(r.matches) {
	case 1:
		for path, info := range r.matches {
			r.bindingPath = path
			r.bindingInfo = info
			if path == previousPath && samePiTitleObject(previousInfo, info) {
				r.needsRebuild = previousNeedsRebuild
				r.rebuild = previousRebuild
				if !r.ready && r.rebuild == nil {
					r.needsRebuild = true
				}
			} else {
				r.clearBindingLocked()
				r.bindingPath = path
				r.bindingInfo = info
				r.needsRebuild = true
			}
		}
	default:
		r.clearBindingLocked()
	}
	if len(r.matches) == 1 {
		r.candidates = nil
		r.candidateSweep = nil
		r.candidateSweepIndex = 0
	}
	r.discovery = nil
}

func (r *PiTitleReader) openHeaderScanLocked(path string, info os.FileInfo) (*piTitleHeaderScan, error) {
	if !regularPiTitleFile(info) {
		return nil, fmt.Errorf("Pi title candidate is not a regular file: %s", path)
	}
	file, err := r.fs.openFile(path)
	if err != nil {
		return nil, err
	}
	openedInfo, err := file.Stat()
	if err != nil {
		_ = file.Close()
		return nil, err
	}
	if !regularPiTitleFile(openedInfo) || !samePiTitleObject(info, openedInfo) {
		_ = file.Close()
		return nil, fmt.Errorf("Pi title candidate changed while opening: %s", path)
	}
	return &piTitleHeaderScan{
		path:       path,
		info:       openedInfo,
		file:       file,
		targetSize: openedInfo.Size(),
	}, nil
}

func (r *PiTitleReader) advanceHeaderScanLocked(budget int) (int, bool, piTitleHeaderOutcome, os.FileInfo, error, error) {
	scan := r.headerScan
	if scan == nil {
		return 0, true, piTitleHeaderInconclusive, nil, nil, nil
	}
	used := 0
	prematureEOF := false
	var one [1]byte
	for used < budget && scan.offset < scan.targetSize && !scan.finished {
		n, readErr := scan.file.ReadAt(one[:], scan.offset)
		if n > 0 {
			scan.offset += int64(n)
			used += n
			feedWarning := scan.decoder.Feed(one[:n], false, func(record []byte) error {
				scan.finished = true
				if !json.Valid(record) {
					scan.outcome = piTitleHeaderInconclusive
					return fmt.Errorf("decode Pi session header in %s: malformed JSON", scan.path)
				}
				var header PiSessionHeader
				if err := json.Unmarshal(record, &header); err != nil {
					scan.outcome = piTitleHeaderInconclusive
					return fmt.Errorf("decode Pi session header in %s: %w", scan.path, err)
				}
				if header.Type == "" {
					scan.outcome = piTitleHeaderInconclusive
					return nil
				}
				if header.Type != "session" {
					scan.outcome = piTitleHeaderNonmatch
					return nil
				}
				if strings.TrimSpace(header.ID) == "" {
					scan.outcome = piTitleHeaderInconclusive
					return nil
				}
				if header.ID != r.id {
					scan.outcome = piTitleHeaderNonmatch
					return nil
				}
				headerCwd, err := canonicalPiCWD(header.Cwd)
				if err != nil {
					scan.outcome = piTitleHeaderInconclusive
					return nil
				}
				matches, err := piCWDEqual(r.cwd, headerCwd)
				if err != nil {
					scan.outcome = piTitleHeaderInconclusive
					return nil
				}
				if !matches {
					scan.outcome = piTitleHeaderNonmatch
					return nil
				}
				scan.outcome = piTitleHeaderMatch
				return nil
			})
			if feedWarning != nil {
				scan.warning = mergePiTitleWarnings(scan.warning, feedWarning)
				if errors.Is(feedWarning, errPiTitleRecordTooLarge) {
					scan.finished = true
					scan.outcome = piTitleHeaderNonmatch
				}
			}
		}
		if readErr != nil {
			if errors.Is(readErr, io.EOF) {
				prematureEOF = true
				break
			}
			return used, false, scan.outcome, scan.info, scan.warning, fmt.Errorf("read Pi session header %s: %w", scan.path, readErr)
		}
		if n == 0 {
			return used, false, scan.outcome, scan.info, scan.warning, io.ErrNoProgress
		}
	}
	if !scan.finished && scan.offset < scan.targetSize && used >= budget {
		return used, false, scan.outcome, scan.info, scan.warning, nil
	}

	fileInfo, statErr := scan.file.Stat()
	pathInfo, pathErr := r.fs.lstat(scan.path)
	if statErr != nil {
		return used, false, scan.outcome, scan.info, scan.warning, fmt.Errorf("stat opened Pi session header %s: %w", scan.path, statErr)
	}
	if pathErr != nil || !samePiTitleObject(fileInfo, pathInfo) || !samePiTitleMetadata(scan.info, fileInfo) {
		// Keep the metadata captured before reading. If the candidate changed
		// while its captured header range was inspected, the next recovery sweep
		// must notice the newer metadata and retry those bytes.
		scan.outcome = piTitleHeaderInconclusive
	}
	if prematureEOF {
		if pathErr == nil && samePiTitleObject(fileInfo, pathInfo) && !samePiTitleMetadata(scan.info, fileInfo) {
			// The captured range disappeared under this reader. Reset against the
			// new in-place contents so the next bounded step can inspect them from
			// byte zero instead of retrying the unreachable old target forever.
			scan.info = fileInfo
			scan.targetSize = fileInfo.Size()
			scan.offset = 0
			scan.decoder = piRecordDecoder{}
			scan.outcome = piTitleHeaderInconclusive
			scan.finished = false
			return used, scan.targetSize == 0, scan.outcome, scan.info, scan.warning, nil
		}
		// An EOF without a metadata change cannot make progress. Finish it as
		// inconclusive and retain the candidate metadata for a later change.
		scan.outcome = piTitleHeaderInconclusive
		return used, true, scan.outcome, scan.info, scan.warning, nil
	}
	if scan.finished || scan.offset >= scan.targetSize || errors.Is(scan.warning, errPiTitleRecordTooLarge) {
		return used, true, scan.outcome, scan.info, scan.warning, nil
	}
	return used, false, scan.outcome, scan.info, scan.warning, nil
}

func (r *PiTitleReader) stepCandidatesLocked() (warning error, more bool, err error) {
	budget := piTitleStepByteBudget
	checksUsed := 0
	if r.headerScan != nil && !r.headerInDiscovery {
		used, completed, outcome, info, scanWarning, scanErr := r.advanceHeaderScanLocked(budget)
		budget -= used
		checksUsed++
		warning = scanWarning
		if scanErr != nil {
			path := r.headerScan.path
			r.candidates[path] = r.headerScan.info
			r.closeHeaderScanLocked()
			return warning, false, scanErr
		}
		if !completed {
			return warning, true, nil
		}
		path := r.headerScan.path
		r.applyCandidateHeaderLocked(path, info, outcome)
		r.closeHeaderScanLocked()
		if len(r.matches) > 1 {
			return warning, false, fmt.Errorf("%w: %s", errPiTitleAmbiguous, r.cwd)
		}
		if budget == 0 && r.candidateSweepIndex < len(r.candidateSweep) {
			return warning, true, nil
		}
	}

	if len(r.candidates) == 0 {
		r.candidateSweep = nil
		r.candidateSweepIndex = 0
		r.negative = len(r.matches) == 0
		return warning, false, nil
	}
	if r.candidateSweep == nil {
		paths := make([]string, 0, len(r.candidates))
		for path := range r.candidates {
			paths = append(paths, path)
		}
		sort.Strings(paths)
		r.candidateSweep = paths
		r.candidateSweepIndex = 0
	}
	remaining := len(r.candidateSweep) - r.candidateSweepIndex
	if remaining <= 0 {
		r.candidateSweep = nil
		r.candidateSweepIndex = 0
		r.negative = len(r.matches) == 0 && len(r.candidates) == 0
		return warning, false, nil
	}
	limit := min(remaining, piTitleStepEntryBudget-checksUsed)
	examinedCount := 0
	for examinedCount < limit && budget > 0 {
		path := r.candidateSweep[r.candidateSweepIndex]
		r.candidateSweepIndex++
		examinedCount++
		if _, tracked := r.candidates[path]; !tracked {
			continue
		}
		info, statErr := r.fs.lstat(path)
		if errors.Is(statErr, os.ErrNotExist) {
			delete(r.candidates, path)
			continue
		}
		if statErr != nil {
			if warning == nil {
				warning = fmt.Errorf("stat Pi title candidate %s: %w", path, statErr)
			}
			continue
		}
		if !regularPiTitleFile(info) {
			delete(r.candidates, path)
			continue
		}
		previous := r.candidates[path]
		if previous != nil && samePiTitleMetadata(previous, info) {
			continue
		}
		scan, openErr := r.openHeaderScanLocked(path, info)
		if openErr != nil {
			r.candidates[path] = info
			if warning == nil {
				warning = fmt.Errorf("open Pi title header %s: %w", path, openErr)
			}
			continue
		}
		r.headerScan = scan
		r.headerInDiscovery = false
		used, completed, outcome, finalInfo, scanWarning, scanErr := r.advanceHeaderScanLocked(budget)
		budget -= used
		warning = mergePiTitleWarnings(warning, scanWarning)
		if scanErr != nil {
			r.candidates[path] = info
			r.closeHeaderScanLocked()
			return warning, false, scanErr
		}
		if !completed {
			return warning, true, nil
		}
		r.applyCandidateHeaderLocked(path, finalInfo, outcome)
		r.closeHeaderScanLocked()
		if len(r.matches) > 1 {
			return warning, false, fmt.Errorf("%w: %s", errPiTitleAmbiguous, r.cwd)
		}
		if len(r.candidates) == 0 {
			break
		}
	}
	more = r.candidateSweep != nil && r.candidateSweepIndex < len(r.candidateSweep)
	if !more {
		r.candidateSweep = nil
		r.candidateSweepIndex = 0
		r.negative = len(r.matches) == 0 && len(r.candidates) == 0
	}
	return warning, more, nil
}

func (r *PiTitleReader) applyCandidateHeaderLocked(path string, info os.FileInfo, outcome piTitleHeaderOutcome) {
	switch outcome {
	case piTitleHeaderMatch:
		delete(r.candidates, path)
		r.matches[path] = info
		if r.bindingPath == "" {
			r.bindingPath = path
			r.bindingInfo = info
			r.needsRebuild = true
		}
		if len(r.matches) == 1 {
			r.candidates = nil
			r.candidateSweep = nil
			r.candidateSweepIndex = 0
		}
	case piTitleHeaderNonmatch:
		delete(r.candidates, path)
	default:
		r.candidates[path] = info
	}
	r.negative = len(r.matches) == 0 && len(r.candidates) == 0
	r.ambiguous = len(r.matches) > 1
}

func (r *PiTitleReader) startRebuildLocked(info os.FileInfo) {
	r.rebuild = &piTitleRebuild{target: info.Size(), lastInfo: info}
	r.needsRebuild = false
	r.appendTarget = 0
}

func (r *PiTitleReader) openBoundFileLocked(path string, pathInfo os.FileInfo) (piTitleFile, os.FileInfo, error) {
	if !regularPiTitleFile(pathInfo) {
		return nil, nil, fmt.Errorf("Pi session binding is not a regular file: %s", path)
	}
	file, err := r.fs.openFile(path)
	if err != nil {
		return nil, nil, err
	}
	openedInfo, err := file.Stat()
	if err != nil {
		_ = file.Close()
		return nil, nil, err
	}
	if !regularPiTitleFile(openedInfo) || !samePiTitleObject(pathInfo, openedInfo) {
		_ = file.Close()
		return nil, nil, fmt.Errorf("Pi session binding changed while opening: %s", path)
	}
	return file, openedInfo, nil
}

func (r *PiTitleReader) stepBoundFileLocked() (PiTitleResult, error) {
	path := r.bindingPath
	info, err := r.fs.lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		r.invalidateBindingAndDiscoverLocked()
		return r.resultLocked(true, nil), fmt.Errorf("Pi session binding disappeared: %s", path)
	}
	if err != nil {
		return r.resultLocked(false, nil), fmt.Errorf("stat Pi session binding %s: %w", path, err)
	}
	if !regularPiTitleFile(info) {
		r.invalidateBindingAndDiscoverLocked()
		return r.resultLocked(true, nil), fmt.Errorf("Pi session binding is not a regular nonsymlink file: %s", path)
	}
	if r.rebuild != nil || r.needsRebuild || !r.ready || r.observedInfo == nil {
		if r.rebuild == nil {
			r.startRebuildLocked(info)
		}
		return r.stepRebuildLocked(info)
	}
	if r.appendTarget == 0 && info.Size() == r.readOffset && samePiTitleMetadata(r.observedInfo, info) {
		return r.resultLocked(false, nil), nil
	}
	return r.stepAppendLocked(info)
}

func (r *PiTitleReader) invalidateBindingAndDiscoverLocked() {
	delete(r.matches, r.bindingPath)
	r.clearBindingLocked()
	r.scanInfo = nil
	if r.dirExists && r.dirInfo != nil {
		_ = r.beginDiscoveryLocked(r.dirInfo)
	}
}

func (r *PiTitleReader) stepRebuildLocked(pathInfo os.FileInfo) (PiTitleResult, error) {
	pass := r.rebuild
	if pass == nil {
		r.startRebuildLocked(pathInfo)
		pass = r.rebuild
	}
	if !samePiTitleObject(pass.lastInfo, pathInfo) || pathInfo.Size() < pass.readOffset || pathInfo.Size() < pass.target {
		r.startRebuildLocked(pathInfo)
		return r.resultLocked(true, nil), nil
	}
	file, openedInfo, err := r.openBoundFileLocked(r.bindingPath, pathInfo)
	if err != nil {
		return r.resultLocked(false, nil), fmt.Errorf("open Pi session for title rebuild: %w", err)
	}
	defer file.Close()
	if !samePiTitleObject(pass.lastInfo, openedInfo) || openedInfo.Size() < pass.readOffset || openedInfo.Size() < pass.target {
		r.startRebuildLocked(openedInfo)
		return r.resultLocked(true, nil), nil
	}
	if !samePiTitleMetadata(pass.lastInfo, openedInfo) && pass.readOffset > 0 {
		matches, sampleErr := comparePiTitleSamples(file, openedInfo.Size(), pass.readOffset, pass.prefixSample, pass.endSample)
		if sampleErr != nil {
			return r.resultLocked(false, nil), fmt.Errorf("check Pi session continuity: %w", sampleErr)
		}
		if !matches || openedInfo.Size() <= pass.lastInfo.Size() {
			r.startRebuildLocked(openedInfo)
			return r.resultLocked(true, nil), nil
		}
	}

	remaining := pass.target - pass.readOffset
	if remaining < 0 {
		r.startRebuildLocked(openedInfo)
		return r.resultLocked(true, nil), nil
	}
	newBytes := int(min(int64(piTitleStepByteBudget), remaining))
	data, readErr := readPiTitleBytes(file, pass.readOffset, newBytes)
	if readErr != nil {
		if errors.Is(readErr, io.ErrUnexpectedEOF) && openedInfo.Size() < pass.target {
			r.startRebuildLocked(openedInfo)
			return r.resultLocked(true, nil), nil
		}
		return r.resultLocked(false, nil), fmt.Errorf("read Pi session title rebuild: %w", readErr)
	}
	afterInfo, err := file.Stat()
	if err != nil {
		return r.resultLocked(false, nil), fmt.Errorf("stat Pi session after rebuild read: %w", err)
	}
	pathAfter, err := r.fs.lstat(r.bindingPath)
	if err != nil || !samePiTitleObject(afterInfo, pathAfter) {
		return r.resultLocked(false, nil), fmt.Errorf("Pi session binding changed during title rebuild: %s", r.bindingPath)
	}
	if afterInfo.Size() < pass.readOffset+int64(len(data)) {
		r.startRebuildLocked(afterInfo)
		return r.resultLocked(true, nil), nil
	}
	if !samePiTitleMetadata(openedInfo, afterInfo) && afterInfo.Size() <= openedInfo.Size() {
		r.startRebuildLocked(afterInfo)
		return r.resultLocked(true, nil), nil
	}

	var warning error
	if len(data) > 0 {
		baseOffset := pass.readOffset
		warning = pass.decoder.Feed(data, false, func(record []byte) error {
			if !pass.headerVerified {
				if headerErr := validatePiTitleHeader(record, r.cwd, r.id); headerErr != nil {
					pass.headerErr = headerErr
					return headerErr
				}
				pass.headerVerified = true
				return nil
			}
			return pass.state.applyRecord(record)
		})
		pass.prefixSample = extendPiTitlePrefix(pass.prefixSample, baseOffset, data)
		pass.endSample = appendPiTitleSample(pass.endSample, data, piTitleContinuitySampleMax)
		pass.completeOffset = lastPiTitleRecordOffset(pass.completeOffset, baseOffset, data)
		pass.readOffset += int64(len(data))
	}
	if pass.headerErr != nil {
		path := r.bindingPath
		r.invalidateBindingAndDiscoverLocked()
		return r.resultLocked(true, warning), fmt.Errorf("Pi session header no longer matches exact ID/CWD for %s: %w", path, pass.headerErr)
	}
	pass.lastInfo = afterInfo
	if !pass.headerVerified && pass.readOffset >= pass.target {
		path := r.bindingPath
		r.invalidateBindingAndDiscoverLocked()
		return r.resultLocked(true, warning), fmt.Errorf("Pi session header no longer matches exact ID/CWD for %s", path)
	}
	if pass.readOffset < pass.target {
		r.rebuild = pass
		return r.resultLocked(true, warning), nil
	}

	r.state = pass.state
	r.decoder = pass.decoder
	r.readOffset = pass.readOffset
	r.completeOffset = pass.completeOffset
	r.prefixSample = pass.prefixSample
	r.endSample = pass.endSample
	r.observedInfo = pass.lastInfo
	r.bindingInfo = pass.lastInfo
	r.matches[r.bindingPath] = pass.lastInfo
	r.rebuild = nil
	r.ready = true
	return r.resultLocked(afterInfo.Size() > r.readOffset, warning), nil
}

func validatePiTitleHeader(record []byte, cwd, id string) error {
	var header PiSessionHeader
	if err := json.Unmarshal(record, &header); err != nil {
		return fmt.Errorf("decode Pi session header: %w", err)
	}
	if header.Type != "session" {
		return fmt.Errorf("Pi session header has type %q", header.Type)
	}
	if strings.TrimSpace(header.ID) == "" || header.ID != id {
		return fmt.Errorf("Pi session header ID does not match exact ID %q", id)
	}
	matches, err := piCWDEqual(cwd, header.Cwd)
	if err != nil {
		return fmt.Errorf("validate Pi session header CWD: %w", err)
	}
	if !matches {
		return fmt.Errorf("Pi session header CWD %q does not match %q", header.Cwd, cwd)
	}
	return nil
}

func (r *PiTitleReader) stepAppendLocked(pathInfo os.FileInfo) (PiTitleResult, error) {
	file, openedInfo, err := r.openBoundFileLocked(r.bindingPath, pathInfo)
	if err != nil {
		return r.resultLocked(false, nil), fmt.Errorf("open Pi session for title append: %w", err)
	}
	defer file.Close()
	if !samePiTitleObject(r.observedInfo, openedInfo) || openedInfo.Size() < r.readOffset {
		r.startRebuildLocked(openedInfo)
		return r.resultLocked(true, nil), nil
	}

	metadataChanged := !samePiTitleMetadata(r.observedInfo, openedInfo)
	newPass := r.appendTarget == 0
	if metadataChanged || newPass {
		if r.readOffset > 0 {
			matches, sampleErr := comparePiTitleSamples(file, openedInfo.Size(), r.readOffset, r.prefixSample, r.endSample)
			if sampleErr != nil {
				return r.resultLocked(false, nil), fmt.Errorf("check Pi session append continuity: %w", sampleErr)
			}
			if !matches {
				r.startRebuildLocked(openedInfo)
				return r.resultLocked(true, nil), nil
			}
		}
		if metadataChanged && openedInfo.Size() <= r.observedInfo.Size() {
			r.startRebuildLocked(openedInfo)
			return r.resultLocked(true, nil), nil
		}
	}
	if r.appendTarget == 0 {
		r.appendTarget = openedInfo.Size()
	}
	if openedInfo.Size() < r.appendTarget {
		r.startRebuildLocked(openedInfo)
		return r.resultLocked(true, nil), nil
	}
	remaining := r.appendTarget - r.readOffset
	if remaining <= 0 {
		r.appendTarget = 0
		return r.resultLocked(openedInfo.Size() > r.readOffset, nil), nil
	}
	newBytes := int(min(int64(piTitleStepByteBudget), remaining))
	data, readErr := readPiTitleBytes(file, r.readOffset, newBytes)
	if readErr != nil {
		if errors.Is(readErr, io.ErrUnexpectedEOF) && openedInfo.Size() < r.appendTarget {
			r.startRebuildLocked(openedInfo)
			return r.resultLocked(true, nil), nil
		}
		return r.resultLocked(false, nil), fmt.Errorf("read Pi session title append: %w", readErr)
	}
	afterInfo, err := file.Stat()
	if err != nil {
		return r.resultLocked(false, nil), fmt.Errorf("stat Pi session after append read: %w", err)
	}
	pathAfter, err := r.fs.lstat(r.bindingPath)
	if err != nil || !samePiTitleObject(afterInfo, pathAfter) {
		return r.resultLocked(false, nil), fmt.Errorf("Pi session binding changed during title append: %s", r.bindingPath)
	}
	if afterInfo.Size() < r.readOffset+int64(len(data)) {
		r.startRebuildLocked(afterInfo)
		return r.resultLocked(true, nil), nil
	}
	if !samePiTitleMetadata(openedInfo, afterInfo) && afterInfo.Size() <= openedInfo.Size() {
		r.startRebuildLocked(afterInfo)
		return r.resultLocked(true, nil), nil
	}

	baseOffset := r.readOffset
	var warning error
	if len(data) > 0 {
		warning = r.decoder.Feed(data, false, r.state.applyRecord)
		r.prefixSample = extendPiTitlePrefix(r.prefixSample, baseOffset, data)
		r.endSample = appendPiTitleSample(r.endSample, data, piTitleContinuitySampleMax)
		r.completeOffset = lastPiTitleRecordOffset(r.completeOffset, baseOffset, data)
		r.readOffset += int64(len(data))
	}
	r.observedInfo = afterInfo
	r.bindingInfo = afterInfo
	r.matches[r.bindingPath] = afterInfo
	if r.readOffset >= r.appendTarget {
		r.appendTarget = 0
	}
	return r.resultLocked(r.appendTarget > 0 || afterInfo.Size() > r.readOffset, warning), nil
}

func samePiTitleObject(left, right os.FileInfo) bool {
	return left != nil && right != nil && os.SameFile(left, right)
}

func samePiTitleMetadata(left, right os.FileInfo) bool {
	return samePiTitleObject(left, right) && left.Size() == right.Size() && left.Mode() == right.Mode() && left.ModTime().Equal(right.ModTime())
}

func regularPiTitleFile(info os.FileInfo) bool {
	return info != nil && info.Mode()&os.ModeSymlink == 0 && info.Mode().IsRegular()
}

func appendPiTitleSample(sample, data []byte, limit int) []byte {
	if limit <= 0 {
		return nil
	}
	dataStart := max(0, len(data)-limit)
	dataTail := data[dataStart:]
	sampleLimit := limit - len(dataTail)
	sampleStart := max(0, len(sample)-sampleLimit)
	combined := make([]byte, len(sample)-sampleStart+len(dataTail))
	copy(combined, sample[sampleStart:])
	copy(combined[len(sample)-sampleStart:], dataTail)
	return combined
}

func extendPiTitlePrefix(prefix []byte, base int64, data []byte) []byte {
	if len(prefix) >= piTitleContinuitySampleMax || len(data) == 0 || base > int64(len(prefix)) {
		return prefix
	}
	start := int64(len(prefix)) - base
	if start < 0 {
		return prefix
	}
	needed := piTitleContinuitySampleMax - len(prefix)
	if int(start) >= len(data) {
		return prefix
	}
	available := data[int(start):]
	if len(available) > needed {
		available = available[:needed]
	}
	return append(prefix, available...)
}

func lastPiTitleRecordOffset(previous, offset int64, data []byte) int64 {
	if index := bytes.LastIndexByte(data, '\n'); index >= 0 {
		return offset + int64(index) + 1
	}
	return previous
}

func readPiTitleBytes(file piTitleFile, offset int64, size int) ([]byte, error) {
	if size <= 0 {
		return nil, nil
	}
	data := make([]byte, 0, size)
	buffer := make([]byte, min(64*1024, size))
	for len(data) < size {
		want := min(len(buffer), size-len(data))
		n, err := file.ReadAt(buffer[:want], offset+int64(len(data)))
		if n > 0 {
			data = append(data, buffer[:n]...)
		}
		if err != nil {
			if errors.Is(err, io.EOF) && len(data) == size {
				return data, nil
			}
			if errors.Is(err, io.EOF) {
				return data, io.ErrUnexpectedEOF
			}
			return data, err
		}
		if n == 0 {
			return data, io.ErrNoProgress
		}
	}
	return data, nil
}

func comparePiTitleSamples(file piTitleFile, fileSize, readOffset int64, prefix, end []byte) (bool, error) {
	if fileSize < int64(len(prefix)) || fileSize < readOffset || int64(len(end)) > readOffset {
		return false, nil
	}
	if len(prefix) > 0 {
		current, err := readPiTitleBytes(file, 0, len(prefix))
		if err != nil {
			return false, err
		}
		if !bytes.Equal(current, prefix) {
			return false, nil
		}
	}
	if len(end) > 0 {
		current, err := readPiTitleBytes(file, readOffset-int64(len(end)), len(end))
		if err != nil {
			return false, err
		}
		if !bytes.Equal(current, end) {
			return false, nil
		}
	}
	return true, nil
}
