package pibridge

import (
	"sync"

	pibridgepb "github.com/hypernewbie/phi/internal/pibridge/pb"
)

// journal is the bounded per-runtime lifecycle record store. Sequence
// numbers are monotonic and never reused; a duplicate or out-of-order
// sequence is ignored; overflow drops the oldest record and latches a gap
// indicator that only a new runtime generation clears.
type journal struct {
	mu       sync.Mutex
	records  []lifecycleRecord
	firstSeq uint64
	lastSeq  uint64
	gap      bool
}

type lifecycleRecord struct {
	sequence uint64
	runID    uint64
	settled  bool
	outcome  pibridgepb.RunOutcome
}

// append stores one edge when its sequence advances the journal. It returns
// false for duplicate or out-of-order sequences, which callers ignore.
func (j *journal) append(sequence, runID uint64, settled bool, outcome pibridgepb.RunOutcome) bool {
	j.mu.Lock()
	defer j.mu.Unlock()
	if len(j.records) > 0 && sequence <= j.lastSeq {
		return false
	}
	if len(j.records) == maxJournalRecords {
		j.records = j.records[1:]
		j.gap = true
	}
	j.records = append(j.records, lifecycleRecord{
		sequence: sequence, runID: runID, settled: settled, outcome: outcome,
	})
	j.firstSeq = j.records[0].sequence
	j.lastSeq = sequence
	return true
}

// snapshot copies the retained records and the gap indicator.
func (j *journal) snapshot() (records []lifecycleRecord, gap bool, first, last uint64) {
	j.mu.Lock()
	defer j.mu.Unlock()
	out := make([]lifecycleRecord, len(j.records))
	copy(out, j.records)
	return out, j.gap, j.firstSeq, j.lastSeq
}

// reset clears the journal for a new runtime generation.
func (j *journal) reset() {
	j.mu.Lock()
	defer j.mu.Unlock()
	j.records = nil
	j.firstSeq = 0
	j.lastSeq = 0
	j.gap = false
}
