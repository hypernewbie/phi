//go:build unix && cgo

package phic

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"github.com/creack/pty"
	"github.com/gorilla/websocket"
	"github.com/hypernewbie/phi/pkg/ws/wireproto"
)

func TestPhicConsoleProcessHelper(t *testing.T) {
	if os.Getenv("PHIC_CONSOLE_HELPER") != "1" {
		return
	}
	origin := os.Getenv("PHIC_CONSOLE_ORIGIN")
	http.DefaultTransport = testOriginTransport{allowed: []string{origin}, base: http.DefaultTransport}
	cfg, err := parseFlags([]string{"--profiles", os.Getenv("PHIC_CONSOLE_PROFILES")})
	if err == nil {
		err = RunTUI(context.Background(), cfg, "native-test")
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	os.Exit(0)
}

func TestConsoleRelaunchKeepsLoginWithoutKeychainOrPasswordFile(t *testing.T) {
	home := t.TempDir()
	file := filepath.Join(home, "profiles.json")
	password := "not-stored-password"
	salt := []byte("0123456789abcdef")
	verifier, _ := deriveVerifier(password, salt, "pbkdf2-sha256", 1000)
	mac := hmac.New(sha256.New, verifier)
	mac.Write([]byte("single-challenge"))
	proof := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	cookie := rememberCookie()
	var logins atomic.Int32
	upgrade := websocket.Upgrader{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/healthz":
			fmt.Fprint(w, "ok")
		case "/api/auth/status":
			c, _ := r.Cookie(accessSessionCookieName)
			json.NewEncoder(w).Encode(authStatus{Enabled: true, Authenticated: c != nil && c.Value == cookie.Value, Version: "v1", Algorithm: "pbkdf2-sha256", Iterations: 1000, Salt: base64.RawURLEncoding.EncodeToString(salt), Challenge: "single-challenge"})
		case "/api/auth/login":
			var body map[string]string
			json.NewDecoder(r.Body).Decode(&body)
			if body["proof"] != proof || body["challenge"] != "single-challenge" {
				http.Error(w, "bad proof", 401)
				return
			}
			if body["password"] != "" {
				t.Error("password crossed the wire")
			}
			logins.Add(1)
			http.SetCookie(w, &cookie)
			json.NewEncoder(w).Encode(loginResponse{OK: true})
		case "/api/config":
			json.NewEncoder(w).Encode(serverIdentity{Hostname: "fixture", Workspaces: []string{home}})
		case "/api/coders":
			json.NewEncoder(w).Encode(map[string]CoderDescriptor{"shell": {ID: "shell", Name: "Shell", IsShell: true}})
		case "/api/terminals":
			json.NewEncoder(w).Encode([]TerminalView{{ID: "live", Dir: home, Coder: "shell", Title: "already live"}})
		case "/api/sessions":
			fmt.Fprint(w, "[]")
		case "/ws/pane/live":
			ws, err := upgrade.Upgrade(w, r, nil)
			if err != nil {
				return
			}
			defer ws.Close()
			ws.WriteMessage(websocket.BinaryMessage, wireproto.EncodeAttachHeadFrame(wireproto.AttachHeadHeader{Epoch: 7, Head: 0}, nil))
			for {
				if _, _, err = ws.ReadMessage(); err != nil {
					return
				}
			}
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	os.WriteFile(file, []byte(`{"profiles":[{"id":"test","name":"fixture","origin":"`+server.URL+`"}]}`), 0600)
	for launch := 0; launch < 2; launch++ {
		ctx, cancel := context.WithTimeout(t.Context(), 12*time.Second)
		cmd := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestPhicConsoleProcessHelper$")
		cmd.Dir = home
		cmd.Env = append(os.Environ(), "HOME="+home, "XDG_CONFIG_HOME="+filepath.Join(home, ".config"), "PHIC_CONSOLE_HELPER=1", "PHIC_CONSOLE_PROFILES="+file, "PHIC_CONSOLE_ORIGIN="+server.URL, "TERM=xterm-256color", "NO_COLOR=", "SSH_AUTH_SOCK=", "TMUX=")
		master, err := pty.StartWithSize(cmd, &pty.Winsize{Cols: 120, Rows: 30})
		if err != nil {
			cancel()
			t.Fatal(err)
		}
		t.Cleanup(func() {
			cancel()
			master.Close()
			if cmd.Process != nil {
				_ = cmd.Process.Kill()
			}
		})
		tape := startPtyReader(master)
		await := func(marker string) {
			t.Helper()
			deadline := time.Now().Add(5 * time.Second)
			for time.Now().Before(deadline) {
				if bytes.Contains(tape.snapshot(), []byte(marker)) {
					return
				}
				time.Sleep(5 * time.Millisecond)
			}
			t.Fatalf("launch %d missing %q: %q", launch, marker, tape.snapshot())
		}
		if launch == 0 {
			await("Phi server password")
			master.Write([]byte(password + "\r"))
		}
		await("connected")
		if launch == 1 && bytes.Contains(tape.snapshot(), []byte("Phi server password")) {
			t.Fatal("console relaunch prompted despite remembered login")
		}
		master.Write([]byte{0x1d, 'q'})
		err = cmd.Wait()
		master.Close()
		cancel()
		if err != nil {
			t.Fatal(err)
		}
	}
	if logins.Load() != 1 {
		t.Fatalf("relaunch re-authenticated %d times", logins.Load())
	}
	p := newSessionPersistence(file)
	data, err := os.ReadFile(p.file(server.URL))
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(data, []byte(password)) || bytes.Contains(data, []byte("verifier")) {
		t.Fatal("password or reusable verifier persisted")
	}
}
