package rpc

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/hypernewbie/phi/pkg/session"
)

// Manager owns live Instances keyed by ID.
type Manager struct {
	mu      sync.RWMutex
	inst    map[string]*Instance
	spawnFn func(SpawnOptions) (Cmd, WriteCloser, ReadCloser, error)
	spawnMu sync.Mutex

	reservations map[string]*spawnReservation
	spawnKeys    map[string]*spawnReservation
	initializing map[*Instance]struct{}

	subMu             sync.Mutex
	subscriptions     map[*Instance]int
	detachTimers      map[*Instance]*time.Timer
	detachGenerations map[*Instance]uint64
	detachGrace       time.Duration
}

type spawnReservation struct {
	mu        sync.Mutex
	path      string
	spawnIDs  map[string]struct{}
	cwd       string
	title     string
	piOffline bool
	instance  *Instance
	err       error
	done      chan struct{}
	closed    bool
}

// SpawnLease is the creator/reuser handoff for a two-phase child bootstrap.
// A creator must call FinishSpawn after its subscribed startup refresh. A
// reused lease is already published and must not be finished.
type SpawnLease struct {
	manager     *Manager
	instance    *Instance
	reservation *spawnReservation
	created     bool
	mu          sync.Mutex
	finished    bool
}

// Instance returns the child reserved by the lease.
func (l *SpawnLease) Instance() *Instance {
	if l == nil {
		return nil
	}
	return l.instance
}

// Created reports whether this lease owns the bootstrap reservation.
func (l *SpawnLease) Created() bool {
	return l != nil && l.created
}

// NewManager returns an empty Manager.
func NewManager() *Manager {
	return newManager(nil)
}

func newManager(spawn func(SpawnOptions) (Cmd, WriteCloser, ReadCloser, error)) *Manager {
	return &Manager{
		inst:              map[string]*Instance{},
		spawnFn:           spawn,
		reservations:      map[string]*spawnReservation{},
		spawnKeys:         map[string]*spawnReservation{},
		initializing:      map[*Instance]struct{}{},
		subscriptions:     map[*Instance]int{},
		detachTimers:      map[*Instance]*time.Timer{},
		detachGenerations: map[*Instance]uint64{},
		detachGrace:       30 * time.Minute,
	}
}

// NewManagerWithSpawner returns a Manager using spawn for child creation.
func NewManagerWithSpawner(spawn func(SpawnOptions) (Cmd, WriteCloser, ReadCloser, error)) *Manager {
	return newManager(spawn)
}

// SpawnOptions configures child creation.
type SpawnOptions struct {
	Cwd             string
	Title           string
	SpawnID         string
	PiOffline       bool
	SessionPath     string
	InitialMessages []Message
}

// Sentinel errors.
var (
	ErrUnknownSession  = errors.New("rpc unknown session")
	ErrEmptyCwd        = errors.New("rpc empty cwd")
	ErrSpawnIDConflict = errors.New("rpc spawnId already belongs to a different spawn")
)

// Lookup returns the Instance for sid.
func (m *Manager) Lookup(sid string) (*Instance, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	inst, ok := m.inst[sid]
	if !ok {
		return nil, fmt.Errorf("%w: %s", ErrUnknownSession, sid)
	}
	return inst, nil
}

// List returns live instances ordered by creation time.
func (m *Manager) List() []*Instance {
	m.mu.RLock()
	out := make([]*Instance, 0, len(m.inst))
	for _, i := range m.inst {
		out = append(out, i)
	}
	m.mu.RUnlock()
	sort.Slice(out, func(a, b int) bool { return out[a].CreatedAt.Before(out[b].CreatedAt) })
	return out
}

func (m *Manager) instanceRefs() []*Instance {
	m.mu.RLock()
	out := make([]*Instance, 0, len(m.inst))
	for _, inst := range m.inst {
		out = append(out, inst)
	}
	m.mu.RUnlock()
	return out
}

func (r *spawnReservation) result() (*Instance, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.instance, r.err
}

func (r *spawnReservation) complete(inst *Instance, err error) {
	r.mu.Lock()
	if r.closed {
		r.mu.Unlock()
		return
	}
	r.instance = inst
	r.err = err
	r.closed = true
	close(r.done)
	r.mu.Unlock()
}

func waitSpawnReservation(ctx context.Context, reservation *spawnReservation) (*Instance, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	select {
	case <-reservation.done:
		return reservation.result()
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

func (m *Manager) newInstance(opts SpawnOptions, cmd Cmd, stdin WriteCloser, stdout ReadCloser) (*Instance, error) {
	id, err := newID()
	if err != nil {
		return nil, err
	}
	inst := &Instance{
		ID:        id,
		Cwd:       opts.Cwd,
		Title:     TitleFor(opts.Cwd, opts.Title),
		CreatedAt: time.Now(),
		cmd:       cmd,
		stdin:     stdin,
		stdout:    stdout,
		sc:        NewLineScanner(stdout),
		alive:     true,
		pending:   make(map[string]*pendingWaiter),
		subs:      newSubscriberSet(),
		snap:      &Snapshot{Messages: cloneMessages(opts.InitialMessages)},
	}
	inst.setSessionPath(opts.SessionPath)
	inst.SetState(State{Sid: id, Title: inst.Title, Cwd: opts.Cwd, Status: "live"})
	inst.exitHook = func() { m.removeLifecycle(inst) }
	go m.readLoop(inst)
	return inst, nil
}

func (m *Manager) pathReservation(path string) *spawnReservation {
	if path == "" {
		return nil
	}
	return m.reservations[path]
}

func newSpawnReservation(opts SpawnOptions) *spawnReservation {
	return &spawnReservation{
		path:      opts.SessionPath,
		spawnIDs:  spawnIDSet(opts.SpawnID),
		cwd:       opts.Cwd,
		title:     opts.Title,
		piOffline: opts.PiOffline,
		done:      make(chan struct{}),
	}
}

func spawnIDSet(spawnID string) map[string]struct{} {
	if spawnID == "" {
		return nil
	}
	return map[string]struct{}{spawnID: {}}
}

func (r *spawnReservation) matches(opts SpawnOptions) bool {
	return r.cwd == opts.Cwd && r.title == opts.Title && r.piOffline == opts.PiOffline && r.path == opts.SessionPath
}

func (m *Manager) removeSpawnReservationLocked(reservation *spawnReservation) {
	if reservation == nil {
		return
	}
	if reservation.path != "" && m.reservations[reservation.path] == reservation {
		delete(m.reservations, reservation.path)
	}
	for spawnID := range reservation.spawnIDs {
		if m.spawnKeys[spawnID] == reservation {
			delete(m.spawnKeys, spawnID)
		}
	}
}

// BeginSpawn creates an initializing child reservation or waits for the
// creator of an existing same-path reservation. It performs no Pi metadata
// writes; the subscribed control handler owns bootstrap requests.
func (m *Manager) BeginSpawn(ctx context.Context, opts SpawnOptions) (*SpawnLease, error) {
	if opts.Cwd == "" {
		return nil, ErrEmptyCwd
	}
	if ctx == nil {
		ctx = context.Background()
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}

	m.spawnMu.Lock()
	if m.reservations == nil {
		m.reservations = make(map[string]*spawnReservation)
	}
	if m.spawnKeys == nil {
		m.spawnKeys = make(map[string]*spawnReservation)
	}
	if m.inst == nil {
		m.inst = make(map[string]*Instance)
	}

	if opts.SpawnID != "" {
		if reservation := m.spawnKeys[opts.SpawnID]; reservation != nil {
			if !reservation.matches(opts) {
				m.spawnMu.Unlock()
				return nil, fmt.Errorf("%w: %s", ErrSpawnIDConflict, opts.SpawnID)
			}
			m.spawnMu.Unlock()
			inst, err := waitSpawnReservation(ctx, reservation)
			if err != nil {
				return nil, err
			}
			if inst == nil || !inst.IsAlive() {
				return nil, ErrNotAlive
			}
			return &SpawnLease{manager: m, instance: inst, created: false}, nil
		}
	}

	if opts.SessionPath != "" {
		if reservation := m.pathReservation(opts.SessionPath); reservation != nil {
			if opts.SpawnID != "" && !reservation.matches(opts) {
				m.spawnMu.Unlock()
				return nil, fmt.Errorf("%w: session path reservation", ErrSpawnIDConflict)
			}
			if opts.SpawnID != "" {
				if reservation.spawnIDs == nil {
					reservation.spawnIDs = make(map[string]struct{})
				}
				reservation.spawnIDs[opts.SpawnID] = struct{}{}
				m.spawnKeys[opts.SpawnID] = reservation
			}
			m.spawnMu.Unlock()
			inst, err := waitSpawnReservation(ctx, reservation)
			if err != nil {
				return nil, err
			}
			if inst == nil {
				_, err = reservation.result()
				if err == nil {
					err = ErrNotAlive
				}
				return nil, err
			}
			return &SpawnLease{manager: m, instance: inst, created: false}, nil
		}
		for _, inst := range m.instanceRefs() {
			if inst.SessionPathCopy() != opts.SessionPath || !inst.IsAlive() {
				continue
			}
			if opts.SpawnID != "" {
				binding := newSpawnReservation(opts)
				binding.instance = inst
				binding.complete(inst, nil)
				m.spawnKeys[opts.SpawnID] = binding
			}
			m.spawnMu.Unlock()
			return &SpawnLease{manager: m, instance: inst, created: false}, nil
		}
	}

	reservation := newSpawnReservation(opts)
	if opts.SessionPath != "" {
		m.reservations[opts.SessionPath] = reservation
	}
	if opts.SpawnID != "" {
		m.spawnKeys[opts.SpawnID] = reservation
	}
	spawn := m.spawnFn
	if spawn == nil {
		spawn = spawnChild
	}
	cmd, stdin, stdout, err := spawn(opts)
	if err != nil {
		m.removeSpawnReservationLocked(reservation)
		reservation.complete(nil, err)
		m.spawnMu.Unlock()
		return nil, err
	}
	inst, err := m.newInstance(opts, cmd, stdin, stdout)
	if err != nil {
		if stdin != nil {
			_ = stdin.Close()
		}
		if cmd != nil {
			_ = cmd.Kill()
		}
		m.removeSpawnReservationLocked(reservation)
		reservation.complete(nil, err)
		m.spawnMu.Unlock()
		return nil, err
	}
	reservation.instance = inst
	m.initializing[inst] = struct{}{}
	lease := &SpawnLease{manager: m, instance: inst, reservation: reservation, created: true}
	m.spawnMu.Unlock()
	return lease, nil
}

// FinishSpawn publishes a creator lease only after its bootstrap result is
// known. A failure never enters the reusable live map.
func (m *Manager) FinishSpawn(lease *SpawnLease, bootstrapErr error) error {
	if lease == nil || lease.manager != m || !lease.created || lease.instance == nil {
		return errors.New("invalid spawn creator lease")
	}
	lease.mu.Lock()
	if lease.finished {
		lease.mu.Unlock()
		return errors.New("spawn creator lease already finished")
	}
	lease.finished = true
	lease.mu.Unlock()

	m.spawnMu.Lock()
	inst := lease.instance
	reservation := lease.reservation
	if bootstrapErr == nil {
		delete(m.initializing, inst)
		m.mu.Lock()
		m.inst[inst.ID] = inst
		m.mu.Unlock()
		m.armDetachIfUnsubscribed(inst)
		if reservation != nil {
			if current := m.reservations[reservation.path]; current == reservation {
				delete(m.reservations, reservation.path)
			}
		}
	} else {
		delete(m.initializing, inst)
		m.removeSpawnReservationLocked(reservation)
	}
	if reservation != nil {
		reservation.complete(inst, bootstrapErr)
	}
	m.spawnMu.Unlock()

	if bootstrapErr != nil {
		inst.Kill()
	}
	return bootstrapErr
}

// Spawn retains the package's synchronous API for non-WebSocket callers. It
// intentionally performs no startup metadata writes.
func (m *Manager) Spawn(opts SpawnOptions) (*Instance, error) {
	lease, err := m.BeginSpawn(context.Background(), opts)
	if err != nil {
		return nil, err
	}
	if !lease.Created() {
		return lease.Instance(), nil
	}
	if err := m.FinishSpawn(lease, nil); err != nil {
		return nil, err
	}
	return lease.Instance(), nil
}

// UpdateSessionPath applies server-owned session-path ownership while
// serializing against Spawn and reservation publication. Manager locks are
// released before touching instance locks.
func (m *Manager) UpdateSessionPath(inst *Instance, path string) {
	if inst == nil {
		return
	}
	m.spawnMu.Lock()
	defer m.spawnMu.Unlock()
	m.mu.RLock()
	managed := m.inst[inst.ID] == inst
	m.mu.RUnlock()
	var reservation *spawnReservation
	for _, candidate := range m.reservations {
		if candidate.instance == inst {
			reservation = candidate
			break
		}
	}
	if !managed && !containsInitializing(m.initializing, inst) && reservation == nil {
		return
	}
	old := inst.SessionPathCopy()
	inst.setSessionPath(path)
	if reservation == nil || old == path {
		return
	}
	if current := m.reservations[reservation.path]; current == reservation {
		delete(m.reservations, reservation.path)
	}
	reservation.path = path
	if path != "" {
		if current := m.reservations[path]; current == nil || current == reservation {
			m.reservations[path] = reservation
		}
	}
}

// subagentStep and subagentTranscript shape the op response: the run's
// steps with their fork-session transcripts merged in message order.
type subagentStep struct {
	Label       string                 `json:"label"`
	SessionFile string                 `json:"sessionFile"`
	Messages    []session.PiRPCMessage `json:"messages"`
}

type subagentTranscript struct {
	RunId string         `json:"runId"`
	Steps []subagentStep `json:"steps"`
}

// SubagentTranscript resolves a subagent run to its transcript
// messages. runId is validated by charset rejection and enumeration,
// never joined into a path directly.
func (m *Manager) SubagentTranscript(runId string) (any, error) {
	if runId == "" || strings.ContainsAny(runId, "/\\") || strings.Contains(runId, "..") {
		return nil, fmt.Errorf("invalid subagent run id: %q", runId)
	}
	candidates, err := filepath.Glob(filepath.Join(os.TempDir(), "pi-subagents-*", "async-subagent-runs", "*", "status.json"))
	if err != nil {
		return nil, fmt.Errorf("scan subagent runs: %w", err)
	}
	for _, candidate := range candidates {
		info, err := os.Stat(candidate)
		if err != nil || !info.Mode().IsRegular() || info.Size() > 64*1024 {
			continue
		}
		raw, err := os.ReadFile(candidate)
		if err != nil {
			continue
		}
		var st struct {
			RunId string `json:"runId"`
			Cwd   string `json:"cwd"`
			Steps []struct {
				Label       string `json:"label"`
				SessionFile string `json:"sessionFile"`
			} `json:"steps"`
		}
		if err := json.Unmarshal(raw, &st); err != nil || st.RunId != runId {
			continue
		}
		steps := make([]subagentStep, 0, len(st.Steps))
		seen := make(map[string]bool, len(st.Steps))
		for _, step := range st.Steps {
			if step.SessionFile == "" || seen[step.SessionFile] {
				continue
			}
			seen[step.SessionFile] = true
			messages, err := session.GetPiForkSessionRPCTranscript(st.Cwd, step.SessionFile)
			if err != nil {
				// A partially failed workflow still shows its completed steps.
				continue
			}
			steps = append(steps, subagentStep{
				Label:       step.Label,
				SessionFile: step.SessionFile,
				Messages:    messages,
			})
		}
		return subagentTranscript{RunId: st.RunId, Steps: steps}, nil
	}
	return nil, fmt.Errorf("subagent run not found: %s", runId)
}

// SubscriptionCount reports active control subscribers for an instance.
// It is used by connection lifecycle observers and tests.
func (m *Manager) SubscriptionCount(inst *Instance) int {
	m.subMu.Lock()
	defer m.subMu.Unlock()
	return m.subscriptions[inst]
}

// Subscribe registers a control subscriber and owns its detach lifecycle.
func (m *Manager) Subscribe(inst *Instance) *Subscriber {
	if inst == nil {
		return nil
	}
	m.mu.RLock()
	managed := m.inst[inst.ID] == inst
	m.mu.RUnlock()
	if !managed {
		m.spawnMu.Lock()
		managed = containsInitializing(m.initializing, inst)
		if !managed {
			for _, reservation := range m.reservations {
				if reservation.instance == inst {
					managed = true
					break
				}
			}
		}
		m.spawnMu.Unlock()
	}
	if !managed || !inst.IsAlive() {
		return nil
	}

	m.subMu.Lock()
	m.detachGenerations[inst]++
	if timer := m.detachTimers[inst]; timer != nil {
		timer.Stop()
		delete(m.detachTimers, inst)
	}
	m.subscriptions[inst]++
	m.subMu.Unlock()

	sub := inst.subscribeWithCallback(func() { m.subscriptionClosed(inst) })
	if sub == nil || sub.isClosed() {
		m.subscriptionClosed(inst)
		return nil
	}
	return sub
}

func (m *Manager) subscriptionClosed(inst *Instance) {
	m.subMu.Lock()
	count := m.subscriptions[inst]
	if count > 0 {
		count--
	}
	if count == 0 {
		delete(m.subscriptions, inst)
	}
	m.subMu.Unlock()
	if count == 0 {
		m.armDetachIfUnsubscribed(inst)
	}
}

func (m *Manager) armDetachIfUnsubscribed(inst *Instance) {
	if inst == nil || !inst.IsAlive() {
		return
	}
	m.mu.RLock()
	managed := m.inst[inst.ID] == inst
	m.mu.RUnlock()
	if !managed {
		return
	}
	m.subMu.Lock()
	if m.subscriptions[inst] != 0 || m.detachTimers[inst] != nil {
		m.subMu.Unlock()
		return
	}
	grace := m.detachGrace
	if grace <= 0 {
		grace = 30 * time.Minute
	}
	m.detachGenerations[inst]++
	generation := m.detachGenerations[inst]
	timer := time.AfterFunc(grace, func() { m.expireDetach(inst, generation) })
	m.detachTimers[inst] = timer
	m.subMu.Unlock()
}

func (m *Manager) expireDetach(inst *Instance, generation uint64) {
	m.subMu.Lock()
	if m.subscriptions[inst] != 0 || m.detachTimers[inst] == nil || m.detachGenerations[inst] != generation {
		m.subMu.Unlock()
		return
	}
	delete(m.detachTimers, inst)
	delete(m.subscriptions, inst)
	m.detachGenerations[inst]++
	m.subMu.Unlock()
	m.evict(inst)
}

func (m *Manager) removeLifecycle(inst *Instance) {
	m.subMu.Lock()
	m.detachGenerations[inst]++
	if timer := m.detachTimers[inst]; timer != nil {
		timer.Stop()
		delete(m.detachTimers, inst)
	}
	delete(m.subscriptions, inst)
	m.subMu.Unlock()
	m.spawnMu.Lock()
	delete(m.initializing, inst)
	for spawnID, reservation := range m.spawnKeys {
		if reservation.instance == inst {
			delete(m.spawnKeys, spawnID)
		}
	}
	m.spawnMu.Unlock()
	m.mu.Lock()
	if m.inst[inst.ID] == inst {
		delete(m.inst, inst.ID)
	}
	m.mu.Unlock()
}

func (m *Manager) handleExit(inst *Instance, reason string) {
	if inst == nil {
		return
	}
	m.removeLifecycle(inst)
	inst.OnExit(reason)
}

func containsInitializing(initializing map[*Instance]struct{}, inst *Instance) bool {
	_, ok := initializing[inst]
	return ok
}

func (m *Manager) evict(inst *Instance) {
	if inst == nil {
		return
	}
	m.removeLifecycle(inst)
	inst.Kill()
}

// Kill terminates by sid and evicts the matching instance.
func (m *Manager) Kill(sid string) error {
	inst, err := m.Lookup(sid)
	if err != nil {
		return err
	}
	m.evict(inst)
	return nil
}

func newID() (string, error) {
	var b [8]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(b[:]), nil
}
