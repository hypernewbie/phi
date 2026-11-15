package phic

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
)

// Pi bridge control API. These endpoints mirror the browser's Pi header
// controls: live model catalog, thinking levels, skills, native compaction,
// extension reload, and the Pi prompt history. Every response uses the
// server's safe outcome vocabulary; raw provider errors never cross.

// BridgeModel is one catalog entry of the live Pi session.
type BridgeModel struct {
	Provider string `json:"provider"`
	ID       string `json:"id"`
}

func (m BridgeModel) label() string {
	if m.Provider == "" {
		return m.ID
	}
	return m.Provider + "/" + m.ID
}

// BridgeSkill is one invocable skill of the live Pi session.
type BridgeSkill struct {
	Name        string `json:"name"`
	Description string `json:"description"`
}

// bridgeCatalog is the models list.
type bridgeCatalog struct {
	Models      []BridgeModel `json:"models"`
	Truncated   bool          `json:"truncated"`
	Unavailable bool          `json:"unavailable"`
}

// bridgeThinking is the levels list plus the process origin a set must echo.
type bridgeThinking struct {
	Levels      []string `json:"levels"`
	Provider    string   `json:"provider"`
	Model       string   `json:"model"`
	ProcessID   string   `json:"process_id"`
	Generation  string   `json:"generation"`
	Unavailable bool     `json:"unavailable"`
}

// bridgeSkills is the skill list plus the process origin an invoke must echo.
type bridgeSkills struct {
	Skills      []BridgeSkill `json:"skills"`
	Truncated   bool          `json:"truncated"`
	Unavailable bool          `json:"unavailable"`
	ProcessID   string        `json:"process_id"`
	Generation  string        `json:"generation"`
}

// bridgePromptHistory is the Pi input history of one pane.
type bridgePromptHistory struct {
	Entries     []string `json:"entries"`
	Unavailable bool     `json:"unavailable"`
}

// BridgeAction is one ack for a setter or an invoke. OK=false carries the
// server's safe reason vocabulary.
type BridgeAction struct {
	OK     bool   `json:"ok"`
	Reason string `json:"reason"`
}

// bridgeOutcome words mirror the server exactly: compact answers
// completed/failed/unknown/rejected-before-start, reload answers
// dispatched/unknown/rejected-before-start.
const (
	bridgeOutcomeCompleted  = "completed"
	bridgeOutcomeDispatched = "dispatched"
	bridgeOutcomeRejected   = "rejected-before-start"
	bridgeOutcomeFailed     = "failed"
	bridgeOutcomeUnknown    = "unknown"
)

// bridgeOutcomeBody is the fixed JSON body of compact/reload replies.
type bridgeOutcomeBody struct {
	Outcome   string `json:"outcome"`
	Reason    string `json:"reason"`
	RequestID string `json:"request_id"`
}

// BridgeModels lists the models of the Pi session attached to one pane.
func (a *apiClient) BridgeModels(ctx context.Context, pane string) (bridgeCatalog, error) {
	var out bridgeCatalog
	err := a.getJSON(ctx, "/api/pi-bridge/models?pane="+url.QueryEscape(pane), &out)
	return out, err
}

// BridgeSetModel switches the live Pi session to one catalog entry.
func (a *apiClient) BridgeSetModel(ctx context.Context, pane, provider, model string) (BridgeAction, error) {
	var out BridgeAction
	body := fmt.Sprintf(`{"pane":%q,"provider":%q,"model":%q}`, pane, provider, model)
	err := a.postJSON(ctx, "/api/pi-bridge/model", []byte(body), &out)
	return out, err
}

// BridgeThinking lists the thinking levels of the live Pi session together
// with the process origin a setter must echo back.
func (a *apiClient) BridgeThinking(ctx context.Context, pane string) (bridgeThinking, error) {
	var out bridgeThinking
	err := a.getJSON(ctx, "/api/pi-bridge/thinking-levels?pane="+url.QueryEscape(pane), &out)
	return out, err
}

// BridgeSetThinking applies one thinking level. The process origin comes
// from the levels list that produced the choice.
func (a *apiClient) BridgeSetThinking(ctx context.Context, pane, level, provider, model, processID, generation string) (BridgeAction, error) {
	var out BridgeAction
	body := fmt.Sprintf(`{"pane":%q,"level":%q,"provider":%q,"model":%q,"process_id":%q,"generation":%q}`,
		pane, level, provider, model, processID, generation)
	err := a.postJSON(ctx, "/api/pi-bridge/thinking", []byte(body), &out)
	return out, err
}

// BridgeSkills lists the skills of the live Pi session together with the
// process origin an invoke must echo back.
func (a *apiClient) BridgeSkills(ctx context.Context, pane string) (bridgeSkills, error) {
	var out bridgeSkills
	err := a.getJSON(ctx, "/api/pi-bridge/skills?pane="+url.QueryEscape(pane), &out)
	return out, err
}

// BridgeInvokeSkill sends one skill to the live Pi session. The ack means
// dispatched, never that the agent accepted or completed it.
func (a *apiClient) BridgeInvokeSkill(ctx context.Context, pane, name, processID, generation string) (BridgeAction, error) {
	var out BridgeAction
	body := fmt.Sprintf(`{"pane":%q,"name":%q,"process_id":%q,"generation":%q}`, pane, name, processID, generation)
	err := a.postJSON(ctx, "/api/pi-bridge/skill", []byte(body), &out)
	return out, err
}

// BridgePromptHistory returns the staged-input history of the Pi session.
func (a *apiClient) BridgePromptHistory(ctx context.Context, pane string) (bridgePromptHistory, error) {
	var out bridgePromptHistory
	err := a.getJSON(ctx, "/api/pi-history?pane="+url.QueryEscape(pane), &out)
	return out, err
}

// BridgeCompact runs one native Pi compaction. The stamps come from the
// pane's latest bridge state; a stale origin is rejected before dispatch.
func (a *apiClient) BridgeCompact(ctx context.Context, pane, generation, telemetryRevision string) (string, string, error) {
	body := fmt.Sprintf(`{"pane":%q,"generation":%q,"telemetry_revision":%q}`, pane, generation, telemetryRevision)
	return a.postBridgeOutcome(ctx, "/api/pi-bridge/compact", bridgeOutcomeCompleted, body)
}

// BridgeReload dispatches Pi's fixed /reload command. The stamps come from
// the pane's latest bridge state; a stale origin is rejected before dispatch.
func (a *apiClient) BridgeReload(ctx context.Context, pane, processID, generation, telemetryRevision, runID, contextRevision string) (string, string, error) {
	body := fmt.Sprintf(`{"pane":%q,"process_id":%q,"generation":%q,"telemetry_revision":%q,"run_id":%q,"context_revision":%q}`,
		pane, processID, generation, telemetryRevision, runID, contextRevision)
	return a.postBridgeOutcome(ctx, "/api/pi-bridge/reload", bridgeOutcomeDispatched, body)
}

// outcomeForStatus maps one HTTP status to the server's safe outcome word.
// The success word is caller-specific: compact answers completed (200),
// reload answers dispatched (202).
func outcomeForStatus(status int, success string) (string, bool) {
	switch status {
	case http.StatusOK, http.StatusAccepted:
		return success, true
	case http.StatusConflict, http.StatusServiceUnavailable:
		return bridgeOutcomeRejected, true
	case http.StatusBadGateway:
		return bridgeOutcomeFailed, true
	case http.StatusGatewayTimeout:
		return bridgeOutcomeUnknown, true
	}
	return "", false
}

// postBridgeOutcome posts one compact/reload body and reduces the answer to
// the safe outcome word and reason. A status/body mismatch is a protocol
// fault, never a silent success.
func (a *apiClient) postBridgeOutcome(ctx context.Context, path, success, body string) (string, string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, a.base.String()+path, strings.NewReader(body))
	if err != nil {
		return "", "", err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := a.http.Do(req)
	if err != nil {
		return "", "", err
	}
	defer resp.Body.Close()
	expected, ok := outcomeForStatus(resp.StatusCode, success)
	if !ok {
		return "", "", &apiError{Code: resp.StatusCode, Message: "POST " + path + ": " + resp.Status}
	}
	var out bridgeOutcomeBody
	if err := decodeJSON(resp.Body, &out); err != nil || out.Outcome == "" {
		return "", "", &apiError{Code: resp.StatusCode, Message: "POST " + path + ": malformed outcome"}
	}
	if out.Outcome != expected {
		return "", "", &apiError{Code: resp.StatusCode, Message: "POST " + path + ": outcome/status mismatch"}
	}
	switch out.Outcome {
	case bridgeOutcomeCompleted, bridgeOutcomeDispatched, bridgeOutcomeRejected, bridgeOutcomeFailed, bridgeOutcomeUnknown:
		return out.Outcome, out.Reason, nil
	}
	return "", "", &apiError{Code: resp.StatusCode, Message: "POST " + path + ": unknown outcome word"}
}

// stampString renders one bridge stamp for the wire in the canonical
// digits-only form the server requires.
func stampString(v uint64) string { return strconv.FormatUint(v, 10) }
