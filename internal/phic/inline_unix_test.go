//go:build unix

package phic

import (
	"bytes"
	"context"
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

func TestCLIInlineViewsReplayOutputAndSwitchPaneWithoutInputLoss(t *testing.T) {
	dir, err := resolveDir(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	pager := filepath.Join(t.TempDir(), "pager")
	if err := os.WriteFile(pager, []byte("#!/bin/sh\n[ \"$LESSSECURE\" = 1 ] || exit 19\n[ \"$1\" = -R ] || exit 20\nprintf '\\033[?1049h\\033[34mPAGER VIEW\\033[0m\\r\\n'\n"), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PHIC_PAGER", pager)
	var mu sync.Mutex
	source := map[string][]byte{"p": []byte("\x1b[6n\x1b[?1049hORIGINAL BACKEND\r\n"), "other": []byte("\x1b[?1049hSECOND BACKEND\r\n")}
	inputs := map[string][]byte{}
	connections := map[string]int{}
	active := map[string]int{}
	upgrader := websocket.Upgrader{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/auth/status":
			fmt.Fprint(w, `{"enabled":false}`)
		case "/api/coders":
			fmt.Fprint(w, `{"bash":{"id":"bash","name":"Shell"}}`)
		case "/api/terminals":
			if r.Method != "GET" {
				t.Error("pane switching spawned a new backend")
				http.Error(w, "unexpected spawn", 400)
				return
			}
			mu.Lock()
			defer mu.Unlock()
			_ = json.NewEncoder(w).Encode([]TerminalView{{ID: "p", Coder: "bash", Dir: dir, ActiveWSCount: active["p"]}, {ID: "other", Coder: "bash", Dir: dir, OpenCodeMode: "mini", ActiveWSCount: active["other"]}})
		case "/api/git/worktrees":
			_ = json.NewEncoder(w).Encode([]Worktree{{Path: dir}})
		case "/api/git/raw-diff":
			if r.URL.Query().Get("cwd") != dir || r.URL.Query().Get("ansi") != "1" {
				t.Error("diff used the wrong pane identity")
			}
			fmt.Fprint(w, "server diff source")
		default:
			pane := "p"
			if r.URL.Path == "/ws/pane/other" || r.URL.Path == "/api/terminals/other/recording" {
				pane = "other"
			}
			if r.URL.Path == "/ws/pane/"+pane {
				ws, err := upgrader.Upgrade(w, r, nil)
				if err != nil {
					return
				}
				defer ws.Close()
				mu.Lock()
				connections[pane]++
				active[pane]++
				head := len(source[pane])
				mu.Unlock()
				defer func() { mu.Lock(); active[pane]--; mu.Unlock() }()
				_ = ws.WriteMessage(websocket.BinaryMessage, wireproto.EncodeAttachHeadFrame(wireproto.AttachHeadHeader{Epoch: 7, Head: uint64(head)}, nil))
				for {
					_, data, err := ws.ReadMessage()
					if err != nil {
						return
					}
					if len(data) > 0 && data[0] == 1 {
						mu.Lock()
						inputs[pane] = append(inputs[pane], data[1:]...)
						mu.Unlock()
					}
				}
			} else if r.URL.Path == "/api/terminals/"+pane+"/recording" {
				mu.Lock()
				defer mu.Unlock()
				from, _ := strconv.ParseUint(r.URL.Query().Get("from"), 10, 64)
				through, _ := strconv.ParseUint(r.URL.Query().Get("through"), 10, 64)
				if through > uint64(len(source[pane])) {
					through = uint64(len(source[pane]))
				}
				hdr, _ := json.Marshal(wireproto.RecordingHeader{Epoch: 7, Start: from, End: through, Resizes: [][3]uint64{{0, 120, 36}}})
				var size [4]byte
				binary.BigEndian.PutUint32(size[:], uint32(len(hdr)))
				_, _ = w.Write(size[:])
				_, _ = w.Write(hdr)
				_, _ = w.Write(source[pane][from:through])
			} else {
				http.NotFound(w, r)
			}
		}
	}))
	defer server.Close()
	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
	defer cancel()
	args, _ := json.Marshal([]string{"--server", server.URL, "--pane", "p"})
	cmd := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestPhicProcessHelper$")
	cmd.Env = append(os.Environ(), "PHIC_PROCESS_HELPER=1", "PHIC_PROCESS_ARGS="+string(args))
	master, err := pty.StartWithSize(cmd, &pty.Winsize{Cols: 80, Rows: 24})
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
	await("ORIGINAL BACKEND", 0)
	pos := len(tape.snapshot())
	_, _ = master.Write([]byte("\x1d?"))
	await("Shortcuts", pos)
	// While the client owns the view, the old socket is gone and output exists
	// only in Phi. Native input cannot be forwarded into the previous backend.
	mu.Lock()
	source["p"] = append(source["p"], []byte("OUTPUT WHILE MENU OPEN\r\n")...)
	oldActive := active["p"]
	mu.Unlock()
	if oldActive != 0 {
		t.Fatal("menu was rendered before relay socket closed")
	}
	if bytes.Contains(tape.snapshot(), []byte("OUTPUT WHILE MENU OPEN")) {
		t.Fatal("backend output interleaved with menu")
	}
	pos = len(tape.snapshot())
	_, _ = master.Write([]byte("\r"))
	await("OUTPUT WHILE MENU OPEN", pos)
	// A complete command and menu response in one OS read must survive handoff.
	pos = len(tape.snapshot())
	_, _ = master.Write([]byte("\x1d?\r"))
	await("OUTPUT WHILE MENU OPEN", pos)
	pos = len(tape.snapshot())
	_, _ = master.Write([]byte("\x1ds"))
	await("Phi sessions", pos)
	_, _ = master.Write([]byte("\x1b"))
	await("OUTPUT WHILE MENU OPEN", pos)
	pos = len(tape.snapshot())
	_, _ = master.Write([]byte("\x1dw"))
	await("Worktrees", pos)
	_, _ = master.Write([]byte("q"))
	await("OUTPUT WHILE MENU OPEN", pos)
	pos = len(tape.snapshot())
	_, _ = master.Write([]byte("\x1dd"))
	await("PAGER VIEW", pos)
	await("OUTPUT WHILE MENU OPEN", pos)
	pos = len(tape.snapshot())
	_, _ = master.Write([]byte("\x1ds2\r"))
	await("SECOND BACKEND", pos)
	application := []byte("\x1b[1;2R\x1b[200~literal \x1dq\x1b[201~")
	_, _ = master.Write(application)
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		mu.Lock()
		received := bytes.Equal(inputs["other"], application)
		mu.Unlock()
		if received {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	_, _ = master.Write([]byte("\x1dq"))
	if err := cmd.Wait(); err != nil {
		t.Fatalf("CLI failed: %v %q", err, tape.snapshot())
	}
	if bytes.Contains(tape.snapshot(), []byte("\x1b[6n")) {
		t.Fatal("historical query reached native terminal")
	}
	mu.Lock()
	defer mu.Unlock()
	if len(inputs["p"]) != 0 || !bytes.Equal(inputs["other"], application) {
		t.Fatalf("menu leaked or application keys lost: %#v", inputs)
	}
	if connections["p"] != 6 || connections["other"] != 1 {
		t.Fatalf("handoffs not exercised: %#v", connections)
	}
}

func TestRebuildOracleInput(t *testing.T) {
	fixtures := map[string]string{
		"normal":                        "\x1b[31mRED\x1b[0m\r\nworking command: ",
		"alternate":                     "\x1b[?1049h\x1b[32mTUI CONTENT\x1b[0m\x1b[3;5H\x1b[?1000h\x1b[?1006h\x1b[?2004h",
		"both buffers":                  "NORMAL\r\n\x1b[?1049hALTERNATE\x1b[2;3H",
		"custom tabs and scroll region": "\x1b[?1049h\x1b[3g\x1b[1;5H\x1bH\x1b[2;6r\x1b[3;1Habc\tZ\x1b[4:3;58:2::200:80:30mstyle",
		"keyboard":                      "\x1b[?1049h\x1b[>1u\x1b[>4;2mKEYBOARD",
		"query":                         "\x1b[?1049h\x1b[6nCONTENT",
	}
	replay := map[string]string{}
	for name, body := range fixtures {
		var filter repaintFilter
		out, err := filter.Feed([]byte(body), true)
		if err != nil {
			t.Fatal(err)
		}
		replay[name] = string(out)
	}
	data, _ := json.Marshal(map[string]any{"baseline": neutralDisplay + clearRelayDisplay + defaultTabStops(40), "menu": neutralDisplay + "\r\nΦ MENU\r\n1 session\r\n2 session\r\n", "fixtures": fixtures, "replay": replay})
	t.Log("PHIC_REBUILD " + string(data))
}
