package ws

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/hypernewbie/phi/pkg/pty"
)

// A replay-memory cap is an optimization, not permission to delete recording
// bytes. Cold recording reads must still cover the complete ingested stream.
func TestRecordingSurvivesReplayMemoryLimits(t *testing.T) {
	source := []byte("FIRST\r\n" + strings.Repeat("retained history 你好 🙂\r\n", 80) + "LAST\r\n")
	for _, capacity := range []int{0, 8, 64, 1024} {
		for _, chunkSize := range []int{1, 7, 32768} {
			t.Run(fmt.Sprintf("capacity_%d_chunk_%d", capacity, chunkSize), func(t *testing.T) {
				hub := NewHub(capacity)
				for start := 0; start < len(source); start += chunkSize {
					end := min(start+chunkSize, len(source))
					hub.Ingest("p", source[start:end])
				}
				rec, ok := hub.Recording("p", 0, uint64(len(source)))
				if !ok || rec.Start != 0 || rec.End != uint64(len(source)) || !bytes.Equal(rec.Data, source) {
					t.Fatalf("memory limit cut output: span=[%d,%d), bytes=%d, want [0,%d) and exact original bytes", rec.Start, rec.End, len(rec.Data), len(source))
				}
				_, used, cap := hub.PaneStats("p")
				if used > capacity || cap > capacity {
					t.Fatalf("recovery must not remove the memory optimization: used=%d capacity=%d configured=%d", used, cap, capacity)
				}
			})
		}
	}
}

func TestProcessExitDoesNotEraseColdRecording(t *testing.T) {
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
	client := &Client{Send: make(chan []byte, 32)}
	hub.Register(inst.ID, client)
	StartPTYReadLoop(inst, hub)
	deadline := time.After(5 * time.Second)
	for {
		select {
		case frame := <-client.Send:
			if len(frame) > 0 && frame[0] == 0x04 {
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
	recording, ok := hub.Recording(inst.ID, 0, 4096)
	if !ok || !bytes.Contains(recording.Data, []byte("retain output after process exit")) {
		t.Fatal("normal process exit destroyed bytes needed for history on reload")
	}
}

func TestHotDropWarningUsesTheClientsActualControlEnvelope(t *testing.T) {
	hub := NewHub(64)
	client := &Client{Hot: true, Send: make(chan []byte, 1)}
	hub.injectDropWarning(client, time.Now())
	msg := <-client.Send
	if msg[0] != 0x02 {
		t.Fatalf("type=%x", msg[0])
	}
	var control map[string]string
	if err := json.Unmarshal(msg[1:], &control); err != nil {
		t.Fatalf("browser cannot decode drop control, so quiet tail losses remain invisible: %v", err)
	}
	if control["type"] != "output-dropped" {
		t.Fatalf("control=%v", control)
	}
}

func TestColdRecordingRetainsItsStartingResize(t *testing.T) {
	hub := NewHub(8192)
	hub.RecordResize("p", 80, 24)
	hub.Ingest("p", []byte("first\r\n"))
	for i := 0; i < maxResizeMarkers+20; i++ {
		hub.RecordResize("p", uint16(80+i%2), 24)
		hub.Ingest("p", []byte("x"))
	}
	rec, ok := hub.Recording("p", 0, 7)
	if !ok || len(rec.Resizes) == 0 || rec.Resizes[0].AtSeq != 0 || rec.Resizes[0].Cols != 80 {
		t.Fatalf("resize optimization destroyed the geometry needed to replay old bytes: %v", rec.Resizes)
	}
}
