package main

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// withTempHomeForHistory points os.UserHomeDir at a fresh tmp dir so
// the handler writes to ~/.phi/prompt_history.json there. Mirrors the
// withTempHome pattern in api_attachments_test.go but scoped narrowly
// to the prompt-history handler tests.
func withTempHomeForHistory(t *testing.T) string {
	t.Helper()
	tmp := t.TempDir()
	t.Setenv("HOME", tmp)
	t.Setenv("USERPROFILE", tmp)
	return tmp
}

func resetPromptHistoryState(t *testing.T) {
	t.Helper()
	promptHistoryStoreMu.Lock()
	promptHistoryStore = nil
	promptHistoryLoadErr = nil
	promptHistoryStoreMu.Unlock()
}

func postJSON(t *testing.T, path, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	return w
}

func TestHandlePromptHistoryAppend_RecordsAndPersists(t *testing.T) {
	home := withTempHomeForHistory(t)
	resetPromptHistoryState(t)

	w := postJSON(t, "/api/prompt-history/append", `{"text":"fix the login bug","cwd":"/proj/a"}`)
	handlePromptHistoryAppend(w, httptest.NewRequest(http.MethodPost, "/api/prompt-history/append", strings.NewReader(`{"text":"fix the login bug","cwd":"/proj/a"}`)))

	if w.Code != http.StatusOK {
		t.Fatalf("status: %d body=%s", w.Code, w.Body.String())
	}

	// File actually exists at ~/.phi/prompt_history.json.
	path := filepath.Join(home, ".phi", "prompt_history.json")
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("file not written: %v", err)
	}
	body, _ := os.ReadFile(path)
	if !strings.Contains(string(body), "fix the login bug") {
		t.Fatalf("written file missing prompt: %s", body)
	}
}

func TestHandlePromptHistoryAppend_SkipsEmptyText(t *testing.T) {
	withTempHomeForHistory(t)
	resetPromptHistoryState(t)

	w := postJSON(t, "/api/prompt-history/append", `{"text":"   ","cwd":"/p"}`)
	handlePromptHistoryAppend(w, httptest.NewRequest(http.MethodPost, "/api/prompt-history/append", strings.NewReader(`{"text":"   ","cwd":"/p"}`)))

	if w.Code != http.StatusOK {
		t.Fatalf("status: %d", w.Code)
	}
	// No file should exist (empty entries skip persist).
	path := filepath.Join(home_for(t), ".phi", "prompt_history.json")
	if _, err := os.Stat(path); err == nil {
		t.Fatalf("file was written for empty prompt (should skip)")
	}
}

func TestHandlePromptHistoryRecent_FiltersByCwd(t *testing.T) {
	withTempHomeForHistory(t)
	resetPromptHistoryState(t)

	// Seed: 3 entries in /proj/a, 2 entries in /proj/b.
	for _, p := range []struct{ text, cwd string }{
		{"ls", "/proj/a"}, {"cat README", "/proj/a"}, {"git status", "/proj/a"},
		{"pwd", "/proj/b"}, {"ls -la", "/proj/b"},
	} {
		w := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, "/api/prompt-history/append",
			strings.NewReader(`{"text":"`+p.text+`","cwd":"`+p.cwd+`"}`))
		req.Header.Set("Content-Type", "application/json")
		handlePromptHistoryAppend(w, req)
		if w.Code != http.StatusOK {
			t.Fatalf("seed %s/%s: %d body=%s", p.cwd, p.text, w.Code, w.Body.String())
		}
	}

	// /recent?cwd=/proj/a → 3 entries.
	{
		req := httptest.NewRequest(http.MethodGet, "/api/prompt-history/recent?cwd=/proj/a&n=20", nil)
		w := httptest.NewRecorder()
		handlePromptHistoryRecent(w, req)
		if w.Code != http.StatusOK {
			t.Fatalf("status: %d", w.Code)
		}
		var entries []historyEntryForTest
		if err := json.Unmarshal(w.Body.Bytes(), &entries); err != nil {
			t.Fatalf("decode: %v body=%s", err, w.Body.String())
		}
		if len(entries) != 3 {
			t.Fatalf("want 3 /proj/a entries, got %d", len(entries))
		}
		for _, e := range entries {
			if e.Cwd != "/proj/a" {
				t.Fatalf("wrong cwd leaked: %+v", e)
			}
		}
	}

	// /recent?cwd=/proj/b → 2 entries, newest first.
	{
		req := httptest.NewRequest(http.MethodGet, "/api/prompt-history/recent?cwd=/proj/b&n=20", nil)
		w := httptest.NewRecorder()
		handlePromptHistoryRecent(w, req)
		var entries []historyEntryForTest
		if err := json.Unmarshal(w.Body.Bytes(), &entries); err != nil {
			t.Fatalf("decode: %v", err)
		}
		if len(entries) != 2 {
			t.Fatalf("want 2 /proj/b entries, got %d", len(entries))
		}
		// Newest first: "ls -la" was last appended.
		if entries[0].Text != "ls -la" {
			t.Fatalf("newest first broken: got %+v", entries)
		}
	}
}

func TestHandlePromptHistoryRecent_RequiresGet(t *testing.T) {
	withTempHomeForHistory(t)
	resetPromptHistoryState(t)
	req := httptest.NewRequest(http.MethodPost, "/api/prompt-history/recent", nil)
	w := httptest.NewRecorder()
	handlePromptHistoryRecent(w, req)
	if w.Code != http.StatusMethodNotAllowed {
		t.Fatalf("expected 405, got %d", w.Code)
	}
}

func TestHandlePromptHistoryAppend_RequiresPost(t *testing.T) {
	withTempHomeForHistory(t)
	resetPromptHistoryState(t)
	req := httptest.NewRequest(http.MethodGet, "/api/prompt-history/append", nil)
	w := httptest.NewRecorder()
	handlePromptHistoryAppend(w, req)
	if w.Code != http.StatusMethodNotAllowed {
		t.Fatalf("expected 405, got %d", w.Code)
	}
}

// historyEntryForTest is a local mirror of prompt_history.Entry for
// decoding the /recent handler's response body without pulling the
// package into the test binary.
type historyEntryForTest struct {
	Ts   string `json:"ts"`
	Cwd  string `json:"cwd"`
	Text string `json:"text"`
}

// home_for returns the active test HOME (only meaningful after
// withTempHomeForHistory has set it).
func home_for(t *testing.T) string {
	t.Helper()
	return os.Getenv("HOME")
}

// silence unused import for io in case it's stripped by future refactors.
var _ = io.Discard
var _ = bytes.NewReader
