package phicmd

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"google.golang.org/protobuf/proto"

	"github.com/hypernewbie/phi/pkg/rpc"
	wspb "github.com/hypernewbie/phi/pkg/ws/pb"
	"github.com/hypernewbie/phi/pkg/ws/wireproto"
)

// ControlCallTimeout bounds one control call, matching the web client's
// non-compact budget (Compact is not used by phi-cmd v1).
const ControlCallTimeout = 35 * time.Second

// ControlEvent is one decoded sequenced event, delivered in arrival order.
type ControlEvent struct {
	SID  string
	Seq  uint64
	Name string         // oneof variant name, e.g. "state_changed"
	Body map[string]any // decoded JSON view of the event payload
	wire *wspb.ControlEvent
}

// Wire returns the protobuf event for callers that need typed access.
func (e ControlEvent) Wire() *wspb.ControlEvent { return e.wire }

// Control is one /ws/control connection: hello, correlated calls, events.
type Control struct {
	conn *websocket.Conn

	nextID  int
	pending map[string]chan *wspb.ControlResponse
	mu      sync.Mutex

	events   chan ControlEvent
	dead     chan struct{}
	deadOnce sync.Once
	deadErr  error
}

// DialControl opens the control socket: the required subprotocol, the
// hello frame, and the welcome handshake. The HTTP client's cookie jar
// rides the upgrade request so an authenticated REST session authorizes
// the socket.
func DialControl(ctx context.Context, h *HTTP) (*Control, error) {
	wsURL := "ws://" + h.Base.Host + "/ws/control"
	if h.Base.Scheme == "https" {
		wsURL = "wss://" + h.Base.Host + "/ws/control"
	}
	header := http.Header{}
	// Copy the access session cookie onto the upgrade, like a browser.
	if h.Client.Jar != nil {
		if u, err := h.Base.Parse("/ws/control"); err == nil && u != nil {
			for _, cookie := range h.Client.Jar.Cookies(u) {
				header.Add("Cookie", cookie.Name+"="+cookie.Value)
			}
		}
	}
	dialer := &websocket.Dialer{
		HandshakeTimeout: 30 * time.Second,
		Subprotocols:     []string{wireproto.ControlSubprotocol},
	}
	conn, resp, err := dialer.DialContext(ctx, wsURL, header)
	if err != nil {
		if resp != nil && resp.StatusCode == http.StatusUnauthorized {
			return nil, fmt.Errorf("%w: control socket refused", ErrUnauthorized)
		}
		if resp != nil && resp.StatusCode == http.StatusUpgradeRequired {
			return nil, fmt.Errorf("phi-cmd: control socket requires subprotocol %s", wireproto.ControlSubprotocol)
		}
		return nil, fmt.Errorf("phi-cmd: control dial: %w", err)
	}
	c := &Control{
		conn:    conn,
		pending: map[string]chan *wspb.ControlResponse{},
		events:  make(chan ControlEvent, 128),
		dead:    make(chan struct{}),
	}
	hello, err := proto.Marshal(&wspb.ControlClientFrame{Payload: &wspb.ControlClientFrame_Hello{
		Hello: &wspb.ControlHello{Version: uint32(rpc.ProtocolVersion)},
	}})
	if err != nil {
		_ = conn.Close()
		return nil, err
	}
	if err := conn.WriteMessage(websocket.BinaryMessage, hello); err != nil {
		_ = conn.Close()
		return nil, fmt.Errorf("phi-cmd: control hello: %w", err)
	}
	// The first server frame must be the welcome.
	conn.SetReadDeadline(time.Now().Add(30 * time.Second))
	mt, raw, err := wireproto.ReadBoundedMessage(conn, wireproto.MaxControlMessageBytes)
	if err != nil {
		_ = conn.Close()
		return nil, fmt.Errorf("phi-cmd: control welcome: %w", err)
	}
	conn.SetReadDeadline(time.Time{})
	if mt != websocket.BinaryMessage {
		_ = conn.Close()
		return nil, fmt.Errorf("phi-cmd: control endpoint is binary-only")
	}
	frame := &wspb.ControlServerFrame{}
	if err := (proto.UnmarshalOptions{}).Unmarshal(raw, frame); err != nil || frame.GetWelcome() == nil {
		_ = conn.Close()
		return nil, fmt.Errorf("phi-cmd: expected control welcome")
	}
	go c.readLoop()
	return c, nil
}

func (c *Control) readLoop() {
	defer c.Close()
	for {
		mt, raw, err := wireproto.ReadBoundedMessage(c.conn, wireproto.MaxControlMessageBytes)
		if err != nil {
			c.fail(err)
			return
		}
		if mt != websocket.BinaryMessage {
			c.fail(fmt.Errorf("phi-cmd: text frame on control socket"))
			return
		}
		frame := &wspb.ControlServerFrame{}
		if err := (proto.UnmarshalOptions{}).Unmarshal(raw, frame); err != nil {
			c.fail(fmt.Errorf("phi-cmd: invalid control frame: %w", err))
			return
		}
		if resp := frame.GetResponse(); resp != nil {
			c.mu.Lock()
			ch := c.pending[resp.GetId()]
			delete(c.pending, resp.GetId())
			c.mu.Unlock()
			if ch != nil {
				ch <- resp
			}
			continue
		}
		if event := frame.GetEvent(); event != nil {
			select {
			case c.events <- ControlEvent{SID: event.GetSid(), Seq: event.GetSeq(), Name: eventName(event), wire: event}:
			default:
				// A slow consumer must not stall the socket; the event is
				// dropped and the caller rehydrates on gap detection.
			}
		}
	}
}

// eventName maps the oneof payload to its variant name.
func eventName(event *wspb.ControlEvent) string {
	switch event.GetEvent().(type) {
	case *wspb.ControlEvent_StateChanged:
		return "state_changed"
	case *wspb.ControlEvent_MessageStart:
		return "message_start"
	case *wspb.ControlEvent_MessageUpdate:
		return "message_update"
	case *wspb.ControlEvent_MessageEnd:
		return "message_end"
	case *wspb.ControlEvent_TranscriptReset:
		return "transcript_reset"
	case *wspb.ControlEvent_RpcExited:
		return "rpc_exited"
	case *wspb.ControlEvent_SubagentFleet:
		return "subagent_fleet"
	case *wspb.ControlEvent_AutoRetryStart:
		return "auto_retry_start"
	case *wspb.ControlEvent_AutoRetryEnd:
		return "auto_retry_end"
	case *wspb.ControlEvent_SummarizationRetryScheduled:
		return "summarization_retry_scheduled"
	case *wspb.ControlEvent_SummarizationRetryFinished:
		return "summarization_retry_finished"
	case *wspb.ControlEvent_CompactionEnd:
		return "compaction_end"
	case *wspb.ControlEvent_ExtensionError:
		return "extension_error"
	case *wspb.ControlEvent_QueueChanged:
		return "queue_changed"
	case *wspb.ControlEvent_ExtensionUiRequest:
		return "extension_ui_request"
	case *wspb.ControlEvent_ExtensionUiClosed:
		return "extension_ui_closed"
	case *wspb.ControlEvent_ToolExecutionUpdate:
		return "tool_execution_update"
	}
	return "unknown"
}

func (c *Control) fail(err error) {
	c.deadOnce.Do(func() {
		c.deadErr = err
		close(c.dead)
		c.mu.Lock()
		for id, ch := range c.pending {
			close(ch)
			delete(c.pending, id)
		}
		c.mu.Unlock()
	})
}

// Close tears the socket down. Calls in flight fail with ErrClosed.
var ErrClosed = errors.New("phi-cmd: control socket closed")

func (c *Control) Close() {
	c.deadOnce.Do(func() {
		c.deadErr = ErrClosed
		close(c.dead)
	})
	_ = c.conn.Close()
	c.mu.Lock()
	for id, ch := range c.pending {
		close(ch)
		delete(c.pending, id)
	}
	c.mu.Unlock()
}

// Done reports socket death; Err returns why.
func (c *Control) Done() <-chan struct{} { return c.dead }

func (c *Control) Err() error {
	select {
	case <-c.dead:
		return c.deadErr
	default:
		return nil
	}
}

// Events is the sequenced-event stream. One value per event, in order.
func (c *Control) Events() <-chan ControlEvent { return c.events }

// call sends one ControlCall and waits for its correlated response.
func (c *Control) call(ctx context.Context, payload any) (*wspb.ControlResponse, error) {
	c.mu.Lock()
	c.nextID++
	id := fmt.Sprintf("c%d", c.nextID)
	ch := make(chan *wspb.ControlResponse, 1)
	c.pending[id] = ch
	c.mu.Unlock()
	call := &wspb.ControlCall{Id: id}
	switch p := payload.(type) {
	case *wspb.SpawnCall:
		call.Call = &wspb.ControlCall_Spawn{Spawn: p}
	case *wspb.ListSessionsCall:
		call.Call = &wspb.ControlCall_ListSessions{ListSessions: p}
	case *wspb.GetStateCall:
		call.Call = &wspb.ControlCall_GetState{GetState: p}
	case *wspb.HydrateCall:
		call.Call = &wspb.ControlCall_Hydrate{Hydrate: p}
	case *wspb.GetMessagesCall:
		call.Call = &wspb.ControlCall_GetMessages{GetMessages: p}
	case *wspb.PromptCall:
		call.Call = &wspb.ControlCall_Prompt{Prompt: p}
	case *wspb.GetAvailableModelsCall:
		call.Call = &wspb.ControlCall_GetAvailableModels{GetAvailableModels: p}
	case *wspb.SetModelCall:
		call.Call = &wspb.ControlCall_SetModel{SetModel: p}
	case *wspb.GetAvailableThinkingLevelsCall:
		call.Call = &wspb.ControlCall_GetAvailableThinkingLevels{GetAvailableThinkingLevels: p}
	case *wspb.SetThinkingCall:
		call.Call = &wspb.ControlCall_SetThinking{SetThinking: p}
	case *wspb.NewSessionCall:
		call.Call = &wspb.ControlCall_NewSession{NewSession: p}
	case *wspb.AbortCall:
		call.Call = &wspb.ControlCall_Abort{Abort: p}
	case *wspb.SetSessionNameCall:
		call.Call = &wspb.ControlCall_SetSessionName{SetSessionName: p}
	default:
		c.mu.Lock()
		delete(c.pending, id)
		c.mu.Unlock()
		return nil, fmt.Errorf("phi-cmd: unsupported call %T", payload)
	}
	frameBytes, err := proto.Marshal(&wspb.ControlClientFrame{Payload: &wspb.ControlClientFrame_Call{Call: call}})
	if err != nil {
		return nil, err
	}
	if err := c.conn.WriteMessage(websocket.BinaryMessage, frameBytes); err != nil {
		c.mu.Lock()
		delete(c.pending, id)
		c.mu.Unlock()
		return nil, err
	}
	select {
	case resp, ok := <-ch:
		if !ok {
			return nil, c.Err()
		}
		return resp, nil
	case <-ctx.Done():
		c.mu.Lock()
		delete(c.pending, id)
		c.mu.Unlock()
		return nil, ctx.Err()
	case <-c.dead:
		return nil, c.Err()
	}
}

// result unwraps a response: an error variant becomes a Go error.
func result(resp *wspb.ControlResponse) error {
	if e := resp.GetError(); e != nil {
		if notFoundReason(e.GetReason()) {
			return fmt.Errorf("%w: %s", ErrNotFound, e.GetReason())
		}
		if authReason(e.GetReason()) {
			return fmt.Errorf("%w: %s", ErrUnauthorized, e.GetReason())
		}
		return errors.New(e.GetReason())
	}
	return nil
}

func notFoundReason(reason string) bool {
	for _, frag := range []string{"unknown session", "unknown sid", "not found", "no such"} {
		if contains(reason, frag) {
			return true
		}
	}
	return false
}

func authReason(reason string) bool {
	return contains(reason, "unauthorized") || contains(reason, "authentication")
}

func contains(s, frag string) bool { return strings.Contains(s, frag) }

// Spawn opens (or idempotently reuses) a chat session. An empty cwd uses
// the server's active cwd; sessionPath resumes a persisted session.
func (c *Control) Spawn(ctx context.Context, cwd, sessionPath, spawnID string) (*wspb.SpawnResult, error) {
	call := &wspb.SpawnCall{}
	if cwd != "" {
		call.Cwd = &cwd
	}
	if sessionPath != "" {
		call.SessionPath = &sessionPath
	}
	if spawnID != "" {
		call.SpawnId = &spawnID
	}
	resp, err := c.call(ctx, call)
	if err != nil {
		return nil, err
	}
	if err := result(resp); err != nil {
		return nil, err
	}
	return resp.GetSpawn(), nil
}

// ListSessions returns the backend's live chat sessions.
func (c *Control) ListSessions(ctx context.Context) ([]*wspb.SessionSummary, error) {
	resp, err := c.call(ctx, &wspb.ListSessionsCall{})
	if err != nil {
		return nil, err
	}
	if err := result(resp); err != nil {
		return nil, err
	}
	return resp.GetListSessions().GetSessions(), nil
}

// State returns one session's state (and subscribes for its events).
func (c *Control) State(ctx context.Context, sid string) (*wspb.ControlState, error) {
	resp, err := c.call(ctx, &wspb.GetStateCall{Sid: sid})
	if err != nil {
		return nil, err
	}
	if err := result(resp); err != nil {
		return nil, err
	}
	return resp.GetGetState().GetState(), nil
}

// Hydrate returns one session's transcript snapshot (and subscribes).
func (c *Control) Hydrate(ctx context.Context, sid string) (*wspb.TranscriptSnapshot, error) {
	resp, err := c.call(ctx, &wspb.HydrateCall{Sid: sid})
	if err != nil {
		return nil, err
	}
	if err := result(resp); err != nil {
		return nil, err
	}
	return resp.GetHydrate().GetSession(), nil
}

// Prompt submits one user turn. It acks immediately; the answer streams
// as events on Events().
func (c *Control) Prompt(ctx context.Context, sid, message string) error {
	resp, err := c.call(ctx, &wspb.PromptCall{Sid: sid, Message: message})
	if err != nil {
		return err
	}
	if err := result(resp); err != nil {
		return err
	}
	if !resp.GetPrompt().GetAccepted() {
		return errors.New("phi-cmd: prompt not accepted")
	}
	return nil
}

// Models lists the models available to one session.
func (c *Control) Models(ctx context.Context, sid string) ([]*wspb.ModelInfo, error) {
	resp, err := c.call(ctx, &wspb.GetAvailableModelsCall{Sid: sid})
	if err != nil {
		return nil, err
	}
	if err := result(resp); err != nil {
		return nil, err
	}
	return resp.GetGetAvailableModels().GetModels(), nil
}

// SetModel switches a session's model.
func (c *Control) SetModel(ctx context.Context, sid, provider, modelID string) (*wspb.ControlState, error) {
	resp, err := c.call(ctx, &wspb.SetModelCall{Sid: sid, Provider: provider, ModelId: modelID})
	if err != nil {
		return nil, err
	}
	if err := result(resp); err != nil {
		return nil, err
	}
	return resp.GetSetModel().GetState(), nil
}

// ThinkingLevels lists the thinking levels available to one session.
func (c *Control) ThinkingLevels(ctx context.Context, sid string) ([]string, error) {
	resp, err := c.call(ctx, &wspb.GetAvailableThinkingLevelsCall{Sid: sid})
	if err != nil {
		return nil, err
	}
	if err := result(resp); err != nil {
		return nil, err
	}
	return resp.GetGetAvailableThinkingLevels().GetLevels(), nil
}

// SetThinking switches a session's thinking level.
func (c *Control) SetThinking(ctx context.Context, sid, level string) (*wspb.ControlState, error) {
	resp, err := c.call(ctx, &wspb.SetThinkingCall{Sid: sid, Level: level})
	if err != nil {
		return nil, err
	}
	if err := result(resp); err != nil {
		return nil, err
	}
	return resp.GetSetThinking().GetState(), nil
}

// Abort cancels the current turn of one session.
func (c *Control) Abort(ctx context.Context, sid string) error {
	resp, err := c.call(ctx, &wspb.AbortCall{Sid: sid})
	if err != nil {
		return err
	}
	if err := result(resp); err != nil {
		return err
	}
	return nil
}

// SetSessionName renames one session.
func (c *Control) SetSessionName(ctx context.Context, sid, name string) error {
	resp, err := c.call(ctx, &wspb.SetSessionNameCall{Sid: sid, Name: name})
	if err != nil {
		return err
	}
	return result(resp)
}

// JSONString is a small helper for tests and command rendering.
func JSONString(v any) string {
	data, err := json.Marshal(v)
	if err != nil {
		return ""
	}
	return string(data)
}
