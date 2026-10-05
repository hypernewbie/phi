package termproof

import (
	"bytes"
	"testing"
)

func TestReplayReportsAndUserInputAcrossEverySplit(t *testing.T) {
	_, barrier, err := newParserBarrier()
	if err != nil {
		t.Fatal(err)
	}
	source := []byte("key\x1b[1;7R\x1b[?1;2c\x1bP1$r0m\x1b\\\x1b]11;rgb:ffff/ffff/ffff\a\x1b[A界")
	source = append(source, barrier...)
	source = append(source, []byte("after\x1b[200~\x1b[1;7R\x1dq\x1b[201~")...)
	want := []byte("key\x1b[A界after\x1b[200~\x1b[1;7R\x1dq\x1b[201~")
	for cut := 0; cut <= len(source); cut++ {
		p := replayInput{}
		a, doneA, errA := p.Feed(source[:cut], barrier)
		b, doneB, errB := p.Feed(source[cut:], barrier)
		if errA != nil || errB != nil || !bytes.Equal(append(a, b...), want) || !(doneA || doneB) {
			t.Fatalf("split %d: input %q reached=%t/%t errors=%v/%v", cut, append(a, b...), doneA, doneB, errA, errB)
		}
	}
}

func TestReplayBarrierRequiresItsOwnEchoNotAWriteOrAnotherReport(t *testing.T) {
	_, a, err := newParserBarrier()
	if err != nil {
		t.Fatal(err)
	}
	_, b, err := newParserBarrier()
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Equal(a, b) {
		t.Fatal("barrier nonce reused")
	}
	p := replayInput{}
	if _, done, err := p.Feed(b, a); done || err != nil {
		t.Fatalf("unrelated report released replay: %t %v", done, err)
	}
	if _, done, err := p.Feed(a, a); !done || err != nil {
		t.Fatalf("own echo rejected: %t %v", done, err)
	}
}

// This is a measured reason not to enable the policy for legacy keyboards.
// Shift-F3 and cursor row 1, column 2 have the same bytes; a lexer cannot
// determine which source produced them while a CPR response is outstanding.
func TestLegacyShiftF3CannotBeDistinguishedFromCursorReport(t *testing.T) {
	p := replayInput{}
	keys, _, err := p.Feed([]byte("\x1b[1;2R"), nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(keys) != 0 {
		t.Fatal("counterexample no longer exercises report classification")
	}
	t.Log("Legacy Shift-F3 is consumed by the proposed reply policy; this policy is not safe to ship for that keyboard")
}

func TestReplayReplyStorageIsBounded(t *testing.T) {
	p := replayInput{}
	if _, _, err := p.Feed(append([]byte("\x1bP"), bytes.Repeat([]byte{'x'}, maxReplayInput)...), nil); err != errReplayInputLimit {
		t.Fatalf("unbounded reply accepted: %v", err)
	}
}
