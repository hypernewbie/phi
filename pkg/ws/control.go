package ws

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"

	"github.com/hypernewbie/phi/pkg/rpc"
	"github.com/hypernewbie/phi/pkg/session"
)

// ControlOperationTimeout is the one server-side budget for a complete Phi
// control operation, including gate acquisition and every Pi request it owns.
const ControlOperationTimeout = 5 * time.Second

// Envelope is the wire shape of every control frame (both directions).
type Envelope struct {
	Type  string          `json:"t"`
	V     int             `json:"v,omitempty"`
	ID    string          `json:"id,omitempty"`
	Op    string          `json:"op,omitempty"`
	Sid   string          `json:"sid,omitempty"`
	Seq   uint64          `json:"seq,omitempty"`
	Evt   string          `json:"evt,omitempty"`
	Data  json.RawMessage `json:"data,omitempty"`
	Args  json.RawMessage `json:"args,omitempty"`
	Error string          `json:"error,omitempty"`
	Ok    *bool           `json:"ok,omitempty"`
}

// HandleControl returns the /ws/control handler. defaultCwd supplies the
// spawn cwd when a spawn call omits it (main passes activeCWD).
func HandleControl(mgr *rpc.Manager, defaultCwd func() string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		c, err := Upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer c.Close()
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

func decodeStrict(raw json.RawMessage, dst any, allowAbsent bool) error {
	if len(bytes.TrimSpace(raw)) == 0 {
		if allowAbsent {
			return nil
		}
		return errors.New("args are required")
	}
	if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return errors.New("args must be an object")
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(dst); err != nil {
		return fmt.Errorf("invalid args: %w", err)
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		if err == nil {
			return errors.New("invalid args: trailing data")
		}
		return fmt.Errorf("invalid args: %w", err)
	}
	return nil
}

func decodeEmptyArgs(raw json.RawMessage) error {
	var args struct{}
	return decodeStrict(raw, &args, true)
}

func boolPtr(b bool) *bool { return &b }

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

func failedResponse(id string, err error) Envelope {
	return Envelope{Type: rpc.ResFrame, ID: id, Ok: boolPtr(false), Error: controlError(err)}
}

func successfulResponse(id string, payload any) Envelope {
	res := Envelope{Type: rpc.ResFrame, ID: id, Ok: boolPtr(true)}
	if payload != nil {
		res.Data, _ = json.Marshal(payload)
	}
	return res
}

func lookupSid(mgr *rpc.Manager, sid string) (*rpc.Instance, error) {
	if strings.TrimSpace(sid) == "" {
		return nil, errors.New("sid is required")
	}
	return mgr.Lookup(sid)
}

func availableModels(ctx context.Context, inst *rpc.Instance) ([]map[string]string, error) {
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
	models := make([]map[string]string, 0, len(response.Models))
	for _, model := range response.Models {
		if model.Provider == "" || model.ID == "" {
			continue
		}
		item := map[string]string{"provider": model.Provider, "id": model.ID}
		if model.Name != "" {
			item["name"] = model.Name
		}
		models = append(models, item)
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

func resetSession(ctx context.Context, mgr *rpc.Manager, inst *rpc.Instance) (any, error) {
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
	var result struct {
		Cancelled bool `json:"cancelled"`
	}
	if err := json.Unmarshal(data, &result); err != nil {
		return nil, fmt.Errorf("invalid Pi new_session response: %w", err)
	}
	if result.Cancelled {
		return map[string]any{"cancelled": true}, nil
	}

	// Pi has accepted the reset. The old path and transcript are invalid now;
	// the subsequent get_state is allowed to repopulate only a fresh path.
	mgr.UpdateSessionPath(inst, "")
	inst.ResetTranscript()
	fresh, err := refreshState(ctx, inst)
	if err != nil {
		return map[string]any{
			"cancelled":    false,
			"reset":        true,
			"stateWarning": controlError(err),
		}, nil
	}
	return map[string]any{"cancelled": false, "reset": true, "state": fresh}, nil
}

func (s *controlServer) dispatch(ctx context.Context, e Envelope) Envelope {
	if e.Type != rpc.CallFrame {
		return failedResponse(e.ID, errors.New("expected call"))
	}
	var payload any
	var err error
	switch e.Op {
	case rpc.OpSpawn:
		var args struct {
			Cwd         string `json:"cwd"`
			SessionPath string `json:"sessionPath"`
			SpawnID     string `json:"spawnId"`
		}
		if err = decodeStrict(e.Args, &args, true); err != nil {
			break
		}
		cwd := args.Cwd
		if cwd == "" && s.defaultCwd != nil {
			cwd = s.defaultCwd()
		}
		opts, optsErr := piSpawnOptions(cwd, args.SessionPath)
		if optsErr != nil {
			err = optsErr
			break
		}
		opts.SpawnID = args.SpawnID
		lease, beginErr := s.mgr.BeginSpawn(ctx, opts)
		if beginErr != nil {
			err = beginErr
			break
		}
		inst := lease.Instance()
		s.subscribeInstance(inst)
		if lease.Created() {
			_, bootstrapErr := inst.WithControl(ctx, func(requestCtx context.Context) (any, error) {
				for _, command := range []string{"get_state", "get_session_stats", "get_commands"} {
					if _, requestErr := inst.Request(requestCtx, command, nil); requestErr != nil {
						return nil, requestErr
					}
				}
				return nil, nil
			})
			if bootstrapErr != nil {
				_ = s.mgr.FinishSpawn(lease, bootstrapErr)
				err = bootstrapErr
				break
			}
			if finishErr := s.mgr.FinishSpawn(lease, nil); finishErr != nil {
				err = finishErr
				break
			}
		}
		snapshot := inst.SnapshotCopy()
		payload = map[string]any{
			"sid": inst.ID, "title": inst.TitleCopy(), "cwd": inst.Cwd,
			"snapshot": snapshot, "state": inst.StateCopy(),
		}
	case rpc.OpListSessions:
		if err = decodeEmptyArgs(e.Args); err != nil {
			break
		}
		out := []map[string]any{}
		for _, inst := range s.mgr.List() {
			out = append(out, map[string]any{
				"sid": inst.ID, "title": inst.TitleCopy(), "cwd": inst.Cwd,
				"status": inst.StateCopy().Status,
			})
		}
		payload = out
	case rpc.OpSubagentTranscript:
		// Disk-scoped like listSessions: resolves a pi-subagents run from
		// its status.json on disk, no sid ownership involved.
		var args struct {
			RunId string `json:"runId"`
		}
		if err = decodeStrict(e.Args, &args, false); err != nil {
			break
		}
		payload, err = s.mgr.SubagentTranscript(args.RunId)
	case rpc.OpHydrate, rpc.OpGetMessages:
		if err = decodeEmptyArgs(e.Args); err != nil {
			break
		}
		inst, lookupErr := lookupSid(s.mgr, e.Sid)
		if lookupErr != nil {
			err = lookupErr
			break
		}
		s.subscribeInstance(inst)
		snapshot := inst.SnapshotCopy()
		payload = map[string]any{
			"messages": snapshot.Messages, "lastSeq": snapshot.LastSeq,
			"state": inst.StateCopy(), "queue": inst.QueueSnapshotCopy(),
		}
	case rpc.OpGetState:
		if err = decodeEmptyArgs(e.Args); err != nil {
			break
		}
		inst, lookupErr := lookupSid(s.mgr, e.Sid)
		if lookupErr != nil {
			err = lookupErr
			break
		}
		payload = inst.StateCopy()
	case rpc.OpPrompt:
		var args struct {
			Message           string `json:"message"`
			StreamingBehavior string `json:"streamingBehavior"`
		}
		if err = decodeStrict(e.Args, &args, false); err != nil {
			break
		}
		inst, lookupErr := lookupSid(s.mgr, e.Sid)
		if lookupErr != nil {
			err = lookupErr
			break
		}
		prompt := map[string]any{"type": "prompt", "message": args.Message}
		if args.StreamingBehavior != "" {
			prompt["streamingBehavior"] = args.StreamingBehavior
		}
		if err = inst.SendPrompt(prompt); err != nil {
			break
		}
		payload = map[string]any{"accepted": true}
	case rpc.OpQueueSubmit:
		var args struct {
			ItemID         string            `json:"itemId"`
			SessionEpoch   string            `json:"sessionEpoch"`
			Message        string            `json:"message"`
			Delivery       rpc.QueueDelivery `json:"delivery"`
			AttachmentRefs []string          `json:"attachmentRefs"`
		}
		if err = decodeStrict(e.Args, &args, false); err != nil {
			break
		}
		inst, lookupErr := lookupSid(s.mgr, e.Sid)
		if lookupErr != nil {
			err = lookupErr
			break
		}
		var item rpc.QueueItem
		item, err = inst.SubmitQueue(ctx, args.ItemID, args.SessionEpoch, args.Message, args.Delivery, args.AttachmentRefs)
		if err == nil {
			payload = item
		}
	case rpc.OpQueueRestore:
		var args struct {
			ItemID       string `json:"itemId"`
			SessionEpoch string `json:"sessionEpoch"`
		}
		if err = decodeStrict(e.Args, &args, false); err != nil {
			break
		}
		inst, lookupErr := lookupSid(s.mgr, e.Sid)
		if lookupErr != nil {
			err = lookupErr
			break
		}
		payload, err = inst.QueueRestore(args.ItemID, args.SessionEpoch)
	case rpc.OpQueueCopy:
		var args struct {
			ItemID       string `json:"itemId"`
			SessionEpoch string `json:"sessionEpoch"`
		}
		if err = decodeStrict(e.Args, &args, false); err != nil {
			break
		}
		inst, lookupErr := lookupSid(s.mgr, e.Sid)
		if lookupErr != nil {
			err = lookupErr
			break
		}
		payload, err = inst.QueueCopy(args.ItemID, args.SessionEpoch)
	case rpc.OpQueueDiscard:
		var args struct {
			ItemID       string `json:"itemId"`
			SessionEpoch string `json:"sessionEpoch"`
		}
		if err = decodeStrict(e.Args, &args, false); err != nil {
			break
		}
		inst, lookupErr := lookupSid(s.mgr, e.Sid)
		if lookupErr != nil {
			err = lookupErr
			break
		}
		payload, err = inst.QueueDiscard(args.ItemID, args.SessionEpoch)
	case rpc.OpGetAvailableModels:
		if err = decodeEmptyArgs(e.Args); err != nil {
			break
		}
		inst, lookupErr := lookupSid(s.mgr, e.Sid)
		if lookupErr != nil {
			err = lookupErr
			break
		}
		var models []map[string]string
		_, err = inst.WithControl(ctx, func(requestCtx context.Context) (any, error) {
			var requestErr error
			models, requestErr = availableModels(requestCtx, inst)
			return nil, requestErr
		})
		if err == nil {
			payload = map[string]any{"models": models}
		}
	case rpc.OpSetModel:
		var args struct {
			Provider string `json:"provider"`
			ModelID  string `json:"modelId"`
		}
		if err = decodeStrict(e.Args, &args, false); err != nil {
			break
		}
		if args.Provider == "" || args.ModelID == "" {
			err = errors.New("provider and modelId are required")
			break
		}
		inst, lookupErr := lookupSid(s.mgr, e.Sid)
		if lookupErr != nil {
			err = lookupErr
			break
		}
		_, err = inst.WithControl(ctx, func(requestCtx context.Context) (any, error) {
			models, requestErr := availableModels(requestCtx, inst)
			if requestErr != nil {
				return nil, requestErr
			}
			found := false
			for _, model := range models {
				if model["provider"] == args.Provider && model["id"] == args.ModelID {
					found = true
					break
				}
			}
			if !found {
				return nil, errors.New("model is not available in Pi")
			}
			if _, requestErr = inst.Request(requestCtx, "set_model", map[string]any{
				"provider": args.Provider, "modelId": args.ModelID,
			}); requestErr != nil {
				return nil, requestErr
			}
			state, requestErr := refreshState(requestCtx, inst)
			if requestErr != nil {
				return nil, requestErr
			}
			return state, nil
		})
		if err == nil {
			payload = map[string]any{"state": inst.StateCopy()}
		}
	case rpc.OpGetAvailableThinkingLevels:
		if err = decodeEmptyArgs(e.Args); err != nil {
			break
		}
		inst, lookupErr := lookupSid(s.mgr, e.Sid)
		if lookupErr != nil {
			err = lookupErr
			break
		}
		var levels []string
		_, err = inst.WithControl(ctx, func(requestCtx context.Context) (any, error) {
			var requestErr error
			levels, requestErr = availableThinkingLevels(requestCtx, inst)
			return nil, requestErr
		})
		if err == nil {
			payload = map[string]any{"levels": levels}
		}
	case rpc.OpSetThinking:
		var args struct {
			Level string `json:"level"`
		}
		if err = decodeStrict(e.Args, &args, false); err != nil {
			break
		}
		if args.Level == "" {
			err = errors.New("level is required")
			break
		}
		inst, lookupErr := lookupSid(s.mgr, e.Sid)
		if lookupErr != nil {
			err = lookupErr
			break
		}
		_, err = inst.WithControl(ctx, func(requestCtx context.Context) (any, error) {
			levels, requestErr := availableThinkingLevels(requestCtx, inst)
			if requestErr != nil {
				return nil, requestErr
			}
			found := false
			for _, level := range levels {
				if level == args.Level {
					found = true
					break
				}
			}
			if !found {
				return nil, errors.New("thinking level is not available in Pi")
			}
			if _, requestErr = inst.Request(requestCtx, "set_thinking_level", map[string]any{
				"level": args.Level,
			}); requestErr != nil {
				return nil, requestErr
			}
			state, requestErr := refreshState(requestCtx, inst)
			if requestErr != nil {
				return nil, requestErr
			}
			return state, nil
		})
		if err == nil {
			payload = map[string]any{"state": inst.StateCopy()}
		}
	case rpc.OpNewSession:
		if err = decodeEmptyArgs(e.Args); err != nil {
			break
		}
		inst, lookupErr := lookupSid(s.mgr, e.Sid)
		if lookupErr != nil {
			err = lookupErr
			break
		}
		payload, err = inst.WithControl(ctx, func(requestCtx context.Context) (any, error) {
			return resetSession(requestCtx, s.mgr, inst)
		})
	case rpc.OpAbort:
		if err = decodeEmptyArgs(e.Args); err != nil {
			break
		}
		inst, lookupErr := lookupSid(s.mgr, e.Sid)
		if lookupErr != nil {
			err = lookupErr
			break
		}
		_, err = inst.WithControl(ctx, func(requestCtx context.Context) (any, error) {
			_, requestErr := inst.Request(requestCtx, "abort", nil)
			return nil, requestErr
		})
		if err == nil {
			payload = map[string]any{"aborted": true}
		}
	case rpc.OpSetSessionName:
		var args struct {
			Name string `json:"name"`
		}
		if err = decodeStrict(e.Args, &args, false); err != nil {
			break
		}
		name := strings.TrimSpace(args.Name)
		if name == "" {
			err = errors.New("name is required")
			break
		}
		inst, lookupErr := lookupSid(s.mgr, e.Sid)
		if lookupErr != nil {
			err = lookupErr
			break
		}
		_, err = inst.WithControl(ctx, func(requestCtx context.Context) (any, error) {
			if _, requestErr := inst.Request(requestCtx, "set_session_name", map[string]any{
				"name": name,
			}); requestErr != nil {
				return nil, requestErr
			}
			return nil, nil
		})
		if err != nil {
			break
		}
		// Mirror the new name onto the live instance so listSessions and
		// any title observers pick it up immediately; Pi writes the
		// session_info entry itself, which the sidebar re-reads.
		inst.SetTitle(name)
		st := inst.StateCopy()
		st.Title = name
		inst.SetState(st)
		inst.Emit(rpc.EvtStateChanged, nil, st)
		payload = map[string]any{"state": inst.StateCopy()}
	default:
		if isStubbed(e.Op) {
			payload = map[string]any{"stubbed": true}
			break
		}
		err = fmt.Errorf("unknown op: %s", e.Op)
	}
	if err != nil {
		return failedResponse(e.ID, err)
	}
	return successfulResponse(e.ID, payload)
}

type controlServer struct {
	mgr               *rpc.Manager
	defaultCwd        func() string
	subscribeInstance func(*rpc.Instance)
}

type controlCallResult struct {
	response     Envelope
	hydrateSid   string
	hydrateEpoch uint64
}

type hydrateFence struct {
	latest uint64
	queued []rpc.Event
}

func runConn(r *http.Request, c *websocket.Conn, mgr *rpc.Manager, defaultCwd func() string) {
	var hello Envelope
	if err := c.ReadJSON(&hello); err != nil {
		return
	}
	if hello.Type != rpc.HelloFrame || hello.V != rpc.ProtocolVersion {
		ok := false
		_ = c.WriteJSON(Envelope{Type: rpc.ResFrame, Ok: &ok, Error: "expected hello v1"})
		return
	}
	if err := c.WriteJSON(Envelope{Type: rpc.WelcomeFrame, V: rpc.ProtocolVersion}); err != nil {
		return
	}

	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()

	calls := make(chan Envelope, 32)
	go func() {
		defer close(calls)
		defer cancel()
		for {
			var e Envelope
			if err := c.ReadJSON(&e); err != nil {
				return
			}
			select {
			case calls <- e:
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
	write := func(frame Envelope) bool {
		if err := c.WriteJSON(frame); err != nil {
			cancel()
			return false
		}
		return true
	}
	writeEvent := func(ev rpc.Event) bool {
		var data json.RawMessage
		if ev.Data != nil {
			data, _ = json.Marshal(ev.Data)
		}
		return write(Envelope{Type: "evt", Evt: ev.Evt, Sid: ev.Sid, Seq: ev.Seq, Data: data})
	}
	flushFence := func(sid string, epoch uint64) bool {
		fence := fences[sid]
		if fence == nil || fence.latest != epoch {
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
		case e, ok := <-calls:
			if !ok {
				callsOpen = false
				calls = nil
				continue
			}
			if e.Type != rpc.CallFrame {
				if !write(failedResponse(e.ID, errors.New("expected call"))) {
					return
				}
				continue
			}
			epoch := uint64(0)
			if e.Op == rpc.OpHydrate {
				fence := fences[e.Sid]
				if fence == nil {
					fence = &hydrateFence{}
					fences[e.Sid] = fence
				}
				fence.latest++
				epoch = fence.latest
			}
			opCtx, opCancel := context.WithTimeout(ctx, ControlOperationTimeout)
			go func(call Envelope, hydrateEpoch uint64, callCtx context.Context, done context.CancelFunc) {
				defer done()
				response := server.dispatch(callCtx, call)
				result := controlCallResult{response: response, hydrateSid: call.Sid, hydrateEpoch: hydrateEpoch}
				select {
				case results <- result:
				case <-ctx.Done():
				}
			}(e, epoch, opCtx, opCancel)
		case result := <-results:
			if !write(result.response) {
				return
			}
			if result.response.ID == "" || result.hydrateEpoch == 0 {
				continue
			}
			if !flushFence(result.hydrateSid, result.hydrateEpoch) {
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

func isStubbed(op string) bool {
	for _, s := range rpc.P0StubbedFrames {
		if s == op {
			return true
		}
	}
	return false
}
