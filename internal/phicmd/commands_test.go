package phicmd

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	wspb "github.com/hypernewbie/phi/pkg/ws/pb"
)

func TestCmdServersJSON(t *testing.T) {
	b := newFakeBackend(t)
	b.mu.Lock()
	b.instances["live-1"] = &wspb.ControlState{Sid: "live-1", Title: "A session", Status: "live"}
	b.mu.Unlock()
	prefix := profileEnv(t, b)
	out, code := captureRun(t, append(prefix, "servers", "--json")...)
	if code != ExitOK {
		t.Fatalf("exit=%d out=%s", code, out)
	}
	var doc struct {
		Servers []ServerRow `json:"servers"`
	}
	if err := json.Unmarshal([]byte(out), &doc); err != nil {
		t.Fatalf("json: %v\n%s", err, out)
	}
	if len(doc.Servers) != 1 {
		t.Fatalf("servers: %+v", doc.Servers)
	}
	row := doc.Servers[0]
	if row.ID != "fake" || row.Health != "up" || row.Hostname != "fake-host" {
		t.Fatalf("row: %+v", row)
	}
	if row.LiveSessions == nil || *row.LiveSessions != 1 {
		t.Fatalf("live sessions: %+v", row)
	}
}

func TestCmdServersDownBackend(t *testing.T) {
	b := newFakeBackend(t)
	b.ts.Close() // nothing listens anymore
	prefix := profileEnv(t, b)
	out, code := captureRun(t, append(prefix, "servers", "--json")...)
	if code != ExitOK {
		t.Fatalf("servers reports per-row health; exit=%d out=%s", code, out)
	}
	if !strings.Contains(out, `"down"`) {
		t.Fatalf("want down row: %s", out)
	}
}

func TestCmdStatusJSON(t *testing.T) {
	b := newFakeBackend(t)
	b.mu.Lock()
	busy := true
	b.instances["live-1"] = &wspb.ControlState{Sid: "live-1", Title: "working", Cwd: "/w1", Status: "live", Busy: busy, Model: strptr("claude-3")}
	b.terminals = []map[string]any{{"id": "p1", "coder": "bash", "cwd": "/w1", "title": "shell"}}
	b.mu.Unlock()
	prefix := profileEnv(t, b)
	out, code := captureRun(t, append(prefix, "status", "--json")...)
	if code != ExitOK {
		t.Fatalf("exit=%d out=%s", code, out)
	}
	var doc struct {
		Sessions []StatusRow    `json:"sessions"`
		Panes    []PaneRow      `json:"panes"`
		Coders   []coderSummary `json:"coders"`
	}
	if err := json.Unmarshal([]byte(out), &doc); err != nil {
		t.Fatalf("json: %v\n%s", err, out)
	}
	if len(doc.Sessions) != 1 || doc.Sessions[0].SID != "live-1" || !doc.Sessions[0].Busy || doc.Sessions[0].Model != "claude-3" {
		t.Fatalf("sessions: %+v", doc.Sessions)
	}
	if len(doc.Panes) != 1 || doc.Panes[0].ID != "p1" {
		t.Fatalf("panes: %+v", doc.Panes)
	}
	if len(doc.Coders) == 0 {
		t.Fatalf("coders: %+v", doc.Coders)
	}
}

func TestCmdTabsJSON(t *testing.T) {
	b := newFakeBackend(t)
	b.mu.Lock()
	b.instances["live-1"] = &wspb.ControlState{Sid: "live-1", Title: "chat", Cwd: "/w1", Status: "live"}
	b.sessions = []map[string]any{{"id": "hist-1", "title": "old work", "cwd": "/w1", "coder": "pi", "time_updated": "2026-01-01T00:00:00Z"}}
	b.terminals = []map[string]any{{"id": "p1", "coder": "bash", "cwd": "/w1"}}
	b.mu.Unlock()
	prefix := profileEnv(t, b)
	out, code := captureRun(t, append(prefix, "tabs", "--json")...)
	if code != ExitOK {
		t.Fatalf("exit=%d out=%s", code, out)
	}
	var doc struct {
		Tabs []struct {
			ID       string               `json:"id"`
			Sessions []persistedSession   `json:"sessions"`
			Live     []liveSessionSummary `json:"live"`
		} `json:"tabs"`
		Panes []PaneRow `json:"panes"`
	}
	if err := json.Unmarshal([]byte(out), &doc); err != nil {
		t.Fatalf("json: %v\n%s", err, out)
	}
	var piTab, bashTab bool
	for _, tab := range doc.Tabs {
		switch tab.ID {
		case "pi":
			piTab = true
			if len(tab.Sessions) != 1 || tab.Sessions[0].ID != "hist-1" {
				t.Fatalf("pi sessions: %+v", tab.Sessions)
			}
			if len(tab.Live) != 1 || tab.Live[0].SID != "live-1" {
				t.Fatalf("pi live: %+v", tab.Live)
			}
		case "bash":
			bashTab = true
			if len(tab.Sessions) != 0 {
				t.Fatalf("bash sessions should be empty: %+v", tab.Sessions)
			}
		}
	}
	if !piTab || !bashTab {
		t.Fatalf("tabs missing: pi=%v bash=%v (%+v)", piTab, bashTab, doc.Tabs)
	}
	if len(doc.Panes) != 1 {
		t.Fatalf("panes: %+v", doc.Panes)
	}
}

func TestCmdUseStateRoundTrip(t *testing.T) {
	b := newFakeBackend(t)
	prefix := profileEnv(t, b)
	_, code := captureRun(t, append(prefix, "use", "pi", "--cwd", "/w1", "--session", "live-9")...)
	if code != ExitOK {
		t.Fatalf("use exit=%d", code)
	}
	st, err := LoadState()
	if err != nil || st.Coder != "pi" || st.Cwd != "/w1" || st.Session != "live-9" {
		t.Fatalf("state: %+v err=%v", st, err)
	}
	// use --clear resets
	_, code = captureRun(t, append(prefix, "use", "--clear")...)
	if code != ExitOK {
		t.Fatalf("clear exit=%d", code)
	}
	st, _ = LoadState()
	if st.Coder != "" || st.Session != "" {
		t.Fatalf("cleared state: %+v", st)
	}
}

func TestCmdSessionsHuman(t *testing.T) {
	b := newFakeBackend(t)
	b.mu.Lock()
	b.sessions = []map[string]any{{"id": "s1", "title": "fix bug", "cwd": "/w1", "coder": "pi", "time_updated": "2026-01-01T00:00:00Z"}}
	b.mu.Unlock()
	prefix := profileEnv(t, b)
	out, code := captureRun(t, append(prefix, "sessions")...)
	if code != ExitOK {
		t.Fatalf("exit=%d", code)
	}
	if !strings.Contains(out, "s1") || !strings.Contains(out, "fix bug") {
		t.Fatalf("human output: %s", out)
	}
}

func TestCmdTranscriptLiveAndPersisted(t *testing.T) {
	b := newFakeBackend(t)
	b.mu.Lock()
	b.instances["live-1"] = &wspb.ControlState{Sid: "live-1", Title: "chat", Cwd: "/w1", Status: "live"}
	b.mu.Unlock()
	prefix := profileEnv(t, b)
	out, code := captureRun(t, append(prefix, "transcript", "--session", "live-1", "--json")...)
	if code != ExitOK {
		t.Fatalf("live exit=%d out=%s", code, out)
	}
	if !strings.Contains(out, `"session": "live-1"`) {
		t.Fatalf("live transcript: %s", out)
	}
	out, code = captureRun(t, append(prefix, "transcript", "--id", "hist-9", "--json")...)
	if code != ExitOK {
		t.Fatalf("persisted exit=%d", code)
	}
	if !strings.Contains(out, `"id": "hist-9"`) || !strings.Contains(out, "hi") {
		t.Fatalf("persisted transcript: %s", out)
	}
}

func TestCmdSendSpawnsAndStreams(t *testing.T) {
	b := newFakeBackend(t)
	prefix := profileEnv(t, b)
	out, code := captureRun(t, append(prefix, "send", "add a test", "--json", "--timeout", "20s")...)
	if code != ExitOK {
		t.Fatalf("exit=%d out=%s", code, out)
	}
	lines := strings.Split(strings.TrimSpace(out), "\n")
	var sawEnd, sawTurnEnd bool
	for _, line := range lines {
		var ev SendEvent
		if err := json.Unmarshal([]byte(line), &ev); err != nil {
			t.Fatalf("ndjson line: %q: %v", line, err)
		}
		if ev.Type == "session" && ev.SID == "spawned-1" {
			// spawned path
		}
		if ev.Type == "message_end" && ev.Text == "echo: add a test" {
			sawEnd = true
		}
		if ev.Type == "turn_end" {
			sawTurnEnd = true
		}
	}
	if !sawEnd || !sawTurnEnd {
		t.Fatalf("stream: end=%v turn_end=%v out=%s", sawEnd, sawTurnEnd, out)
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	if len(b.promptSeen) != 1 || !strings.HasSuffix(b.promptSeen[0], "add a test") {
		t.Fatalf("prompt seen: %v", b.promptSeen)
	}
}

func TestCmdSendReusesOnlyLiveSession(t *testing.T) {
	b := newFakeBackend(t)
	b.mu.Lock()
	b.instances["live-1"] = &wspb.ControlState{Sid: "live-1", Title: "a", Cwd: "/w1", Status: "live"}
	b.mu.Unlock()
	prefix := profileEnv(t, b)
	_, code := captureRun(t, append(prefix, "send", "hi", "--json", "--timeout", "20s")...)
	if code != ExitOK {
		t.Fatalf("exit=%d", code)
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	if len(b.promptSeen) != 1 || !strings.HasPrefix(b.promptSeen[0], "live-1:") {
		t.Fatalf("prompt should target live-1: %v", b.promptSeen)
	}
}

func TestCmdSendAmbiguousIsUsage(t *testing.T) {
	b := newFakeBackend(t)
	b.mu.Lock()
	b.instances["live-1"] = &wspb.ControlState{Sid: "live-1", Title: "a", Cwd: "/w1", Status: "live"}
	b.instances["live-2"] = &wspb.ControlState{Sid: "live-2", Title: "b", Cwd: "/w2", Status: "live"}
	b.mu.Unlock()
	prefix := profileEnv(t, b)
	_, code := captureRun(t, append(prefix, "send", "hi")...)
	if code != ExitUsage {
		t.Fatalf("ambiguous live sessions must be usage error, got %d", code)
	}
}

func TestCmdInputSendsVerbatim(t *testing.T) {
	b := newFakeBackend(t)
	b.mu.Lock()
	b.terminals = []map[string]any{{"id": "p1", "coder": "bash", "cwd": "/w1"}}
	b.paneEcho = true
	b.mu.Unlock()
	prefix := profileEnv(t, b)
	_, code := captureRun(t, append(prefix, "input", "ls -la\\r")...)
	if code != ExitOK {
		t.Fatalf("exit=%d", code)
	}
	b.waitForPaneInput(t, "ls -la\r")
}

func TestCmdInputHex(t *testing.T) {
	b := newFakeBackend(t)
	b.mu.Lock()
	b.terminals = []map[string]any{{"id": "p1", "coder": "bash", "cwd": "/w1"}}
	b.mu.Unlock()
	prefix := profileEnv(t, b)
	_, code := captureRun(t, append(prefix, "input", "--hex", "1b5b417e")...)
	if code != ExitOK {
		t.Fatalf("exit=%d", code)
	}
	b.waitForPaneInput(t, "\x1b[A~")
}

func TestCmdInputNoPaneIsNotFound(t *testing.T) {
	b := newFakeBackend(t)
	prefix := profileEnv(t, b)
	_, code := captureRun(t, append(prefix, "input", "x")...)
	if code != ExitNotFound {
		t.Fatalf("want not-found, got %d", code)
	}
}

func TestCmdModelsLiveSession(t *testing.T) {
	b := newFakeBackend(t)
	b.mu.Lock()
	b.instances["live-1"] = &wspb.ControlState{Sid: "live-1", Title: "a", Cwd: "/w1", Status: "live", Model: strptr("claude-3")}
	b.mu.Unlock()
	prefix := profileEnv(t, b)
	argv := append(append(prefix, "--session", "live-1"), "models", "--json")
	out, code := captureRun(t, argv...)
	if code != ExitOK {
		t.Fatalf("exit=%d out=%s", code, out)
	}
	if !strings.Contains(out, `"provider": "anthropic"`) || !strings.Contains(out, `"current_model": "claude-3"`) {
		t.Fatalf("models json: %s", out)
	}
}

func TestCmdModelsRecipeCoder(t *testing.T) {
	b := newFakeBackend(t)
	b.mu.Lock()
	b.coders = map[string]any{
		"gemini": map[string]any{"id": "gemini", "order": 0, "name": "Gemini", "sidebar_visible": true,
			"capabilities": map[string]bool{"list": true},
			"presets":      []map[string]string{{"name": "pro", "value": "gemini-pro"}},
			"model_switch": []map[string]any{{"send": "/model set {model}\r", "delay_ms": 100}}},
	}
	b.mu.Unlock()
	prefix := profileEnv(t, b)
	argv := append(append(prefix, "--coder", "gemini"), "models", "--json")
	out, code := captureRun(t, argv...)
	if code != ExitOK {
		t.Fatalf("exit=%d out=%s", code, out)
	}
	if !strings.Contains(out, `/model set {model}\r`) {
		t.Fatalf("recipe json: %s", out)
	}
}

func TestCmdModelSetLiveSession(t *testing.T) {
	b := newFakeBackend(t)
	b.mu.Lock()
	b.instances["live-1"] = &wspb.ControlState{Sid: "live-1", Title: "a", Cwd: "/w1", Status: "live"}
	b.mu.Unlock()
	prefix := profileEnv(t, b)
	argv := append(append(prefix, "--session", "live-1"), "model", "set", "anthropic/claude-3", "--json")
	out, code := captureRun(t, argv...)
	if code != ExitOK {
		t.Fatalf("exit=%d out=%s", code, out)
	}
	if !strings.Contains(out, "anthropic/claude-3") {
		t.Fatalf("set model json: %s", out)
	}
}

func TestCmdModelSetRecipeTypesIntoPane(t *testing.T) {
	b := newFakeBackend(t)
	b.mu.Lock()
	b.coders = map[string]any{
		"gemini": map[string]any{"id": "gemini", "order": 0, "name": "Gemini", "sidebar_visible": true,
			"capabilities": map[string]bool{"list": true},
			"model_switch": []map[string]any{{"send": "/model set {model}\r"}}},
	}
	b.terminals = []map[string]any{{"id": "p9", "coder": "gemini", "cwd": "/w1"}}
	b.mu.Unlock()
	prefix := profileEnv(t, b)
	argv := append(append(append(prefix, "--coder", "gemini"), "model", "set", "gemini-pro$&x", "--pane", "p9", "--json"), "--timeout", "20s")
	_, code := captureRun(t, argv...)
	if code != ExitOK {
		t.Fatalf("exit=%d", code)
	}
	// Literal substitution: $& must not expand.
	b.waitForPaneInput(t, "/model set gemini-pro$&x\r")
}

func TestCmdModelSetNoRecipeIsHonest(t *testing.T) {
	b := newFakeBackend(t)
	prefix := profileEnv(t, b)
	// No live session, no recipe on pi... but pi panes use the bridge;
	// with no pane at all the honest answer is a usage error naming pane.
	_, code := captureRun(t, append(prefix, "model", "set", "whatever")...)
	if code != ExitError && code != ExitUsage {
		t.Fatalf("want error/usage, got %d", code)
	}
}

func TestCmdGitViews(t *testing.T) {
	b := newFakeBackend(t)
	b.mu.Lock()
	b.rawDiff = "diff --git a/x b/x\n+added\n"
	b.mu.Unlock()
	prefix := profileEnv(t, b)
	out, code := captureRun(t, append(prefix, "git", "status")...)
	if code != ExitOK || !strings.Contains(out, "M file.go") {
		t.Fatalf("status: %d %s", code, out)
	}
	out, code = captureRun(t, append(prefix, "git", "diff")...)
	if code != ExitOK || !strings.Contains(out, "+added") {
		t.Fatalf("diff: %d %s", code, out)
	}
	out, code = captureRun(t, append(prefix, "git", "diff", "--json")...)
	if code != ExitOK || !strings.Contains(out, `"text"`) {
		t.Fatalf("diff json: %d %s", code, out)
	}
}

func TestCmdRunJSON(t *testing.T) {
	b := newFakeBackend(t)
	prefix := profileEnv(t, b)
	out, code := captureRun(t, append(prefix, "run", "make test", "--json")...)
	if code != ExitOK {
		t.Fatalf("exit=%d", code)
	}
	if !strings.Contains(out, `"exit_code": 0`) || !strings.Contains(out, `"worktree": "/w1"`) {
		t.Fatalf("run json: %s", out)
	}
}

func TestCmdRawGet(t *testing.T) {
	b := newFakeBackend(t)
	prefix := profileEnv(t, b)
	out, code := captureRun(t, append(prefix, "raw", "GET", "/api/version")...)
	if code != ExitOK || !strings.Contains(out, "test") {
		t.Fatalf("raw: %d %s", code, out)
	}
}

func TestExitCodesAuthAndUsage(t *testing.T) {
	b := newFakeBackend(t)
	b.mu.Lock()
	b.authEnabled = true
	b.password = "pw"
	b.mu.Unlock()
	prefix := profileEnv(t, b)
	_, code := captureRun(t, append(prefix, "status")...)
	if code != ExitAuth {
		t.Fatalf("no password -> auth exit, got %d", code)
	}
	out, code := captureRun(t, append(append(prefix, "--password-file", writeTemp(t, "pw")), "status", "--json")...)
	if code != ExitOK || !strings.Contains(out, `"coders"`) {
		t.Fatalf("password file login: %d %s", code, out)
	}
	// usage
	_, code = captureRun(t, append(prefix, "send")...)
	if code != ExitUsage {
		t.Fatalf("missing arg -> usage, got %d", code)
	}
}

func TestExitCodeNotFound(t *testing.T) {
	b := newFakeBackend(t)
	prefix := profileEnv(t, b)
	_, code := captureRun(t, append(append(prefix, "--server", "nosuch"), "status")...)
	if code != ExitNotFound {
		t.Fatalf("unknown server -> not-found, got %d", code)
	}
}

func TestUnescapeInput(t *testing.T) {
	cases := map[string]string{
		`ls\r`:            "ls\r",
		`a\tb`:            "a\tb",
		`c:\\d`:           `c:\d`,
		`\x1b[A`:          "\x1b[A",
		`plain`:           "plain",
		`back \xZZ stays`: "back \\xZZ stays",
	}
	for in, want := range cases {
		if got := unescapeInput(in); got != want {
			t.Errorf("unescape(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestRecipeBoundsAndSubstitution(t *testing.T) {
	ctx := context.Background()
	base := []recipeStep{{Send: "/model set {model}\r"}}
	if err := runRecipe(ctx, base, "m1", func([]byte) error { return nil }); err != nil {
		t.Fatalf("valid recipe rejected: %v", err)
	}
	// literal substitution of $&
	var got []byte
	_ = runRecipe(ctx, base, "pro$&x", func(b []byte) error { got = b; return nil })
	if string(got) != "/model set pro$&x\r" {
		t.Fatalf("substitution: %q", got)
	}
	// control chars rejected
	if err := runRecipe(ctx, base, "m\x1b", func([]byte) error { return nil }); err == nil {
		t.Fatal("control char accepted")
	}
	// too many steps
	many := make([]recipeStep, maxRecipeSteps+1)
	for i := range many {
		many[i] = recipeStep{Send: "x"}
	}
	if err := runRecipe(ctx, many, "m", func([]byte) error { return nil }); err == nil {
		t.Fatal("oversized recipe accepted")
	}
	// step bytes
	big := recipeStep{Send: strings.Repeat("x", maxRecipeStepBytes+1)}
	if err := runRecipe(ctx, []recipeStep{big}, "m", func([]byte) error { return nil }); err == nil {
		t.Fatal("oversized step accepted")
	}
	// total delay
	slow := []recipeStep{{Send: "x", DelayMs: 4000}, {Send: "y", DelayMs: 2000}}
	if err := runRecipe(ctx, slow, "m", func([]byte) error { return nil }); err == nil {
		t.Fatal("slow recipe accepted")
	}
	// abort on send failure, no replay
	var sends int
	err := runRecipe(ctx, []recipeStep{{Send: "a"}, {Send: "b"}}, "m", func([]byte) error {
		sends++
		if sends == 1 {
			return errFakeSend
		}
		return nil
	})
	if err == nil || sends != 1 {
		t.Fatalf("abort: err=%v sends=%d", err, sends)
	}
	// delay respected between steps (fast path: zero-delay recipe skips waits)
	start := time.Now()
	_ = runRecipe(ctx, []recipeStep{{Send: "a"}, {Send: "b"}}, "m", func([]byte) error { return nil })
	if time.Since(start) > 500*time.Millisecond {
		t.Fatal("zero-delay recipe should not wait")
	}
}

var errFakeSend = &fakeSendError{}

type fakeSendError struct{}

func (*fakeSendError) Error() string { return "send failed" }

func writeTemp(t *testing.T, content string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "pw")
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}
