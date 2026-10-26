package main

import (
	"log"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/hypernewbie/phi/pkg/fswatch"
	"github.com/hypernewbie/phi/pkg/pty"
	"github.com/hypernewbie/phi/pkg/session"
	"github.com/hypernewbie/phi/pkg/ws"
	"github.com/hypernewbie/phi/pkg/ws/wireproto"
)

const piTitleRecoveryInterval = 15 * time.Second

type piTitleTrack struct {
	instance  *pty.PTYInstance
	paneID    string
	sessionID string
	cwd       string
	reader    *session.PiTitleReader
}

// piTerminalTitleService owns one shared reader cache, a fair continuation
// queue, and one optional filesystem watcher for all tracked live Pi panes.
type piTerminalTitleService struct {
	manager *pty.Manager
	hub     *ws.Hub
	cache   *session.PiTitleCache

	mu           sync.Mutex
	panes        map[string]*piTitleTrack
	readers      map[*session.PiTitleReader]map[string]*piTitleTrack
	queue        []*session.PiTitleReader
	queued       map[*session.PiTitleReader]bool
	watcher      *fswatch.Watcher
	watcherDirty bool
	closed       bool
	started      bool

	wake             chan struct{}
	done             chan struct{}
	workerDone       chan struct{}
	lifecycleMu      sync.Mutex
	recoveryInterval time.Duration
	watcherFactory   func(func() []string, func(string)) (*fswatch.Watcher, error)
	refreshStep      func(*session.PiTitleReader) (session.PiTitleResult, error)
}

func newPiTerminalTitleService(manager *pty.Manager, hub *ws.Hub) *piTerminalTitleService {
	return &piTerminalTitleService{
		manager:          manager,
		hub:              hub,
		cache:            session.NewPiTitleCache(),
		panes:            make(map[string]*piTitleTrack),
		readers:          make(map[*session.PiTitleReader]map[string]*piTitleTrack),
		queued:           make(map[*session.PiTitleReader]bool),
		wake:             make(chan struct{}, 1),
		done:             make(chan struct{}),
		workerDone:       make(chan struct{}),
		recoveryInterval: piTitleRecoveryInterval,
		watcherFactory:   fswatch.New,
	}
}

// Start reconciles already-restored panes, starts the worker, then arms the
// single shared watcher. Watcher failure is nonfatal; the recovery sweep still
// supplies bounded progress.
func (s *piTerminalTitleService) Start() {
	s.lifecycleMu.Lock()
	defer s.lifecycleMu.Unlock()
	s.mu.Lock()
	if s.closed || s.started {
		s.mu.Unlock()
		return
	}
	s.started = true
	go s.run()
	s.mu.Unlock()

	s.reconcile()
	factory := s.watcherFactory
	if factory == nil {
		factory = fswatch.New
	}
	watcher, err := factory(s.watchDirectories, s.directoryChanged)
	if err != nil {
		log.Printf("[terminal-title] filesystem watcher unavailable; recovery remains enabled: %v", err)
		s.signal()
		return
	}
	watcher.Filter = fswatch.ExtFilter(".jsonl")
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		watcher.Close()
		return
	}
	s.watcher = watcher
	s.mu.Unlock()
	watcher.Start()
	s.signal()
}

// Register tracks a newly spawned Pi pane. Acquire and Directory are
// memory-only operations; all file discovery is left to the worker.
func (s *piTerminalTitleService) Register(inst *pty.PTYInstance) {
	if inst == nil || s.manager == nil {
		return
	}
	snapshot := inst.Snapshot()
	current, ok := s.manager.Get(snapshot.ID)
	if !ok || current != inst || snapshot.Coder != "pi" || snapshot.SessionID == "" || inst.Pty == nil || inst.IsPtyDead() {
		s.unregisterIfInstance(snapshot.ID, inst)
		return
	}

	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return
	}
	if old := s.panes[snapshot.ID]; old != nil && old.instance == inst && old.sessionID == snapshot.SessionID && old.cwd == snapshot.Cwd {
		s.enqueueLocked(old.reader)
		s.mu.Unlock()
		return
	}
	reader, err := s.cache.Acquire(snapshot.Cwd, snapshot.SessionID)
	if err != nil {
		oldReader := s.removePaneLocked(snapshot.ID, nil)
		s.mu.Unlock()
		if oldReader != nil {
			s.cache.Release(oldReader)
		}
		log.Printf("[terminal-title] cannot track pane %s: %v", snapshot.ID, err)
		return
	}
	oldReader := s.removePaneLocked(snapshot.ID, nil)
	track := &piTitleTrack{instance: inst, paneID: snapshot.ID, sessionID: snapshot.SessionID, cwd: snapshot.Cwd, reader: reader}
	s.addTrackLocked(track)
	s.watcherDirty = true
	s.mu.Unlock()
	if oldReader != nil {
		s.cache.Release(oldReader)
	}
}

func (s *piTerminalTitleService) unregisterIfInstance(paneID string, instance *pty.PTYInstance) {
	s.mu.Lock()
	reader := s.removePaneLocked(paneID, instance)
	s.mu.Unlock()
	if reader != nil {
		s.cache.Release(reader)
	}
}

func (s *piTerminalTitleService) addTrackLocked(track *piTitleTrack) {
	s.panes[track.paneID] = track
	group := s.readers[track.reader]
	if group == nil {
		group = make(map[string]*piTitleTrack)
		s.readers[track.reader] = group
	}
	group[track.paneID] = track
	s.enqueueLocked(track.reader)
}

// removePaneLocked removes one pane reference and returns the reader that the
// caller must release after dropping s.mu.
func (s *piTerminalTitleService) removePaneLocked(paneID string, expected *pty.PTYInstance) *session.PiTitleReader {
	track := s.panes[paneID]
	if track == nil || (expected != nil && track.instance != expected) {
		return nil
	}
	delete(s.panes, paneID)
	group := s.readers[track.reader]
	delete(group, paneID)
	if len(group) == 0 {
		delete(s.readers, track.reader)
		delete(s.queued, track.reader)
		for index, reader := range s.queue {
			if reader == track.reader {
				s.queue = append(s.queue[:index], s.queue[index+1:]...)
				break
			}
		}
	}
	s.watcherDirty = true
	return track.reader
}

func (s *piTerminalTitleService) enqueueLocked(reader *session.PiTitleReader) {
	if s.closed || reader == nil || len(s.readers[reader]) == 0 || s.queued[reader] {
		return
	}
	s.queued[reader] = true
	s.queue = append(s.queue, reader)
	s.signalLocked()
}

func (s *piTerminalTitleService) signalLocked() {
	select {
	case s.wake <- struct{}{}:
	default:
	}
}

func (s *piTerminalTitleService) signal() {
	s.mu.Lock()
	if !s.closed {
		s.signalLocked()
	}
	s.mu.Unlock()
}

func (s *piTerminalTitleService) directoryChanged(directory string) {
	directory = filepath.Clean(directory)
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return
	}
	for reader := range s.readers {
		if samePiTitleDirectory(reader.Directory(), directory) {
			s.enqueueLocked(reader)
		}
	}
}

func samePiTitleDirectory(left, right string) bool {
	left = filepath.Clean(left)
	right = filepath.Clean(right)
	if runtime.GOOS == "windows" {
		return strings.EqualFold(left, right)
	}
	return left == right
}

func (s *piTerminalTitleService) watchDirectories() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	seen := make(map[string]struct{}, len(s.readers))
	directories := make([]string, 0, len(s.readers))
	for reader := range s.readers {
		directory := reader.Directory()
		key := filepath.Clean(directory)
		if runtime.GOOS == "windows" {
			key = strings.ToUpper(key)
		}
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		directories = append(directories, directory)
	}
	return directories
}

func (s *piTerminalTitleService) recomputeWatcher() {
	s.mu.Lock()
	watcher := s.watcher
	if watcher == nil || s.closed || !s.watcherDirty {
		s.mu.Unlock()
		return
	}
	s.watcherDirty = false
	s.mu.Unlock()
	watcher.Recompute()
}

func (s *piTerminalTitleService) reconcile() {
	if s.manager == nil {
		return
	}
	type desiredTrack struct {
		instance *pty.PTYInstance
		snapshot pty.PTYInstanceSnapshot
	}
	desired := make(map[string]desiredTrack)
	for _, inst := range s.manager.ListActive() {
		if inst == nil || inst.Pty == nil || inst.IsPtyDead() {
			continue
		}
		snapshot := inst.Snapshot()
		if snapshot.Coder == "pi" && snapshot.SessionID != "" {
			desired[snapshot.ID] = desiredTrack{instance: inst, snapshot: snapshot}
		}
	}

	var releases []*session.PiTitleReader
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return
	}
	for paneID, existing := range s.panes {
		candidate, ok := desired[paneID]
		if !ok || candidate.instance != existing.instance || candidate.snapshot.SessionID != existing.sessionID || candidate.snapshot.Cwd != existing.cwd {
			if reader := s.removePaneLocked(paneID, nil); reader != nil {
				releases = append(releases, reader)
			}
		}
	}
	for paneID, candidate := range desired {
		if existing := s.panes[paneID]; existing != nil && existing.instance == candidate.instance && existing.sessionID == candidate.snapshot.SessionID && existing.cwd == candidate.snapshot.Cwd {
			continue
		}
		reader, err := s.cache.Acquire(candidate.snapshot.Cwd, candidate.snapshot.SessionID)
		if err != nil {
			log.Printf("[terminal-title] cannot track pane %s: %v", paneID, err)
			continue
		}
		track := &piTitleTrack{instance: candidate.instance, paneID: paneID, sessionID: candidate.snapshot.SessionID, cwd: candidate.snapshot.Cwd, reader: reader}
		s.addTrackLocked(track)
	}
	for reader := range s.readers {
		s.enqueueLocked(reader)
	}
	s.watcherDirty = true
	s.mu.Unlock()
	for _, reader := range releases {
		s.cache.Release(reader)
	}
	s.recomputeWatcher()
}

func (s *piTerminalTitleService) run() {
	defer close(s.workerDone)
	interval := s.recoveryInterval
	if interval <= 0 {
		interval = piTitleRecoveryInterval
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-s.done:
			return
		case <-ticker.C:
			s.reconcile()
		case <-s.wake:
			s.recomputeWatcher()
			s.processOne()
		}
	}
}

func (s *piTerminalTitleService) processOne() {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return
	}
	var reader *session.PiTitleReader
	var targets []*piTitleTrack
	for len(s.queue) > 0 {
		reader = s.queue[0]
		s.queue = s.queue[1:]
		delete(s.queued, reader)
		if group := s.readers[reader]; len(group) > 0 {
			targets = make([]*piTitleTrack, 0, len(group))
			for _, track := range group {
				targets = append(targets, track)
			}
			break
		}
		reader = nil
	}
	s.mu.Unlock()
	if reader == nil {
		return
	}

	var result session.PiTitleResult
	var err error
	if s.refreshStep != nil {
		result, err = s.refreshStep(reader)
	} else {
		result, err = reader.RefreshStep()
	}
	if err != nil {
		log.Printf("[terminal-title] refresh failed: %v", err)
	}
	if result.Warning != nil {
		log.Printf("[terminal-title] skipped session record: %v", result.Warning)
	}
	if err == nil && result.Ready {
		s.publish(targets, result.Title)
	}

	s.mu.Lock()
	if !s.closed && result.More {
		s.enqueueLocked(reader)
	}
	if !s.closed && len(s.queue) > 0 {
		s.signalLocked()
	}
	s.mu.Unlock()
}

func (s *piTerminalTitleService) publish(tracks []*piTitleTrack, title string) {
	for _, track := range tracks {
		if !s.trackIsCurrent(track) {
			continue
		}
		revision, changed := s.manager.SetDerivedPiTitle(track.instance, track.sessionID, track.cwd, title)
		if !changed {
			continue
		}
		if s.hub != nil {
			if frame, err := wireproto.EncodeTitleFrame(track.paneID, track.sessionID, title, revision); err == nil {
				s.hub.BroadcastFrame(track.paneID, frame)
			}
		}
	}
}

func (s *piTerminalTitleService) trackIsCurrent(track *piTitleTrack) bool {
	s.mu.Lock()
	current := !s.closed && s.panes[track.paneID] == track
	s.mu.Unlock()
	return current && track.instance.Pty != nil && !track.instance.IsPtyDead()
}

// Close is idempotent. It rejects late callbacks, stops the watcher, cancels
// queued work, joins the worker, then releases every pane's reader reference.
func (s *piTerminalTitleService) Close() {
	s.lifecycleMu.Lock()
	defer s.lifecycleMu.Unlock()
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return
	}
	s.closed = true
	watcher := s.watcher
	s.watcher = nil
	started := s.started
	s.queue = nil
	s.queued = make(map[*session.PiTitleReader]bool)
	close(s.done)
	s.mu.Unlock()

	if watcher != nil {
		watcher.Close()
	}
	if started {
		<-s.workerDone
	}

	s.mu.Lock()
	readers := make([]*session.PiTitleReader, 0, len(s.panes))
	for _, track := range s.panes {
		readers = append(readers, track.reader)
	}
	s.panes = make(map[string]*piTitleTrack)
	s.readers = make(map[*session.PiTitleReader]map[string]*piTitleTrack)
	s.queue = nil
	s.queued = nil
	s.mu.Unlock()
	for _, reader := range readers {
		s.cache.Release(reader)
	}
}
