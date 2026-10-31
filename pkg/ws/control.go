package ws

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
	"github.com/hypernewbie/phi/pkg/session"
	wspb "github.com/hypernewbie/phi/pkg/ws/pb"
	"github.com/hypernewbie/phi/pkg/ws/wireproto"
)

// ControlOperationTimeout is the one server-side budget for a complete Phi
// control operation, including gate acquisition and every Pi request it owns.
const ControlOperationTimeout = 30 * time.Second

// CompactOperationTimeout is the compact budget. Compaction runs a summary
// LLM call; Pi only answers the correlated response when compaction finishes,
// so compact needs its own budget instead of the shared control one.
const CompactOperationTimeout = 10 * time.Minute

// HandleControl returns the /ws/control handler. defaultCwd supplies the
// spawn cwd when a spawn call omits it (main passes activeCWD). hub fences the
// socket to the access generation it was admitted at; nil disables fencing
// (tests).
func HandleControl(hub *Hub, mgr *rpc.Manager, defaultCwd func() string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !wireproto.ClientRequestedSubprotocol(r, wireproto.ControlSubprotocol) {
			http.Error(w, "expected WebSocket subprotocol "+wireproto.ControlSubprotocol, http.StatusUpgradeRequired)
			return
		}
		// Copy the shared upgrader: concurrent upgrades for other endpoints
		// must not observe this endpoint's subprotocol selection.
		upgrader := Upgrader
		upgrader.Subprotocols = []string{wireproto.ControlSubprotocol}
		c, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer c.Close()
		if hub != nil {
			if fence, fenced := AuthFenceFrom(r.Context()); fenced && !hub.AdmitAuth(c, fence) {
				return
			}
			defer hub.ForgetAuth(c)
		}
		// SetReadLimit bounds the compressed wire; ReadBoundedMessage bounds
		// the decompressed body. Both stages are required.
		c.SetReadLimit(wireproto.MaxControlMessageBytes)
		runConn(r, c, mgr, defaultCwd)
	}
}

func piSpawnOptions(cwd, sessionPath string) (rpc.SpawnOptions, error) {
	opts := rpc.SpawnOptions{Cwd: cwd}
	if sessionPath == "" {
		return opts, nil
	}
	envelopes, err := session.GetPiSessionRPCTranscriptForPath(cwd, sessionPath)
	if err != nil {
		return rpc.SpawnOptions{}, err
	}
	initial := make([]rpc.Message, 0, len(envelopes))
	for _, envelope := range envelopes {
		initial = append(initial, rpc.Message{
			Role:       envelope.Role,
			Content:    envelope.Content,
			Details:    envelope.Details,
			ToolCallId: envelope.ToolCallID,
			ToolName:   envelope.ToolName,
			IsError:    envelope.IsError,
		})
	}
	opts.SessionPath = sessionPath
	opts.InitialMessages = initial
	return opts, nil
}

func controlError(err error) string {
	if err == nil {
		return ""
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return "control operation timeout"
	}
	if errors.Is(err, context.Canceled) {
		return "control connection closed"
	}
	return err.Error()
}

func lookupSid(mgr *rpc.Manager, sid string) (*rpc.Instance, error) {
	if strings.TrimSpace(sid) == "" {
		return nil, errors.New("sid is required")
	}
	return mgr.Lookup(sid)
}

func availableModels(ctx context.Context, inst *rpc.Instance) ([]*wspb.ModelInfo, error) {
	data, err := inst.Request(ctx, "get_available_models", nil)
	if err != nil {
		return nil, err
	}
	var response struct {
		Models []struct {
			Provider string `json:"provider"`
			ID       string `json:"id"`
			Name     string `json:"name"`
		} `json:"models"`
	}
	if err := json.Unmarshal(data, &response); err != nil {
		return nil, fmt.Errorf("invalid Pi model list: %w", err)
	}
	models := make([]*wspb.ModelInfo, 0, len(response.Models))
	for _, model := range response.Models {
		if model.Provider == "" || model.ID == "" {
			continue
		}
		models = append(models, &wspb.ModelInfo{
			Provider: model.Provider,
			Id:       model.ID,
			Name:     optionalString(model.Name),
		})
	}
	return models, nil
}

func availableThinkingLevels(ctx context.Context, inst *rpc.Instance) ([]string, error) {
	data, err := inst.Request(ctx, "get_available_thinking_levels", nil)
	if err != nil {
		return nil, err
	}
	var response struct {
		Levels []string `json:"levels"`
	}
	if err := json.Unmarshal(data, &response); err != nil {
		return nil, fmt.Errorf("invalid Pi thinking level list: %w", err)
	}
	return response.Levels, nil
}

func refreshState(ctx context.Context, inst *rpc.Instance) (rpc.State, error) {
	if _, err := inst.Request(ctx, "get_state", nil); err != nil {
		return rpc.State{}, err
	}
	return inst.StateCopy(), nil
}

func resetSession(ctx context.Context, inst *rpc.Instance) (*wspb.NewSessionResult, error) {
	generation := inst.PromptWriteGeneration()
	state, err := refreshState(ctx, inst)
	if err != nil {
		return nil, err
	}
	if state.Busy || state.QueueDepth > 0 {
		return nil, errors.New("Pi session is busy or has queued messages")
	}
	data, err := inst.RequestAfterPromptGeneration(ctx, generation, "new_session", nil)
	if err != nil {
		return nil, err
	}
	cancelled, err := rpc.DecodeNewSessionResult(data)
	if err != nil {
		return nil, fmt.Errorf("invalid Pi new_session response: %w", err)
	}
	if cancelled {
		return &wspb.NewSessionResult{Cancelled: true}, nil
	}

	// The read loop invalidated the old path and transcript at the accepted
	// reset event boundary. The refresh may repopulate only a fresh path.
	fresh, err := refreshState(ctx, inst)
	if err != nil {
		// The reset completed; only the follow-up refresh failed.
		return &wspb.NewSessionResult{
			Cancelled:    false,
			Reset_:       proto.Bool(true),
			StateWarning: optionalString(controlError(err)),
		}, nil
	}
	return &wspb.NewSessionResult{Cancelled: false, Reset_: proto.Bool(true), State: stateToWire(fresh)}, nil
}

type controlServer struct {
	mgr               *rpc.Manager
	defaultCwd        func() string
	subscribeInstance func(*rpc.Instance)
}

// dispatch runs one typed call and attaches the call id. Every known
// operation maps to its own result variant; an unknown or missing variant is
// an error, never an untyped tunnel.
func (s *controlServer) dispatch(ctx context.Context, call *wspb.ControlCall) *wspb.ControlResponse {
	response, err := s.dispatchResult(ctx, call)
	if err != nil {
		response = &wspb.ControlResponse{
			Result: &wspb.ControlResponse_Error{Error: &wspb.ControlError{Reason: controlError(err)}},
		}
	}
	response.Id = call.GetId()
	return response
}

func (s *controlServer) dispatchResult(ctx context.Context, call *wspb.ControlCall) (*wspb.ControlResponse, error) {
	switch payload := call.GetCall().(type) {
	case *wspb.ControlCall_Spawn:
		cwd := payload.Spawn.GetCwd()
		if cwd == "" && s.defaultCwd != nil {
			cwd = s.defaultCwd()
		}
		opts, err := piSpawnOptions(cwd, payload.Spawn.GetSessionPath())
		if err != nil {
			return nil, err
		}
		lease, err := s.mgr.BeginSpawn(ctx, opts)
		if err != nil {
			return nil, err
		}
		inst := lease.Instance()
		s.subscribeInstance(inst)
		if lease.Created() {
			_, err := inst.WithControl(ctx, func(requestCtx context.Context) (any, error) {
				for _, command := range []string{"get_state", "get_session_stats", "get_commands"} {
					if _, requestErr := inst.Request(requestCtx, command, nil); requestErr != nil {
						return nil, requestErr
					}
				}
				return nil, nil
			})
			if err != nil {
				_ = s.mgr.FinishSpawn(lease, err)
				return nil, err
			}
			if err := s.mgr.FinishSpawn(lease, nil); err != nil {
				return nil, err
			}
		}
		snapshot, state := inst.SnapshotStateCopy()
		wireSnapshot, err := snapshotToWire(snapshot)
		if err != nil {
			return nil, err
		}
		return &wspb.ControlResponse{Result: &wspb.ControlResponse_Spawn{Spawn: &wspb.SpawnResult{
			Sid:     inst.ID,
			Title:   state.Title,
			Cwd:     inst.Cwd,
			Session: wireSnapshot,
			State:   stateToWire(state),
		}}}, nil

	case *wspb.ControlCall_ListSessions:
		sessions := []*wspb.SessionSummary{}
		for _, inst := range s.mgr.List() {
			state := inst.StateCopy()
			sessions = append(sessions, &wspb.SessionSummary{
				Sid:    inst.ID,
				Title:  state.Title,
				Cwd:    inst.Cwd,
				Status: state.Status,
			})
		}
		return &wspb.ControlResponse{Result: &wspb.ControlResponse_ListSessions{
			ListSessions: &wspb.ListSessionsResult{Sessions: sessions},
		}}, nil

	case *wspb.ControlCall_SubagentTranscript:
		// Disk-scoped like listSessions: resolves a pi-subagents run from
		// its status.json on disk, no sid ownership involved.
		value, err := s.mgr.SubagentTranscript(payload.SubagentTranscript.GetRunId())
		if err != nil {
			return nil, err
		}
		transcript, err := subagentTranscriptToWire(value)
		if err != nil {
			return nil, err
		}
		return &wspb.ControlResponse{Result: &wspb.ControlResponse_SubagentTranscript{
			SubagentTranscript: transcript,
		}}, nil

	case *wspb.ControlCall_Hydrate:
		return s.transcriptResult(payload.Hydrate.GetSid(), true, false)
	case *wspb.ControlCall_GetMessages:
		// Both transcript reads subscribe: a fresh connection that asks for
		// messages must also receive the events that follow them.
		return s.transcriptResult(payload.GetMessages.GetSid(), true, true)

	case *wspb.ControlCall_GetState:
		inst, err := lookupSid(s.mgr, payload.GetState.GetSid())
		if err != nil {
			return nil, err
		}
		return &wspb.ControlResponse{Result: &wspb.ControlResponse_GetState{
			GetState: &wspb.StateResult{State: stateToWire(inst.StateCopy())},
		}}, nil

	case *wspb.ControlCall_Prompt:
		inst, err := lookupSid(s.mgr, payload.Prompt.GetSid())
		if err != nil {
			return nil, err
		}
		prompt := map[string]any{"type": "prompt", "message": payload.Prompt.GetMessage()}
		if behavior := payload.Prompt.GetStreamingBehavior(); behavior != "" {
			prompt["streamingBehavior"] = behavior
		}
		if err := inst.SendPrompt(prompt); err != nil {
			return nil, err
		}
		return &wspb.ControlResponse{Result: &wspb.ControlResponse_Prompt{
			Prompt: &wspb.PromptResult{Accepted: true},
		}}, nil

	case *wspb.ControlCall_GetAvailableModels:
		inst, err := lookupSid(s.mgr, payload.GetAvailableModels.GetSid())
		if err != nil {
			return nil, err
		}
		var models []*wspb.ModelInfo
		_, err = inst.WithControl(ctx, func(requestCtx context.Context) (any, error) {
			var requestErr error
			models, requestErr = availableModels(requestCtx, inst)
			return nil, requestErr
		})
		if err != nil {
			return nil, err
		}
		return &wspb.ControlResponse{Result: &wspb.ControlResponse_GetAvailableModels{
			GetAvailableModels: &wspb.ModelsResult{Models: models},
		}}, nil

	case *wspb.ControlCall_SetModel:
		provider, modelID := payload.SetModel.GetProvider(), payload.SetModel.GetModelId()
		if provider == "" || modelID == "" {
			return nil, errors.New("provider and modelId are required")
		}
		inst, err := lookupSid(s.mgr, payload.SetModel.GetSid())
		if err != nil {
			return nil, err
		}
		_, err = inst.WithControl(ctx, func(requestCtx context.Context) (any, error) {
			models, requestErr := availableModels(requestCtx, inst)
			if requestErr != nil {
				return nil, requestErr
			}
			found := false
			for _, model := range models {
				if model.GetProvider() == provider && model.GetId() == modelID {
					found = true
					break
				}
			}
			if !found {
				return nil, errors.New("model is not available in Pi")
			}
			if _, requestErr = inst.Request(requestCtx, "set_model", map[string]any{
				"provider": provider, "modelId": modelID,
			}); requestErr != nil {
				return nil, requestErr
			}
			_, requestErr = refreshState(requestCtx, inst)
			return nil, requestErr
		})
		if err != nil {
			return nil, err
		}
		return &wspb.ControlResponse{Result: &wspb.ControlResponse_SetModel{
			SetModel: &wspb.StateResult{State: stateToWire(inst.StateCopy())},
		}}, nil

	case *wspb.ControlCall_GetAvailableThinkingLevels:
		inst, err := lookupSid(s.mgr, payload.GetAvailableThinkingLevels.GetSid())
		if err != nil {
			return nil, err
		}
		var levels []string
		_, err = inst.WithControl(ctx, func(requestCtx context.Context) (any, error) {
			var requestErr error
			levels, requestErr = availableThinkingLevels(requestCtx, inst)
			return nil, requestErr
		})
		if err != nil {
			return nil, err
		}
		return &wspb.ControlResponse{Result: &wspb.ControlResponse_GetAvailableThinkingLevels{
			GetAvailableThinkingLevels: &wspb.ThinkingLevelsResult{Levels: levels},
		}}, nil

	case *wspb.ControlCall_SetThinking:
		level := payload.SetThinking.GetLevel()
		if level == "" {
			return nil, errors.New("level is required")
		}
		inst, err := lookupSid(s.mgr, payload.SetThinking.GetSid())
		if err != nil {
			return nil, err
		}
		_, err = inst.WithControl(ctx, func(requestCtx context.Context) (any, error) {
			levels, requestErr := availableThinkingLevels(requestCtx, inst)
			if requestErr != nil {
				return nil, requestErr
			}
			found := false
			for _, candidate := range levels {
				if candidate == level {
					found = true
					break
				}
			}
			if !found {
				return nil, errors.New("thinking level is not available in Pi")
			}
			if _, requestErr = inst.Request(requestCtx, "set_thinking_level", map[string]any{
				"level": level,
			}); requestErr != nil {
				return nil, requestErr
			}
			_, requestErr = refreshState(requestCtx, inst)
			return nil, requestErr
		})
		if err != nil {
			return nil, err
		}
		return &wspb.ControlResponse{Result: &wspb.ControlResponse_SetThinking{
			SetThinking: &wspb.StateResult{State: stateToWire(inst.StateCopy())},
		}}, nil

	case *wspb.ControlCall_NewSession:
		inst, err := lookupSid(s.mgr, payload.NewSession.GetSid())
		if err != nil {
			return nil, err
		}
		var result *wspb.NewSessionResult
		_, err = inst.WithControl(ctx, func(requestCtx context.Context) (any, error) {
			var requestErr error
			result, requestErr = resetSession(requestCtx, inst)
			return nil, requestErr
		})
		if err != nil {
			return nil, err
		}
		return &wspb.ControlResponse{Result: &wspb.ControlResponse_NewSession{NewSession: result}}, nil

	case *wspb.ControlCall_Abort:
		inst, err := lookupSid(s.mgr, payload.Abort.GetSid())
		if err != nil {
			return nil, err
		}
		// Abort bypasses the control gate: it must stay available while a
		// long-running operation (e.g. compact) holds the gate for minutes.
		if _, err := inst.Request(ctx, "abort", nil); err != nil {
			return nil, err
		}
		return &wspb.ControlResponse{Result: &wspb.ControlResponse_Abort{
			Abort: &wspb.AbortResult{Aborted: true},
		}}, nil

	case *wspb.ControlCall_Compact:
		inst, err := lookupSid(s.mgr, payload.Compact.GetSid())
		if err != nil {
			return nil, err
		}
		var warning string
		_, err = inst.WithControl(ctx, func(requestCtx context.Context) (any, error) {
			if _, requestErr := inst.Request(requestCtx, "compact", nil); requestErr != nil {
				return nil, requestErr
			}
			// Compaction already completed; a refresh failure must not report
			// the whole operation as failed, or the UI invites a second compact.
			if _, refreshErr := refreshState(requestCtx, inst); refreshErr != nil {
				warning = controlError(refreshErr)
			}
			return nil, nil
		})
		if err != nil {
			return nil, err
		}
		return &wspb.ControlResponse{Result: &wspb.ControlResponse_Compact{Compact: &wspb.CompactResult{
			State:        stateToWire(inst.StateCopy()),
			StateWarning: optionalString(warning),
		}}}, nil

	case *wspb.ControlCall_SetSessionName:
		name := strings.TrimSpace(payload.SetSessionName.GetName())
		if name == "" {
			return nil, errors.New("name is required")
		}
		inst, err := lookupSid(s.mgr, payload.SetSessionName.GetSid())
		if err != nil {
			return nil, err
		}
		var state rpc.State
		_, err = inst.WithControl(ctx, func(requestCtx context.Context) (any, error) {
			if _, requestErr := inst.Request(requestCtx, "set_session_name", map[string]any{"name": name}); requestErr != nil {
				return nil, requestErr
			}
			// Pi's session_info_changed event owns the title update.
			state = inst.StateCopy()
			return nil, nil
		})
		if err != nil {
			return nil, err
		}
		return &wspb.ControlResponse{Result: &wspb.ControlResponse_SetSessionName{
			SetSessionName: &wspb.StateResult{State: stateToWire(state)},
		}}, nil

	// The six accepted no-ops keep explicit variants and answer with a
	// typed stub result.
	case *wspb.ControlCall_ViewReady:
		return &wspb.ControlResponse{Result: &wspb.ControlResponse_ViewReady{
			ViewReady: &wspb.StubResult{Stubbed: true},
		}}, nil
	case *wspb.ControlCall_SetCapabilities:
		return &wspb.ControlResponse{Result: &wspb.ControlResponse_SetCapabilities{
			SetCapabilities: &wspb.StubResult{Stubbed: true},
		}}, nil
	case *wspb.ControlCall_WaitViewReady:
		return &wspb.ControlResponse{Result: &wspb.ControlResponse_WaitViewReady{
			WaitViewReady: &wspb.StubResult{Stubbed: true},
		}}, nil
	case *wspb.ControlCall_Dlg:
		return &wspb.ControlResponse{Result: &wspb.ControlResponse_Dlg{
			Dlg: &wspb.StubResult{Stubbed: true},
		}}, nil
	case *wspb.ControlCall_DlgClosed:
		return &wspb.ControlResponse{Result: &wspb.ControlResponse_DlgClosed{
			DlgClosed: &wspb.StubResult{Stubbed: true},
		}}, nil
	case *wspb.ControlCall_ActivateTab:
		return &wspb.ControlResponse{Result: &wspb.ControlResponse_ActivateTab{
			ActivateTab: &wspb.StubResult{Stubbed: true},
		}}, nil

	default:
		return nil, fmt.Errorf("unknown control call variant %T", call.GetCall())
	}
}

// transcriptResult serves hydrate and getMessages from one snapshot. Both
// subscribe; only hydrate participates in the hydrate fence.
func (s *controlServer) transcriptResult(sid string, subscribe, getMessages bool) (*wspb.ControlResponse, error) {
	inst, err := lookupSid(s.mgr, sid)
	if err != nil {
		return nil, err
	}
	if subscribe {
		s.subscribeInstance(inst)
	}
	snapshotCopy, state := inst.SnapshotStateCopy()
	snapshot, err := snapshotToWire(snapshotCopy)
	if err != nil {
		return nil, err
	}
	snapshot.State = stateToWire(state)
	if getMessages {
		return &wspb.ControlResponse{Result: &wspb.ControlResponse_GetMessages{
			GetMessages: &wspb.TranscriptResult{Session: snapshot},
		}}, nil
	}
	return &wspb.ControlResponse{Result: &wspb.ControlResponse_Hydrate{
		Hydrate: &wspb.TranscriptResult{Session: snapshot},
	}}, nil
}

type controlCallResult struct {
	response     *wspb.ControlResponse
	hydrateSid   string
	hydrateEpoch uint64
}

type hydrateFence struct {
	latest       uint64
	nextResponse uint64
	responses    map[uint64]*wspb.ControlResponse
	queued       []rpc.Event
}

// controlConn owns the control socket's write side. Gorilla allows one
// concurrent writer plus WriteControl, which is what failure paths use.
type controlConn struct {
	conn *websocket.Conn
	once sync.Once
}

// encode marshals one server frame without touching the socket, so a
// conversion failure cannot be mistaken for a write failure.
func (c *controlConn) encode(frame *wspb.ControlServerFrame) ([]byte, error) {
	return proto.Marshal(frame)
}

func (c *controlConn) writeRaw(data []byte) error {
	return c.conn.WriteMessage(websocket.BinaryMessage, data)
}

func (c *controlConn) send(frame *wspb.ControlServerFrame) error {
	data, err := c.encode(frame)
	if err != nil {
		return err
	}
	return c.writeRaw(data)
}

// encodeResponseFrame marshals one response frame. A response whose typed
// result cannot be encoded (for example a string that is not valid UTF-8)
// still gets a correlated error frame with the same call id, so the caller
// never loses its answer.
func encodeResponseFrame(response *wspb.ControlResponse) ([]byte, error) {
	data, err := proto.Marshal(&wspb.ControlServerFrame{
		Payload: &wspb.ControlServerFrame_Response{Response: response},
	})
	if err == nil {
		return data, nil
	}
	return proto.Marshal(&wspb.ControlServerFrame{
		Payload: &wspb.ControlServerFrame_Response{Response: &wspb.ControlResponse{
			Id:     response.GetId(),
			Result: &wspb.ControlResponse_Error{Error: &wspb.ControlError{Reason: "result encoding failed"}},
		}},
	})
}

// close writes one bounded close frame. Later calls are ignored.
func (c *controlConn) close(code int, reason string) {
	c.once.Do(func() {
		_ = c.conn.WriteControl(
			websocket.CloseMessage,
			websocket.FormatCloseMessage(code, reason),
			time.Now().Add(time.Second),
		)
	})
}

func runConn(r *http.Request, c *websocket.Conn, mgr *rpc.Manager, defaultCwd func() string) {
	conn := &controlConn{conn: c}

	// Admission is already enforced by the handler; the first application
	// message must still be a hello with the current protocol version.
	mt, raw, err := wireproto.ReadBoundedMessage(c, wireproto.MaxControlMessageBytes)
	if err != nil {
		conn.close(controlCloseCode(err), "read failed")
		return
	}
	// The control endpoint is binary-only. A text frame must never reach
	// protobuf decoding, even when its bytes happen to be a valid frame.
	if mt != websocket.BinaryMessage {
		conn.close(websocket.CloseProtocolError, "text frame not allowed")
		return
	}
	frame := &wspb.ControlClientFrame{}
	if err := wireproto.DecodeControlClientFrame(raw, frame); err != nil {
		conn.close(websocket.CloseProtocolError, "invalid frame")
		return
	}
	if hello := frame.GetHello(); hello == nil || hello.GetVersion() != uint32(rpc.ProtocolVersion) {
		conn.close(websocket.CloseProtocolError, "expected hello v1")
		return
	}
	if err := conn.send(&wspb.ControlServerFrame{Payload: &wspb.ControlServerFrame_Welcome{
		Welcome: &wspb.ControlWelcome{Version: uint32(rpc.ProtocolVersion)},
	}}); err != nil {
		return
	}

	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()

	calls := make(chan *wspb.ControlCall, 32)
	go func() {
		defer close(calls)
		defer cancel()
		for {
			mt, raw, err := wireproto.ReadBoundedMessage(c, wireproto.MaxControlMessageBytes)
			if err != nil {
				if errors.Is(err, wireproto.ErrMessageTooLarge) {
					conn.close(websocket.CloseMessageTooBig, "control message too large")
				}
				return
			}
			if mt != websocket.BinaryMessage {
				conn.close(websocket.CloseProtocolError, "text frame not allowed")
				return
			}
			frame := &wspb.ControlClientFrame{}
			if err := wireproto.DecodeControlClientFrame(raw, frame); err != nil {
				conn.close(websocket.CloseProtocolError, "invalid frame")
				return
			}
			call := frame.GetCall()
			if call == nil {
				conn.close(websocket.CloseProtocolError, "expected call")
				return
			}
			select {
			case calls <- call:
			case <-ctx.Done():
				return
			}
		}
	}()

	merge := make(chan rpc.Event, 256)
	var subMu sync.Mutex
	subs := map[string]*rpc.Subscriber{}
	server := &controlServer{mgr: mgr, defaultCwd: defaultCwd}
	server.subscribeInstance = func(inst *rpc.Instance) {
		if inst == nil || ctx.Err() != nil {
			return
		}
		sid := inst.ID
		subMu.Lock()
		if _, ok := subs[sid]; ok {
			subMu.Unlock()
			return
		}
		sub := mgr.Subscribe(inst)
		if sub == nil {
			subMu.Unlock()
			return
		}
		subs[sid] = sub
		subMu.Unlock()
		go func() {
			for ev := range sub.Channel() {
				select {
				case merge <- ev:
				case <-ctx.Done():
					return
				}
			}
		}()
	}
	defer func() {
		subMu.Lock()
		for _, sub := range subs {
			sub.CloseThis()
		}
		subMu.Unlock()
	}()

	results := make(chan controlCallResult, 32)
	fences := map[string]*hydrateFence{}
	callsOpen := true
	// write answers one call. A response that cannot be encoded still gets a
	// correlated error instead of a silent disconnect; only a failed write
	// ends the stream.
	write := func(response *wspb.ControlResponse) bool {
		data, err := encodeResponseFrame(response)
		if err != nil {
			cancel()
			return false
		}
		if err := conn.writeRaw(data); err != nil {
			cancel()
			return false
		}
		return true
	}
	writeEvent := func(ev rpc.Event) bool {
		event, err := eventToWire(ev)
		if err != nil {
			// A refused event stops the stream instead of skipping the event
			// or advancing past it.
			conn.close(websocket.CloseInternalServerErr, "event conversion failed")
			cancel()
			return false
		}
		// Encode before writing: an encoding failure is a conversion failure
		// and must close with 1011, not look like a dead socket.
		data, err := conn.encode(&wspb.ControlServerFrame{Payload: &wspb.ControlServerFrame_Event{Event: event}})
		if err != nil {
			conn.close(websocket.CloseInternalServerErr, "event encoding failed")
			cancel()
			return false
		}
		if err := conn.writeRaw(data); err != nil {
			cancel()
			return false
		}
		return true
	}
	flushFence := func(sid string) bool {
		fence := fences[sid]
		if fence == nil {
			return false
		}
		for {
			response, ok := fence.responses[fence.nextResponse]
			if !ok {
				break
			}
			delete(fence.responses, fence.nextResponse)
			if !write(response) {
				return false
			}
			fence.nextResponse++
		}
		if fence.nextResponse <= fence.latest {
			return true
		}
		for _, ev := range fence.queued {
			if !writeEvent(ev) {
				return false
			}
		}
		delete(fences, sid)
		return true
	}

	for {
		select {
		case <-ctx.Done():
			return
		case call, ok := <-calls:
			if !ok {
				callsOpen = false
				calls = nil
				continue
			}
			epoch := uint64(0)
			sid := ""
			if hydrate := call.GetHydrate(); hydrate != nil {
				sid = hydrate.GetSid()
				fence := fences[sid]
				if fence == nil {
					fence = &hydrateFence{
						nextResponse: 1,
						responses:    make(map[uint64]*wspb.ControlResponse),
					}
					fences[sid] = fence
				}
				fence.latest++
				epoch = fence.latest
			}
			opCtx, opCancel := context.WithTimeout(ctx, operationBudget(call))
			go func(call *wspb.ControlCall, hydrateSid string, hydrateEpoch uint64, callCtx context.Context, done context.CancelFunc) {
				defer done()
				response := server.dispatch(callCtx, call)
				result := controlCallResult{response: response, hydrateSid: hydrateSid, hydrateEpoch: hydrateEpoch}
				select {
				case results <- result:
				case <-ctx.Done():
				}
			}(call, sid, epoch, opCtx, opCancel)
		case result := <-results:
			if result.response.GetId() == "" || result.hydrateEpoch == 0 {
				if !write(result.response) {
					return
				}
				continue
			}
			fence := fences[result.hydrateSid]
			if fence == nil {
				if !write(result.response) {
					return
				}
				continue
			}
			fence.responses[result.hydrateEpoch] = result.response
			if !flushFence(result.hydrateSid) {
				return
			}
		case ev := <-merge:
			if fence := fences[ev.Sid]; fence != nil {
				fence.queued = append(fence.queued, ev)
				continue
			}
			if !writeEvent(ev) {
				return
			}
		}
		if !callsOpen && len(results) == 0 && len(merge) == 0 {
			return
		}
	}
}

// operationBudget is the one per-call deadline selection: compaction runs a
// summary through Pi and gets the long budget, every other operation uses
// the short one. Abort does not take the control gate, so a compact in
// flight never starves it.
func operationBudget(call *wspb.ControlCall) time.Duration {
	if call.GetCompact() != nil {
		return CompactOperationTimeout
	}
	return ControlOperationTimeout
}

// controlCloseCode maps a read failure to the close code peers expect.
func controlCloseCode(err error) int {
	if errors.Is(err, wireproto.ErrMessageTooLarge) {
		return websocket.CloseMessageTooBig
	}
	return websocket.CloseProtocolError
}
