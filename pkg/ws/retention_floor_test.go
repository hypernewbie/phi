// Property invariants for a rotating recording window. The bounded window
// only stays usable if two things hold for every reachable state, not just
// the happy path:
//
//  1. the attach head is client-consistent (0 <= oldest <= head, and any
//     checkpoint it advertises sits inside the retained window);
//  2. every retained byte stays addressable, so a reader can page from the
//     floor to the head without a hole.
//
// The sequences are seeded so a failure is reproducible: the seed is printed
// and can be passed with -run and PHI_SEED.
package ws

import (
	"bytes"
	"fmt"
	"math/rand"
	"os"
	"strconv"
	"testing"
)

// position reads the pane's floor and head under its lock. A pane that has no
// recording yet has no position to check.
func position(t *testing.T, h *Hub, pane string) (oldest, head uint64, ok bool) {
	t.Helper()
	ph, found := h.LookupPane(pane)
	if !found {
		return 0, 0, false
	}
	ph.mu.Lock()
	defer ph.mu.Unlock()
	pos := ph.positionLocked()
	return pos.Oldest, pos.Head, true
}

// assertClientConsistent checks what web-src/ws.ts requires of an attach head.
func assertClientConsistent(t *testing.T, h *Hub, pane string) {
	t.Helper()
	if _, _, ok := position(t, h, pane); !ok {
		return
	}
	c := &Client{Send: make(chan []byte, 4)}
	h.AttachHot(pane, c)
	hdr, extra := parseAttachHead(t, drainOne(c.Send))
	if !NumberIsSafeUint(hdr.Oldest) || !NumberIsSafeUint(hdr.Head) {
		t.Fatalf("head carries a non-integer frontier: %+v", hdr)
	}
	if hdr.Oldest > hdr.Head {
		t.Fatalf("oldest %d above head %d", hdr.Oldest, hdr.Head)
	}
	if hdr.Ckpt == nil {
		if len(extra) != 0 {
			t.Fatalf("snapshot bytes %d sent without a checkpoint", len(extra))
		}
		return
	}
	// web-src/ws.ts closes the socket unless oldest <= ckpt.through <= head.
	if hdr.Ckpt.Through < hdr.Oldest || hdr.Ckpt.Through > hdr.Head {
		t.Fatalf("checkpoint %d outside the retained window [%d,%d]", hdr.Ckpt.Through, hdr.Oldest, hdr.Head)
	}
	if hdr.Ckpt.Len != len(extra) {
		t.Fatalf("checkpoint len %d, snapshot %d bytes", hdr.Ckpt.Len, len(extra))
	}
}

// NumberIsSafeUint mirrors the client check: seqs survive JSON as doubles.
func NumberIsSafeUint(v uint64) bool { return v <= 1<<53-1 }

// assertWindowAddressable checks the paging invariant: any range the reader
// may legally ask for inside the window comes back whole, and any answer stays
// inside the window and reports the range it actually served.
func assertWindowAddressable(t *testing.T, h *Hub, pane string, rng *rand.Rand) {
	t.Helper()
	oldest, head, ok := position(t, h, pane)
	if !ok {
		return
	}
	for i := 0; i < 4 && head > oldest; i++ {
		from := oldest + uint64(rng.Int63n(int64(head-oldest)+1))
		rec, ok := h.Recording(pane, from, head)
		if !ok {
			t.Fatalf("retained range [%d,%d] refused (floor %d head %d)", from, head, oldest, head)
		}
		// The floor moves the start and the head moves the end. The answer
		// always reports what it served, which is how the client detects an
		// evicted prefix.
		if rec.Start != from || rec.End != head {
			t.Fatalf("range [%d,%d] answered as [%d,%d]", from, head, rec.Start, rec.End)
		}
		if uint64(len(rec.Data)) != head-from {
			t.Fatalf("range [%d,%d] returned %d bytes", from, head, len(rec.Data))
		}
	}
	// A window the floor already passed must never answer with bytes: it is
	// either refused, or clamped to an empty range at the floor.
	if oldest > 0 {
		rec, ok := h.Recording(pane, 0, oldest)
		switch {
		case ok && rec.Start >= oldest && rec.End >= rec.Start && rec.End <= head && uint64(len(rec.Data)) == rec.End-rec.Start:
		case ok:
			t.Fatalf("evicted range [0,%d] answered outside the window as [%d,%d] (%d bytes)", oldest, rec.Start, rec.End, len(rec.Data))
		}
	}
}

// assertDiskBound checks the reason this window exists: however much a pane
// writes, the retained recording never grows past the cap.
func assertDiskBound(t *testing.T, h *Hub, pane string) {
	t.Helper()
	oldest, head, ok := position(t, h, pane)
	if !ok {
		return
	}
	if head-oldest > retentionHistoryCap {
		t.Fatalf("retained %d bytes above the %d cap", head-oldest, retentionHistoryCap)
	}
}

// assertCheckpointRules checks the store contract: an upload for another pane
// lifetime, or ahead of the head, is refused and changes nothing.
func assertCheckpointRules(t *testing.T, h *Hub, pane string, epoch uint64) {
	t.Helper()
	_, head, ok := position(t, h, pane)
	if !ok {
		return
	}
	if h.StoreCheckpoint(pane, CheckpointUpload{Epoch: epoch + 1, Through: head, Cols: 80, Rows: 24, Ansi: []byte("bad-epoch")}) {
		t.Fatal("an upload for another pane lifetime was accepted")
	}
	if head > 0 && h.StoreCheckpoint(pane, CheckpointUpload{Epoch: epoch, Through: head + 1, Cols: 80, Rows: 24, Ansi: []byte("ahead")}) {
		t.Fatal("an upload ahead of the head was accepted")
	}
	// Whatever is stored must still satisfy the attach contract.
	assertClientConsistent(t, h, pane)
}

func seedFromEnv(def int64) int64 {
	if v := os.Getenv("PHI_SEED"); v != "" {
		if n, err := strconv.ParseInt(v, 10, 64); err == nil {
			return n
		}
	}
	return def
}

// TestRetentionWindowInvariants drives random ingest/resize/checkpoint/attach
// sequences through a rotating window and holds the two invariants above.
func TestRetentionWindowInvariants(t *testing.T) {
	seeds := []int64{1, 2, 3, 7, 42, 1337}
	if s := seedFromEnv(0); s != 0 {
		seeds = []int64{s}
	}
	for _, seed := range seeds {
		t.Run(fmt.Sprintf("seed=%d", seed), func(t *testing.T) {
			h := NewHub(64)
			if err := h.SetRecordingDirectory(t.TempDir()); err != nil {
				t.Fatalf("SetRecordingDirectory: %v", err)
			}
			rng := rand.New(rand.NewSource(seed))
			var epoch uint64
			// A checkpoint uploaded early, as a browser tab does. Rotation must
			// never make the server advertise it below the floor.
			staleThrough := uint64(0)
			for step := 0; step < 60; step++ {
				switch rng.Intn(5) {
				case 0, 1: // burst of output, usually larger than the cap
					size := 1 + rng.Intn(300<<10)
					payload := bytes.Repeat([]byte{byte('a' + rng.Intn(26))}, size)
					if err := h.Ingest("p", payload); err != nil {
						t.Fatalf("step %d: Ingest: %v", step, err)
					}
				case 2:
					h.RecordResize("p", uint16(20+rng.Intn(200)), uint16(10+rng.Intn(60)))
				case 3:
					p, exists := h.LookupPane("p")
					if !exists {
						break // nothing recorded yet, so nothing to checkpoint
					}
					p.mu.Lock()
					epoch = p.epoch
					p.mu.Unlock()
					oldest, head, _ := position(t, h, "p")
					through := head
					if head > oldest {
						through = oldest + uint64(rng.Int63n(int64(head-oldest)+1))
					}
					if rng.Intn(2) == 0 {
						staleThrough = through
					}
					h.StoreCheckpoint("p", CheckpointUpload{Epoch: epoch, Through: staleThrough, Cols: 80, Rows: 24, Ansi: bytes.Repeat([]byte("c"), 8)})
				default:
					assertClientConsistent(t, h, "p")
				}
				if step%7 == 0 {
					assertClientConsistent(t, h, "p")
					assertWindowAddressable(t, h, "p", rng)
					assertDiskBound(t, h, "p")
				}
			}
			assertClientConsistent(t, h, "p")
			assertWindowAddressable(t, h, "p", rng)
			assertDiskBound(t, h, "p")
			assertCheckpointRules(t, h, "p", epoch)
		})
	}
}

// TestRetentionWindowNeverLosesTheTail checks the invariant a reader depends
// on after a rotation: the newest byte is always readable, whatever the
// history looks like.
func TestRetentionWindowNeverLosesTheTail(t *testing.T) {
	rng := rand.New(rand.NewSource(seedFromEnv(9)))
	h := NewHub(64)
	if err := h.SetRecordingDirectory(t.TempDir()); err != nil {
		t.Fatalf("SetRecordingDirectory: %v", err)
	}
	var want byte
	for step := 0; step < 40; step++ {
		payload := bytes.Repeat([]byte{'z'}, 1+rng.Intn(200<<10))
		want = payload[len(payload)-1]
		if err := h.Ingest("p", payload); err != nil {
			t.Fatalf("step %d: Ingest: %v", step, err)
		}
		_, head, _ := position(t, h, "p")
		if head == 0 {
			continue
		}
		rec, ok := h.Recording("p", head-1, head)
		if !ok {
			t.Fatalf("step %d: last byte [%d,%d] refused", step, head-1, head)
		}
		if len(rec.Data) != 1 || rec.Data[0] != want {
			t.Fatalf("step %d: last byte = %q, want %q", step, rec.Data, want)
		}
	}
}
