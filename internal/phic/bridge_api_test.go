package phic

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// bridgeAPIRecorder serves every Pi bridge endpoint once and records the
// calls so tests assert both directions of the wire contract.
type bridgeAPIRecorder struct {
	mu     chan struct{} // closed after init; guards below via test serialization
	gets   []string
	posts  []string
	bodies []string

	models   string
	thinking string
	skills   string
	history  string
	setModel string
	setThink string
	invoke   string
	compactS int
	compactB string
	reloadS  int
	reloadB  string
}

func newBridgeRecorder() *bridgeAPIRecorder {
	r := &bridgeAPIRecorder{
		models:   `{"models":[{"provider":"anthropic","id":"claude-sonnet-4-5"}],"truncated":false,"unavailable":false}`,
		thinking: `{"levels":["off","medium","high"],"provider":"anthropic","model":"claude-sonnet-4-5","process_id":"pi-1","generation":"7","unavailable":false}`,
		skills:   `{"skills":[{"name":"update_ae","description":"pull and rebuild"}],"truncated":false,"unavailable":false,"process_id":"pi-1","generation":"7"}`,
		history:  `{"entries":["fix the parser","run tests"],"unavailable":false}`,
		setModel: `{"ok":true}`,
		setThink: `{"ok":true}`,
		invoke:   `{"ok":true}`,
		compactS: http.StatusOK,
		compactB: `{"outcome":"completed"}`,
		reloadS:  http.StatusAccepted,
		reloadB:  `{"outcome":"dispatched"}`,
	}
	return r
}

func (r *bridgeAPIRecorder) handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		if req.Method == http.MethodGet {
			r.gets = append(r.gets, req.URL.Path+"?"+req.URL.RawQuery)
			switch req.URL.Path {
			case "/api/pi-bridge/models":
				fmt.Fprint(w, r.models)
			case "/api/pi-bridge/thinking-levels":
				fmt.Fprint(w, r.thinking)
			case "/api/pi-bridge/skills":
				fmt.Fprint(w, r.skills)
			case "/api/pi-history":
				fmt.Fprint(w, r.history)
			default:
				http.NotFound(w, req)
			}
			return
		}
		if req.Method != http.MethodPost {
			http.Error(w, "method", http.StatusMethodNotAllowed)
			return
		}
		var body map[string]any
		dec := json.NewDecoder(req.Body)
		dec.DisallowUnknownFields()
		if err := dec.Decode(&body); err != nil {
			http.Error(w, "bad request", http.StatusBadRequest)
			return
		}
		r.posts = append(r.posts, req.URL.Path)
		raw, _ := json.Marshal(body)
		r.bodies = append(r.bodies, string(raw))
		switch req.URL.Path {
		case "/api/pi-bridge/model":
			fmt.Fprint(w, r.setModel)
		case "/api/pi-bridge/thinking":
			fmt.Fprint(w, r.setThink)
		case "/api/pi-bridge/skill":
			fmt.Fprint(w, r.invoke)
		case "/api/pi-bridge/compact":
			w.WriteHeader(r.compactS)
			fmt.Fprint(w, r.compactB)
		case "/api/pi-bridge/reload":
			w.WriteHeader(r.reloadS)
			fmt.Fprint(w, r.reloadB)
		default:
			http.NotFound(w, req)
		}
	})
}

func mustBridgeClient(t *testing.T, h http.Handler) (*apiClient, *httptest.Server) {
	t.Helper()
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	api, err := newAPIClient(srv.URL)
	if err != nil {
		t.Fatalf("newAPIClient: %v", err)
	}
	return api, srv
}

// hasJSONFields asserts that body carries exactly the want object with no
// extra keys, tolerant of key order.
func hasJSONFields(t *testing.T, body string, want map[string]string) bool {
	t.Helper()
	var got map[string]any
	if err := json.Unmarshal([]byte(body), &got); err != nil {
		return false
	}
	if len(got) != len(want) {
		return false
	}
	for k, v := range want {
		if got[k] != v {
			return false
		}
	}
	return true
}

func TestBridgeAPIListsAndSetters(t *testing.T) {
	rec := newBridgeRecorder()
	api, _ := mustBridgeClient(t, rec.handler())
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()

	catalog, err := api.BridgeModels(ctx, "pa ne")
	if err != nil {
		t.Fatalf("models: %v", err)
	}
	if len(catalog.Models) != 1 || catalog.Models[0].label() != "anthropic/claude-sonnet-4-5" || catalog.Unavailable {
		t.Fatalf("catalog decode: %+v", catalog)
	}
	if !strings.Contains(rec.gets[0], "/api/pi-bridge/models?pane=pa+ne") {
		t.Fatalf("pane was not query-escaped: %q", rec.gets[0])
	}

	think, err := api.BridgeThinking(ctx, "p")
	if err != nil || len(think.Levels) != 3 || think.ProcessID != "pi-1" || think.Generation != "7" {
		t.Fatalf("thinking decode: %+v err=%v", think, err)
	}
	if ack, err := api.BridgeSetThinking(ctx, "p", "high", think.Provider, think.Model, think.ProcessID, think.Generation); err != nil || !ack.OK {
		t.Fatalf("set thinking: %+v err=%v", ack, err)
	}
	wantThink := map[string]string{"pane": "p", "level": "high", "provider": "anthropic", "model": "claude-sonnet-4-5", "process_id": "pi-1", "generation": "7"}
	if got := rec.bodies[len(rec.bodies)-1]; !hasJSONFields(t, got, wantThink) {
		t.Fatalf("set thinking body = %q, want fields %v", got, wantThink)
	}

	skills, err := api.BridgeSkills(ctx, "p")
	if err != nil || len(skills.Skills) != 1 || skills.Skills[0].Name != "update_ae" {
		t.Fatalf("skills decode: %+v err=%v", skills, err)
	}
	if ack, err := api.BridgeInvokeSkill(ctx, "p", "update_ae", skills.ProcessID, skills.Generation); err != nil || !ack.OK {
		t.Fatalf("invoke: %+v err=%v", ack, err)
	}
	wantInvoke := map[string]string{"name": "update_ae", "process_id": "pi-1", "generation": "7", "pane": "p"}
	if got := rec.bodies[len(rec.bodies)-1]; !hasJSONFields(t, got, wantInvoke) {
		t.Fatalf("invoke body = %q, want %v", got, wantInvoke)
	}

	if ack, err := api.BridgeSetModel(ctx, "p", "anthropic", "claude-sonnet-4-5"); err != nil || !ack.OK {
		t.Fatalf("set model: %+v err=%v", ack, err)
	}
	wantModel := map[string]string{"pane": "p", "provider": "anthropic", "model": "claude-sonnet-4-5"}
	if got := rec.bodies[len(rec.bodies)-1]; !hasJSONFields(t, got, wantModel) {
		t.Fatalf("set model body = %q, want %v", got, wantModel)
	}

	hist, err := api.BridgePromptHistory(ctx, "p")
	if err != nil || len(hist.Entries) != 2 {
		t.Fatalf("history decode: %+v err=%v", hist, err)
	}
}

func TestBridgeAPIRefusalAcks(t *testing.T) {
	rec := newBridgeRecorder()
	rec.setModel = `{"ok":false,"reason":"busy"}`
	rec.invoke = `{"ok":false,"reason":"unavailable"}`
	api, _ := mustBridgeClient(t, rec.handler())
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()

	ack, err := api.BridgeSetModel(ctx, "p", "a", "m")
	if err != nil || ack.OK || ack.Reason != "busy" {
		t.Fatalf("set model refusal: %+v err=%v", ack, err)
	}
	ack, err = api.BridgeInvokeSkill(ctx, "p", "s", "pi-1", "7")
	if err != nil || ack.OK || ack.Reason != "unavailable" {
		t.Fatalf("invoke refusal: %+v err=%v", ack, err)
	}
}

func TestBridgeAPIOutcomeVocabulary(t *testing.T) {
	cases := []struct {
		status  int
		body    string
		outcome string
		reason  string
	}{
		{http.StatusOK, `{"outcome":"completed"}`, bridgeOutcomeCompleted, ""},
		{http.StatusConflict, `{"outcome":"rejected-before-start","reason":"running"}`, bridgeOutcomeRejected, "running"},
		{http.StatusServiceUnavailable, `{"outcome":"rejected-before-start"}`, bridgeOutcomeRejected, ""},
		{http.StatusBadGateway, `{"outcome":"failed","reason":"cancelled"}`, bridgeOutcomeFailed, "cancelled"},
		{http.StatusGatewayTimeout, `{"outcome":"unknown"}`, bridgeOutcomeUnknown, ""},
	}
	for _, tc := range cases {
		rec := newBridgeRecorder()
		rec.compactS, rec.compactB = tc.status, tc.body
		api, _ := mustBridgeClient(t, rec.handler())
		ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
		outcome, reason, err := api.BridgeCompact(ctx, "p", "3", "9")
		cancel()
		if err != nil {
			t.Fatalf("compact %d: %v", tc.status, err)
		}
		if outcome != tc.outcome || reason != tc.reason {
			t.Fatalf("compact %d = (%q,%q), want (%q,%q)", tc.status, outcome, reason, tc.outcome, tc.reason)
		}
		wantBody := map[string]string{"pane": "p", "generation": "3", "telemetry_revision": "9"}
		if got := rec.bodies[len(rec.bodies)-1]; !hasJSONFields(t, got, wantBody) {
			t.Fatalf("compact body = %q, want %v", got, wantBody)
		}
	}
}

func TestBridgeAPIRejectsStatusBodyMismatch(t *testing.T) {
	cases := []struct {
		status int
		body   string
	}{
		{http.StatusOK, `{"outcome":"unknown"}`},         // success status with timeout word
		{http.StatusAccepted, `{"outcome":"completed"}`}, // reload never answers completed at 202
		{http.StatusConflict, `{"outcome":"completed"}`}, // rejection status with success word
		{http.StatusBadGateway, `{"outcome":"no-such"}`}, // word outside the vocabulary
		{http.StatusOK, `{}`},                            // missing outcome
		{http.StatusTeapot, `{"outcome":"completed"}`},   // status outside the contract
	}
	for _, tc := range cases {
		rec := newBridgeRecorder()
		rec.reloadS, rec.reloadB = tc.status, tc.body
		api, _ := mustBridgeClient(t, rec.handler())
		ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
		_, _, err := api.BridgeReload(ctx, "p", "pi-1", "3", "9", "12", "40")
		cancel()
		if err == nil {
			t.Fatalf("reload %d %q was accepted", tc.status, tc.body)
		}
	}
}

func TestBridgeAPIUnavailableSurfacesAsError(t *testing.T) {
	rec := newBridgeRecorder()
	rec.models = `{"models":[],"truncated":false,"unavailable":true}`
	api, _ := mustBridgeClient(t, rec.handler())
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	catalog, err := api.BridgeModels(ctx, "p")
	if err != nil {
		t.Fatalf("unavailable must still decode: %v", err)
	}
	if !catalog.Unavailable {
		t.Fatal("unavailable flag lost")
	}
}

// TestBridgeAPIReloadVocabulary pins the reload success word (dispatched at
// 202) separately from compact.
func TestBridgeAPIReloadVocabulary(t *testing.T) {
	rec := newBridgeRecorder()
	api, _ := mustBridgeClient(t, rec.handler())
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	outcome, reason, err := api.BridgeReload(ctx, "p", "pi-1", "3", "9", "12", "40")
	if err != nil {
		t.Fatalf("reload: %v", err)
	}
	if outcome != bridgeOutcomeDispatched || reason != "" {
		t.Fatalf("reload = (%q,%q), want dispatched", outcome, reason)
	}
	want := map[string]string{"pane": "p", "process_id": "pi-1", "generation": "3", "telemetry_revision": "9", "run_id": "12", "context_revision": "40"}
	if got := rec.bodies[len(rec.bodies)-1]; !hasJSONFields(t, got, want) {
		t.Fatalf("reload body = %q, want %v", got, want)
	}
}
