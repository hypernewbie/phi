//go:build unix

package piapp

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/creack/pty"
)

// compactProcessTape drains a child PTY so the TUI never blocks on output.
// The test synchronizes on observed text, not elapsed time.
type compactProcessTape struct {
	mu   sync.Mutex
	data bytes.Buffer
}

func (t *compactProcessTape) read(r io.Reader) {
	buf := make([]byte, 4096)
	for {
		n, err := r.Read(buf)
		if n > 0 {
			t.mu.Lock()
			_, _ = t.data.Write(buf[:n])
			t.mu.Unlock()
		}
		if err != nil {
			return
		}
	}
}

func (t *compactProcessTape) text() string {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.data.String()
}

func (t *compactProcessTape) wait(tb testing.TB, marker string) {
	tb.Helper()
	deadline := time.Now().Add(8 * time.Second)
	for time.Now().Before(deadline) {
		if strings.Contains(t.text(), marker) {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	tb.Fatalf("PTY text never contained %q: %q", marker, t.text())
}

// compactSeedSession writes one v3 session with enough old history for a
// manual summary. Psi owns this format; the fixture keeps only the fields the
// loader requires.
func compactSeedSession(t *testing.T, path, cwd, provider, model string) {
	t.Helper()
	now := time.Now().UTC().Format(time.RFC3339Nano)
	ms := time.Now().UnixMilli()
	records := []any{
		map[string]any{
			"type": "session", "version": 3, "id": "compactfixture",
			"timestamp": now, "cwd": cwd,
		},
		map[string]any{
			"type": "message", "id": "u1", "parentId": nil, "timestamp": now,
			"message": map[string]any{
				"role": "user", "content": "SEED_HISTORY", "timestamp": ms,
			},
		},
		map[string]any{
			"type": "message", "id": "a1", "parentId": "u1", "timestamp": now,
			"message": map[string]any{
				"role": "assistant",
				"content": []any{
					map[string]any{"type": "text", "text": strings.Repeat("prior ", 6000)},
				},
				"api": provider + "-messages", "provider": provider, "model": model,
				"usage": map[string]any{
					"input": 5, "output": 1, "cacheRead": 0, "cacheWrite": 0,
					"totalTokens": 6,
					"cost":        map[string]any{"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "total": 0},
				},
				"stopReason": "stop", "timestamp": ms + 1,
			},
		},
	}
	var out bytes.Buffer
	for _, record := range records {
		raw, err := json.Marshal(record)
		if err != nil {
			t.Fatal(err)
		}
		out.Write(raw)
		out.WriteByte('\n')
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, out.Bytes(), 0o600); err != nil {
		t.Fatal(err)
	}
}

func compactRecordCounts(t *testing.T, path string) (prompts int, aborted int, checkpoints int) {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	for _, line := range strings.Split(string(data), "\n") {
		if strings.TrimSpace(line) == "" {
			continue
		}
		var record struct {
			Type    string `json:"type"`
			Message struct {
				Role       string          `json:"role"`
				Content    json.RawMessage `json:"content"`
				StopReason string          `json:"stopReason"`
			} `json:"message"`
		}
		if err := json.Unmarshal([]byte(line), &record); err != nil {
			t.Fatalf("decode session record: %v", err)
		}
		switch record.Type {
		case "compaction":
			checkpoints++
		case "message":
			switch record.Message.Role {
			case "user":
				var text string
				if json.Unmarshal(record.Message.Content, &text) == nil && text == "LIVE_PROMPT_MARKER" {
					prompts++
				}
			case "assistant":
				var blocks []struct {
					Type string `json:"type"`
					Text string `json:"text"`
				}
				if json.Unmarshal(record.Message.Content, &blocks) == nil {
					for _, block := range blocks {
						if block.Type == "text" && block.Text == "ORIGINAL_PARTIAL" && record.Message.StopReason == "aborted" {
							aborted++
						}
					}
				}
			}
		}
	}
	return prompts, aborted, checkpoints
}

// TestActualPsiBridgeCompactSettlement runs one manual compact through Phi's
// real HTTP endpoint to a built Psi. The active run is cancelled once, settles,
// then the summary starts and commits exactly one checkpoint.
func TestActualPsiBridgeCompactSettlement(t *testing.T) {
	binary := os.Getenv("PSI_COMPACT_TEST_BINARY")
	if binary == "" {
		t.Skip("PSI_COMPACT_TEST_BINARY is not set")
	}
	if !filepath.IsAbs(binary) {
		t.Fatalf("PSI_COMPACT_TEST_BINARY must be absolute: %q", binary)
	}
	if _, err := os.Stat(binary); err != nil {
		t.Fatalf("PSI_COMPACT_TEST_BINARY: %v", err)
	}

	const (
		instructionMarker = "INSTRUCTION_MARKER_9F3C"
		partialMarker     = "ORIGINAL_PARTIAL"
	)
	var calls struct {
		sync.Mutex
		seen   int
		bodies []string
	}
	releaseSummary := make(chan struct{})
	stopStub := make(chan struct{})
	summarySeen := make(chan string, 1)
	runSeen := make(chan string, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/messages" {
			http.NotFound(w, r)
			return
		}
		body, err := io.ReadAll(r.Body)
		if err != nil {
			t.Errorf("read provider body: %v", err)
			return
		}
		calls.Lock()
		calls.seen++
		index := calls.seen
		calls.bodies = append(calls.bodies, string(body))
		calls.Unlock()
		w.Header().Set("Content-Type", "text/event-stream")
		w.(http.Flusher).Flush()
		switch index {
		case 1:
			select {
			case runSeen <- string(body):
			default:
			}
			fmt.Fprint(w, compactProcessSSEStart("ORIGINAL_STREAM"))
			fmt.Fprintf(w, "event: content_block_delta\ndata: {\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":%q}}\n\n", partialMarker)
			w.(http.Flusher).Flush()
			select {
			case <-stopStub:
			case <-r.Context().Done():
			}
		case 2:
			select {
			case summarySeen <- string(body):
			default:
			}
			select {
			case <-releaseSummary:
			case <-stopStub:
			case <-r.Context().Done():
				return
			}
			fmt.Fprint(w, compactProcessSSEText("SUMMARY_COMMITTED"))
		default:
			t.Errorf("unexpected provider call %d: %s", index, body)
			fmt.Fprint(w, compactProcessSSEText("EXTRA_REPLY"))
		}
	}))
	defer server.Close()
	defer close(stopStub)

	home, work := t.TempDir(), t.TempDir()
	agentDir := filepath.Join(home, ".pi", "agent")
	writeCompactProcessFile(t, filepath.Join(agentDir, "settings.json"), `{"defaultProvider":"anthropic","defaultModel":"local-model","defaultThinkingLevel":"off","compaction":{"enabled":false,"keepRecentTokens":50}}`)
	writeCompactProcessFile(t, filepath.Join(agentDir, "models.json"), `{"providers":{"anthropic":{"models":[{"id":"local-model","api":"anthropic-messages","baseUrl":"`+server.URL+`","contextWindow":22000,"maxTokens":4096,"input":["text"]}]}}}`)
	writeCompactProcessFile(t, filepath.Join(agentDir, "auth.json"), `{"anthropic":{"type":"api_key","key":"synthetic-key"}}`)
	sessionPath := filepath.Join(agentDir, "sessions", "compactfixture.jsonl")
	compactSeedSession(t, sessionPath, work, "anthropic", "local-model")

	b := startTestBridge(t)
	pane := "pane-compact-process"
	env, _, managed := b.Provision(pane, true)
	if !managed {
		t.Fatal("bridge did not provision the pane")
	}

	cmd := exec.Command(binary, "--deny-project", "--no-tools", "--session", sessionPath)
	cmd.Dir = work
	cmd.Env = []string{
		"PATH=/usr/local/bin:/usr/bin:/bin",
		"HOME=" + home,
		"PI_CODING_AGENT_DIR=" + agentDir,
		"PI_CODING_AGENT_SESSION_DIR=",
		"TERM=xterm-256color",
		"LANG=C.UTF-8",
		"TMPDIR=/tmp",
	}
	for key, value := range env {
		cmd.Env = append(cmd.Env, key+"="+value)
	}
	master, err := pty.StartWithSize(cmd, &pty.Winsize{Cols: 100, Rows: 30})
	if err != nil {
		t.Fatal(err)
	}
	tape := &compactProcessTape{}
	go tape.read(master)
	var waitOnce sync.Once
	var waitErr error
	waitChild := func() error {
		waitOnce.Do(func() { waitErr = cmd.Wait() })
		return waitErr
	}
	t.Cleanup(func() {
		_ = master.Close()
		if cmd.Process != nil {
			_ = cmd.Process.Kill()
		}
		_ = waitChild()
	})

	tape.wait(t, "esc interrupt")
	_, _ = master.WriteString("LIVE_PROMPT_MARKER\r")
	select {
	case body := <-runSeen:
		if !strings.Contains(body, "LIVE_PROMPT_MARKER") {
			t.Fatalf("active request lacks the prompt marker: %s", body)
		}
	case <-time.After(8 * time.Second):
		t.Fatalf("active provider request never arrived: %q", tape.text())
	}
	tape.wait(t, partialMarker)

	var generation, telemetry string
	deadline := time.Now().Add(8 * time.Second)
	for time.Now().Before(deadline) {
		state := b.PaneSnapshot(pane)
		if state.State == piBridgeManaged && state.Connected != nil && *state.Connected &&
			state.Running != nil && *state.Running && state.Generation != "" && state.TelemetryRevision != "" {
			generation, telemetry = state.Generation, state.TelemetryRevision
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	if generation == "" || telemetry == "" {
		t.Fatalf("pane never reached a running bridge snapshot: %+v", b.PaneSnapshot(pane))
	}

	body, err := json.Marshal(map[string]string{
		"pane": pane, "generation": generation, "telemetry_revision": telemetry,
		"custom_instructions": instructionMarker,
	})
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, "/api/pi-bridge/compact", bytes.NewReader(body))
	req.Host = "example.com"
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	api := NewAPI(func() *Bridge { return b }, nil, nil)
	handlerDone := make(chan struct{})
	go func() {
		api.HandlePiBridgeCompact(rec, req)
		close(handlerDone)
	}()

	var summaryBody string
	select {
	case summaryBody = <-summarySeen:
	case <-handlerDone:
		t.Fatalf("compact rejected before the summary request: status=%d body=%s", rec.Code, rec.Body.String())
	case <-time.After(8 * time.Second):
		t.Fatalf("summary request never arrived: %q", tape.text())
	}
	if !strings.Contains(summaryBody, instructionMarker) {
		t.Fatalf("summary request lacks the instruction marker: %s", summaryBody)
	}
	prompts, aborted, checkpoints := compactRecordCounts(t, sessionPath)
	if prompts != 1 || aborted != 1 || checkpoints != 0 {
		t.Fatalf("durable prompts/aborted/checkpoints at summary start = %d/%d/%d, want 1/1/0", prompts, aborted, checkpoints)
	}
	select {
	case <-handlerDone:
		t.Fatalf("compact answered while the summary was held: status=%d body=%s", rec.Code, rec.Body.String())
	default:
	}

	close(releaseSummary)
	select {
	case <-handlerDone:
	case <-time.After(8 * time.Second):
		t.Fatalf("compact response never arrived: %q", tape.text())
	}
	if rec.Code != http.StatusOK {
		t.Fatalf("compact status = %d body = %s", rec.Code, rec.Body.String())
	}
	var result map[string]string
	if err := json.Unmarshal(rec.Body.Bytes(), &result); err != nil {
		t.Fatalf("decode compact response %q: %v", rec.Body.String(), err)
	}
	if result["outcome"] != "completed" || result["request_id"] == "" {
		t.Fatalf("compact response = %v, want completed with request_id", result)
	}
	tape.wait(t, "Compacted from")
	_, _ = master.WriteString("/quit\r")
	if err := waitChild(); err != nil {
		t.Fatalf("psi exit: %v\n%s", err, tape.text())
	}
	prompts, aborted, checkpoints = compactRecordCounts(t, sessionPath)
	if prompts != 1 || aborted != 1 || checkpoints != 1 {
		t.Fatalf("durable prompts/aborted/checkpoints = %d/%d/%d, want 1/1/1", prompts, aborted, checkpoints)
	}
	calls.Lock()
	seen := calls.seen
	calls.Unlock()
	if seen != 2 {
		t.Fatalf("provider calls = %d, want the interrupted run and one summary", seen)
	}
}

func writeCompactProcessFile(t *testing.T, path, body string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
}

func compactProcessSSEStart(id string) string {
	return fmt.Sprintf("event: message_start\ndata: {\"message\":{\"id\":%q,\"model\":\"local-model\",\"usage\":{\"input_tokens\":5}}}\n\n", id) +
		"event: content_block_start\ndata: {\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n"
}

func compactProcessSSEText(text string) string {
	return compactProcessSSEStart("reply") +
		fmt.Sprintf("event: content_block_delta\ndata: {\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":%q}}\n\n", text) +
		"event: content_block_stop\ndata: {\"index\":0}\n\nevent: message_delta\ndata: {\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":1}}\n\nevent: message_stop\ndata: {}\n\n"
}
