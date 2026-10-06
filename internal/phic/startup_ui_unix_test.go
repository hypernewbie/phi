//go:build unix

package phic

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"sync/atomic"
	"testing"
	"time"

	"github.com/creack/pty"
	"github.com/gorilla/websocket"
	"github.com/hypernewbie/phi/pkg/ws/wireproto"
)

// No --server or --profiles: exercise what the user actually runs, including
// desktop legacy discovery and first run without any local Phi service.
func TestCLIBareStartupShowsServersBeforeAuthAndCanConnectWithoutProfiles(t *testing.T) {
	for _, mode := range []string{"none", "legacy", "backup", "offline"} {
		t.Run(mode, func(t *testing.T) {
			saved := mode == "legacy" || mode == "backup"
			home := t.TempDir()
			home, err := filepath.EvalSymlinks(home)
			if err != nil {
				t.Fatal(err)
			}
			var authCalls, menuInputs atomic.Int32
			data := []byte("CONNECTED WITHOUT LOCALHOST\r\n")
			upgrade := websocket.Upgrader{}
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch r.URL.Path {
				case "/api/auth/status":
					authCalls.Add(1)
					json.NewEncoder(w).Encode(authStatus{})
				case "/api/config":
					json.NewEncoder(w).Encode(serverIdentity{Hostname: "Test server", Theme: "blue", Workspaces: []string{home}})
				case "/api/terminals":
					json.NewEncoder(w).Encode([]TerminalView{{ID: "startup", Dir: home, Coder: "bash"}})
				case "/ws/pane/startup":
					ws, err := upgrade.Upgrade(w, r, nil)
					if err != nil {
						return
					}
					defer ws.Close()
					ws.WriteMessage(websocket.BinaryMessage, wireproto.EncodeAttachHeadFrame(wireproto.AttachHeadHeader{Epoch: 7, Head: uint64(len(data))}, nil))
					for {
						_, input, err := ws.ReadMessage()
						if err != nil {
							return
						}
						if len(input) > 0 && input[0] == 1 {
							menuInputs.Add(int32(len(input) - 1))
						}
					}
				case "/api/terminals/startup/recording":
					from, _ := strconv.ParseUint(r.URL.Query().Get("from"), 10, 64)
					end, _ := strconv.ParseUint(r.URL.Query().Get("through"), 10, 64)
					hdr, _ := json.Marshal(wireproto.RecordingHeader{Epoch: 7, Start: from, End: end})
					var size [4]byte
					binary.BigEndian.PutUint32(size[:], uint32(len(hdr)))
					w.Write(size[:])
					w.Write(hdr)
					w.Write(data[from:end])
				default:
					http.NotFound(w, r)
				}
			}))
			defer server.Close()
			configDir := filepath.Join(home, ".config")
			if runtime.GOOS == "darwin" {
				configDir = filepath.Join(home, "Library", "Application Support")
			}
			file := filepath.Join(configDir, "Phi", "profiles.json")
			original := []byte(`{"profiles":[{"id":"test","name":"Shared desktop server","origin":"` + server.URL + `"}],"petEnabled":true}`)
			if mode == "backup" {
				file += ".bak"
			}
			if saved {
				os.MkdirAll(filepath.Dir(file), 0700)
				if err := os.WriteFile(file, original, 0600); err != nil {
					t.Fatal(err)
				}
			}
			ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
			defer cancel()
			args := []string{"."}
			if mode == "offline" {
				down := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Error(w, "offline", 503) }))
				defer down.Close()
				args = []string{"--server", down.URL, "."}
			}
			encodedArgs, _ := json.Marshal(args)
			cmd := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestPhicProcessHelper$")
			cmd.Dir = home
			cmd.Env = append(os.Environ(), "HOME="+home, "XDG_CONFIG_HOME="+filepath.Join(home, ".config"), "PHIC_PROCESS_HELPER=1", "PHIC_PROCESS_ARGS="+string(encodedArgs), "NO_COLOR=", "TERM=xterm-256color")
			master, err := pty.StartWithSize(cmd, &pty.Winsize{Cols: 100, Rows: 24})
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
				t.Fatalf("missing %q: %q", marker, tape.snapshot())
			}
			await("Connect to another server", 0)
			if authCalls.Load() != 0 {
				t.Fatal("startup authenticated before letting the user choose")
			}
			if !saved {
				master.Write([]byte("\x1b[F\r"))
				await("Server URL", 0)
				pos := len(tape.snapshot())
				master.Write([]byte("\x1b"))
				await("Servers", pos)
				master.Write([]byte("\x1b[F\r"))
				await("Server URL", pos)
				master.Write([]byte("\x1b[200~" + server.URL + "\x1b[201~\x1b[13;1u\x1b[13;1:3u"))
			} else {
				await("Shared desktop", 0)
				master.Write([]byte("\x1b[13;1u\x1b[13;1:3u"))
			}
			await("CONNECTED WITHOUT LOCALHOST", 0)
			pos := len(tape.snapshot())
			master.Write([]byte("\x1db"))
			await("Servers", pos)
			await("↑↓ Select", pos)
			master.Write([]byte("q"))
			await("CONNECTED WITHOUT LOCALHOST", pos)
			master.Write([]byte("\x1dq"))
			if err := cmd.Wait(); err != nil {
				t.Fatalf("bare client failed: %v %q", err, tape.snapshot())
			}
			if menuInputs.Load() != 0 {
				t.Fatal("menu key releases reached backend input")
			}
			if saved {
				got, _ := os.ReadFile(file)
				if !bytes.Equal(got, original) {
					t.Fatal("client rewrote shared desktop preferences")
				}
			}
		})
	}
}
