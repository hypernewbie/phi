package pibridge

import "testing"

import (
	pibridgepb "github.com/hypernewbie/phi/internal/pibridge/pb"
)

func TestJournalAppendMonotonic(t *testing.T) {
	var j journal
	if !j.append(1, 10, false, pibridgepb.RunOutcome_RUN_OUTCOME_UNSPECIFIED) {
		t.Fatal("first append rejected")
	}
	if !j.append(2, 10, true, pibridgepb.RunOutcome_RUN_OUTCOME_COMPLETED) {
		t.Fatal("second append rejected")
	}
	records, gap, first, last := j.snapshot()
	if gap || first != 1 || last != 2 || len(records) != 2 {
		t.Fatalf("unexpected snapshot: gap=%v first=%d last=%d n=%d", gap, first, last, len(records))
	}
	if !records[1].settled || records[1].outcome != pibridgepb.RunOutcome_RUN_OUTCOME_COMPLETED {
		t.Fatalf("settlement not retained: %+v", records[1])
	}
}

func TestJournalIgnoresDuplicateAndOutOfOrder(t *testing.T) {
	var j journal
	if !j.append(5, 1, false, pibridgepb.RunOutcome_RUN_OUTCOME_UNSPECIFIED) {
		t.Fatal("seed rejected")
	}
	if j.append(5, 1, true, pibridgepb.RunOutcome_RUN_OUTCOME_COMPLETED) {
		t.Fatal("duplicate accepted")
	}
	if j.append(4, 1, false, pibridgepb.RunOutcome_RUN_OUTCOME_UNSPECIFIED) {
		t.Fatal("out-of-order accepted")
	}
	records, gap, first, last := j.snapshot()
	if gap || len(records) != 1 || first != 5 || last != 5 {
		t.Fatalf("journal changed on duplicate: %+v gap=%v", records, gap)
	}
	if records[0].settled {
		t.Fatal("duplicate overwrote retained record")
	}
}

func TestJournalOverflowKeepsBoundAndGap(t *testing.T) {
	var j journal
	for i := uint64(1); i <= maxJournalRecords+10; i++ {
		if !j.append(i, i, i%2 == 0, pibridgepb.RunOutcome_RUN_OUTCOME_COMPLETED) {
			t.Fatalf("append %d rejected", i)
		}
	}
	records, gap, first, last := j.snapshot()
	if !gap {
		t.Fatal("gap not latched on overflow")
	}
	if len(records) != maxJournalRecords {
		t.Fatalf("retained %d, want %d", len(records), maxJournalRecords)
	}
	if first != 11 || last != maxJournalRecords+10 {
		t.Fatalf("range %d..%d, want 11..%d", first, last, maxJournalRecords+10)
	}
	if records[0].sequence != 11 {
		t.Fatalf("oldest not dropped: %d", records[0].sequence)
	}
}

func TestJournalResetClearsGap(t *testing.T) {
	var j journal
	for i := uint64(1); i <= maxJournalRecords+1; i++ {
		j.append(i, 1, false, pibridgepb.RunOutcome_RUN_OUTCOME_UNSPECIFIED)
	}
	if _, gap, _, _ := j.snapshot(); !gap {
		t.Fatal("gap not set before reset")
	}
	j.reset()
	records, gap, first, last := j.snapshot()
	if gap || len(records) != 0 || first != 0 || last != 0 {
		t.Fatalf("reset incomplete: n=%d gap=%v %d..%d", len(records), gap, first, last)
	}
	if !j.append(1, 1, false, pibridgepb.RunOutcome_RUN_OUTCOME_UNSPECIFIED) {
		t.Fatal("append after reset rejected")
	}
}
