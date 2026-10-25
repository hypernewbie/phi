package rpc

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sync"
	"sync/atomic"
	"time"
)

// ErrNotAlive is returned by Send after the child has exited.
var ErrNotAlive = errors.New("rpc instance not alive")

// ErrPromptChanged means an ordinary prompt was written after a caller
// captured the prompt generation and before its conditional control write.
var ErrPromptChanged = errors.New("rpc prompt changed")

// State is phi-synthesized session state.
type State struct {
	Sid                 string   `json:"sid"`
	Title               string   `json:"title"`
	Cwd                 string   `json:"cwd"`
	Model               string   `json:"model,omitempty"`
	Thinking            string   `json:"thinking,omitempty"`
	InputTokens         *int64   `json:"inputTokens"`
	OutputTokens        *int64   `json:"outputTokens"`
	ContextUsedTokens   *int64   `json:"contextUsedTokens"`
	ContextWindowTokens *int64   `json:"contextWindowTokens"`
	CacheReadTokens     *int64   `json:"cacheReadTokens"`
	CacheWriteTokens    *int64   `json:"cacheWriteTokens"`
	Skills              []string `json:"skills"`
	Busy                bool     `json:"busy"`
	Status              string   `json:"status"` // "live" | "exited"
	QueueDepth          int      `json:"queueDepth"`
	// SessionPath is the published resume path: a nonempty value
	// identifies an existing regular Pi session file that Phi can
	// reopen after a reload. The manager promotes it from the raw
	// Instance.SessionPathCopy() value only after the file exists;
	// the raw value itself may point at a file Pi has not written yet.
	SessionPath string `json:"sessionPath,omitempty"`
}

// Message is one transcript entry; message_end.message is authoritative.
// Tool-result envelopes carry pairing fields alongside content so the
// UI can render the call's output inline (rpc.md: ToolResultMessage).
type Message struct {
	Role       string          `json:"role"`
	Content    json.RawMessage `json:"content"`
	Details    json.RawMessage `json:"details,omitempty"`
	ToolCallId string          `json:"toolCallId,omitempty"`
	ToolName   string          `json:"toolName,omitempty"`
	IsError    *bool           `json:"isError,omitempty"`
	Ts         int64           `json:"ts,omitempty"`
	// Pi's message_end surface may carry an error/abort/length marker
	// alongside the partial content. The chat-pi frontend renders the
	// matching red row or per-tool error text from these fields without
	// parsing pi's wire format itself.
	StopReason   string `json:"stopReason,omitempty"`
	ErrorMessage string `json:"errorMessage,omitempty"`
}

// Snapshot is the atomic hydrate payload.
type Snapshot struct {
	LastSeq  uint64    `json:"lastSeq"`
	Messages []Message `json:"messages"`
}

func cloneMessages(messages []Message) []Message {
	if messages == nil {
		return []Message{}
	}
	cloned := make([]Message, len(messages))
	for idx, message := range messages {
		cloned[idx] = message
		if message.Content != nil {
			cloned[idx].Content = append(json.RawMessage(nil), message.Content...)
		}
		if message.Details != nil {
			cloned[idx].Details = append(json.RawMessage(nil), message.Details...)
		}
		if message.IsError != nil {
			value := *message.IsError
			cloned[idx].IsError = &value
		}
	}
	return cloned
}

func cloneInt64(value *int64) *int64 {
	if value == nil {
		return nil
	}
	copy := *value
	return &copy
}

func cloneState(state State) State {
	state.InputTokens = cloneInt64(state.InputTokens)
	state.OutputTokens = cloneInt64(state.OutputTokens)
	state.ContextUsedTokens = cloneInt64(state.ContextUsedTokens)
	state.ContextWindowTokens = cloneInt64(state.ContextWindowTokens)
	state.CacheReadTokens = cloneInt64(state.CacheReadTokens)
	state.CacheWriteTokens = cloneInt64(state.CacheWriteTokens)
	if state.Skills != nil {
		state.Skills = append([]string{}, state.Skills...)
	}
	return state
}

type pendingResult struct {
	response piResponse
	err      error
}

type pendingWaiter struct {
	command string
	result  chan pendingResult
}

// Instance is one pi --mode rpc child. All methods are goroutine-safe.
type Instance struct {
	ID        string
	Cwd       string
	Title     string
	CreatedAt time.Time

	cmd    Cmd
	stdin  WriteCloser
	stdout ReadCloser
	sc     *LineScanner
	alive  bool
	mu     sync.Mutex

	writeMu               sync.Mutex
	promptWriteGeneration uint64

	pendingMu  sync.Mutex
	pending    map[string]*pendingWaiter
	requestSeq uint64

	controlOnce sync.Once
	controlGate chan struct{}

	eventMu sync.Mutex
	seq     uint64
	snap    *Snapshot
	subs    *SubscriberSet

	state State

	sessionPath   string
	sessionPathMu sync.RWMutex

	titleMu  sync.RWMutex
	titleSrc titleSources

	exitOnce sync.Once
	exitHook func()
}

func snapshotCopyLocked(i *Instance) Snapshot {
	if i.snap == nil {
		return Snapshot{}
	}
	cp := *i.snap
	cp.Messages = cloneMessages(i.snap.Messages)
	return cp
}

// SnapshotCopy returns a deep-enough copy of the snapshot; nil-safe.
func (i *Instance) SnapshotCopy() Snapshot {
	i.eventMu.Lock()
	defer i.eventMu.Unlock()
	return snapshotCopyLocked(i)
}

// SnapshotStateCopy returns transcript and metadata from one event boundary.
func (i *Instance) SnapshotStateCopy() (Snapshot, State) {
	i.eventMu.Lock()
	defer i.eventMu.Unlock()
	return snapshotCopyLocked(i), cloneState(i.state)
}

// publishLocked assigns the next sequence, updates the snapshot, and
// broadcasts while eventMu is held so subscribers cannot observe sequence
// N+1 before sequence N.
func (i *Instance) publishLocked(evt string, msg *Message, data any, clear bool) {
	if i.snap == nil {
		i.snap = &Snapshot{}
	}
	i.seq++
	seq := i.seq
	if clear {
		i.snap.Messages = []Message{}
	}
	if msg != nil {
		message := *msg
		message.Content = append(json.RawMessage(nil), msg.Content...)
		message.Details = append(json.RawMessage(nil), msg.Details...)
		i.snap.Messages = append(i.snap.Messages, message)
	}
	i.snap.LastSeq = seq
	if i.subs != nil {
		i.subs.Broadcast(Event{Type: "evt", Evt: evt, Sid: i.ID, Seq: seq, Data: data})
	}
}

func (i *Instance) publish(evt string, msg *Message, data any, clear bool) {
	i.eventMu.Lock()
	defer i.eventMu.Unlock()
	i.publishLocked(evt, msg, data, clear)
}

// Emit assigns the next seq, updates the snapshot, and broadcasts.
func (i *Instance) Emit(evt string, msg *Message, data any) {
	i.publish(evt, msg, data, false)
}

// ResetTranscript clears stored messages and emits transcriptReset. After exit
// there is no subscriber left, so a late reset must not advance the cursor a
// later hydrate would report.
func (i *Instance) ResetTranscript() {
	i.eventMu.Lock()
	defer i.eventMu.Unlock()
	if i.state.Status == "exited" {
		return
	}
	i.publishLocked(EvtTranscriptReset, nil, nil, true)
}

// StateCopy returns a detached copy of the cached state.
func (i *Instance) StateCopy() State {
	i.eventMu.Lock()
	defer i.eventMu.Unlock()
	return cloneState(i.state)
}

// SetState is gone: runtime writers must use updateState so a whole-state copy
// can never replace a newer commit. initState seeds state before publication.
func (i *Instance) initState(s State) {
	i.eventMu.Lock()
	i.state = cloneState(s)
	i.eventMu.Unlock()
}

// commitReset removes the public resume path and clears the transcript under
// one event boundary, so a paired reader cannot observe the intermediate state.
// A reset after exit changes nothing.
func (i *Instance) commitReset() bool {
	i.eventMu.Lock()
	defer i.eventMu.Unlock()
	if i.state.Status == "exited" {
		return false
	}
	next := cloneState(i.state)
	changed := next.SessionPath != ""
	next.SessionPath = ""
	if i.applyTitleLocked(&next, func(src *titleSources) {
		*src = titleSources{seeded: true}
	}) {
		changed = true
	}
	if changed {
		i.state = cloneState(next)
		i.publishLocked(EvtStateChanged, nil, cloneState(i.state), false)
	}
	i.publishLocked(EvtTranscriptReset, nil, nil, true)
	return true
}

// updateState applies one current-state transaction and publishes its detached
// result while holding the same lock as the transcript and event sequence. The
// callback runs with that lock held and must not call back into the Instance
// (StateCopy, Send, SetTitle, ResetTranscript): the lock is not reentrant.
func (i *Instance) updateState(update func(*State) bool) bool {
	i.eventMu.Lock()
	defer i.eventMu.Unlock()
	if i.state.Status == "exited" {
		return false
	}
	next := cloneState(i.state)
	if !update(&next) {
		return false
	}
	i.state = cloneState(next)
	i.publishLocked(EvtStateChanged, nil, cloneState(i.state), false)
	return true
}

// IsAlive reports whether the child is still running.
func (i *Instance) IsAlive() bool {
	i.mu.Lock()
	defer i.mu.Unlock()
	return i.alive
}

// SessionPathCopy returns the manager-owned session path.
func (i *Instance) SessionPathCopy() string {
	i.sessionPathMu.RLock()
	defer i.sessionPathMu.RUnlock()
	return i.sessionPath
}

func (i *Instance) setSessionPath(path string) {
	i.sessionPathMu.Lock()
	i.sessionPath = path
	i.sessionPathMu.Unlock()
}

// promotePublicPath publishes candidate as the resume path only while the raw
// ownership value still matches. It takes sessionPathMu before eventMu.
func (i *Instance) promotePublicPath(candidate string) bool {
	i.sessionPathMu.RLock()
	defer i.sessionPathMu.RUnlock()
	if i.sessionPath != candidate {
		return false
	}
	return i.updateState(func(state *State) bool {
		if state.SessionPath == candidate {
			return false
		}
		state.SessionPath = candidate
		return true
	})
}

// TitleCopy returns the current user-facing title.
func (i *Instance) TitleCopy() string {
	i.titleMu.RLock()
	defer i.titleMu.RUnlock()
	return i.Title
}

// SetNativeName records a native name observed on the RPC read loop and
// publishes the resolved title. An empty name means Pi cleared it, so the
// request fallback, then the generic label, takes over.
func (i *Instance) SetNativeName(name string) {
	i.updateState(func(state *State) bool {
		return i.applyTitleLocked(state, func(src *titleSources) {
			src.nativeName = name
			src.seeded = true
		})
	})
}

// applyTitleLocked mutates the guarded title sources and writes the resolved
// title to both mirrors. It returns true only when the displayed title changed,
// so an equal repeat publishes nothing. Callers hold eventMu through an
// updateState or commitReset callback, which keeps the eventMu -> titleMu order.
func (i *Instance) applyTitleLocked(state *State, change func(*titleSources)) bool {
	i.titleMu.Lock()
	change(&i.titleSrc)
	resolved := i.titleSrc.resolve(i.Cwd)
	changed := i.Title != resolved
	i.Title = resolved
	i.titleMu.Unlock()
	if !changed {
		return false
	}
	state.Title = resolved
	return true
}

// PromptWriteGeneration returns the generation of ordinary prompt writes.
func (i *Instance) PromptWriteGeneration() uint64 {
	i.writeMu.Lock()
	defer i.writeMu.Unlock()
	return i.promptWriteGeneration
}

func (i *Instance) initControl() {
	i.controlOnce.Do(func() {
		i.controlGate = make(chan struct{}, 1)
		i.controlGate <- struct{}{}
	})
}

// withControl serializes one complete Pi control operation. The caller's
// context is used for both gate acquisition and the operation itself.
func (i *Instance) withControl(ctx context.Context, fn func(context.Context) (any, error)) (any, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	i.initControl()
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-i.controlGate:
	}
	defer func() { i.controlGate <- struct{}{} }()
	return fn(ctx)
}

// WithControl exposes the per-instance operation gate to the control server.
func (i *Instance) WithControl(ctx context.Context, fn func(context.Context) (any, error)) (any, error) {
	return i.withControl(ctx, fn)
}

func (i *Instance) nextCommandID() string {
	n := atomic.AddUint64(&i.requestSeq, 1)
	if i.ID != "" {
		return fmt.Sprintf("%s-%d", i.ID, n)
	}
	return fmt.Sprintf("rpc-%d", n)
}

func (i *Instance) registerWaiter(id, command string) (*pendingWaiter, error) {
	if id == "" {
		return nil, errors.New("empty Pi command id")
	}
	i.pendingMu.Lock()
	defer i.pendingMu.Unlock()
	i.mu.Lock()
	alive := i.alive
	i.mu.Unlock()
	if !alive {
		return nil, ErrNotAlive
	}
	if i.pending == nil {
		i.pending = make(map[string]*pendingWaiter)
	}
	waiter := &pendingWaiter{command: command, result: make(chan pendingResult, 1)}
	i.pending[id] = waiter
	return waiter, nil
}

func (i *Instance) removeWaiter(id string, expected *pendingWaiter) bool {
	i.pendingMu.Lock()
	defer i.pendingMu.Unlock()
	waiter, ok := i.pending[id]
	if !ok || (expected != nil && waiter != expected) {
		return false
	}
	delete(i.pending, id)
	return true
}

// claimWaiter atomically removes a matching request so a duplicate response
// cannot complete it twice.
func (i *Instance) claimWaiter(id string) *pendingWaiter {
	if id == "" {
		return nil
	}
	i.pendingMu.Lock()
	defer i.pendingMu.Unlock()
	waiter := i.pending[id]
	if waiter != nil {
		delete(i.pending, id)
	}
	return waiter
}

func (i *Instance) failPending(err error) {
	i.pendingMu.Lock()
	pending := i.pending
	i.pending = make(map[string]*pendingWaiter)
	i.pendingMu.Unlock()
	for _, waiter := range pending {
		waiter.result <- pendingResult{err: err}
	}
}

func (i *Instance) writeBytesLocked(b []byte, prompt bool) error {
	i.mu.Lock()
	stdin := i.stdin
	alive := i.alive
	i.mu.Unlock()
	if !alive || stdin == nil {
		return ErrNotAlive
	}
	if prompt {
		// Keep this increment immediately adjacent to the complete stdin write.
		i.promptWriteGeneration++
	}
	n, err := stdin.Write(b)
	if err != nil {
		return err
	}
	if n != len(b) {
		return io.ErrShortWrite
	}
	return nil
}

func (i *Instance) sendValue(v any, prompt bool) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	b = append(b, '\n')
	i.writeMu.Lock()
	defer i.writeMu.Unlock()
	return i.writeBytesLocked(b, prompt)
}

// Send writes one JSON line to the child's stdin under the shared write lock.
func (i *Instance) Send(v any) error { return i.sendValue(v, false) }

// SendPrompt writes an ordinary prompt and advances its reset generation.
func (i *Instance) SendPrompt(v any) error { return i.sendValue(v, true) }

func makeRequest(command string, id string, fields map[string]any) ([]byte, error) {
	if command == "" || id == "" {
		return nil, errors.New("Pi command and id are required")
	}
	record := make(map[string]any, len(fields)+2)
	record["id"] = id
	record["type"] = command
	for key, value := range fields {
		record[key] = value
	}
	b, err := json.Marshal(record)
	if err != nil {
		return nil, err
	}
	return append(b, '\n'), nil
}

func (i *Instance) waitFor(ctx context.Context, id string, waiter *pendingWaiter) (json.RawMessage, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	select {
	case result := <-waiter.result:
		if result.err != nil {
			return nil, result.err
		}
		if !result.response.Success {
			if result.response.Error != "" {
				return nil, fmt.Errorf("pi: %s", result.response.Error)
			}
			return nil, fmt.Errorf("pi rejected %s", result.response.Command)
		}
		return append(json.RawMessage(nil), result.response.Data...), nil
	case <-ctx.Done():
		i.removeWaiter(id, waiter)
		return nil, ctx.Err()
	}
}

// Request sends one correlated Pi JSONL command and waits for its response.
func (i *Instance) Request(ctx context.Context, command string, fields map[string]any) (json.RawMessage, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	id := i.nextCommandID()
	waiter, err := i.registerWaiter(id, command)
	if err != nil {
		return nil, err
	}
	b, err := makeRequest(command, id, fields)
	if err != nil {
		i.removeWaiter(id, waiter)
		return nil, err
	}
	i.writeMu.Lock()
	err = i.writeBytesLocked(b, false)
	i.writeMu.Unlock()
	if err != nil {
		i.removeWaiter(id, waiter)
		return nil, err
	}
	return i.waitFor(ctx, id, waiter)
}

// RequestAfterPromptGeneration conditionally writes a correlated control
// command while holding the ordinary-write mutex. It is used by Reset Chat to
// close the preflight/write race without blocking ordinary prompt submission.
func (i *Instance) RequestAfterPromptGeneration(ctx context.Context, expected uint64, command string, fields map[string]any) (json.RawMessage, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	id := i.nextCommandID()
	b, err := makeRequest(command, id, fields)
	if err != nil {
		return nil, err
	}
	i.writeMu.Lock()
	if i.promptWriteGeneration != expected {
		i.writeMu.Unlock()
		return nil, ErrPromptChanged
	}
	waiter, err := i.registerWaiter(id, command)
	if err == nil {
		err = i.writeBytesLocked(b, false)
	}
	i.writeMu.Unlock()
	if err != nil {
		i.removeWaiter(id, waiter)
		return nil, err
	}
	return i.waitFor(ctx, id, waiter)
}

// OnExit terminates the instance exactly once: it marks the child dead,
// releases all request waiters, broadcasts rpcExited, then closes subscribers.
func (i *Instance) OnExit(reason string) {
	i.exitOnce.Do(func() {
		i.mu.Lock()
		i.alive = false
		i.mu.Unlock()
		i.eventMu.Lock()
		st := cloneState(i.state)
		st.Status = "exited"
		i.state = st
		i.publishLocked(EvtRpcExited, nil, map[string]any{"reason": reason}, false)
		i.eventMu.Unlock()
		i.failPending(ErrNotAlive)
		if i.subs != nil {
			i.subs.CloseAll()
		}
		if i.exitHook != nil {
			i.exitHook()
		}
	})
}

// Kill terminates the child process.
func (i *Instance) Kill() {
	i.mu.Lock()
	cmd, stdin := i.cmd, i.stdin
	i.mu.Unlock()
	if stdin != nil {
		_ = stdin.Close()
	}
	if cmd != nil {
		_ = cmd.Kill()
	}
	i.OnExit("killed")
}

// Subscribe registers an event subscriber. Nil-safe.
func (i *Instance) Subscribe() *Subscriber {
	return i.subscribeWithCallback(nil)
}

func (i *Instance) subscribeWithCallback(callback func()) *Subscriber {
	if i.subs == nil {
		return nil
	}
	return i.subs.SubscribeWithCallback(callback)
}
