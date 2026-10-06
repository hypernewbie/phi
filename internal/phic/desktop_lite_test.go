package phic

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"testing"
)

func TestDesktopHealthIsIndependentOfAuthenticationAndMetadata(t *testing.T) {
	for _, locked := range []bool{true, false} {
		t.Run(map[bool]string{true: "locked but up", false: "config works but health down"}[locked], func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/healthz" {
					if r.Header.Get("Cookie") != "" {
						t.Error("health probe carried credential")
					}
					if !locked {
						http.Error(w, "down", 503)
					}
					return
				}
				if locked {
					http.Error(w, "password", 401)
					return
				}
				w.Write([]byte(`{"hostname":"NEW","theme_color":"blue"}`))
			}))
			defer srv.Close()
			api := mustAPI(t, srv.URL)
			u, _ := url.Parse(srv.URL)
			api.http.Jar.SetCookies(u, []*http.Cookie{{Name: "phi_access_session", Value: "private"}})
			state := &serverState{api: api, identity: serverIdentity{Hostname: "KNOWN", Theme: "green"}}
			(&client{}).refreshIdentity(t.Context(), state)
			if locked && (state.health != "up" || state.identity.Hostname != "KNOWN") {
				t.Fatal("locked server lost desktop identity/health")
			}
			if !locked && (state.health != "down" || state.identity.Hostname != "NEW") {
				t.Fatal("config response substituted for desktop health probe")
			}
		})
	}
}
func TestDesktopBulkFormPartialSuccessAndDuplicateIdentity(t *testing.T) {
	store := &desktopStore{path: filepath.Join(t.TempDir(), "profiles.json")}
	result := store.addServerInput("jupiter\nhttp://bad/path\nhttps://charon:443\nJUPITER")
	if len(result.Profiles) != 3 || len(result.Errors) != 1 {
		t.Fatalf("desktop bulk result: %+v", result)
	}
	saved, err := readDesktopProfiles(store.path)
	if err != nil || len(saved) != 2 {
		t.Fatalf("bad bulk store: %+v %v", saved, err)
	}
	if saved[0].Origin != "http://jupiter:7070/" || saved[1].Origin != "https://charon:7070/" {
		t.Fatal("desktop default-port normalization missing")
	}
	if result.Profiles[2].ID != result.Profiles[0].ID {
		t.Fatal("duplicate URL generated another identity")
	}
}
func TestDesktopRenameSelectionCursorAndPasteSeparators(t *testing.T) {
	for _, test := range []struct {
		keys, initial, want string
		options             formOptions
	}{
		{"New name\r", "Old name", "New name", formOptions{selectAll: true}},
		{"\x1b[Hab\x1b[F\x1b[D\x1b[3~c\r", "X", "abc", formOptions{}},
		{"\x1b[200~jupiter\r\ncharon\x1b[201~\r", "", "jupiter  charon", formOptions{pasteSpaces: true}},
	} {
		v := &viewTerminal{input: bytes.NewReader([]byte(test.keys))}
		got, err := (&client{}).textFormView(t.Context(), v, func() (int, int, error) { return 60, 10, nil }, "Rename profile", "Server name", test.initial, 120, nil, test.options)
		if err != nil || got != test.want {
			t.Fatalf("form: got %q %v want %q", got, err, test.want)
		}
	}
}
