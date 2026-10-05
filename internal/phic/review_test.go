package phic

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestReviewServerShapesAndSpawnDirectory(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/coders":
			_, _ = w.Write([]byte(`{"custom":{"id":"custom","order":0,"name":"Custom","capabilities":{"list":true}},"bash":{"id":"bash","order":1,"name":"Shell","is_shell":true}}`))
		case "/api/terminals":
			if r.Method == http.MethodGet {
				_, _ = w.Write([]byte(`[{"id":"p","cwd":"/project","coder":"custom","ActiveWSCount":2}]`))
			} else {
				var body map[string]any
				_ = json.NewDecoder(r.Body).Decode(&body)
				if body["cwd"] != "/project" {
					t.Errorf("spawn lost requested directory: %v", body)
				}
				_, _ = w.Write([]byte(`{"pane_id":"p"}`))
			}
		}
	}))
	defer srv.Close()
	api := mustAPI(t, srv.URL)
	coders, err := api.ListCoders(context.Background())
	if err != nil || len(coders) != 2 || coders[0].ID != "custom" {
		t.Errorf("real coder registry: %v, %v", coders, err)
	}
	panes, err := api.ListTerminals(context.Background(), "/project")
	if err != nil || len(panes) != 1 || panes[0].Dir != "/project" || panes[0].ActiveWSCount != 2 {
		t.Errorf("real terminal shape: %v, %v", panes, err)
	}
	_, err = api.Spawn(context.Background(), SpawnRequest{Coder: "custom", Dir: "/project"})
	if err != nil {
		t.Fatal(err)
	}
}

func TestReviewEmptyFramesNeverPanic(t *testing.T) {
	defer func() {
		if r := recover(); r != nil {
			t.Errorf("empty wire frame panicked: %v", r)
		}
	}()
	if _, _, err := ParseAttachHead(nil); err == nil {
		t.Error("empty attach accepted")
	}
	if _, _, err := ParseLiveOutput(nil); err == nil {
		t.Error("empty live frame accepted")
	}
}

func TestReviewCrossOriginRedirectDoesNotLeakLogin(t *testing.T) {
	leaked := false
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { leaked = true; _, _ = w.Write([]byte(`{"ok":true}`)) }))
	defer target.Close()
	source := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, target.URL, http.StatusTemporaryRedirect)
	}))
	defer source.Close()
	api := mustAPI(t, source.URL)
	var out loginResponse
	err := api.postJSON(context.Background(), "/api/auth/login", []byte(`{"proof":"secret"}`), &out)
	if err == nil || leaked {
		t.Fatalf("cross-origin proof redirect: leaked=%t err=%v", leaked, err)
	}
}

func TestReviewMetadataCannotInjectC1Controls(t *testing.T) {
	got := []byte(QuotedID("name\u009b2J\u009d52;c;data\u009c"))
	if bytes.Contains(got, []byte("\u009b")) || bytes.Contains(got, []byte("\u009d")) {
		t.Fatalf("C1 control in metadata: %q", got)
	}
	got = []byte(formatPaneRow(0, TerminalView{ID: "p", Coder: "\x1b[2J", Title: "\x1b]52;c;secret\a"}))
	if bytes.ContainsRune(got, '\x1b') {
		t.Fatalf("unquoted pane metadata: %q", got)
	}
}
