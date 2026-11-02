//go:build profiling

package ws

import "sync/atomic"

// journalCounters holds process-wide raw-journal admission counters. They
// are never reset: a journal is created and destroyed per pane, so pane
// lifetime must not erase history. Rates come from snapshot deltas.
var journalCounters struct {
	appends         atomic.Uint64
	bytes           atomic.Uint64
	syncs           atomic.Uint64
	syncFailures    atomic.Uint64
	pendingRecovery atomic.Uint64
}

// JournalCounters is the published view of journal admission counters.
type JournalCounters struct {
	Appends           uint64 `json:"appends"`
	Bytes             uint64 `json:"bytes"`
	Syncs             uint64 `json:"syncs"`
	SyncFailures      uint64 `json:"sync_failures"`
	PendingRecoveries uint64 `json:"pending_recoveries"`
}

// RuntimeCounters is the published view of process-wide runtime counters.
type RuntimeCounters struct {
	Journal JournalCounters `json:"journal"`
}

// countJournalAppend records one successful payload admission. It runs in
// advancePayload, the single funnel for fresh and resumed admissions.
func countJournalAppend(payloadLen int) {
	journalCounters.appends.Add(1)
	journalCounters.bytes.Add(uint64(payloadLen))
}

// countJournalSync records one journal-file Sync attempt.
func countJournalSync() {
	journalCounters.syncs.Add(1)
}

// countJournalSyncFailure records one failed journal-file Sync attempt,
// including injected faults that return before the syscall.
func countJournalSyncFailure() {
	journalCounters.syncFailures.Add(1)
}

// countJournalPendingRecovery records one payload admission resumed from
// rawPending instead of written as a new record.
func countJournalPendingRecovery() {
	journalCounters.pendingRecovery.Add(1)
}

// RuntimeStats reads the counters without touching any hub or pane state.
// Each field is one atomic load; the struct is not a transaction.
func RuntimeStats() RuntimeCounters {
	return RuntimeCounters{
		Journal: JournalCounters{
			Appends:           journalCounters.appends.Load(),
			Bytes:             journalCounters.bytes.Load(),
			Syncs:             journalCounters.syncs.Load(),
			SyncFailures:      journalCounters.syncFailures.Load(),
			PendingRecoveries: journalCounters.pendingRecovery.Load(),
		},
	}
}
