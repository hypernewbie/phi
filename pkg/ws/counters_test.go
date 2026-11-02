//go:build profiling

package ws

import (
	"errors"
	"os"
	"testing"
)

// Counter tests assert deltas, never absolute values: the counters are
// package-level and every test in this package shares them. These tests
// stay serial; pkg/ws has no t.Parallel calls.
func TestJournalCountersReconcileWithFile(t *testing.T) {
	for _, tc := range []struct {
		name      string
		ephemeral bool
	}{
		{name: "durable"},
		{name: "ephemeral", ephemeral: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var j *rawJournal
			var dir string
			if tc.ephemeral {
				var err error
				// openTestRawJournal(t, "") is NOT ephemeral: it substitutes
				// a temp dir. Only an explicit empty dir requests one.
				j, err = openRawJournal("", 80, 24, nil)
				if err != nil {
					t.Fatalf("openRawJournal: %v", err)
				}
				t.Cleanup(func() { _ = j.close() })
			} else {
				dir = t.TempDir()
				j = openTestRawJournal(t, dir)
			}
			payloads := [][]byte{[]byte("first\n"), {}, []byte("second output chunk")}
			var want uint64
			before := RuntimeStats()
			for i, p := range payloads {
				if _, err := j.appendPayload(p); err != nil {
					t.Fatalf("append %d: %v", i, err)
				}
				want += uint64(len(p))
			}
			after := RuntimeStats()
			if got := after.Journal.Appends - before.Journal.Appends; got != 3 {
				t.Fatalf("appends delta = %d, want 3", got)
			}
			if got := after.Journal.Bytes - before.Journal.Bytes; got != want {
				t.Fatalf("bytes delta = %d, want %d", got, want)
			}
			var wantSyncs uint64 = 3
			if tc.ephemeral {
				wantSyncs = 0
			}
			if got := after.Journal.Syncs - before.Journal.Syncs; got != wantSyncs {
				t.Fatalf("syncs delta = %d, want %d", got, wantSyncs)
			}
			if got := after.Journal.SyncFailures - before.Journal.SyncFailures; got != 0 {
				t.Fatalf("sync_failures delta = %d, want 0", got)
			}
			if got := after.Journal.PendingRecoveries - before.Journal.PendingRecoveries; got != 0 {
				t.Fatalf("pending_recoveries delta = %d, want 0", got)
			}
			if j.head != want {
				t.Fatalf("head = %d, want %d", j.head, want)
			}

			// A resize commits geometry, not output: no admission growth,
			// 9 more file bytes, and only a durable staging syncs.
			resizeBefore := RuntimeStats()
			if err := j.stageResize(100, 30); err != nil {
				t.Fatalf("stageResize: %v", err)
			}
			if _, err := j.commitResize(); err != nil {
				t.Fatalf("commitResize: %v", err)
			}
			resizeAfter := RuntimeStats()
			if got := resizeAfter.Journal.Appends - resizeBefore.Journal.Appends; got != 0 {
				t.Fatalf("resize appends delta = %d, want 0", got)
			}
			if got := resizeAfter.Journal.Bytes - resizeBefore.Journal.Bytes; got != 0 {
				t.Fatalf("resize bytes delta = %d, want 0", got)
			}
			var wantResizeSyncs uint64 = 1
			if tc.ephemeral {
				wantResizeSyncs = 0
			}
			if got := resizeAfter.Journal.Syncs - resizeBefore.Journal.Syncs; got != wantResizeSyncs {
				t.Fatalf("resize syncs delta = %d, want %d", got, wantResizeSyncs)
			}
			fi, err := j.file.Stat()
			if err != nil {
				t.Fatal(err)
			}
			if want := int64(want) + 3*rawRecordHeader + rawRecordHeader + 4; fi.Size() != want {
				t.Fatalf("file size = %d, want %d", fi.Size(), want)
			}

			if tc.ephemeral {
				return
			}
			// Reading and recovery must neither reset the counters nor add
			// admissions: only accepted payloads count.
			steady := RuntimeStats()
			if _, _, _, err := j.readOrd(0, j.head, 0); err != nil {
				t.Fatalf("read: %v", err)
			}
			if err := j.close(); err != nil {
				t.Fatalf("close: %v", err)
			}
			r, err := openRawJournal(dir, 80, 24, nil)
			if err != nil {
				t.Fatalf("reopen: %v", err)
			}
			t.Cleanup(func() { _ = r.close() })
			if _, _, _, err := r.readOrd(0, r.head, 0); err != nil {
				t.Fatalf("read after reopen: %v", err)
			}
			resumed := RuntimeStats()
			if resumed.Journal != steady.Journal {
				t.Fatalf("read/reopen moved counters: %+v -> %+v", steady.Journal, resumed.Journal)
			}
		})
	}
}

func TestJournalCountersFailureAndRetry(t *testing.T) {
	payload := []byte("counter payload")
	injected := errors.New("injected")
	for _, tc := range []struct {
		name   string
		inject func(j *rawJournal)
		// Deltas after the failed append: appends, bytes, syncs, failures, recoveries.
		fail [5]uint64
		// Deltas after the cleared identical retry succeeds.
		retry [5]uint64
	}{
		{
			name:   "journalSync",
			inject: func(j *rawJournal) { j.faults.journalSync = injected },
			fail:   [5]uint64{0, 0, 0, 1, 0},
			retry:  [5]uint64{1, uint64(len(payload)), 1, 1, 0},
		},
		{
			name:   "manifestSync",
			inject: func(j *rawJournal) { j.faults.manifestSync = injected },
			fail:   [5]uint64{0, 0, 1, 0, 0},
			retry:  [5]uint64{1, uint64(len(payload)), 2, 0, 0},
		},
		{
			name:   "dirSync",
			inject: func(j *rawJournal) { j.faults.dirSync = injected },
			fail:   [5]uint64{0, 0, 1, 0, 0},
			retry:  [5]uint64{1, uint64(len(payload)), 1, 0, 1},
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			j := openTestRawJournal(t, "")
			tc.inject(j)
			before := RuntimeStats()
			if _, err := j.appendPayload(payload); err == nil {
				t.Fatal("faulted append must fail")
			}
			deltas := journalDeltas(before, RuntimeStats())
			if deltas != tc.fail {
				t.Fatalf("failure deltas = %v, want %v", deltas, tc.fail)
			}
			if tc.name == "dirSync" {
				if j.pending == nil {
					t.Fatal("ambiguous manifest commit must retain pending state")
				}
				mismatch := RuntimeStats()
				if _, err := j.appendPayload([]byte("different bytes")); !errors.Is(err, errStagedMismatch) {
					t.Fatalf("mismatched retry: got %v, want errStagedMismatch", err)
				}
				if got := journalDeltas(mismatch, RuntimeStats()); got != [5]uint64{} {
					t.Fatalf("mismatched retry moved counters: %v", got)
				}
			} else if j.pending != nil {
				t.Fatalf("clean failure must not retain pending state")
			}
			j.faults = rawFaults{}
			if _, err := j.appendPayload(payload); err != nil {
				t.Fatalf("retry after clear: %v", err)
			}
			if got := journalDeltas(before, RuntimeStats()); got != tc.retry {
				t.Fatalf("final deltas = %v, want %v", got, tc.retry)
			}
			if j.head != uint64(len(payload)) {
				t.Fatalf("head = %d, want %d", j.head, len(payload))
			}
		})
	}

	// A real Sync error counts one attempt and one failure, with no admission.
	t.Run("closedFile", func(t *testing.T) {
		j := openTestRawJournal(t, "")
		if err := j.file.Close(); err != nil {
			t.Fatal(err)
		}
		before := RuntimeStats()
		if err := j.syncJournal(); !errors.Is(err, os.ErrClosed) {
			t.Fatalf("syncJournal on closed file: got %v, want os.ErrClosed", err)
		}
		if got := journalDeltas(before, RuntimeStats()); got != [5]uint64{0, 0, 1, 1, 0} {
			t.Fatalf("closed-file deltas = %v, want [0 0 1 1 0]", got)
		}
	})
}

// journalDeltas returns counter movement as appends, bytes, syncs, failures,
// recoveries between two snapshots.
func journalDeltas(before, after RuntimeCounters) [5]uint64 {
	return [5]uint64{
		after.Journal.Appends - before.Journal.Appends,
		after.Journal.Bytes - before.Journal.Bytes,
		after.Journal.Syncs - before.Journal.Syncs,
		after.Journal.SyncFailures - before.Journal.SyncFailures,
		after.Journal.PendingRecoveries - before.Journal.PendingRecoveries,
	}
}
