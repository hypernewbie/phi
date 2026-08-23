package rpc

import (
	"context"
	"encoding/json"
	"strings"
	"time"
)

// piEvent is the shape of every pi stdout line (subset).
type piEvent struct {
	Type    string          `json:"type"`
	Message json.RawMessage `json:"message"`
}

type piResponse struct {
	ID      string          `json:"id"`
	Command string          `json:"command"`
	Success bool            `json:"success"`
	Data    json.RawMessage `json:"data"`
	Error   string          `json:"error"`
}

type getStateMetadata struct {
	state          State
	sessionFile    string
	sessionID      string
	sessionFileSet bool
	sessionIDSet   bool
}

func parseGetState(data json.RawMessage, current State) (getStateMetadata, bool) {
	var value struct {
		Model *struct {
			Name string `json:"name"`
			ID   string `json:"id"`
		} `json:"model"`
		ThinkingLevel       *string `json:"thinkingLevel"`
		IsStreaming         *bool   `json:"isStreaming"`
		IsCompacting        *bool   `json:"isCompacting"`
		PendingMessageCount *int    `json:"pendingMessageCount"`
		SessionFile         *string `json:"sessionFile"`
		SessionID           *string `json:"sessionId"`
	}
	if err := json.Unmarshal(data, &value); err != nil {
		return getStateMetadata{}, false
	}
	st := current
	if value.Model != nil {
		if value.Model.Name != "" {
			st.Model = value.Model.Name
		} else if value.Model.ID != "" {
			st.Model = value.Model.ID
		}
	}
	if value.ThinkingLevel != nil {
		st.Thinking = *value.ThinkingLevel
	}
	if value.IsStreaming != nil || value.IsCompacting != nil {
		streaming := st.Busy
		compacting := false
		if value.IsStreaming != nil {
			streaming = *value.IsStreaming
		}
		if value.IsCompacting != nil {
			compacting = *value.IsCompacting
		}
		st.Busy = st.Busy || streaming || compacting
	}
	if value.PendingMessageCount != nil {
		st.QueueDepth = *value.PendingMessageCount
		if st.QueueDepth < 0 {
			st.QueueDepth = 0
		}
	}
	if value.SessionFile != nil {
		stMeta := *value.SessionFile
		return getStateMetadata{
			state:          st,
			sessionFile:    stMeta,
			sessionID:      valueString(value.SessionID),
			sessionFileSet: true,
			sessionIDSet:   value.SessionID != nil,
		}, true
	}
	return getStateMetadata{
		state:          st,
		sessionID:      valueString(value.SessionID),
		sessionFileSet: false,
		sessionIDSet:   value.SessionID != nil,
	}, true
}

func valueString(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

func mergeStatsMetadata(inst *Instance, resp piResponse) bool {
	var data struct {
		Tokens struct {
			Input      *int64 `json:"input"`
			Output     *int64 `json:"output"`
			CacheRead  *int64 `json:"cacheRead"`
			CacheWrite *int64 `json:"cacheWrite"`
		} `json:"tokens"`
		ContextUsage *struct {
			Tokens        *int64 `json:"tokens"`
			ContextWindow *int64 `json:"contextWindow"`
		} `json:"contextUsage"`
	}
	if err := json.Unmarshal(resp.Data, &data); err != nil {
		return false
	}
	st := inst.StateCopy()
	st.InputTokens = data.Tokens.Input
	st.OutputTokens = data.Tokens.Output
	st.CacheReadTokens = data.Tokens.CacheRead
	st.CacheWriteTokens = data.Tokens.CacheWrite
	st.ContextUsedTokens = nil
	st.ContextWindowTokens = nil
	if data.ContextUsage != nil {
		st.ContextUsedTokens = data.ContextUsage.Tokens
		st.ContextWindowTokens = data.ContextUsage.ContextWindow
	}
	inst.SetState(st)
	inst.Emit(EvtStateChanged, nil, st)
	return true
}

func mergeCommandsMetadata(inst *Instance, resp piResponse) bool {
	var data struct {
		Commands []struct {
			Source string `json:"source"`
			Name   string `json:"name"`
		} `json:"commands"`
	}
	if err := json.Unmarshal(resp.Data, &data); err != nil {
		return false
	}
	skills := make([]string, 0)
	seen := make(map[string]struct{})
	for _, command := range data.Commands {
		if command.Source != "skill" || command.Name == "" {
			continue
		}
		if _, ok := seen[command.Name]; ok {
			continue
		}
		seen[command.Name] = struct{}{}
		skills = append(skills, command.Name)
	}
	st := inst.StateCopy()
	st.Skills = skills
	inst.SetState(st)
	inst.Emit(EvtStateChanged, nil, st)
	return true
}

func applyPiMetadata(inst *Instance, resp piResponse) getStateMetadata {
	if resp.Command == "get_state" {
		metadata, ok := parseGetState(resp.Data, inst.StateCopy())
		if !ok {
			return getStateMetadata{}
		}
		inst.SetState(metadata.state)
		inst.Emit(EvtStateChanged, nil, metadata.state)
		return metadata
	}
	switch resp.Command {
	case "get_session_stats":
		mergeStatsMetadata(inst, resp)
	case "get_commands":
		mergeCommandsMetadata(inst, resp)
	}
	return getStateMetadata{}
}

// mergePiMetadata retains the package-local metadata helper used by focused
// wire tests. Manager response handling additionally updates session ownership.
func mergePiMetadata(inst *Instance, resp piResponse) {
	applyPiMetadata(inst, resp)
}

func (m *Manager) applyPiResponse(inst *Instance, resp piResponse) {
	metadata := applyPiMetadata(inst, resp)
	if resp.Command == "get_state" && metadata.sessionFileSet {
		m.UpdateSessionPath(inst, metadata.sessionFile)
	}
}

func publishPiRejection(inst *Instance, resp piResponse) {
	msg := "pi rejected " + resp.Command
	if resp.Error != "" {
		msg = "pi: " + resp.Error
	}
	inst.Emit(EvtStateChanged, nil, map[string]any{"error": msg})
}

// readLoop parses the child's JSONL stdout into sequenced events until EOF.
func (m *Manager) readLoop(inst *Instance) {
	for {
		line, ok, err := inst.sc.Next()
		if err != nil {
			m.handleExit(inst, "readError")
			return
		}
		if !ok {
			m.handleExit(inst, "exit")
			return
		}
		if len(line) == 0 {
			continue
		}
		var ev piEvent
		if err := json.Unmarshal(line, &ev); err != nil {
			continue // non-JSON noise on stdout: skip, never crash the loop
		}
		m.handlePiEvent(inst, line, ev)
	}
}

var piEvtToPhi = map[string]string{
	"message_start":                 EvtMessageStart,
	"message_update":                EvtMessageUpdate,
	"message_end":                   EvtMessageEnd,
	"auto_retry_start":              EvtAutoRetryStart,
	"auto_retry_end":                EvtAutoRetryEnd,
	"compaction_end":                EvtCompactionEnd,
	"extension_error":               EvtExtensionError,
	"summarization_retry_scheduled": EvtSummarizationRetryScheduled,
	"summarization_retry_finished":  EvtSummarizationRetryFinished,
}

func (m *Manager) handlePiEvent(inst *Instance, line []byte, ev piEvent) {
	switch ev.Type {
	case "message_start", "message_update":
		// Raw passthrough: message_update's assistantMessageEvent deltas are not
		// captured by piEvent; the raw line IS the payload. Copy because line
		// aliases LineScanner's reusable buffer and is overwritten by the next
		// Scan; json.Unmarshal would copy elsewhere but we don't unmarshal here.
		payload := append([]byte(nil), line...)
		inst.Emit(piEvtToPhi[ev.Type], nil, json.RawMessage(payload))
	case "message_end":
		var probe struct {
			Role         string          `json:"role"`
			Content      json.RawMessage `json:"content"`
			Details      json.RawMessage `json:"details"`
			ToolCallId   string          `json:"toolCallId"`
			ToolName     string          `json:"toolName"`
			IsError      *bool           `json:"isError"`
			StopReason   string          `json:"stopReason"`
			ErrorMessage string          `json:"errorMessage"`
		}
		_ = json.Unmarshal(ev.Message, &probe)
		msg := Message{
			Role:         probe.Role,
			Content:      probe.Content,
			Details:      probe.Details,
			ToolCallId:   probe.ToolCallId,
			ToolName:     probe.ToolName,
			IsError:      probe.IsError,
			StopReason:   probe.StopReason,
			ErrorMessage: probe.ErrorMessage,
		}
		// Data carries the authoritative message (rpc.md: message_end.message).
		inst.Emit(EvtMessageEnd, &msg, map[string]any{"message": ev.Message})
	case "response":
		var resp piResponse
		if err := json.Unmarshal(line, &resp); err != nil || resp.ID == "" {
			return
		}
		waiter := inst.claimWaiter(resp.ID)
		if waiter == nil {
			return
		}
		if resp.Success {
			// Correlated callers only complete after metadata and session ownership
			// have been made visible to StateCopy/SnapshotCopy subscribers.
			m.applyPiResponse(inst, resp)
		} else {
			publishPiRejection(inst, resp)
		}
		waiter.result <- pendingResult{response: resp}
	case "agent_start":
		st := inst.StateCopy()
		if !st.Busy {
			st.Busy = true
			inst.SetState(st)
			inst.Emit(EvtStateChanged, nil, st)
		}
	case "agent_end":
		// Pi's settled event, not agent_end, owns the end of the active turn.
	case "agent_settled":
		st := inst.StateCopy()
		if st.Busy {
			st.Busy = false
			inst.SetState(st)
			inst.Emit(EvtStateChanged, nil, st)
		}
		go func() {
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			_, _ = inst.Request(ctx, "get_session_stats", nil)
		}()
	case "compaction_start":
		st := inst.StateCopy()
		if !st.Busy {
			st.Busy = true
			inst.SetState(st)
			inst.Emit(EvtStateChanged, nil, st)
		}
	case "compaction_end":
		// Compaction is still part of the active turn until Pi settles.
		// Order matters: the chat-pi client uses the EvtCompactionEnd
		// payload to surface error/aborted UIs (status bar text,
		// ephemeral red row); emitting it BEFORE ResetTranscript lets
		// the client render against the pre-reset state and avoids the
		// post-reset-hydrate double-application race. EvtCompactionEnd
		// is raw passthrough — msg=nil, snapshot untouched — and the
		// snapshot is only cleared by ResetTranscript immediately
		// after.
		payload := append([]byte(nil), line...)
		inst.Emit(EvtCompactionEnd, nil, json.RawMessage(payload))
		inst.ResetTranscript()
	case "auto_retry_start", "auto_retry_end", "extension_error",
		"summarization_retry_scheduled", "summarization_retry_finished":
		// Raw passthrough: the chat-pi client owns all rendering for
		// these error/control surfaces (retry indicator, status bar
		// text, ephemeral row). We only forward the original JSONL
		// line so the client can read whichever fields pi sends
		// (attempt/maxAttempts, success/finalError, error, etc.).
		// Copy the buffer because line aliases LineScanner's reusable
		// slice and is overwritten by the next Scan.
		payload := append([]byte(nil), line...)
		inst.Emit(piEvtToPhi[ev.Type], nil, json.RawMessage(payload))
	case "extension_ui_request":
		// pi-subagents drives its TUI fleet strip through setWidget on the
		// extension UI channel. Only the "subagent-async" widget is ours:
		// everything else on this channel (dialog select/confirm prompts,
		// other extension widgets) is intentionally ignored so dialogs keep
		// working. Fire-and-forget mapping to a sequenced event: msg is nil,
		// the hydrate snapshot is untouched. pi's rpc-mode serializes
		// setWidget(key, undefined) with widgetLines dropped by JSON.stringify,
		// so a missing, empty, or [""] widgetLines all mean "widget cleared"
		// and emit nil data so the browser hides the strip. The payload is
		// re-derived from the decoded WidgetLines string, never sliced from
		// line — the scanner reuses that buffer.
		var req struct {
			Method      string   `json:"method"`
			WidgetKey   string   `json:"widgetKey"`
			WidgetLines []string `json:"widgetLines"`
		}
		if err := json.Unmarshal(line, &req); err != nil {
			return
		}
		if req.Method != "setWidget" || req.WidgetKey != "subagent-async" {
			return
		}
		if len(req.WidgetLines) == 0 || req.WidgetLines[0] == "" {
			inst.Emit(EvtSubagentFleet, nil, nil)
			return
		}
		const prefix = "PI_SUBAGENT_ASYNC_JSON:"
		if !strings.HasPrefix(req.WidgetLines[0], prefix) {
			return
		}
		remainder := json.RawMessage(req.WidgetLines[0][len(prefix):])
		if json.Valid(remainder) {
			inst.Emit(EvtSubagentFleet, nil, remainder)
		}
	default:
		// Unknown pi events are ignored.
	}
}
