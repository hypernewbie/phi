package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestHandleUseHiddenTerminal(t *testing.T) {
	withTempConfig(t)

	// Test GET is rejected (only POST allowed)
	reqGet := httptest.NewRequest(http.MethodGet, "/api/config/use-hidden-terminal", nil)
	wGet := httptest.NewRecorder()
	handleUseHiddenTerminal(wGet, reqGet)
	if wGet.Code != http.StatusMethodNotAllowed {
		t.Errorf("GET status: want 405, got %d", wGet.Code)
	}

	// Test POST invalid JSON
	reqBad := httptest.NewRequest(http.MethodPost, "/api/config/use-hidden-terminal", bytes.NewReader([]byte("bad json")))
	wBad := httptest.NewRecorder()
	handleUseHiddenTerminal(wBad, reqBad)
	if wBad.Code != http.StatusBadRequest {
		t.Errorf("bad JSON status: want 400, got %d", wBad.Code)
	}

	// Test POST enable
	body, _ := json.Marshal(map[string]bool{"enabled": true})
	reqEnable := httptest.NewRequest(http.MethodPost, "/api/config/use-hidden-terminal", bytes.NewReader(body))
	wEnable := httptest.NewRecorder()
	handleUseHiddenTerminal(wEnable, reqEnable)
	if wEnable.Code != http.StatusOK {
		t.Fatalf("enable status: want 200, got %d", wEnable.Code)
	}

	var resEnable map[string]bool
	if err := json.NewDecoder(wEnable.Body).Decode(&resEnable); err != nil {
		t.Fatalf("decode enable response: %v", err)
	}
	if !resEnable["enabled"] {
		t.Errorf("enable response: want true, got false")
	}

	// Verify persistence in loaded config
	cfg := loadConfig()
	if !cfg.UseHiddenTerminal {
		t.Errorf("saved config UseHiddenTerminal: want true, got false")
	}

	// Verify handleConfig returns use_hidden_terminal
	reqCfg := httptest.NewRequest(http.MethodGet, "/api/config", nil)
	wCfg := httptest.NewRecorder()
	handleConfig(wCfg, reqCfg)
	var cfgMap map[string]interface{}
	if err := json.NewDecoder(wCfg.Body).Decode(&cfgMap); err != nil {
		t.Fatalf("decode config response: %v", err)
	}
	if val, ok := cfgMap["use_hidden_terminal"].(bool); !ok || !val {
		t.Errorf("config map use_hidden_terminal: want true, got %v", cfgMap["use_hidden_terminal"])
	}
}

func TestHandleRunCommand(t *testing.T) {
	tempDir := t.TempDir()
	subDir1 := filepath.Join(tempDir, "wt1")
	subDir2 := filepath.Join(tempDir, "wt2")
	_ = os.MkdirAll(subDir1, 0755)
	_ = os.MkdirAll(subDir2, 0755)

	// Test GET method rejection
	reqGet := httptest.NewRequest(http.MethodGet, "/api/cmd/run", nil)
	wGet := httptest.NewRecorder()
	handleRunCommand(wGet, reqGet)
	if wGet.Code != http.StatusMethodNotAllowed {
		t.Errorf("GET status: want 405, got %d", wGet.Code)
	}

	// Test empty command rejection
	reqEmpty := httptest.NewRequest(http.MethodPost, "/api/cmd/run", bytes.NewReader([]byte(`{"command":""}`)))
	wEmpty := httptest.NewRecorder()
	handleRunCommand(wEmpty, reqEmpty)
	if wEmpty.Code != http.StatusBadRequest {
		t.Errorf("empty command status: want 400, got %d", wEmpty.Code)
	}

	// Test single worktree command execution
	reqSingle := RunCommandRequest{
		Command: "echo hello",
		Cwd:     subDir1,
	}
	bodySingle, _ := json.Marshal(reqSingle)
	req1 := httptest.NewRequest(http.MethodPost, "/api/cmd/run", bytes.NewReader(bodySingle))
	w1 := httptest.NewRecorder()
	handleRunCommand(w1, req1)
	if w1.Code != http.StatusOK {
		t.Fatalf("single run status: want 200, got %d", w1.Code)
	}

	var res1 RunCommandResponse
	if err := json.NewDecoder(w1.Body).Decode(&res1); err != nil {
		t.Fatalf("decode single response: %v", err)
	}
	if len(res1.Results) != 1 {
		t.Fatalf("expected 1 result, got %d", len(res1.Results))
	}
	if !res1.Results[0].Success {
		t.Errorf("expected success, got error: %s (output: %s)", res1.Results[0].Error, res1.Results[0].Output)
	}

	// Test multi worktree batch execution
	reqBatch := RunCommandRequest{
		Command:   "echo batch_test",
		Worktrees: []string{subDir1, subDir2},
	}
	bodyBatch, _ := json.Marshal(reqBatch)
	req2 := httptest.NewRequest(http.MethodPost, "/api/cmd/batch-run", bytes.NewReader(bodyBatch))
	w2 := httptest.NewRecorder()
	handleRunCommand(w2, req2)
	if w2.Code != http.StatusOK {
		t.Fatalf("batch run status: want 200, got %d", w2.Code)
	}

	var res2 RunCommandResponse
	if err := json.NewDecoder(w2.Body).Decode(&res2); err != nil {
		t.Fatalf("decode batch response: %v", err)
	}
	if len(res2.Results) != 2 {
		t.Fatalf("expected 2 results, got %d", len(res2.Results))
	}
	for i, r := range res2.Results {
		if !r.Success {
			t.Errorf("result %d failed: %s", i, r.Error)
		}
	}

	// Test nonexistent directory
	reqNonexistent := RunCommandRequest{
		Command: "echo test",
		Cwd:     filepath.Join(tempDir, "nonexistent"),
	}
	bodyNonexistent, _ := json.Marshal(reqNonexistent)
	req3 := httptest.NewRequest(http.MethodPost, "/api/cmd/run", bytes.NewReader(bodyNonexistent))
	w3 := httptest.NewRecorder()
	handleRunCommand(w3, req3)
	if w3.Code != http.StatusOK {
		t.Fatalf("nonexistent run status: want 200, got %d", w3.Code)
	}
	var res3 RunCommandResponse
	_ = json.NewDecoder(w3.Body).Decode(&res3)
	if len(res3.Results) != 1 || res3.Results[0].Success {
		t.Errorf("expected failure for nonexistent directory, got %+v", res3)
	}
}
