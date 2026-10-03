package session

import (
	"github.com/hypernewbie/phi/pkg/coders"
	"testing"
)

func TestCodexNativeResumeFooterAcrossEverySplitAndANSI(t *testing.T) {
	id := "123e4567-e89b-12d3-a456-426614174000"
	footer := "Token usage: total=2 input=0 output=2\r\nTo continue this session, run:\r\n  \x1b[36mcodex resume " + id + "\x1b[39m\r\n"
	for split := 0; split <= len(footer); split++ {
		got := ""
		observer := ResumeReferenceObserver(coders.NewManager().MustGet("codex"), func(id string) { got = id })
		observer([]byte(footer[:split]))
		observer([]byte(footer[split:]))
		if got != id {
			t.Fatalf("split %d: %q", split, got)
		}
	}
}

func TestResumeObserverDoesNotGuessFromOrdinaryModelText(t *testing.T) {
	got := ""
	observer := ResumeReferenceObserver(coders.NewManager().MustGet("codex"), func(id string) { got = id })
	observer([]byte("Try codex resume 123e4567-e89b-12d3-a456-426614174000 or use --last.\n"))
	if got != "" {
		t.Fatal("guessed a session from arbitrary text")
	}
}
