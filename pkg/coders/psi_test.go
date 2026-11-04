package coders

import (
	"reflect"
	"testing"
)

func TestPiPsiIsPerLaunch(t *testing.T) {
	m := NewManager()
	base, ok := m.Get("pi")
	if !ok {
		t.Fatal("pi coder missing")
	}
	psi, err := PiPsi(base)
	if err != nil {
		t.Fatal(err)
	}
	if psi.Command != "psi" {
		t.Fatalf("expected command psi, got %q", psi.Command)
	}
	if psi.PiMode != "psi" {
		t.Fatalf("expected pi_mode psi, got %q", psi.PiMode)
	}
	if m.MustGet("pi").Command != "pi" || m.MustGet("pi").PiMode != "" {
		t.Fatal("PiPsi mutated registry default")
	}

	// Test ResolveLaunch with resume
	plan, err := ResolveLaunch(psi, SpawnRequest{SessionID: "sess-123"}, LaunchOptions{})
	if err != nil || !reflect.DeepEqual(plan.Args, []string{"--session", "sess-123"}) {
		t.Fatalf("bad Psi resume argv: %v %v", plan.Args, err)
	}

	// Psi takes the same caller-chosen --session-id as pi.
	freshPsi, id := FreshSession(psi)
	if id == "" || len(freshPsi.Args) != 2 || freshPsi.Args[0] != "--session-id" || freshPsi.Args[1] != id {
		t.Fatalf("FreshSession should inject --session-id for Psi: id=%q args=%v", id, freshPsi.Args)
	}

	// Ensure PiPsi cannot be called on non-pi coder
	if _, err := PiPsi(m.MustGet("claude")); err == nil {
		t.Fatal("PiPsi applied to claude")
	}
}

func TestPiPsiCustomCommand(t *testing.T) {
	m := NewManagerWithOptions(BuiltinOptions{PsiCommand: "/custom/path/psi"})
	base, _ := m.Get("pi")
	psi, err := PiPsi(base)
	if err != nil {
		t.Fatal(err)
	}
	if psi.Command != "/custom/path/psi" {
		t.Fatalf("expected custom command /custom/path/psi, got %q", psi.Command)
	}
}
