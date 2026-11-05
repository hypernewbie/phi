package ws

import (
	"bytes"
	"context"
	"errors"
	"runtime"
	"testing"
	"time"

	"github.com/hypernewbie/phi/pkg/pty"
	"github.com/hypernewbie/phi/pkg/ws/wireproto"
)

// A page cap is an optimization, not permission to delete replay bytes.
// Chaining 2 MiB pages across a larger journal must return every byte.
// The RAM window retains its capacity, never the full stream. A client
// that asks for an evicted prefix is refused instead of silently losing
// bytes mid-replay.
func TestRecordingSurvivesReplayMemoryLimits(t *testing.T) {
	big := bytes.Repeat([]byte("retained history 你好 🙂\r\n"), (2<<20)/len("retained history 你好 🙂\r\n")+2)
	const capacity = 64
	hub := NewHub(capacity)
	if err := hub.InitPaneJournal("p", 80, 24); err != nil {
		t.Fatal(err)
	}
	for start := 0; start < len(big); start += 64 << 10 {
		end := min(start+(64<<10), len(big))
		hub.Ingest("p", big[start:end])
	}
	ph, _ := hub.LookupPane("p")
	epoch := ph.EpochOf()

	if _, err := hub.Replay("p", ReplayRequest{Epoch: epoch, From: 0, Latest: true}); !errors.Is(err, ErrReplayExpired) {
		t.Fatalf("replay from an evicted prefix = %v, want expired", err)
	}

	page, err := hub.Replay("p", ReplayRequest{Epoch: epoch, From: uint64(len(big) - capacity), Latest: true})
	if err != nil {
		t.Fatalf("replay retained tail: %v", err)
	}
	want := big[len(big)-capacity:]
	if !bytes.Equal(page.Data, want) {
		t.Fatalf("retained tail = %q, want %q", page.Data, want)
	}
	if page.End != uint64(len(big)) {
		t.Fatalf("retained tail ends at %d, want %d", page.End, len(big))
	}
	if !page.Incomplete {
		t.Fatal("a rolled-over window must report incomplete history")
	}
}

func TestProcessExitDoesNotEraseColdRecording(t *testing.T) {
	testProcessExitRecording(t, false)
}

func TestProcessExitBeforeReaderRetainsColdRecording(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("Linux allows the child to exit before its PTY output is read")
	}
	testProcessExitRecording(t, true)
}

func testProcessExitRecording(t *testing.T, exitBeforeReader bool) {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("POSIX PTY child")
	}
	manager := pty.NewManager()
	t.Cleanup(func() { manager.Shutdown(100 * time.Millisecond) })
	inst, err := manager.Spawn(context.Background(), t.TempDir(), "/bin/sh", []string{"-c", "printf 'retain output after process exit'"}, "bash", "")
	if err != nil {
		t.Fatal(err)
	}
	hub := NewHub(4096)
	if err := hub.SetRecordingDirectory(t.TempDir()); err != nil {
		t.Fatal(err)
	}
	client := &Client{Send: make(chan []byte, 32)}
	hub.Register(inst.ID, client)
	live, ok := hub.LookupPane(inst.ID)
	if !ok {
		t.Fatal("pane missing after register")
	}
	epoch := live.EpochOf()
	if exitBeforeReader {
		select {
		case <-inst.Pty.Closed:
		case <-time.After(5 * time.Second):
			t.Fatal("process did not exit before reader startup")
		}
	}
	StartPTYReadLoop(inst, hub)
	deadline := time.After(5 * time.Second)
	for {
		select {
		case frame := <-client.Send:
			if server, err := wireproto.DecodeServerFrame(frame); err == nil && server.GetExit() != nil {
				goto exited
			}
		case <-deadline:
			t.Fatal("PTY exit was not observed")
		}
	}
exited:
	until := time.Now().Add(time.Second)
	for {
		if _, present := hub.LookupPane(inst.ID); !present {
			break
		}
		if time.Now().After(until) {
			t.Fatal("read loop did not finish its exit cleanup")
		}
		runtime.Gosched()
	}
	page, err := hub.Replay(inst.ID, ReplayRequest{Epoch: epoch, From: 0, Latest: true})
	if err != nil || !bytes.Contains(page.Data, []byte("retain output after process exit")) {
		t.Fatalf("normal process exit destroyed bytes needed for history on reload: %v", err)
	}
}

func TestHotDropWarningUsesTheClientsActualControlEnvelope(t *testing.T) {
	hub := NewHub(64)
	client := &Client{Send: make(chan []byte, 1)}
	hub.injectDropWarning(client, time.Now())
	msg := <-client.Send
	server, err := wireproto.DecodeServerFrame(msg)
	if err != nil || server.GetDropNotice() == nil {
		t.Fatalf("browser cannot decode drop notice, so quiet tail losses remain invisible: %+v err=%v", server, err)
	}
}

func TestColdRecordingRetainsItsStartingResize(t *testing.T) {
	hub := NewHub(8192)
	if err := hub.SetRecordingDirectory(t.TempDir()); err != nil {
		t.Fatal(err)
	}
	if err := hub.InitPaneJournal("p", 80, 24); err != nil {
		t.Fatal(err)
	}
	hub.Ingest("p", []byte("first\r\n"))
	for i := 0; i < 60; i++ {
		commit, _, err := hub.StagePaneResize("p", uint16(80+i%2), 24)
		if err != nil {
			t.Fatal(err)
		}
		if err := commit(); err != nil {
			t.Fatal(err)
		}
		hub.Ingest("p", []byte("x"))
	}
	ph, _ := hub.LookupPane("p")
	page, err := hub.Replay("p", ReplayRequest{Epoch: ph.EpochOf(), From: 0, Latest: true})
	if err != nil {
		t.Fatal(err)
	}
	// The baseline survives any number of later resizes; it is the
	// geometry old bytes replay under.
	if page.InitCols != 80 || page.InitRows != 24 {
		t.Fatalf("resize churn destroyed the starting geometry: %dx%d", page.InitCols, page.InitRows)
	}
}
