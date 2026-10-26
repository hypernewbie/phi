package ws

// Control wire conversion (phi.websocket.control.v1).
//
// Phi-owned values (state, transcript metadata, event metadata) convert to
// typed fields. Open-ended Pi, tool, provider, and extension data converts
// to ExternalValue. JSON decoding happens only at the Pi JSONL adapter
// boundary; these adapters read the already-decoded payloads rpc publishes.

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"sort"

	"google.golang.org/protobuf/proto"

	"github.com/hypernewbie/phi/pkg/rpc"
	"github.com/hypernewbie/phi/pkg/session"
	wspb "github.com/hypernewbie/phi/pkg/ws/pb"
)

// External-value bounds. Count the root value as depth 1 and one node;
// count every scalar, list element, and object field once.
const (
	maxExternalDepth = 24
	maxExternalNodes = 100000
)

var errExternalBound = errors.New("external value exceeds bound")

func stateToWire(st rpc.State) *wspb.ControlState {
	return &wspb.ControlState{
		Sid:                 st.Sid,
		Title:               st.Title,
		Cwd:                 st.Cwd,
		Model:               optionalString(st.Model),
		Thinking:            optionalString(st.Thinking),
		InputTokens:         optionalInt64(st.InputTokens),
		OutputTokens:        optionalInt64(st.OutputTokens),
		ContextUsedTokens:   optionalInt64(st.ContextUsedTokens),
		ContextWindowTokens: optionalInt64(st.ContextWindowTokens),
		CacheReadTokens:     optionalInt64(st.CacheReadTokens),
		CacheWriteTokens:    optionalInt64(st.CacheWriteTokens),
		Skills:              st.Skills,
		Busy:                st.Busy,
		Status:              st.Status,
		QueueDepth:          uint32(st.QueueDepth),
		SessionPath:         optionalString(st.SessionPath),
	}
}

func optionalString(v string) *string {
	if v == "" {
		return nil
	}
	return &v
}

func optionalInt64(v *int64) *int64 {
	if v == nil {
		return nil
	}
	copied := *v
	return &copied
}

func messageToWire(m rpc.Message) (*wspb.Message, error) {
	content, err := externalFromJSON(m.Content)
	if err != nil {
		return nil, fmt.Errorf("message content: %w", err)
	}
	details, err := externalFromJSON(m.Details)
	if err != nil {
		return nil, fmt.Errorf("message details: %w", err)
	}
	out := &wspb.Message{
		Role:         m.Role,
		Content:      content,
		Details:      details,
		ToolCallId:   optionalString(m.ToolCallId),
		ToolName:     optionalString(m.ToolName),
		IsError:      m.IsError,
		StopReason:   optionalString(m.StopReason),
		ErrorMessage: optionalString(m.ErrorMessage),
	}
	if m.Ts != 0 {
		out.Ts = proto.Int64(m.Ts)
	}
	return out, nil
}

func messagesToWire(messages []rpc.Message) ([]*wspb.Message, error) {
	out := make([]*wspb.Message, 0, len(messages))
	for _, m := range messages {
		converted, err := messageToWire(m)
		if err != nil {
			return nil, err
		}
		out = append(out, converted)
	}
	return out, nil
}

func snapshotToWire(s rpc.Snapshot) (*wspb.TranscriptSnapshot, error) {
	messages, err := messagesToWire(s.Messages)
	if err != nil {
		return nil, err
	}
	return &wspb.TranscriptSnapshot{Messages: messages, LastSeq: s.LastSeq}, nil
}

func subagentTranscriptToWire(value any) (*wspb.SubagentTranscriptResult, error) {
	transcript, ok := value.(rpc.SubagentTranscript)
	if !ok {
		return nil, fmt.Errorf("unexpected subagent transcript type %T", value)
	}
	out := &wspb.SubagentTranscriptResult{RunId: transcript.RunId}
	for _, step := range transcript.Steps {
		messages, err := messagesToWire(fromSessionMessages(step.Messages))
		if err != nil {
			return nil, err
		}
		out.Steps = append(out.Steps, &wspb.SubagentRunStep{
			Label:       step.Label,
			SessionFile: step.SessionFile,
			Messages:    messages,
		})
	}
	return out, nil
}

// fromSessionMessages adapts stored fork-session messages to the transcript
// message shape used by the control wire.
func fromSessionMessages(messages []session.PiRPCMessage) []rpc.Message {
	out := make([]rpc.Message, 0, len(messages))
	for _, m := range messages {
		out = append(out, rpc.Message{
			Role:       m.Role,
			Content:    m.Content,
			Details:    m.Details,
			ToolCallId: m.ToolCallID,
			ToolName:   m.ToolName,
			IsError:    m.IsError,
		})
	}
	return out
}

// eventToWire converts one sequenced rpc event. Raw JSON payloads are the
// Pi wire lines rpc forwards; their known fields become typed fields and
// the rest stays external.
func eventToWire(ev rpc.Event) (*wspb.ControlEvent, error) {
	out := &wspb.ControlEvent{Sid: ev.Sid, Seq: ev.Seq}
	switch ev.Evt {
	case rpc.EvtStateChanged:
		out.Event = &wspb.ControlEvent_StateChanged{StateChanged: stateChangedToWire(ev.Data)}
	case rpc.EvtMessageStart:
		start, err := messageStartToWire(ev.Data)
		if err != nil {
			return nil, err
		}
		out.Event = &wspb.ControlEvent_MessageStart{MessageStart: start}
	case rpc.EvtMessageUpdate:
		update, err := messageUpdateToWire(ev.Data)
		if err != nil {
			return nil, err
		}
		out.Event = &wspb.ControlEvent_MessageUpdate{MessageUpdate: update}
	case rpc.EvtMessageEnd:
		end, err := messageEndToWire(ev.Data)
		if err != nil {
			return nil, err
		}
		out.Event = &wspb.ControlEvent_MessageEnd{MessageEnd: end}
	case rpc.EvtTranscriptReset:
		out.Event = &wspb.ControlEvent_TranscriptReset{TranscriptReset: &wspb.TranscriptResetEvent{}}
	case rpc.EvtRpcExited:
		out.Event = &wspb.ControlEvent_RpcExited{RpcExited: &wspb.RpcExitedEvent{Reason: rawStringField(ev.Data, "reason")}}
	case rpc.EvtSubagentFleet:
		// rpc publishes the fleet as raw JSON in production and as a
		// decoded map in tests; both shapes go through the bounded
		// external-value adapter.
		fleet, err := externalFromAny(ev.Data)
		if err != nil {
			return nil, err
		}
		out.Event = &wspb.ControlEvent_SubagentFleet{SubagentFleet: &wspb.SubagentFleetEvent{Fleet: fleet}}
	case rpc.EvtAutoRetryStart:
		start, err := retryStartToWire(ev.Data)
		if err != nil {
			return nil, err
		}
		out.Event = &wspb.ControlEvent_AutoRetryStart{AutoRetryStart: start}
	case rpc.EvtSummarizationRetryScheduled:
		scheduled, err := retryStartToWire(ev.Data)
		if err != nil {
			return nil, err
		}
		out.Event = &wspb.ControlEvent_SummarizationRetryScheduled{
			SummarizationRetryScheduled: &wspb.SummarizationRetryScheduledEvent{
				Attempt:      scheduled.Attempt,
				MaxAttempts:  scheduled.MaxAttempts,
				DelayMs:      scheduled.DelayMs,
				ErrorMessage: scheduled.ErrorMessage,
			},
		}
	case rpc.EvtAutoRetryEnd:
		end, err := retryEndToWire(ev.Data)
		if err != nil {
			return nil, err
		}
		out.Event = &wspb.ControlEvent_AutoRetryEnd{AutoRetryEnd: end}
	case rpc.EvtSummarizationRetryFinished:
		finished, err := retryEndToWire(ev.Data)
		if err != nil {
			return nil, err
		}
		out.Event = &wspb.ControlEvent_SummarizationRetryFinished{
			SummarizationRetryFinished: &wspb.SummarizationRetryFinishedEvent{
				Success:    finished.Success,
				Attempt:    finished.Attempt,
				FinalError: finished.FinalError,
			},
		}
	case rpc.EvtCompactionEnd:
		end, err := compactionEndToWire(ev.Data)
		if err != nil {
			return nil, err
		}
		out.Event = &wspb.ControlEvent_CompactionEnd{CompactionEnd: end}
	case rpc.EvtExtensionError:
		raw, err := rawRecord(ev.Data)
		if err != nil {
			return nil, err
		}
		out.Event = &wspb.ControlEvent_ExtensionError{ExtensionError: &wspb.ExtensionErrorEvent{
			Error: optionalString(rawString(raw["error"])),
		}}
	default:
		return nil, fmt.Errorf("unknown event %q", ev.Evt)
	}
	return out, nil
}

// stateChangedToWire keeps the two shapes apart: a complete state, or an
// error-only update that must not reset published UI state.
func stateChangedToWire(data any) *wspb.StateChangedEvent {
	switch value := data.(type) {
	case nil:
		return &wspb.StateChangedEvent{}
	case rpc.State:
		return &wspb.StateChangedEvent{Change: &wspb.StateChangedEvent_State{State: stateToWire(value)}}
	case map[string]any:
		if message, ok := value["error"].(string); ok && message != "" {
			return &wspb.StateChangedEvent{Change: &wspb.StateChangedEvent_Error{Error: &wspb.ControlError{Reason: message}}}
		}
	}
	return &wspb.StateChangedEvent{}
}

func messageStartToWire(data any) (*wspb.MessageStartEvent, error) {
	if fields, isRaw, err := rawEventFields(data); isRaw {
		if err != nil {
			return nil, err
		}
		message, ok := fields["message"]
		if !ok {
			return &wspb.MessageStartEvent{}, nil
		}
		record, err := rawObjectFields(message)
		if err != nil {
			return nil, err
		}
		external, err := externalFromJSON(message)
		if err != nil {
			return nil, err
		}
		return &wspb.MessageStartEvent{
			Role:    optionalString(rawFieldString(record, "role")),
			Message: external,
		}, nil
	}
	raw, err := rawRecord(data)
	if err != nil {
		return nil, err
	}
	message, ok := raw["message"]
	if !ok {
		return &wspb.MessageStartEvent{}, nil
	}
	record, err := rawRecord(message)
	if err != nil {
		return nil, err
	}
	external, err := externalFromAny(message)
	if err != nil {
		return nil, err
	}
	return &wspb.MessageStartEvent{
		Role:    optionalString(rawString(record["role"])),
		Message: external,
	}, nil
}

func messageUpdateToWire(data any) (*wspb.MessageUpdateEvent, error) {
	raw, err := rawRecord(data)
	if err != nil {
		return nil, err
	}
	assistant, err := rawRecord(raw["assistantMessageEvent"])
	if err != nil {
		return nil, err
	}
	out := &wspb.MessageUpdateEvent{
		Type:  optionalString(rawString(assistant["type"])),
		Delta: optionalString(rawString(assistant["delta"])),
	}
	if index, ok := rawInt64(assistant["contentIndex"]); ok {
		out.ContentIndex = proto.Int64(index)
	}
	return out, nil
}

func messageEndToWire(data any) (*wspb.MessageEndEvent, error) {
	raw, err := rawRecord(data)
	if err != nil {
		return nil, err
	}
	message, ok := raw["message"]
	if !ok {
		return &wspb.MessageEndEvent{}, nil
	}
	// Production supplies the authoritative message as raw JSON. Keeping the
	// bytes lets the content and details fields go through the same bounded
	// token conversion as the stored snapshot, duplicate keys included.
	if body, ok := rawJSONValue(message); ok {
		fields, err := rawObjectFields(body)
		if err != nil {
			return nil, err
		}
		var content, details *wspb.ExternalValue
		if value, ok := fields["content"]; ok {
			if content, err = externalFromJSON(value); err != nil {
				return nil, fmt.Errorf("message content: %w", err)
			}
		}
		if value, ok := fields["details"]; ok {
			if details, err = externalFromJSON(value); err != nil {
				return nil, fmt.Errorf("message details: %w", err)
			}
		}
		out := &wspb.Message{
			Role:       rawFieldString(fields, "role"),
			Content:    content,
			Details:    details,
			ToolCallId: optionalString(rawFieldString(fields, "toolCallId")),
			ToolName:   optionalString(rawFieldString(fields, "toolName")),
		}
		if flag, ok := rawFieldBool(fields, "isError"); ok {
			out.IsError = proto.Bool(flag)
		}
		if value := rawFieldString(fields, "stopReason"); value != "" {
			out.StopReason = proto.String(value)
		}
		if value := rawFieldString(fields, "errorMessage"); value != "" {
			out.ErrorMessage = proto.String(value)
		}
		return &wspb.MessageEndEvent{Message: out}, nil
	}
	record, err := rawRecord(message)
	if err != nil {
		return nil, err
	}
	// Presence matters: an omitted key leaves the field absent, while an
	// explicit JSON null becomes an ExternalNull, matching the snapshot
	// conversion of the stored message.
	var content, details *wspb.ExternalValue
	if value, ok := record["content"]; ok {
		content, err = externalFromAny(value)
		if err != nil {
			return nil, err
		}
	}
	if value, ok := record["details"]; ok {
		details, err = externalFromAny(value)
		if err != nil {
			return nil, err
		}
	}
	out := &wspb.Message{
		Role:       rawString(record["role"]),
		Content:    content,
		Details:    details,
		ToolCallId: optionalString(rawString(record["toolCallId"])),
		ToolName:   optionalString(rawString(record["toolName"])),
	}
	if flag, ok := record["isError"].(bool); ok {
		out.IsError = proto.Bool(flag)
	}
	if value := rawString(record["stopReason"]); value != "" {
		out.StopReason = proto.String(value)
	}
	if value := rawString(record["errorMessage"]); value != "" {
		out.ErrorMessage = proto.String(value)
	}
	return &wspb.MessageEndEvent{Message: out}, nil
}

func retryStartToWire(data any) (*wspb.AutoRetryStartEvent, error) {
	raw, err := rawRecord(data)
	if err != nil {
		return nil, err
	}
	out := &wspb.AutoRetryStartEvent{
		ErrorMessage: optionalString(rawString(raw["errorMessage"])),
	}
	if attempt, ok := rawInt64(raw["attempt"]); ok {
		out.Attempt = proto.Int64(attempt)
	}
	if maxAttempts, ok := rawInt64(raw["maxAttempts"]); ok {
		out.MaxAttempts = proto.Int64(maxAttempts)
	}
	if delay, ok := rawInt64(raw["delayMs"]); ok {
		out.DelayMs = proto.Int64(delay)
	}
	return out, nil
}

func retryEndToWire(data any) (*wspb.AutoRetryEndEvent, error) {
	raw, err := rawRecord(data)
	if err != nil {
		return nil, err
	}
	out := &wspb.AutoRetryEndEvent{
		FinalError: optionalString(rawString(raw["finalError"])),
	}
	if success, ok := raw["success"].(bool); ok {
		out.Success = proto.Bool(success)
	}
	if attempt, ok := rawInt64(raw["attempt"]); ok {
		out.Attempt = proto.Int64(attempt)
	}
	return out, nil
}

func compactionEndToWire(data any) (*wspb.CompactionEndEvent, error) {
	if fields, isRaw, err := rawEventFields(data); isRaw {
		if err != nil {
			return nil, err
		}
		out := &wspb.CompactionEndEvent{
			Reason:       optionalString(rawFieldString(fields, "reason")),
			ErrorMessage: optionalString(rawFieldString(fields, "errorMessage")),
		}
		if aborted, ok := rawFieldBool(fields, "aborted"); ok {
			out.Aborted = proto.Bool(aborted)
		}
		if result, ok := fields["result"]; ok {
			external, err := externalFromJSON(result)
			if err != nil {
				return nil, err
			}
			out.Result = external
		}
		return out, nil
	}
	raw, err := rawRecord(data)
	if err != nil {
		return nil, err
	}
	out := &wspb.CompactionEndEvent{
		Reason:       optionalString(rawString(raw["reason"])),
		ErrorMessage: optionalString(rawString(raw["errorMessage"])),
	}
	if aborted, ok := raw["aborted"].(bool); ok {
		out.Aborted = proto.Bool(aborted)
	}
	if result, ok := raw["result"]; ok {
		external, err := externalFromAny(result)
		if err != nil {
			return nil, err
		}
		out.Result = external
	}
	return out, nil
}

// rawRecord normalises the payload rpc publishes: either an already
// decoded map or a raw JSON object.
// rawJSONValue reports the raw bytes of a payload when rpc supplied JSON
// text rather than an already decoded value.
func rawJSONValue(data any) ([]byte, bool) {
	switch value := data.(type) {
	case json.RawMessage:
		return []byte(value), true
	case []byte:
		return value, true
	}
	return nil, false
}

func rawEventFields(data any) (map[string]json.RawMessage, bool, error) {
	body, ok := rawJSONValue(data)
	if !ok {
		return nil, false, nil
	}
	fields, err := rawObjectFields(body)
	return fields, true, err
}

// rawObjectFields splits one JSON object into its fields' raw bytes and
// rejects duplicate keys, so external fields reach the bounded token
// conversion with their source bytes intact. A decoded map has already lost
// that information, which is why the live message path uses this helper.
func rawObjectFields(raw []byte) (map[string]json.RawMessage, error) {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	token, err := decoder.Token()
	if err != nil {
		return nil, err
	}
	if delim, ok := token.(json.Delim); !ok || delim != '{' {
		return nil, errors.New("event message is not a JSON object")
	}
	fields := make(map[string]json.RawMessage)
	for decoder.More() {
		token, err := decoder.Token()
		if err != nil {
			return nil, err
		}
		key, ok := token.(string)
		if !ok {
			return nil, errors.New("event message has a non-string key")
		}
		if _, duplicate := fields[key]; duplicate {
			return nil, errors.New("event message has a duplicate object key")
		}
		var value json.RawMessage
		if err := decoder.Decode(&value); err != nil {
			return nil, err
		}
		fields[key] = value
	}
	if _, err := decoder.Token(); err != nil {
		return nil, err
	}
	if _, err := decoder.Token(); err != io.EOF {
		return nil, errors.New("event message has trailing data")
	}
	return fields, nil
}

func rawFieldString(fields map[string]json.RawMessage, key string) string {
	value, ok := fields[key]
	if !ok {
		return ""
	}
	var text string
	if err := json.Unmarshal(value, &text); err != nil {
		return ""
	}
	return text
}

func rawFieldBool(fields map[string]json.RawMessage, key string) (bool, bool) {
	value, ok := fields[key]
	if !ok {
		return false, false
	}
	var flag bool
	if err := json.Unmarshal(value, &flag); err != nil {
		return false, false
	}
	return flag, true
}

func rawRecord(data any) (map[string]any, error) {
	switch value := data.(type) {
	case nil:
		return map[string]any{}, nil
	case map[string]any:
		return value, nil
	case json.RawMessage:
		return decodeRecord([]byte(value))
	case []byte:
		return decodeRecord(value)
	}
	return nil, fmt.Errorf("unexpected event payload type %T", data)
}

func decodeRecord(raw []byte) (map[string]any, error) {
	if len(bytes.TrimSpace(raw)) == 0 {
		return map[string]any{}, nil
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var record map[string]any
	if err := decoder.Decode(&record); err != nil {
		return nil, err
	}
	return record, nil
}

func rawString(value any) string {
	text, _ := value.(string)
	return text
}

func rawStringField(data any, key string) *string {
	record, err := rawRecord(data)
	if err != nil {
		return nil
	}
	value := rawString(record[key])
	if value == "" {
		return nil
	}
	return &value
}

func rawInt64(value any) (int64, bool) {
	switch number := value.(type) {
	case json.Number:
		if parsed, err := number.Int64(); err == nil {
			return parsed, true
		}
		if parsed, err := number.Float64(); err == nil && parsed == math.Trunc(parsed) {
			return int64(parsed), true
		}
	case float64:
		if number == math.Trunc(number) {
			return int64(number), true
		}
	}
	return 0, false
}

// externalFromJSON converts raw JSON to an ExternalValue. Empty input
// yields no value at all. The token walk enforces the depth and node bounds
// while reading, so an oversized tree never becomes a decoded map first,
// and it rejects duplicate object keys, which a map would silently drop.
func externalFromJSON(raw json.RawMessage) (*wspb.ExternalValue, error) {
	if len(bytes.TrimSpace(raw)) == 0 {
		return nil, nil
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	nodes := 0
	value, err := externalFromTokens(decoder, 1, &nodes)
	if err != nil {
		return nil, err
	}
	if _, err := decoder.Token(); !errors.Is(err, io.EOF) {
		if err == nil {
			return nil, errors.New("external value has trailing data")
		}
		return nil, err
	}
	return value, nil
}

// externalFromTokens reads one JSON value at depth and converts it.
func externalFromTokens(decoder *json.Decoder, depth int, nodes *int) (*wspb.ExternalValue, error) {
	if depth > maxExternalDepth {
		return nil, errExternalBound
	}
	token, err := decoder.Token()
	if err != nil {
		return nil, err
	}
	return externalFromToken(decoder, token, depth, nodes)
}

func externalFromToken(decoder *json.Decoder, token json.Token, depth int, nodes *int) (*wspb.ExternalValue, error) {
	*nodes++
	if *nodes > maxExternalNodes {
		return nil, errExternalBound
	}
	if delimiter, ok := token.(json.Delim); ok {
		switch delimiter {
		case '{':
			object := &wspb.ExternalObject{Entries: make([]*wspb.ExternalEntry, 0, 8)}
			seen := make(map[string]struct{}, 8)
			for decoder.More() {
				keyToken, err := decoder.Token()
				if err != nil {
					return nil, err
				}
				key, ok := keyToken.(string)
				if !ok {
					return nil, errors.New("external value has a non-string object key")
				}
				if _, duplicate := seen[key]; duplicate {
					// The key itself is attacker-controlled: keep the reason fixed
					// and never echo it back to the peer.
					return nil, errors.New("external value has a duplicate object key")
				}
				seen[key] = struct{}{}
				value, err := externalFromTokens(decoder, depth+1, nodes)
				if err != nil {
					return nil, err
				}
				object.Entries = append(object.Entries, &wspb.ExternalEntry{Key: key, Value: value})
			}
			if _, err := decoder.Token(); err != nil {
				return nil, err
			}
			sort.Slice(object.Entries, func(i, j int) bool {
				return object.Entries[i].GetKey() < object.Entries[j].GetKey()
			})
			return &wspb.ExternalValue{Kind: &wspb.ExternalValue_ObjectValue{ObjectValue: object}}, nil
		case '[':
			list := &wspb.ExternalList{Values: make([]*wspb.ExternalValue, 0, 8)}
			for decoder.More() {
				value, err := externalFromTokens(decoder, depth+1, nodes)
				if err != nil {
					return nil, err
				}
				list.Values = append(list.Values, value)
			}
			if _, err := decoder.Token(); err != nil {
				return nil, err
			}
			return &wspb.ExternalValue{Kind: &wspb.ExternalValue_ListValue{ListValue: list}}, nil
		}
		return nil, errors.New("external value has an unexpected delimiter")
	}
	return externalFromScalar(token)
}

func externalFromScalar(token json.Token) (*wspb.ExternalValue, error) {
	switch value := token.(type) {
	case nil:
		return &wspb.ExternalValue{Kind: &wspb.ExternalValue_NullValue{NullValue: &wspb.ExternalNull{}}}, nil
	case bool:
		return &wspb.ExternalValue{Kind: &wspb.ExternalValue_BoolValue{BoolValue: value}}, nil
	case string:
		return &wspb.ExternalValue{Kind: &wspb.ExternalValue_StringValue{StringValue: value}}, nil
	case json.Number:
		return externalFromNumber(value)
	}
	return nil, fmt.Errorf("unsupported external value %T", token)
}

func externalFromNumber(number json.Number) (*wspb.ExternalValue, error) {
	if integer, err := number.Int64(); err == nil {
		return externalFromInt(integer), nil
	}
	value, err := number.Float64()
	if err != nil || math.IsInf(value, 0) || math.IsNaN(value) {
		return nil, errors.New("external value has a nonfinite number")
	}
	return &wspb.ExternalValue{Kind: &wspb.ExternalValue_NumberValue{NumberValue: value}}, nil
}

// maxSafeExternalInteger is the largest integer a JavaScript number holds
// exactly. Pi ships arbitrary JSON numbers, so an integer outside this range
// goes out as a double: the browser reads doubles as ordinary numbers, while
// a wider int_value is rejected as a sequence-number style bound violation.
const maxSafeExternalInteger = 1<<53 - 1

func externalFromInt(value int64) *wspb.ExternalValue {
	if value > maxSafeExternalInteger || value < -maxSafeExternalInteger {
		return &wspb.ExternalValue{Kind: &wspb.ExternalValue_NumberValue{NumberValue: float64(value)}}
	}
	return &wspb.ExternalValue{Kind: &wspb.ExternalValue_IntValue{IntValue: value}}
}

// externalFromAny converts one decoded Go value. Objects keep their keys
// verbatim, including reserved names such as __proto__.
func externalFromAny(value any) (*wspb.ExternalValue, error) {
	nodes := 0
	return convertExternal(value, 1, &nodes)
}

func convertExternal(value any, depth int, nodes *int) (*wspb.ExternalValue, error) {
	if depth > maxExternalDepth {
		return nil, errExternalBound
	}
	*nodes++
	if *nodes > maxExternalNodes {
		return nil, errExternalBound
	}
	switch typed := value.(type) {
	case nil:
		return &wspb.ExternalValue{Kind: &wspb.ExternalValue_NullValue{NullValue: &wspb.ExternalNull{}}}, nil
	case bool:
		return &wspb.ExternalValue{Kind: &wspb.ExternalValue_BoolValue{BoolValue: typed}}, nil
	case string:
		return &wspb.ExternalValue{Kind: &wspb.ExternalValue_StringValue{StringValue: typed}}, nil
	case json.Number:
		return externalFromNumber(typed)
	case json.RawMessage:
		// Pi publishes some event payloads as raw JSON. Decode them through
		// the bounded adapter at this depth instead of failing the stream.
		decoded, err := externalFromJSON(typed)
		if err != nil {
			return nil, err
		}
		*nodes--
		return decoded, nil
	case []byte:
		decoded, err := externalFromJSON(json.RawMessage(typed))
		if err != nil {
			return nil, err
		}
		*nodes--
		return decoded, nil
	case float64:
		if math.IsInf(typed, 0) || math.IsNaN(typed) {
			return nil, errors.New("external value has a nonfinite number")
		}
		return &wspb.ExternalValue{Kind: &wspb.ExternalValue_NumberValue{NumberValue: typed}}, nil
	case float32:
		return convertExternal(float64(typed), depth, nodes)
	case int:
		return externalFromInt(int64(typed)), nil
	case int64:
		return externalFromInt(typed), nil
	case []any:
		list := &wspb.ExternalList{Values: make([]*wspb.ExternalValue, 0, len(typed))}
		for _, item := range typed {
			converted, err := convertExternal(item, depth+1, nodes)
			if err != nil {
				return nil, err
			}
			list.Values = append(list.Values, converted)
		}
		return &wspb.ExternalValue{Kind: &wspb.ExternalValue_ListValue{ListValue: list}}, nil
	case map[string]any:
		keys := make([]string, 0, len(typed))
		for key := range typed {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		object := &wspb.ExternalObject{Entries: make([]*wspb.ExternalEntry, 0, len(keys))}
		for _, key := range keys {
			converted, err := convertExternal(typed[key], depth+1, nodes)
			if err != nil {
				return nil, err
			}
			object.Entries = append(object.Entries, &wspb.ExternalEntry{Key: key, Value: converted})
		}
		return &wspb.ExternalValue{Kind: &wspb.ExternalValue_ObjectValue{ObjectValue: object}}, nil
	}
	return nil, fmt.Errorf("unsupported external value type %T", value)
}
