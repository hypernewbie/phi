package rpc

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sort"
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
	Cost                *float64 `json:"cost"`
	Skills              []string `json:"skills"`
	Busy                bool     `json:"busy"`
	Status              string   `json:"status"` // "live" | "exited"
	QueueDepth          int      `json:"queueDepth"`
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

func cloneState(state State) State {
	if state.Skills != nil {
		state.Skills = append([]string{}, state.Skills...)
	}
	if state.Cost != nil {
		cost := *state.Cost
		state.Cost = &cost
	}
	return state
}

// ExtensionUIDialog is the server-owned record for one blocking Pi dialog.
// Optional fields are populated only for the matching dialog method.
type ExtensionUIDialog struct {
	ID          string   `json:"id"`
	Method      string   `json:"method"`
	Title       string   `json:"title"`
	Options     []string `json:"options,omitempty"`
	Message     string   `json:"message,omitempty"`
	Placeholder string   `json:"placeholder,omitempty"`
	Prefill     string   `json:"prefill,omitempty"`
	Timeout     int      `json:"timeout"`
	CreatedAt   int64    `json:"createdAt"`
}

func cloneExtensionUIDialog(dialog ExtensionUIDialog) ExtensionUIDialog {
	if dialog.Options != nil {
		dialog.Options = append([]string{}, dialog.Options...)
	}
	return dialog
}

func isBlockingExtensionUIMethod(method string) bool {
	switch method {
	case "select", "confirm", "input", "editor":
		return true
	default:
		return false
	}
}

func isKnownFireAndForgetExtensionUIMethod(method string) bool {
	switch method {
	case "notify", "setStatus", "setWidget", "setTitle", "set_editor_text":
		return true
	default:
		return false
	}
}

type pendingResult struct {
	response piResponse
	err      error
}

type pendingWaiter struct {
	result chan pendingResult
}

// QueueSubmitOptions carries queue attachment resolver context captured at the
// WebSocket boundary. Attachment metadata stays process-local.
type QueueSubmitOptions struct {
	Owner    string
	Resolver QueueAttachmentResolver
}

type queueClaim struct {
	options QueueSubmitOptions
	leased  bool
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

	state   State
	stateMu sync.Mutex

	queueMu                   sync.Mutex
	sessionEpoch              string
	queueItems                map[string]QueueItem
	queueClaims               map[string]queueClaim
	queueSending              bool
	queueSettlementGeneration uint64
	// queueDispatchGenerations records only commands that crossed the Pi
	// JSONL write boundary; promoted items without an entry are still local.
	queueDispatchGenerations map[string]uint64
	queueBlocked             bool
	piSteering               []string
	piFollowUp               []string

	dialogMu     sync.Mutex
	dialogs      map[string]ExtensionUIDialog
	dialogTimers map[string]*time.Timer

	sessionPath   string
	sessionPathMu sync.RWMutex

	titleMu sync.RWMutex

	exitOnce sync.Once
	exitHook func()
}

// SnapshotCopy returns a deep-enough copy of the snapshot; nil-safe.
func (i *Instance) SnapshotCopy() Snapshot {
	i.eventMu.Lock()
	defer i.eventMu.Unlock()
	if i.snap == nil {
		return Snapshot{}
	}
	cp := *i.snap
	cp.Messages = cloneMessages(i.snap.Messages)
	return cp
}

// publish is the only event publication path. It keeps the sequence and
// hydrate snapshot under one lock, then broadcasts while that lock is held so
// subscribers cannot observe sequence N+1 before sequence N.
func (i *Instance) publish(evt string, msg *Message, data any, clear bool) {
	i.eventMu.Lock()
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
	i.eventMu.Unlock()
}

// Emit assigns the next seq, updates the snapshot, and broadcasts.
func (i *Instance) Emit(evt string, msg *Message, data any) {
	i.publish(evt, msg, data, false)
}

// ResetTranscript clears stored messages and emits transcriptReset.
func (i *Instance) ResetTranscript() {
	i.publish(EvtTranscriptReset, nil, nil, true)
}

// StateCopy returns the cached state.
func (i *Instance) StateCopy() State {
	i.stateMu.Lock()
	defer i.stateMu.Unlock()
	return cloneState(i.state)
}

// retainExtensionUIDialog records one known blocking request. Duplicate IDs
// are ignored so reconnect/event duplication cannot create duplicate records.
func (i *Instance) retainExtensionUIDialog(dialog ExtensionUIDialog) bool {
	if dialog.ID == "" || !isBlockingExtensionUIMethod(dialog.Method) {
		return false
	}
	if dialog.CreatedAt == 0 {
		dialog.CreatedAt = time.Now().UnixMilli()
	}
	dialog = cloneExtensionUIDialog(dialog)
	i.dialogMu.Lock()
	defer i.dialogMu.Unlock()
	if i.dialogs == nil {
		i.dialogs = make(map[string]ExtensionUIDialog)
	}
	if _, exists := i.dialogs[dialog.ID]; exists {
		return false
	}
	i.dialogs[dialog.ID] = dialog
	if dialog.Timeout > 0 && dialog.Method != "editor" {
		if i.dialogTimers == nil {
			i.dialogTimers = make(map[string]*time.Timer)
		}
		i.dialogTimers[dialog.ID] = time.AfterFunc(time.Duration(dialog.Timeout)*time.Millisecond, func() {
			i.expireExtensionUIDialog(dialog.ID)
		})
	}
	return true
}

// ExtensionUIDialogsCopy returns retained dialogs in stable creation order.
func (i *Instance) ExtensionUIDialogsCopy() []ExtensionUIDialog {
	i.dialogMu.Lock()
	out := make([]ExtensionUIDialog, 0, len(i.dialogs))
	for _, dialog := range i.dialogs {
		out = append(out, cloneExtensionUIDialog(dialog))
	}
	i.dialogMu.Unlock()
	sort.SliceStable(out, func(left, right int) bool {
		if out[left].CreatedAt == out[right].CreatedAt {
			return out[left].ID < out[right].ID
		}
		return out[left].CreatedAt < out[right].CreatedAt
	})
	return out
}

func (i *Instance) takeExtensionUIDialog(id string) (ExtensionUIDialog, bool) {
	i.dialogMu.Lock()
	defer i.dialogMu.Unlock()
	dialog, ok := i.dialogs[id]
	if !ok {
		return ExtensionUIDialog{}, false
	}
	delete(i.dialogs, id)
	if timer := i.dialogTimers[id]; timer != nil {
		timer.Stop()
		delete(i.dialogTimers, id)
	}
	return cloneExtensionUIDialog(dialog), true
}

func (i *Instance) expireExtensionUIDialog(id string) {
	dialog, ok := i.takeExtensionUIDialog(id)
	if !ok {
		return
	}
	i.Emit(EvtExtensionUIClosed, nil, map[string]any{
		"id": dialog.ID, "reason": "timeout",
	})
}

func (i *Instance) closeExtensionUIDialogs(reason string) {
	i.dialogMu.Lock()
	closed := make([]ExtensionUIDialog, 0, len(i.dialogs))
	for _, dialog := range i.dialogs {
		closed = append(closed, cloneExtensionUIDialog(dialog))
	}
	for _, timer := range i.dialogTimers {
		timer.Stop()
	}
	i.dialogs = make(map[string]ExtensionUIDialog)
	i.dialogTimers = make(map[string]*time.Timer)
	i.dialogMu.Unlock()
	sort.SliceStable(closed, func(left, right int) bool {
		if closed[left].CreatedAt == closed[right].CreatedAt {
			return closed[left].ID < closed[right].ID
		}
		return closed[left].CreatedAt < closed[right].CreatedAt
	})
	for _, dialog := range closed {
		i.Emit(EvtExtensionUIClosed, nil, map[string]any{
			"id": dialog.ID, "reason": reason,
		})
	}
}

var ErrExtensionUIResponseInvalid = errors.New("invalid extension UI response")

func validateExtensionUIDialogResponse(dialog ExtensionUIDialog, value *string, confirmed *bool, cancelled bool) error {
	if cancelled {
		return nil
	}
	switch dialog.Method {
	case "select", "input", "editor":
		if value == nil {
			return fmt.Errorf("%w: %s requires value or cancelled", ErrExtensionUIResponseInvalid, dialog.Method)
		}
	case "confirm":
		if confirmed == nil {
			return fmt.Errorf("%w: confirm requires confirmed or cancelled", ErrExtensionUIResponseInvalid)
		}
	default:
		return fmt.Errorf("%w: unsupported dialog method %q", ErrExtensionUIResponseInvalid, dialog.Method)
	}
	return nil
}

// ResolveExtensionUIDialog removes the matching request before writing the
// answer, so concurrent and late answers are first-answer-wins. It never
// acquires the ordinary control gate.
func (i *Instance) ResolveExtensionUIDialog(id string, value *string, confirmed *bool, cancelled bool) (bool, error) {
	i.dialogMu.Lock()
	dialog, ok := i.dialogs[id]
	if !ok {
		i.dialogMu.Unlock()
		return false, nil
	}
	if err := validateExtensionUIDialogResponse(dialog, value, confirmed, cancelled); err != nil {
		i.dialogMu.Unlock()
		return false, err
	}
	delete(i.dialogs, id)
	if timer := i.dialogTimers[id]; timer != nil {
		timer.Stop()
		delete(i.dialogTimers, id)
	}
	i.dialogMu.Unlock()

	response := map[string]any{"type": "extension_ui_response", "id": id}
	if cancelled {
		response["cancelled"] = true
	} else if dialog.Method == "confirm" {
		response["confirmed"] = *confirmed
	} else {
		response["value"] = *value
	}
	if err := i.Send(response); err != nil {
		return true, err
	}
	return true, nil
}

// CancelExtensionUIDialogs resolves all open requests as cancelled while the
// child is alive and emits one close event per removed record.
func (i *Instance) CancelExtensionUIDialogs(reason string) int {
	i.dialogMu.Lock()
	closed := make([]ExtensionUIDialog, 0, len(i.dialogs))
	for _, dialog := range i.dialogs {
		closed = append(closed, cloneExtensionUIDialog(dialog))
	}
	for _, timer := range i.dialogTimers {
		timer.Stop()
	}
	i.dialogs = make(map[string]ExtensionUIDialog)
	i.dialogTimers = make(map[string]*time.Timer)
	i.dialogMu.Unlock()
	sort.SliceStable(closed, func(left, right int) bool {
		if closed[left].CreatedAt == closed[right].CreatedAt {
			return closed[left].ID < closed[right].ID
		}
		return closed[left].CreatedAt < closed[right].CreatedAt
	})
	for _, dialog := range closed {
		if i.IsAlive() {
			_ = i.Send(map[string]any{
				"type": "extension_ui_response", "id": dialog.ID, "cancelled": true,
			})
		}
		i.Emit(EvtExtensionUIClosed, nil, map[string]any{
			"id": dialog.ID, "reason": reason,
		})
	}
	return len(closed)
}

// cancelUnsupportedExtensionUI prevents an unknown blocking request from
// leaving Pi waiting forever. It emits the same close event used by later
// dialog cancellation paths; Send is guarded by the instance's alive state.
func (i *Instance) cancelUnsupportedExtensionUI(id string) {
	if id == "" {
		return
	}
	_ = i.Send(map[string]any{
		"type":      "extension_ui_response",
		"id":        id,
		"cancelled": true,
	})
	i.Emit(EvtExtensionUIClosed, nil, map[string]any{
		"id": id, "reason": "unsupported",
	})
}

// SetState replaces the cached state. Once the queue ledger exists, its
// non-terminal depth remains authoritative over Pi's queue_update count.
func (i *Instance) SetState(s State) {
	i.queueMu.Lock()
	if len(i.queueItems) > 0 {
		s.QueueDepth = i.queueDepthLocked()
	}
	i.queueMu.Unlock()
	i.stateMu.Lock()
	i.state = cloneState(s)
	i.stateMu.Unlock()
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

// TitleCopy returns the current user-facing title.
func (i *Instance) TitleCopy() string {
	i.titleMu.RLock()
	defer i.titleMu.RUnlock()
	return i.Title
}

// SetTitle replaces the user-facing title under the title mutex. Callers
// that also want subscribers to see the change must follow with SetState
// (State.Title) and Emit(EvtStateChanged).
func (i *Instance) SetTitle(title string) {
	i.titleMu.Lock()
	i.Title = title
	i.titleMu.Unlock()
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

func (i *Instance) registerWaiter(id string) (*pendingWaiter, error) {
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
	waiter := &pendingWaiter{result: make(chan pendingResult, 1)}
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
	waiter, err := i.registerWaiter(id)
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
	waiter, err := i.registerWaiter(id)
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
		i.stateMu.Lock()
		st := i.state
		st.Status = "exited"
		i.state = cloneState(st)
		i.stateMu.Unlock()
		i.failPending(ErrNotAlive)
		i.markQueueUncertainOnExit()
		// Dialog close events must be sequenced before rpcExited so clients
		// can dismiss every retained overlay while the instance identity is
		// still available. No response is attempted after alive is false.
		i.closeExtensionUIDialogs("childExit")
		i.publish(EvtRpcExited, nil, map[string]any{"reason": reason}, false)
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
