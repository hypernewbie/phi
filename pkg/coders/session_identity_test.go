package coders

import (
	"github.com/google/uuid"
	"strings"
	"testing"
)

func TestFreshNativeSessionIdentityIsExactAndDoesNotMutateDefaults(t *testing.T) {
	m := NewManager()
	for _, id := range []string{"claude", "pi", "opencode"} {
		c := m.MustGet(id)
		fresh, nativeID := FreshSession(c)
		if nativeID == "" || len(fresh.Args) != len(c.Args)+2 {
			t.Fatalf("%s: no exact identity", id)
		}
		if _, err := uuid.Parse(strings.TrimPrefix(nativeID, "ses_")); err != nil {
			t.Fatal(err)
		}
		if fresh.Args[len(fresh.Args)-1] != nativeID {
			t.Fatalf("%s: launch ID differs from stored ID", id)
		}
		if len(m.MustGet(id).Args) != len(c.Args) {
			t.Fatal("mutated registry")
		}
	}
	legacy := NewManagerWithOptions(BuiltinOptions{OpenCodeLegacy: true}).MustGet("opencode")
	if _, id := FreshSession(legacy); id != "" {
		t.Fatal("guessed legacy identity")
	}
	for _, id := range []string{"codex", "agy", "bash", "pwsh"} {
		if _, nativeID := FreshSession(m.MustGet(id)); nativeID != "" {
			t.Fatalf("invented %s native identity", id)
		}
	}
}
