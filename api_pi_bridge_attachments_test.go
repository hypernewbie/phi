package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/google/uuid"
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
