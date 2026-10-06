//go:build unix

package phic

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"sync"
	"testing"
	"time"

	"github.com/creack/pty"
	"github.com/gorilla/websocket"
	"github.com/hypernewbie/phi/pkg/ws/wireproto"
)

// Same host, different ports, same pane ID, different cwd/cookies/recording.
// This is deliberately the shape that exposes cross-server state leakage.
func TestCLIDesktopProfilesColoredServerSwitchOriginIsolationAndRememberedPane(t *testing.T) {
	var mu sync.Mutex
	inputs := map[string][]byte{}
	connects := map[string]int{}
	makeServer := func(name, theme, dir string, fail bool) *httptest.Server {
		salt := []byte("0123456789abcdef")
		password := " password-" + name + " "
		key, _ := deriveVerifier(password, salt, "pbkdf2-sha256", 1000)
		mac := hmac.New(sha256.New, key)
		_, _ = mac.Write([]byte(name))
		proof := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
		source := []byte("\x1b[?1049hSOURCE_" + name + "\r\n")
		upgrade := websocket.Upgrader{}
		return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			cookie, cookieErr := r.Cookie("phi_access_session")
			if cookieErr == nil && cookie.Value != name {
				t.Errorf("origin leaked %q cookie into %s", cookie.Value, name)
			}
			authed := cookieErr == nil && cookie.Value == name
			switch r.URL.Path {
			case "/api/auth/status":
				if fail {
					http.Error(w, "offline", 503)
					return
				}
				_ = json.NewEncoder(w).Encode(authStatus{Enabled: true, Authenticated: authed, Version: "v1", Algorithm: "pbkdf2-sha256", Iterations: 1000, Salt: base64.RawURLEncoding.EncodeToString(salt), Challenge: name})
				return
			case "/api/auth/login":
				var req map[string]string
				_ = json.NewDecoder(r.Body).Decode(&req)
				if req["challenge"] != name || req["proof"] != proof {
					t.Errorf("wrong proof for %s: %+v", name, req)
					http.Error(w, "bad proof", 401)
					return
				}
				http.SetCookie(w, &http.Cookie{Name: "phi_access_session", Value: name, Path: "/"})
				fmt.Fprint(w, `{"ok":true}`)
				return
			}
			if !authed {
				http.Error(w, "login", 401)
				return
			}
			switch r.URL.Path {
			case "/api/config":
				_ = json.NewEncoder(w).Encode(serverIdentity{Hostname: name, Theme: theme, Workspaces: []string{dir}})
			case "/api/terminals":
				if r.Method != "GET" {
					t.Error("server switch created a new pane")
					http.Error(w, "unexpected spawn", 400)
					return
				}
				_ = json.NewEncoder(w).Encode([]TerminalView{{ID: "same", Dir: dir, Coder: "bash", OpenCodeMode: "mini"}})
			case "/ws/pane/same":
				ws, err := upgrade.Upgrade(w, r, nil)
				if err != nil {
					return
				}
				defer ws.Close()
				mu.Lock()
				connects[name]++
				mu.Unlock()
				_ = ws.WriteMessage(websocket.BinaryMessage, wireproto.EncodeAttachHeadFrame(wireproto.AttachHeadHeader{Epoch: 7, Head: uint64(len(source))}, nil))
				for {
					_, data, err := ws.ReadMessage()
					if err != nil {
						return
					}
					if len(data) > 0 && data[0] == 1 {
						mu.Lock()
						inputs[name] = append(inputs[name], data[1:]...)
						mu.Unlock()
					}
				}
			case "/api/terminals/same/recording":
				from, _ := strconv.ParseUint(r.URL.Query().Get("from"), 10, 64)
				through, _ := strconv.ParseUint(r.URL.Query().Get("through"), 10, 64)
				if through > uint64(len(source)) {
					through = uint64(len(source))
				}
				hdr, _ := json.Marshal(wireproto.RecordingHeader{Epoch: 7, Start: from, End: through})
				var size [4]byte
				binary.BigEndian.PutUint32(size[:], uint32(len(hdr)))
				_, _ = w.Write(size[:])
				_, _ = w.Write(hdr)
				_, _ = w.Write(source[from:through])
			default:
				http.NotFound(w, r)
			}
		}))
	}
	a := makeServer("ALPHA", "red", "/not-local/alpha", false)
	defer a.Close()
	b := makeServer("BETA", "blue", "/not-local/beta", false)
	defer b.Close()
	down := makeServer("DOWN", "green", "/not-local/down", true)
	defer down.Close()
	profiles := []desktopProfile{{ID: "a", Name: "Alpha", Origin: a.URL + "/"}, {ID: "b", Name: "Beta", Origin: b.URL + "/"}, {ID: "c", Name: "Down", Origin: down.URL + "/"}}
	file := filepath.Join(t.TempDir(), "profiles.json")
	original, _ := json.Marshal(map[string]any{"profiles": profiles, "closeToTray": true, "petEnabled": true})
	_ = os.WriteFile(file, original, 0600)
	ctx, cancel := context.WithTimeout(t.Context(), 20*time.Second)
	defer cancel()
	args, _ := json.Marshal([]string{"--profiles", file, "--server", a.URL, "--pane", "same"})
	cmd := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestPhicProcessHelper$")
	cmd.Env = append(os.Environ(), "PHIC_PROCESS_HELPER=1", "PHIC_PROCESS_ARGS="+string(args), "NO_COLOR=", "TERM=xterm-256color")
	master, err := pty.StartWithSize(cmd, &pty.Winsize{Cols: 100, Rows: 30})
	if err != nil {
		t.Fatal(err)
	}
	defer master.Close()
	defer cmd.Process.Kill()
	tape := startPtyReader(master)
	await := func(marker string, after int) {
		t.Helper()
		deadline := time.Now().Add(4 * time.Second)
		for time.Now().Before(deadline) {
			got := tape.snapshot()
			if len(got) > after && bytes.Contains(got[after:], []byte(marker)) {
				return
			}
			time.Sleep(5 * time.Millisecond)
		}
		t.Fatalf("missing %q after %d: %q", marker, after, tape.snapshot())
	}
	await("Phi server password", 0)
	_, _ = master.Write([]byte(" password-ALPHA \r"))
	await("SOURCE_ALPHA", 0)
	pos := len(tape.snapshot())
	_, _ = master.Write([]byte("\x1db"))
	await("Servers", pos)
	if !bytes.Contains(tape.snapshot()[pos:], []byte("48;2;248;113;113m")) {
		t.Fatal("active server box did not use Phi red")
	}
	_, _ = master.Write([]byte("q"))
	await("SOURCE_ALPHA", pos)
	pos = len(tape.snapshot())
	_, _ = master.Write([]byte("\x1b[50;5u\x1b[50;5:3u"))
	await("Phi server password", pos)
	_, _ = master.Write([]byte(" password-BETA \r"))
	await("SOURCE_BETA", pos)
	pos = len(tape.snapshot())
	_, _ = master.Write([]byte("\x1db"))
	await("Servers", pos)
	after := tape.snapshot()[pos:]
	if !bytes.Contains(after, []byte("38;2;248;113;113m")) || !bytes.Contains(after, []byte("48;2;56;189;248m")) {
		t.Fatal("server bar colors were not origin-bound")
	}
	_, _ = master.Write([]byte("q"))
	await("SOURCE_BETA", pos)
	// Switching to an unavailable server must roll back the API and selection.
	pos = len(tape.snapshot())
	_, _ = master.Write([]byte("\x1d3"))
	await("503", pos)
	// Server shortcuts from an error acknowledgement still belong to the
	// live controller. Canceling the picker must return to the same pane,
	// not bubble to the startup loop and exit the client.
	viewPos := len(tape.snapshot())
	_, _ = master.Write([]byte("\x1db"))
	await("Servers", viewPos)
	_, _ = master.Write([]byte("q"))
	await("SOURCE_BETA", viewPos)
	pos = len(tape.snapshot())
	_, _ = master.Write([]byte("\x1d1"))
	await("SOURCE_ALPHA", pos)
	// The remembered exact pane avoids a new project/session selection or login.
	pos = len(tape.snapshot())
	_, _ = master.Write([]byte("\x1d2"))
	await("SOURCE_BETA", pos)
	want := []byte("application \x1b[1;2R\x1b[200~\x1d1\x1b[201~")
	_, _ = master.Write(want)
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		mu.Lock()
		ok := bytes.Equal(inputs["BETA"], want)
		mu.Unlock()
		if ok {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	_, _ = master.Write([]byte("\x1dq"))
	if err := cmd.Wait(); err != nil {
		t.Fatalf("client failed: %v %q", err, tape.snapshot())
	}
	mu.Lock()
	defer mu.Unlock()
	if len(inputs["ALPHA"]) != 0 || !bytes.Equal(inputs["BETA"], want) {
		t.Fatalf("cross-server input or consumed shortcut release leaked: %#v", inputs)
	}
	if connects["ALPHA"] != 3 || connects["BETA"] != 4 {
		t.Fatalf("switches not exercised: %#v", connects)
	}
	saved, _ := os.ReadFile(file)
	var preferences map[string]any
	if json.Unmarshal(saved, &preferences) != nil || preferences["closeToTray"] != true || preferences["petEnabled"] != true {
		t.Fatal("desktop preferences changed")
	}
	shared, err := readDesktopProfiles(file)
	if err != nil || len(shared) != len(profiles) {
		t.Fatalf("shared server list changed: %+v %v", shared, err)
	}
	for i, p := range shared {
		if p.ID != profiles[i].ID || p.Name != profiles[i].Name || p.Origin != profiles[i].Origin {
			t.Fatal("desktop order/identity changed")
		}
	}
	if shared[1].LastUsed == "" || shared[2].LastUsed != "" {
		t.Fatal("active stamp missing or failed switch persisted")
	}
	for _, pw := range []string{" password-ALPHA ", " password-BETA "} {
		if bytes.Contains(tape.snapshot(), []byte(pw)) {
			t.Fatal("password echoed")
		}
	}
}
