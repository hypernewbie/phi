package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/hypernewbie/phi/internal/pibridge"
	pibridgepb "github.com/hypernewbie/phi/internal/pibridge/pb"
	"github.com/hypernewbie/phi/pkg/pty"
)

func TestPiAttachmentStatusSurvivesPaneClosure(t *testing.T) {
	withAttachmentTestGlobals(t)
	id := uuid.NewString()
	hash := strings.Repeat("a", 64)
	if _, _, err := attachmentStore.BeginSend(id, "closed-pane", hash); err != nil {
		t.Fatal(err)
	}
	if err := attachmentStore.UpdateSend(id, true, "unknown", "uncertain"); err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodGet, "/api/pi-bridge/attachments?id="+id+"&pane=closed-pane", nil)
	response := httptest.NewRecorder()
	handlePiBridgeAttachments(response, request)
	var got attachmentSendResponse
	if err := json.Unmarshal(response.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if response.Code != http.StatusOK || got.ID != id || got.State != "unknown" {
		t.Fatalf("status=%d response=%+v", response.Code, got)
	}
}

func TestPiAttachmentPostPersistsRefusalAndIdempotentResult(t *testing.T) {
	withAttachmentTestGlobals(t)
	id := uuid.NewString()
	requestBody := attachmentSendRequest{
		ID:   id,
		Pane: "closed-pane",
		Context: attachmentTargetContext{
			ProcessID: stringPtr("process"), Generation: stringPtr("1"),
			SessionID: stringPtr("session"), LeafID: stringPtr("leaf"),
			Model: &attachmentContextModel{Provider: "provider", ID: "model"},
		},
		Text:          "inspect",
		AttachmentIDs: []string{uuid.NewString()},
	}
	body, err := json.Marshal(requestBody)
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(http.HandlerFunc(handlePiBridgeAttachments))
	defer server.Close()
	post := func(raw []byte) *http.Response {
		req, _ := http.NewRequest(http.MethodPost, server.URL+"/api/pi-bridge/attachments", bytes.NewReader(raw))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Origin", server.URL)
		res, err := server.Client().Do(req)
		if err != nil {
			t.Fatal(err)
		}
		return res
	}
	first := post(body)
	var firstResult attachmentSendResponse
	if err := json.NewDecoder(first.Body).Decode(&firstResult); err != nil {
		_ = first.Body.Close()
		t.Fatal(err)
	}
	_ = first.Body.Close()
	if first.StatusCode != http.StatusOK || firstResult.State != "refused" {
		t.Fatalf("first status=%d result=%+v", first.StatusCode, firstResult)
	}
	second := post(body)
	defer second.Body.Close()
	var secondResult attachmentSendResponse
	if err := json.NewDecoder(second.Body).Decode(&secondResult); err != nil {
		t.Fatal(err)
	}
	if second.StatusCode != http.StatusOK || secondResult != firstResult {
		t.Fatalf("duplicate status=%d result=%+v first=%+v", second.StatusCode, secondResult, firstResult)
	}
	requestBody.Text = "different body"
	changed, _ := json.Marshal(requestBody)
	third := post(changed)
	defer third.Body.Close()
	if third.StatusCode != http.StatusConflict {
		t.Fatalf("changed body status=%d", third.StatusCode)
	}
}

func TestPiAttachmentDispatchRetainsValidatedTarget(t *testing.T) {
	for _, change := range []string{"unchanged", "generation", "process"} {
		t.Run(change, func(t *testing.T) {
			withAttachmentTestGlobals(t)
			b := startPiBridge(testBridgeHub())
			if b == nil {
				t.Fatal("bridge did not start")
			}
			defer b.Stop()
			piBridge = b
			const pane = "pane-attachment-target"
			env, _, managed := b.Provision(pane, true)
			if !managed {
				t.Fatal("provision not managed")
			}
			b.Complete(&pty.PTYInstance{ID: pane})
			open := func(generation uint64) pibridgepb.Integration_ConnectClient {
				t.Helper()
				stream, cancel := dialBridge(t, b, pane, env[piBridgeEnvProcess], env[piBridgeEnvToken])
				t.Cleanup(cancel)
				if err := stream.Send(&pibridgepb.PiToPhi{
					PaneId: pane, ProcessId: env[piBridgeEnvProcess], RuntimeGeneration: generation,
					Payload: &pibridgepb.PiToPhi_Hello{Hello: &pibridgepb.Hello{
						ProtocolVersion: 1, SessionId: "session", RuntimeId: "runtime",
						Capabilities: []string{pibridge.CapabilityLifecycle, pibridge.CapabilityAttachments},
						CurrentState: &pibridgepb.StateSnapshot{
							State: pibridgepb.LogicalState_LOGICAL_STATE_IDLE, SessionId: "session", LeafId: "leaf",
							Model:               &pibridgepb.ModelSnapshot{Provider: "provider", Model: "model"},
							AttachmentReadiness: &pibridgepb.AttachmentReadiness{Idle: true},
						},
					}},
				}); err != nil {
					t.Fatal(err)
				}
				if msg, err := stream.Recv(); err != nil || msg.GetAccepted() == nil {
					t.Fatalf("hello response=%v error=%v", msg, err)
				}
				return stream
			}
			stream := open(1)
			processID, view, ok := b.AttachmentPaneView(pane)
			if !ok {
				t.Fatal("missing initial attachment context")
			}
			body := attachmentSendRequest{Pane: pane, Context: attachmentContextFromView(processID, view), Text: "inspect"}
			// Admission has checked this snapshot. Replace the runtime before
			// dispatch, keeping session, leaf, and model identical.
			switch change {
			case "generation":
				stream = open(2)
			case "process":
				b.RevokePane(pane)
				env, _, managed = b.Provision(pane, true)
				if !managed {
					t.Fatal("replacement provision not managed")
				}
				b.Complete(&pty.PTYInstance{ID: pane})
				stream = open(1)
			}
			go func() {
				msg, err := stream.Recv()
				if err != nil || msg.GetAttachmentPromptRequest() == nil {
					return
				}
				_ = stream.Send(&pibridgepb.PiToPhi{
					PaneId: pane, ProcessId: msg.GetProcessId(), RuntimeGeneration: msg.GetRuntimeGeneration(),
					Payload: &pibridgepb.PiToPhi_AttachmentPromptAck{AttachmentPromptAck: &pibridgepb.AttachmentPromptAck{
						RequestId: msg.GetAttachmentPromptRequest().GetRequestId(),
						Outcome:   pibridgepb.AttachmentPromptOutcome_ATTACHMENT_PROMPT_OUTCOME_DISPATCHED,
					}},
				})
			}()
			ctx, cancel := context.WithTimeout(t.Context(), 2*time.Second)
			defer cancel()
			result, err := body.requestPrompt(ctx, []pibridge.AttachmentRef{{
				Basename: "att-file.bin", MIMEType: "application/octet-stream", Kind: "file", SHA256: strings.Repeat("a", 64),
			}}, false)
			if change == "unchanged" {
				if err != nil || result.Outcome != pibridgepb.AttachmentPromptOutcome_ATTACHMENT_PROMPT_OUTCOME_DISPATCHED {
					t.Fatalf("unchanged target result=%+v error=%v", result, err)
				}
				return
			}
			var refusal *pibridge.AttachmentPromptRefusal
			if !errors.As(err, &refusal) || refusal.Reason != "stale" {
				t.Fatalf("changed %s must refuse as stale, result=%+v error=%v", change, result, err)
			}
		})
	}
}

func stringPtr(value string) *string { return &value }

func TestValidateAttachmentSendRequestBoundsItems(t *testing.T) {
	valid := func(ids []string) attachmentSendRequest {
		return attachmentSendRequest{
			ID:   uuid.NewString(),
			Pane: "pane",
			Context: attachmentTargetContext{
				ProcessID: stringPtr("process"), Generation: stringPtr("1"),
				SessionID: stringPtr("session"), LeafID: stringPtr("leaf"),
			},
			Text:          "inspect",
			AttachmentIDs: ids,
		}
	}
	many := make([]string, 0, 9)
	for i := 0; i < 9; i++ {
		many = append(many, uuid.NewString())
	}
	for _, tc := range []struct {
		name  string
		ids   []string
		valid bool
	}{
		{name: "one", ids: []string{uuid.NewString()}, valid: true},
		{name: "eight", ids: many[:8], valid: true},
		{name: "none", ids: nil, valid: false},
		{name: "nine", ids: many, valid: false},
		{name: "duplicate", ids: []string{many[0], many[0]}, valid: false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			err := validateAttachmentSendRequest(valid(tc.ids))
			if tc.valid && err != nil {
				t.Fatalf("error = %v, want valid", err)
			}
			if !tc.valid && !errors.Is(err, errAttachmentInvalid) {
				t.Fatalf("error = %v, want invalid", err)
			}
		})
	}
}
