package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	pibridge "github.com/hypernewbie/phi/internal/pibridge"
	pibridgepb "github.com/hypernewbie/phi/internal/pibridge/pb"
)

const (
	piAttachmentJSONTimeout   = 15 * time.Second
	piAttachmentAckTimeout    = 20 * time.Second
	piAttachmentMaxBody       = 80 << 10
	piAttachmentTextMax       = 64 << 10
	piAttachmentMaxItems      = 8
	piAttachmentMaxTotalBytes = int64(50 << 20)
)

type attachmentContextModel struct {
	Provider string `json:"provider"`
	ID       string `json:"id"`
}

type attachmentTargetContext struct {
	ProcessID      *string                 `json:"process_id"`
	Generation     *string                 `json:"generation"`
	SessionID      *string                 `json:"session_id"`
	LeafID         *string                 `json:"leaf_id"`
	Model          *attachmentContextModel `json:"model"`
	Idle           *bool                   `json:"idle"`
	Queued         *bool                   `json:"queued"`
	ImageAvailable *bool                   `json:"image_available"`
	Available      bool                    `json:"available"`
}

type attachmentSendRequest struct {
	ID            string                  `json:"id"`
	Pane          string                  `json:"pane"`
	Context       attachmentTargetContext `json:"context"`
	Text          string                  `json:"text"`
	AttachmentIDs []string                `json:"attachment_ids"`
}

type attachmentSendResponse struct {
	ID     string `json:"id"`
	State  string `json:"state"`
	Reason string `json:"reason"`
}

func handlePiBridgeAttachmentContext(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", "GET")
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	pane := r.URL.Query().Get("pane")
	if pane == "" || len(pane) > attachmentPaneMaxBytes {
		writeAttachmentJSONError(w, http.StatusBadRequest, "invalid-item")
		return
	}
	if _, err := requireLivePiPane(pane); err != nil {
		writeAttachmentJSONError(w, http.StatusNotFound, "unavailable")
		return
	}
	result := attachmentTargetContext{}
	if piBridge != nil {
		processID, view, ok := piBridge.AttachmentPaneView(pane)
		if ok {
			// Older runtimes keep their existing cached-context behavior.
			// New runtimes sample Pi live: idle extension metadata can move
			// the leaf without a lifecycle event reaching the bridge.
			if view.HasPeer && attachmentContainsString(view.Caps, pibridge.CapabilityState) {
				ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
				defer cancel()
				if err := piBridge.server.RefreshState(ctx, processID); err != nil {
					writeAttachmentJSONError(w, http.StatusServiceUnavailable, "unavailable")
					return
				}
				currentProcess, currentView, current := piBridge.AttachmentPaneView(pane)
				if !current || currentProcess != processID || currentView.Generation != view.Generation {
					writeAttachmentJSONError(w, http.StatusServiceUnavailable, "unavailable")
					return
				}
				view = currentView
			}
			result = attachmentContextFromView(processID, view)
			result.Available = view.HasPeer && attachmentContainsString(view.Caps, pibridge.CapabilityAttachments) && view.AttachmentReadiness != nil && attachmentStore != nil
		}
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(result)
}

func attachmentContextFromView(processID string, view pibridge.StateView) attachmentTargetContext {
	result := attachmentTargetContext{ProcessID: &processID}
	if view.Generation > 0 {
		value := strconv.FormatUint(view.Generation, 10)
		result.Generation = &value
	}
	if view.SessionID != "" {
		value := view.SessionID
		result.SessionID = &value
	}
	if view.HasState {
		value := view.LeafID
		result.LeafID = &value
	}
	if view.ModelProvider != "" && view.ModelID != "" {
		result.Model = &attachmentContextModel{Provider: view.ModelProvider, ID: view.ModelID}
	}
	if ready := view.AttachmentReadiness; ready != nil {
		idle, queued := ready.Idle, ready.HasPendingMessages
		result.Idle, result.Queued = &idle, &queued
		if ready.ImageAvailable != nil {
			value := *ready.ImageAvailable
			result.ImageAvailable = &value
		}
	}
	return result
}

func handlePiBridgeAttachments(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	switch r.Method {
	case http.MethodGet:
		handlePiBridgeAttachmentStatus(w, r)
	case http.MethodPost:
		handlePiBridgeAttachmentSend(w, r)
	default:
		w.Header().Set("Allow", "GET, POST")
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
	}
}

func handlePiBridgeAttachmentStatus(w http.ResponseWriter, r *http.Request) {
	id, pane := r.URL.Query().Get("id"), r.URL.Query().Get("pane")
	if !canonicalAttachmentUUID(id) || pane == "" || len(pane) > attachmentPaneMaxBytes {
		writeAttachmentJSONError(w, http.StatusBadRequest, "invalid-item")
		return
	}
	if attachmentStore == nil {
		writeAttachmentJSONError(w, http.StatusServiceUnavailable, "storage")
		return
	}
	record, err := attachmentStore.Send(id, pane)
	if errors.Is(err, errAttachmentNotFound) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(attachmentSendResponse{ID: id, State: "missing"})
		return
	}
	if err != nil {
		writeAttachmentStoreError(w, err)
		return
	}
	writeAttachmentSend(w, record)
}

func handlePiBridgeAttachmentSend(w http.ResponseWriter, r *http.Request) {
	if !attachmentSameOrigin(r) {
		writeAttachmentJSONError(w, http.StatusForbidden, "unavailable")
		return
	}
	clearDeadline, ok := setAttachmentReadDeadline(w, r, piAttachmentJSONTimeout)
	if !ok {
		writeAttachmentJSONError(w, http.StatusServiceUnavailable, "unavailable")
		return
	}
	defer clearDeadline()
	mediaType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || mediaType != "application/json" {
		writeAttachmentJSONError(w, http.StatusBadRequest, "invalid-item")
		return
	}
	if attachmentStore == nil {
		writeAttachmentJSONError(w, http.StatusServiceUnavailable, "storage")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, piAttachmentMaxBody)
	var body attachmentSendRequest
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&body); err != nil {
		writeAttachmentJSONBodyError(w, err)
		return
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		writeAttachmentJSONBodyError(w, errAttachmentInvalid)
		return
	}
	if err := validateAttachmentSendRequest(body); err != nil {
		writeAttachmentStoreError(w, err)
		return
	}
	fingerprint, err := attachmentSendHash(body)
	if err != nil {
		writeAttachmentJSONError(w, http.StatusBadRequest, "invalid-item")
		return
	}
	record, created, err := attachmentStore.BeginSend(body.ID, body.Pane, fingerprint)
	if err != nil {
		writeAttachmentStoreError(w, err)
		return
	}
	if !created {
		writeAttachmentSend(w, record)
		return
	}
	refuse := func(reason string) {
		if updateErr := attachmentStore.UpdateSend(body.ID, false, "refused", reason); updateErr != nil {
			writeAttachmentJSONError(w, http.StatusServiceUnavailable, "storage")
			return
		}
		record, _ := attachmentStore.Send(body.ID, body.Pane)
		writeAttachmentSend(w, record)
	}
	if _, err := requireLivePiPane(body.Pane); err != nil {
		refuse("unavailable")
		return
	}
	current := currentAttachmentContext(body.Pane)
	if !current.Available {
		refuse("unavailable")
		return
	}
	if !sameAttachmentContext(body.Context, current) {
		refuse("stale")
		return
	}
	text := strings.TrimSpace(body.Text)
	if strings.HasPrefix(text, "/") || strings.HasPrefix(text, "!") {
		refuse("command")
		return
	}
	items := make([]AttachmentItem, 0, len(body.AttachmentIDs))
	imageRequired := false
	var totalBytes int64
	for _, id := range body.AttachmentIDs {
		item, itemErr := attachmentStore.Item(id, body.Pane)
		if itemErr != nil {
			refuse("missing-item")
			return
		}
		items = append(items, item)
		imageRequired = imageRequired || item.Kind == "image"
		totalBytes += item.SizeBytes
	}
	if totalBytes > piAttachmentMaxTotalBytes {
		refuse("limit")
		return
	}
	if imageRequired && (current.ImageAvailable == nil || !*current.ImageAvailable) {
		refuse("unsupported-model")
		return
	}
	processID, view, viewOK := piBridge.AttachmentPaneView(body.Pane)
	if !viewOK {
		refuse("unavailable")
		return
	}
	model := (*pibridgepb.ModelSnapshot)(nil)
	if current.Model != nil {
		model = &pibridgepb.ModelSnapshot{Provider: current.Model.Provider, Model: current.Model.ID}
	}
	_, refs, err := attachmentStore.CreateHandoff(processID, body.Pane, body.AttachmentIDs)
	if err != nil {
		writeAttachmentStoreError(w, err)
		_ = attachmentStore.UpdateSend(body.ID, false, "refused", attachmentStoreReason(err))
		return
	}
	if err := attachmentStore.UpdateSend(body.ID, true, "unknown", "uncertain"); err != nil {
		writeAttachmentJSONError(w, http.StatusServiceUnavailable, "storage")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), piAttachmentAckTimeout)
	defer cancel()
	bridgeRefs := make([]pibridge.AttachmentRef, 0, len(refs))
	for _, ref := range refs {
		bridgeRefs = append(bridgeRefs, pibridge.AttachmentRef{
			Basename: ref.Basename, SizeBytes: uint64(ref.SizeBytes), MIMEType: ref.MIMEType,
			Kind: ref.Kind, SHA256: ref.SHA256,
		})
	}
	outcome, err := piBridge.RequestPaneAttachmentPrompt(ctx, body.Pane, processID, view.Generation, body.Context.SessionIDValue(), body.Context.LeafIDValue(), model, body.Text, bridgeRefs, imageRequired)
	if err != nil {
		var refusal *pibridge.AttachmentPromptRefusal
		var unknown *pibridge.AttachmentPromptUnknown
		switch {
		case errors.As(err, &refusal):
			_ = attachmentStore.UpdateSend(body.ID, true, "refused", refusal.Reason)
		case errors.As(err, &unknown):
			_ = attachmentStore.UpdateSend(body.ID, true, "unknown", "uncertain")
		default:
			_ = attachmentStore.UpdateSend(body.ID, true, "unknown", "uncertain")
		}
		record, _ := attachmentStore.Send(body.ID, body.Pane)
		writeAttachmentSend(w, record)
		return
	}
	state, reason := "unknown", "uncertain"
	switch outcome.Outcome {
	case pibridgepb.AttachmentPromptOutcome_ATTACHMENT_PROMPT_OUTCOME_DISPATCHED:
		state, reason = "dispatched", ""
	case pibridgepb.AttachmentPromptOutcome_ATTACHMENT_PROMPT_OUTCOME_REFUSED:
		state, reason = "refused", outcome.Reason
	case pibridgepb.AttachmentPromptOutcome_ATTACHMENT_PROMPT_OUTCOME_UNKNOWN:
		state, reason = "unknown", "uncertain"
	}
	if err := attachmentStore.UpdateSend(body.ID, true, state, reason); err != nil {
		writeAttachmentJSONError(w, http.StatusServiceUnavailable, "storage")
		return
	}
	record, _ = attachmentStore.Send(body.ID, body.Pane)
	writeAttachmentSend(w, record)
}

func currentAttachmentContext(pane string) attachmentTargetContext {
	if ptyManager == nil || piBridge == nil || attachmentStore == nil {
		return attachmentTargetContext{}
	}
	if _, err := requireLivePiPane(pane); err != nil {
		return attachmentTargetContext{}
	}
	processID, view, ok := piBridge.AttachmentPaneView(pane)
	if !ok {
		return attachmentTargetContext{}
	}
	result := attachmentContextFromView(processID, view)
	result.Available = view.HasPeer && attachmentContainsString(view.Caps, pibridge.CapabilityAttachments) && view.AttachmentReadiness != nil
	return result
}

func validateAttachmentSendRequest(body attachmentSendRequest) error {
	if !canonicalAttachmentUUID(body.ID) || body.Pane == "" || len(body.Pane) > attachmentPaneMaxBytes || !utf8.ValidString(body.Text) || len(body.Text) > piAttachmentTextMax || len(body.AttachmentIDs) < 1 || len(body.AttachmentIDs) > piAttachmentMaxItems {
		return errAttachmentInvalid
	}
	seen := make(map[string]struct{}, len(body.AttachmentIDs))
	for _, id := range body.AttachmentIDs {
		if !canonicalAttachmentUUID(id) {
			return errAttachmentInvalid
		}
		if _, ok := seen[id]; ok {
			return errAttachmentInvalid
		}
		seen[id] = struct{}{}
	}
	c := body.Context
	if c.ProcessID == nil || c.Generation == nil || c.SessionID == nil || c.LeafID == nil || *c.ProcessID == "" || len(*c.ProcessID) > 256 || len(*c.SessionID) > 256 || len(*c.LeafID) > 256 {
		return errAttachmentInvalid
	}
	if _, ok := parsePositiveStamp(*c.Generation); !ok {
		return errAttachmentInvalid
	}
	if c.Model != nil && (c.Model.Provider == "" || c.Model.ID == "" || len(c.Model.Provider) > 256 || len(c.Model.ID) > 256) {
		return errAttachmentInvalid
	}
	return nil
}

func attachmentSendHash(body attachmentSendRequest) (string, error) {
	data, err := json.Marshal(body)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:]), nil
}

func sameAttachmentContext(expected, current attachmentTargetContext) bool {
	if expected.ProcessID == nil || current.ProcessID == nil || *expected.ProcessID != *current.ProcessID || expected.Generation == nil || current.Generation == nil || *expected.Generation != *current.Generation || expected.SessionID == nil || current.SessionID == nil || *expected.SessionID != *current.SessionID || expected.LeafID == nil || current.LeafID == nil || *expected.LeafID != *current.LeafID {
		return false
	}
	if expected.Model == nil || current.Model == nil {
		return expected.Model == nil && current.Model == nil
	}
	return expected.Model.Provider == current.Model.Provider && expected.Model.ID == current.Model.ID
}

func (c attachmentTargetContext) SessionIDValue() string {
	if c.SessionID == nil {
		return ""
	}
	return *c.SessionID
}

func (c attachmentTargetContext) LeafIDValue() string {
	if c.LeafID == nil {
		return ""
	}
	return *c.LeafID
}

func attachmentContainsString(values []string, wanted string) bool {
	for _, value := range values {
		if value == wanted {
			return true
		}
	}
	return false
}

func writeAttachmentJSONBodyError(w http.ResponseWriter, err error) {
	var tooLarge *http.MaxBytesError
	if errors.As(err, &tooLarge) {
		writeAttachmentJSONError(w, http.StatusRequestEntityTooLarge, "limit")
		return
	}
	writeAttachmentJSONError(w, http.StatusBadRequest, "invalid-item")
}

func attachmentStoreReason(err error) string {
	switch {
	case errors.Is(err, errAttachmentUnsupported):
		return "unsupported-image"
	case errors.Is(err, errAttachmentLimit):
		return "limit"
	case errors.Is(err, errAttachmentNotFound):
		return "missing-item"
	case errors.Is(err, errAttachmentInvalid):
		return "invalid-item"
	default:
		return "storage"
	}
}

func writeAttachmentSend(w http.ResponseWriter, record attachmentSendRecord) {
	state := record.State
	if state == "pending" {
		state = "unknown"
	}
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(attachmentSendResponse{ID: record.ID, State: state, Reason: record.Reason})
}
