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
	"os/signal"
	"path/filepath"
	"strconv"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/creack/pty"
	"github.com/gorilla/websocket"
	"github.com/hypernewbie/phi/pkg/ws/wireproto"
)

func TestPhicProcessHelper(t *testing.T) {
	if os.Getenv("PHIC_PROCESS_HELPER") != "1" {
		return
	}
	home := os.Getenv("PHIC_PROCESS_HOME")
	if home == "" {
		home = t.TempDir()
	}
	t.Setenv("HOME", home)
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(home, ".config"))
	var args []string
	if err := json.Unmarshal([]byte(os.Getenv("PHIC_PROCESS_ARGS")), &args); err != nil {
		os.Exit(2)
	}
	if origins := os.Getenv("PHIC_PROCESS_ALLOWED_ORIGINS"); origins != "" {
		var allowed []string
		if json.Unmarshal([]byte(origins), &allowed) != nil {
			os.Exit(2)
		}
		http.DefaultTransport = testOriginTransport{allowed: allowed, base: http.DefaultTransport}
	}
	if err := runLegacyClient(args); err != nil {
		fmt.Fprintf(os.Stderr, "helper error: %q\n", err.Error())
		os.Exit(1)
	}
	os.Exit(0)
}

// runLegacyClient drives the retired inline menu/relay client directly. The
// console is the production entry point; these PTY tests keep the legacy
// transport contracts covered until their deletion is staged.
func runLegacyClient(args []string) error {
	cfg, err := parseFlags(args)
	if err != nil {
		return err
	}
	if cfg.Help || cfg.Version {
		return nil
	}
	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()
	cl, err := newClient(ctx, cfg)
	if err != nil {
		return err
	}
	defer cl.Close()
	return cl.Run(ctx)
}

// This runs the actual CLI controller in a controlling PTY. The server uses
// the real JSON and binary shapes, not structs marshaled by the client.
func TestCLIAuthenticatedFreshPaneRawReplayAndDetach(t *testing.T) {
	for _, resume := range []bool{false, true} {
		t.Run(fmt.Sprintf("saved-resume=%t", resume), func(t *testing.T) {
			dir, err := resolveDir(t.TempDir())
			if err != nil {
				t.Fatal(err)
			}
			salt := []byte("0123456789abcdef")
			password := "  private-password  "
			verifier, err := deriveVerifier(password, salt, "pbkdf2-sha256", 1000)
			if err != nil {
				t.Fatal(err)
			}
			mac := hmac.New(sha256.New, verifier)
			_, _ = mac.Write([]byte("challenge"))
			proof := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
			source := []byte("RECORDED 界 🐙\r\nLIVE READY\r\n")
			if resume {
				source = append([]byte("\x1b[6n"), source...)
			}
			prefixLen := len([]byte("RECORDED 界 🐙\r\n"))
			if resume {
				prefixLen += len("\x1b[6n")
			}
			const epoch = uint64(9007199254740993)
			var mu sync.Mutex
			var spawn SpawnRequest
			var applicationInput []byte
			up := websocket.Upgrader{}
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path != "/api/auth/status" && r.URL.Path != "/api/auth/login" {
					cookie, err := r.Cookie("phi_access_session")
					if err != nil || cookie.Value != "session" {
						http.Error(w, "missing cookie", http.StatusUnauthorized)
						return
					}
				}
				switch r.URL.Path {
				case "/api/auth/status":
					_ = json.NewEncoder(w).Encode(authStatus{Enabled: true, Version: "v1", Algorithm: "pbkdf2-sha256", Iterations: 1000, Salt: base64.RawURLEncoding.EncodeToString(salt), Challenge: "challenge"})
				case "/api/auth/login":
					var req map[string]string
					_ = json.NewDecoder(r.Body).Decode(&req)
					if req["proof"] != proof || req["challenge"] != "challenge" {
						http.Error(w, "bad proof", 401)
						return
					}
					http.SetCookie(w, &http.Cookie{Name: "phi_access_session", Value: "session", Path: "/"})
					_, _ = w.Write([]byte(`{"ok":true}`))
				case "/api/coders":
					_, _ = w.Write([]byte(`{"custom":{"id":"custom","name":"Custom","order":0,"capabilities":{"list":true}}}`))
				case "/api/sessions":
					_, _ = w.Write([]byte(`[{"id":"saved-native-session","title":"Saved Native","cwd":"` + dir + `"}]`))
				case "/api/terminals":
					if r.Method == http.MethodGet {
						_, _ = w.Write([]byte(`[]`))
						return
					}
					var req SpawnRequest
					if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
						t.Error(err)
					}
					mu.Lock()
					spawn = req
					mu.Unlock()
					_, _ = w.Write([]byte(`{"pane_id":"p","session_id":"native"}`))
				case "/ws/pane/p":
					ws, err := up.Upgrade(w, r, nil)
					if err != nil {
						return
					}
					defer ws.Close()
					_ = ws.WriteMessage(websocket.BinaryMessage, wireproto.EncodeAttachHeadFrame(wireproto.AttachHeadHeader{Epoch: epoch, Head: uint64(prefixLen)}, nil))
					_ = ws.WriteMessage(websocket.BinaryMessage, wireproto.EncodeLiveOutputFrame(uint64(prefixLen), source[prefixLen:]))
					for {
						_, msg, err := ws.ReadMessage()
						if err != nil {
							return
						}
						if len(msg) > 0 && msg[0] == 1 {
							mu.Lock()
							applicationInput = append(applicationInput, msg[1:]...)
							mu.Unlock()
						}
					}
				case "/api/terminals/p/recording":
					from, _ := strconv.ParseUint(r.URL.Query().Get("from"), 10, 64)
					through, _ := strconv.ParseUint(r.URL.Query().Get("through"), 10, 64)
					if through > uint64(len(source)) {
						through = uint64(len(source))
					}
					hdr, _ := json.Marshal(wireproto.RecordingHeader{Epoch: epoch, Start: from, End: through, Resizes: [][3]uint64{{0, 91, 29}}})
					var size [4]byte
					binary.BigEndian.PutUint32(size[:], uint32(len(hdr)))
					_, _ = w.Write(size[:])
					_, _ = w.Write(hdr)
					_, _ = w.Write(source[from:through])
				default:
					http.NotFound(w, r)
				}
			}))
			defer srv.Close()
			ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
			defer cancel()
			launch := []string{"--server", srv.URL, "--new", "--coder", "custom", dir}
			if resume {
				launch = []string{"--server", srv.URL, dir}
			}
			args, _ := json.Marshal(launch)
			cmd := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestPhicProcessHelper$")
			cmd.Env = append(os.Environ(), "PHIC_PROCESS_HELPER=1", "PHIC_PROCESS_ARGS="+string(args))
			master, err := pty.StartWithSize(cmd, &pty.Winsize{Cols: 91, Rows: 29})
			if err != nil {
				t.Fatal(err)
			}
			defer master.Close()
			defer func() {
				if cmd.Process != nil {
					_ = cmd.Process.Kill()
				}
			}()
			tape := startPtyReader(master)
			await := func(marker []byte) {
				t.Helper()
				deadline := time.Now().Add(4 * time.Second)
				for time.Now().Before(deadline) {
					if bytes.Contains(tape.snapshot(), marker) {
						return
					}
					time.Sleep(5 * time.Millisecond)
				}
				t.Fatalf("CLI did not reach %q: %q", marker, tape.snapshot())
			}
			await([]byte("Phi server password: "))
			_, _ = master.Write([]byte(password + "\r"))
			if resume {
				await([]byte("Sessions"))
				_, _ = master.Write([]byte("1\r"))
				await([]byte("Custom sessions"))
				_, _ = master.Write([]byte("2\r"))
				await([]byte("\x1b[6n"))
				_, _ = master.Write([]byte("\x1b[1;1R"))
			}
			await([]byte("LIVE READY"))
			_, _ = master.Write([]byte{0x1d, 'q'})
			if err := cmd.Wait(); err != nil {
				t.Fatalf("CLI detach: %v, output=%q", err, tape.snapshot())
			}
			got := tape.snapshot()
			if bytes.Contains(got, []byte(password)) {
				t.Fatalf("password echoed: %q", got)
			}
			if !bytes.Contains(got, source) {
				t.Fatalf("raw Unicode/newlines changed: %q", got)
			}
			mu.Lock()
			defer mu.Unlock()
			if spawn.Dir != dir || spawn.Coder != "custom" || spawn.Cols != 91 || spawn.Rows != 29 {
				t.Fatalf("wrong spawn identity/initial geometry: %+v", spawn)
			}
			wantInput := []byte(nil)
			if resume {
				wantInput = []byte("\x1b[1;1R")
				if spawn.SessionID != "saved-native-session" {
					t.Fatalf("resume identity lost: %+v", spawn)
				}
			}
			if !bytes.Equal(applicationInput, wantInput) {
				t.Fatalf("live startup reply or detach ownership failed: %q want %q", applicationInput, wantInput)
			}
		})
	}
}
