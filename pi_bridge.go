package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"

	"github.com/hypernewbie/phi/internal/pibridge"
	pibridgepb "github.com/hypernewbie/phi/internal/pibridge/pb"
	"github.com/hypernewbie/phi/pkg/pty"
	"github.com/hypernewbie/phi/pkg/system"
	"github.com/hypernewbie/phi/pkg/ws"
)

// Child environment keys for Pi bridge provisioning. The extension reads
// them at session start and deletes them so agent-spawned tools cannot
// inherit credentials. Keep in sync with bonus/pi-phi and PROTOCOL.md.
const (
	piBridgeEnvTarget  = "PHI_PI_BRIDGE_ENDPOINT"
	piBridgeEnvPane    = "PHI_PI_BRIDGE_PANE_ID"
	piBridgeEnvProcess = "PHI_PI_BRIDGE_PROCESS_ID"
	piBridgeEnvToken   = "PHI_PI_BRIDGE_TOKEN"
)

// piBridgeArtifactName is the materialized runtime filename inside the
// bridge endpoint directory. --extension points at it directly; Pi loads
// the self-contained CJS bundle without a loader shim.
const piBridgeArtifactName = "pi-phi-extension.cjs"

// Bridge states published to the browser. "managed" means provisioned
// with credentials and extension args; "unavailable" means provisioning
// was attempted but failed (reason is nonsecret); "plain" means no
// provisioning was attempted for this pane.
const (
	piBridgeManaged     = "managed"
	piBridgeUnavailable = "unavailable"
	piBridgePlain       = "plain"
)

// Bridge owns the Pi↔Phi local-IPC server for this Phi process. It
// provisions per-pane leases before spawn, injects credentials and the
// materialized runtime path, revokes on every exit path, and publishes
// nonsecret bridge state plus settlement notifications to browsers.
type Bridge struct {
	server   *pibridge.Server
	endpoint *pibridge.Endpoint
	listener net.Listener
	hub      *ws.Hub
	artifact string
	reason   string

	mu     sync.Mutex
	panes  map[string]*bridgePane
	closed bool
}

type bridgePane struct {
	processID         string
	managed           bool
	reason            string
	inst              *pty.PTYInstance
	pubRev            uint64 // latest applied publication; 0 means unseeded
	gen               uint64
	hasGen            bool
	lastRun           uint64
	hasRun            bool
	lastOutcome       string
	lastRunning       *bool
	lastModel         string
	lastThinkingLevel string
	lastCaps          []string
	// lastConnected tracks current stream availability: set on every
	// snapshot, cleared on peer-down. Nil until the first snapshot.
	// History recall uses it; bell behavior does not.
	lastConnected *bool
}

// startPiBridge creates the endpoint, materializes the runtime, and
// serves the bridge. A listener failure returns nil so Pi startup
// proceeds without integration. A runtime failure keeps the server but
// marks every provisioning unavailable.
func startPiBridge(hub *ws.Hub) *Bridge {
	endpoint, err := pibridge.NewEndpoint()
	if err != nil {
		log.Printf("[pi-bridge] endpoint unavailable, integration disabled: %v", err)
		return nil
	}
	listener, err := endpoint.Listen()
	if err != nil {
		endpoint.Cleanup()
		log.Printf("[pi-bridge] listen failed, integration disabled: %v", err)
		return nil
	}
	b := &Bridge{
		server:   pibridge.NewServer(),
		endpoint: endpoint,
		listener: listener,
		hub:      hub,
		panes:    map[string]*bridgePane{},
	}
	if err := b.materialize(); err != nil {
		b.reason = "runtime unavailable"
		log.Printf("[pi-bridge] %v, launches proceed unmanaged: %v", b.reason, err)
	}
	// The stable copy serves manual installs; its failure never
	// affects injection, so it only logs.
	if err := materializeStablePiBridge(); err != nil {
		log.Printf("[pi-bridge] stable copy unavailable: %v", err)
	}
	b.server.SetOnSettled(b.onSettled)
	b.server.SetOnState(b.onState)
	b.server.SetOnPeerDown(b.onPeerDown)
	hub.SetBridgeAttach(b.encodeAttach)
	hub.SetOnPaneExit(func(inst *pty.PTYInstance, _ int) { b.handlePaneExit(inst) })
	go func() {
		_ = b.server.GRPCServer().Serve(listener)
	}()
	log.Printf("[pi-bridge] serving local IPC")
	return b
}

// materialize writes the embedded runtime to the owned endpoint
// directory for Pi --extension loading. The file inherits the
// directory's private ownership; content is public bundle code.
func (b *Bridge) materialize() error {
	data, err := piPhiRuntime()
	if err != nil {
		return err
	}
	path, err := b.endpoint.WriteOwnedFile(piBridgeArtifactName, data)
	if err != nil {
		return err
	}
	b.artifact = path
	return nil
}

// piBridgeStableDir is the phi-owned directory holding the stable
// bridge bundle copy for manual Pi installs. Unlike the endpoint
// copy, this path survives restarts, so a settings file-path entry
// keeps working across upgrades.
const piBridgeStableDir = "pi-bridge"

// compareStamp orders two "<version> <hash>" stamps by their leading
// "X.Y.Z" version. The hash suffix marks the content, not the order.
// A stamp without three leading numbers sorts below every well-formed
// one, so a corrupt installed stamp always loses to the bundled one.
func compareStamp(a, b string) int {
	av, aok := stampVersion(a)
	bv, bok := stampVersion(b)
	switch {
	case !aok && !bok:
		return 0
	case !aok:
		return -1
	case !bok:
		return 1
	}
	for i := range av {
		if av[i] != bv[i] {
			if av[i] < bv[i] {
				return -1
			}
			return 1
		}
	}
	return 0
}

// stampVersion reads the leading "X.Y.Z" of a stamp.
func stampVersion(stamp string) ([3]int, bool) {
	var v [3]int
	if _, err := fmt.Sscanf(strings.TrimSpace(stamp), "%d.%d.%d", &v[0], &v[1], &v[2]); err != nil {
		return v, false
	}
	return v, true
}

// materializeStablePiBridge keeps the stable bundle copy current:
// it rewrites the directory only when the embedded stamp is newer
// than the installed one, or when the stamps differ at the same
// version (new content, same version number). An up-to-date copy
// costs one small file read per phi start.
func materializeStablePiBridge() error {
	if testing.Testing() {
		// Tests cover this through materializeStablePiBridgeAt with
		// a temp home. The real home must stay untouched: the repo
		// isolates tests from ~/.phi the same way (see config.go).
		return nil
	}
	return materializeStablePiBridgeAt(piPhiRuntime, strings.TrimSpace(piPhiVersionAsset))
}

func materializeStablePiBridgeAt(runtime func() ([]byte, error), version string) error {
	if _, ok := stampVersion(version); !ok {
		return fmt.Errorf("pi-phi: bundled version %q unparsable", version)
	}
	dir := filepath.Join(system.PhiDataDir(), piBridgeStableDir)
	if raw, err := os.ReadFile(filepath.Join(dir, "VERSION")); err == nil {
		installed := strings.TrimSpace(string(raw))
		// The stamp carries the version and the content hash, so a
		// matching stamp means a matching bundle. A newer installed
		// version still wins and is left alone.
		if compareStamp(version, installed) < 0 {
			return nil
		}
		if installed == version {
			return nil
		}
	} else if !os.IsNotExist(err) {
		return fmt.Errorf("pi-phi: read stable version: %w", err)
	}
	data, err := runtime()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return fmt.Errorf("pi-phi: stable dir: %w", err)
	}
	if err := system.WriteFileAtomic(filepath.Join(dir, piBridgeArtifactName), data, 0o600); err != nil {
		return err
	}
	// VERSION lands last: a crash between the two files leaves the
	// old version gating a rewrite on the next start, never a new
	// version atop old bytes.
	return system.WriteFileAtomic(filepath.Join(dir, "VERSION"), []byte(version+"\n"), 0o600)
}

// Stop revokes every pane, stops the server, and releases owned paths.
func (b *Bridge) Stop() {
	if b == nil {
		return
	}
	b.mu.Lock()
	panes := make([]*bridgePane, 0, len(b.panes))
	for _, p := range b.panes {
		panes = append(panes, p)
	}
	b.panes = map[string]*bridgePane{}
	b.closed = true
	b.mu.Unlock()
	for _, p := range panes {
		b.server.Revoke(p.processID)
	}
	b.server.Stop()
	_ = b.listener.Close()
	b.endpoint.Cleanup()
}

// Provision registers a pending lease for a pane before spawn. It
// returns child env overrides and extension args. When inject is
// false (manual install), the lease and credentials are still
// provisioned but no --extension args are returned. When managed is
// false the caller launches normally without bridge injection, and
// the pane is recorded unavailable with a nonsecret reason.
func (b *Bridge) Provision(paneID string, inject bool) (env map[string]string, args []string, managed bool) {
	if b == nil {
		return nil, nil, false
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.closed {
		// Shutdown raced provisioning: launch unmanaged without
		// recording, so no lease leaks past the cleared map.
		return nil, nil, false
	}
	fail := func(reason string) (map[string]string, []string, bool) {
		b.panes[paneID] = &bridgePane{reason: reason}
		return nil, nil, false
	}
	if b.artifact == "" {
		return fail(b.reason)
	}
	if _, dup := b.panes[paneID]; dup {
		// Never clobber the live record: the first lease stays
		// authoritative and keeps its revoke path. The duplicate
		// launches unmanaged. Pane IDs are unique per spawn, so a
		// duplicate indicates a caller bug; log it loudly.
		log.Printf("[pi-bridge] duplicate provision for pane %q, launching unmanaged", paneID)
		return nil, nil, false
	}
	processID, token, err := b.server.RegisterPending(paneID)
	if err != nil {
		return fail("lease unavailable")
	}
	p := &bridgePane{processID: processID, managed: true}
	// Seed the retained view from the lease's empty baseline: the
	// floor sits above every publication of a prior pane-ID record,
	// so delayed callbacks from a dead lease can never apply.
	if rev, ok := b.server.PublicationRevision(processID); ok {
		p.pubRev = rev
	}
	b.panes[paneID] = p
	env = map[string]string{
		piBridgeEnvTarget:  b.endpoint.Target,
		piBridgeEnvPane:    paneID,
		piBridgeEnvProcess: processID,
		piBridgeEnvToken:   token,
	}
	if inject {
		args = []string{"--extension", b.artifact}
	}
	return env, args, true
}

// Complete binds the spawned instance and marks a provisioned lease live
// after successful spawn. Unknown panes are ignored. The first instance
// wins: a duplicate provision for a live pane never clobbers the owner.
func (b *Bridge) Complete(inst *pty.PTYInstance) {
	if b == nil || inst == nil {
		return
	}
	b.mu.Lock()
	p, ok := b.panes[inst.ID]
	if !ok {
		b.mu.Unlock()
		return
	}
	if p.inst == nil {
		p.inst = inst
	}
	processID, managed := p.processID, p.managed
	b.mu.Unlock()
	if !managed {
		return
	}
	b.server.Complete(processID)
}

// RequestPaneHistory resolves a pane to its bridge process and reads
// the live Pi editor history. Unknown, unmanaged, and peerless panes
// fail; every error means "fall back to pre-bridge behavior". The
// caller owns the deadline: history is best-effort and must never
// hold an HTTP handler past its budget.
func (b *Bridge) RequestPaneHistory(ctx context.Context, paneID string) (pibridge.HistoryResult, error) {
	if b == nil {
		return pibridge.HistoryResult{}, fmt.Errorf("pi-bridge: disabled")
	}
	b.mu.Lock()
	p, ok := b.panes[paneID]
	var processID string
	var managed bool
	if ok {
		processID, managed = p.processID, p.managed
	}
	b.mu.Unlock()
	if !ok || !managed {
		return pibridge.HistoryResult{}, fmt.Errorf("pi-bridge: pane not managed")
	}
	return b.server.RequestHistory(ctx, processID)
}

// RequestPaneModels resolves a pane to its bridge process and reads
// the live Pi selectable-model list. Unknown, unmanaged, and
// peerless panes fail; the picker displays the error. The caller
// owns the deadline: the list is best-effort and must never
// hold an HTTP handler past its budget.
func (b *Bridge) RequestPaneModels(ctx context.Context, paneID string) (pibridge.ModelsResult, error) {
	if b == nil {
		return pibridge.ModelsResult{}, fmt.Errorf("pi-bridge: disabled")
	}
	b.mu.Lock()
	p, ok := b.panes[paneID]
	var processID string
	var managed bool
	if ok {
		processID, managed = p.processID, p.managed
	}
	b.mu.Unlock()
	if !ok || !managed {
		return pibridge.ModelsResult{}, fmt.Errorf("pi-bridge: pane not managed")
	}
	return b.server.RequestModels(ctx, processID)
}

// RequestPaneThinkingLevels reads supported levels and rejects a result if
// the pane was rebound to a different process while the request was in flight.
func (b *Bridge) RequestPaneThinkingLevels(ctx context.Context, paneID string) (pibridge.ThinkingLevelsResult, error) {
	if b == nil {
		return pibridge.ThinkingLevelsResult{}, fmt.Errorf("pi-bridge: disabled")
	}
	b.mu.Lock()
	p, ok := b.panes[paneID]
	processID, managed := "", false
	if ok {
		processID, managed = p.processID, p.managed
	}
	b.mu.Unlock()
	if !ok || !managed {
		return pibridge.ThinkingLevelsResult{}, fmt.Errorf("pi-bridge: pane not managed")
	}
	res, err := b.server.RequestThinkingLevels(ctx, processID)
	if err != nil {
		return pibridge.ThinkingLevelsResult{}, err
	}
	b.mu.Lock()
	current, ok := b.panes[paneID]
	sameProcess := ok && current.managed && current.processID == processID && res.ProcessID == processID
	b.mu.Unlock()
	if !sameProcess {
		return pibridge.ThinkingLevelsResult{}, fmt.Errorf("pi-bridge: pane process replaced")
	}
	return res, nil
}

// RequestPaneSetThinking requires the origin captured by a successful list;
// it never resolves a replacement process or generation on the caller's behalf.
func (b *Bridge) RequestPaneSetThinking(ctx context.Context, paneID, processID string, generation uint64, level, provider, model string) (pibridge.SetThinkingResult, error) {
	if b == nil {
		return pibridge.SetThinkingResult{}, fmt.Errorf("pi-bridge: disabled")
	}
	b.mu.Lock()
	p, ok := b.panes[paneID]
	sameProcess := ok && p.managed && p.processID == processID
	b.mu.Unlock()
	if !sameProcess {
		return pibridge.SetThinkingResult{}, fmt.Errorf("pi-bridge: pane process changed")
	}
	return b.server.RequestSetThinking(ctx, processID, generation, level, provider, model)
}

// RequestPaneSetModel resolves a pane to its bridge process and asks
// the live Pi session to switch models. Unknown, unmanaged, and
// peerless panes fail; the caller owns the deadline like history
// and models reads.
func (b *Bridge) RequestPaneSetModel(ctx context.Context, paneID, provider, model string) (pibridge.SetModelResult, error) {
	if b == nil {
		return pibridge.SetModelResult{}, fmt.Errorf("pi-bridge: disabled")
	}
	b.mu.Lock()
	p, ok := b.panes[paneID]
	var processID string
	var managed bool
	if ok {
		processID, managed = p.processID, p.managed
	}
	b.mu.Unlock()
	if !ok || !managed {
		return pibridge.SetModelResult{}, fmt.Errorf("pi-bridge: pane not managed")
	}
	return b.server.RequestSetModel(ctx, processID, provider, model)
}

// RevokePane revokes a pane's lease and drops its record. Unknown panes
// and nil bridges are ignored. Idempotent.
func (b *Bridge) RevokePane(paneID string) {
	if b == nil {
		return
	}
	b.mu.Lock()
	p, ok := b.panes[paneID]
	if ok {
		delete(b.panes, paneID)
	}
	b.mu.Unlock()
	if ok && p.managed {
		b.server.Revoke(p.processID)
	}
}

// handlePaneExit revokes a pane only when the exiting instance is the
// registered owner. A delayed old PTY exit after a restore retry reuses the
// same pane ID with a new instance pointer; that stale exit must not revoke
// the replacement lease.
func (b *Bridge) handlePaneExit(inst *pty.PTYInstance) {
	if b == nil || inst == nil {
		return
	}
	b.mu.Lock()
	p, ok := b.panes[inst.ID]
	if ok {
		if p.inst != inst {
			ok = false
		} else {
			delete(b.panes, inst.ID)
		}
	}
	b.mu.Unlock()
	if ok && p.managed {
		b.server.Revoke(p.processID)
	}
}

// BridgePaneState is the nonsecret per-pane bridge view for HTTP and
// attach snapshots. RunID and generation are decimal for JSON safety.
type BridgePaneState struct {
	State             string   `json:"state"`
	Reason            string   `json:"reason,omitempty"`
	Running           *bool    `json:"running,omitempty"`
	TelemetryRevision string   `json:"telemetry_revision,omitempty"`
	Generation        string   `json:"generation,omitempty"`
	LastRun           string   `json:"last_run,omitempty"`
	LastOutcome       string   `json:"last_outcome,omitempty"`
	Model             string   `json:"model,omitempty"`
	ThinkingLevel     string   `json:"thinking_level"`
	Capabilities      []string `json:"capabilities,omitempty"`
	Connected         *bool    `json:"connected,omitempty"`
}

// PaneSnapshot reports the bridge view for one pane. Unknown panes and
// nil bridges report plain. Model, thinking level, running, and capabilities
// come from one retained copy under b.mu, delivered by the ordered state
// callback, so HTTP can never mix them with a stale retained
// revision; only connection availability reads the live peer.
func (b *Bridge) PaneSnapshot(paneID string) BridgePaneState {
	if b == nil {
		return BridgePaneState{State: piBridgePlain}
	}
	b.mu.Lock()
	p, ok := b.panes[paneID]
	var view bridgeStateView
	var managed bool
	var reason, processID string
	if ok {
		managed, reason, processID = p.managed, p.reason, p.processID
		if managed {
			view = p.snapshot()
		}
	}
	b.mu.Unlock()
	if !ok {
		return BridgePaneState{State: piBridgePlain}
	}
	if !managed {
		return BridgePaneState{State: piBridgeUnavailable, Reason: reason}
	}
	st := BridgePaneState{State: piBridgeManaged}
	if view.hasGen {
		st.Generation = strconv.FormatUint(view.gen, 10)
	}
	if view.hasRun {
		st.LastRun = strconv.FormatUint(view.lastRun, 10)
		st.LastOutcome = view.lastOutcome
	}
	// Availability is live, not ordered telemetry: it reads the
	// current peer. Model/running/thinking/caps stay retained.
	if srvView, ok := b.server.PaneState(processID); ok {
		connected := srvView.HasPeer
		st.Connected = &connected
	}
	if view.pubRev != 0 {
		st.TelemetryRevision = strconv.FormatUint(view.pubRev, 10)
	}
	if view.running != nil {
		running := *view.running
		st.Running = &running
	}
	if view.model != "" {
		st.Model = view.model
	}
	st.ThinkingLevel = view.thinkingLevel
	st.Capabilities = append(st.Capabilities, view.caps...)
	return st
}

// onState pushes a fresh bridge view after each accepted snapshot so
// browsers track running state, model, thinking level, and capabilities without
// polling. Stale callbacks for revoked panes, older generations, or
// older-or-equal publication revisions are dropped. A newer
// generation clears the obsolete retained settlement and the stale
// model/usage of the old process. A callback without state advances
// the revision floor but keeps model/thinking unknown. It never calls
// back into the Server; all live values arrive as arguments.
func (b *Bridge) onState(paneID, processID string, generation, pubRev uint64, running, hasState bool, model, thinkingLevel string, caps []string) {
	b.mu.Lock()
	p, ok := b.panes[paneID]
	var view bridgeStateView
	if ok && p.managed && p.processID == processID {
		if p.hasGen && generation < p.gen {
			ok = false
		} else if pubRev <= p.pubRev {
			// Delayed duplicate or reordered delivery: the
			// retained view already reflects this publication
			// or a newer one.
			ok = false
		} else {
			if !p.hasGen || generation > p.gen {
				p.gen, p.hasGen = generation, true
				p.hasRun = false
				p.lastRun = 0
				p.lastOutcome = ""
				p.lastRunning = nil
				p.lastModel = ""
				p.lastThinkingLevel = ""
				p.lastCaps = nil
			}
			p.pubRev = pubRev
			// Capabilities are negotiated by Hello, not by the
			// snapshot: a stateless republish still carries the
			// current connection's set.
			p.lastCaps = append(p.lastCaps[:0], caps...)
			if hasState {
				r := running
				p.lastRunning = &r
				p.lastModel = model
				p.lastThinkingLevel = thinkingLevel
			}
			connected := true
			p.lastConnected = &connected
			view = p.snapshot()
		}
	} else {
		ok = false
	}
	b.mu.Unlock()
	if !ok {
		return
	}
	if payload := encodeBridgeState(paneID, view); payload != nil {
		b.hub.BroadcastBridge(paneID, payload)
	}
}

// onPeerDown publishes current unavailability after a disconnect so
// history recall falls back without a round trip. Generation-fenced
// like onState: a delayed down for a replaced stream never clears a
// newer live view. Bell behavior is untouched.
func (b *Bridge) onPeerDown(paneID, processID string, generation uint64) {
	b.mu.Lock()
	p, ok := b.panes[paneID]
	var view bridgeStateView
	if ok && p.managed && p.processID == processID {
		if p.hasGen && generation < p.gen {
			ok = false
		} else {
			connected := false
			p.lastConnected = &connected
			view = p.snapshot()
		}
	} else {
		ok = false
	}
	b.mu.Unlock()
	if !ok {
		return
	}
	if payload := encodeBridgeState(paneID, view); payload != nil {
		b.hub.BroadcastBridge(paneID, payload)
	}
}

// bridgeStateView is a lock-free copy of one pane's retained view.
type bridgeStateView struct {
	pubRev        uint64
	hasGen        bool
	gen           uint64
	hasRun        bool
	lastRun       uint64
	lastOutcome   string
	running       *bool
	model         string
	thinkingLevel string
	caps          []string
	connected     *bool
}

// snapshot copies the retained view. The caller must hold b.mu. The
// running flag is copied by value so later updates never mutate a
// published view.
func (p *bridgePane) snapshot() bridgeStateView {
	var running *bool
	if p.lastRunning != nil {
		r := *p.lastRunning
		running = &r
	}
	var connected *bool
	if p.lastConnected != nil {
		c := *p.lastConnected
		connected = &c
	}
	return bridgeStateView{
		pubRev:        p.pubRev,
		hasGen:        p.hasGen,
		gen:           p.gen,
		hasRun:        p.hasRun,
		lastRun:       p.lastRun,
		lastOutcome:   p.lastOutcome,
		running:       running,
		model:         p.lastModel,
		thinkingLevel: p.lastThinkingLevel,
		caps:          append([]string(nil), p.lastCaps...),
		connected:     connected,
	}
}

// encodeBridgeState renders the managed bridge view from a copy.
func encodeBridgeState(paneID string, view bridgeStateView) []byte {
	frame := map[string]string{"type": "pi-bridge-state", "pane_id": paneID, "state": piBridgeManaged, "thinking_level": view.thinkingLevel}
	if view.hasGen {
		frame["generation"] = strconv.FormatUint(view.gen, 10)
	}
	if view.pubRev != 0 {
		frame["telemetry_revision"] = strconv.FormatUint(view.pubRev, 10)
	}
	if view.hasRun {
		frame["last_run"] = strconv.FormatUint(view.lastRun, 10)
		frame["last_outcome"] = view.lastOutcome
	}
	if view.running != nil {
		frame["running"] = strconv.FormatBool(*view.running)
	}
	if view.connected != nil {
		frame["connected"] = strconv.FormatBool(*view.connected)
	}
	if view.model != "" {
		frame["model"] = view.model
	}
	if len(view.caps) > 0 {
		frame["capabilities"] = strings.Join(view.caps, ",")
	}
	payload, err := json.Marshal(frame)
	if err != nil {
		return nil
	}
	return payload
}

// onSettled retains the latest settlement per pane and notifies
// browsers. Stale callbacks for revoked panes or older generations are
// dropped; a newer generation clears the obsolete retained run first.
func (b *Bridge) onSettled(paneID, processID string, generation, runID uint64, outcome pibridgepb.RunOutcome) {
	b.mu.Lock()
	p, ok := b.panes[paneID]
	if ok && p.managed && p.processID == processID {
		if p.hasGen && generation < p.gen {
			ok = false
		} else {
			if !p.hasGen || generation > p.gen {
				p.gen, p.hasGen = generation, true
				p.hasRun = false
				p.lastThinkingLevel = ""
			}
			p.lastRun, p.hasRun = runID, true
			p.lastOutcome = outcomeName(outcome)
		}
	} else {
		ok = false
	}
	b.mu.Unlock()
	if !ok {
		return
	}
	payload, err := json.Marshal(map[string]string{
		"type":       "pi-bridge-settled",
		"pane_id":    paneID,
		"generation": strconv.FormatUint(generation, 10),
		"run":        strconv.FormatUint(runID, 10),
		"outcome":    outcomeName(outcome),
	})
	if err != nil {
		return
	}
	b.hub.BroadcastBridge(paneID, payload)
}

func outcomeName(outcome pibridgepb.RunOutcome) string {
	switch outcome {
	case pibridgepb.RunOutcome_RUN_OUTCOME_COMPLETED:
		return "completed"
	case pibridgepb.RunOutcome_RUN_OUTCOME_ABORTED:
		return "aborted"
	case pibridgepb.RunOutcome_RUN_OUTCOME_ERROR:
		return "error"
	default:
		return "unknown"
	}
}

// encodeAttach renders the bridge attach snapshot for pi panes with a
// bridge record. Other panes get no frame. The retained last run lets
// a reconnecting browser catch up on a settlement it never saw.
func (b *Bridge) encodeAttach(snapshot pty.PTYInstanceSnapshot) []byte {
	if b == nil || !piBridgeForCoder(snapshot.Coder) {
		return nil
	}
	b.mu.Lock()
	p, ok := b.panes[snapshot.ID]
	var view bridgeStateView
	var managed bool
	var reason string
	if ok {
		managed = p.managed
		reason = p.reason
		if managed {
			view = p.snapshot()
		}
	}
	b.mu.Unlock()
	if !ok {
		return nil
	}
	frame := map[string]string{"type": "pi-bridge-state", "pane_id": snapshot.ID}
	if !managed {
		frame["state"] = piBridgeUnavailable
		if reason != "" {
			frame["reason"] = reason
		}
		payload, err := json.Marshal(frame)
		if err != nil {
			return nil
		}
		return payload
	}
	return encodeBridgeState(snapshot.ID, view)
}

// piBridgeForCoder reports whether a coder ID gets bridge provisioning.
// Only interactive Pi PTY tabs are managed; shells and other backends
// never receive credentials or extension args.
func piBridgeForCoder(coderID string) bool {
	return coderID == "pi"
}
