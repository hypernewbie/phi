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

	// Psi chooses its own fresh ID and reports it through its built-in
	// bridge, so the launch adds no identity flag. A forced ID would make
	// Psi scan every session file before it starts.
	freshPsi, id := FreshSession(psi)
	if id != "" || len(freshPsi.Args) != 0 {
		t.Fatalf("FreshSession should leave Psi identity unset: id=%q args=%v", id, freshPsi.Args)
	}
	freshPlan, err := ResolveLaunch(freshPsi, SpawnRequest{}, LaunchOptions{})
	if err != nil {
		t.Fatalf("resolve fresh Psi launch: %v", err)
	}
	for _, arg := range freshPlan.Args {
		if arg == "--session-id" || arg == "--session" {
			t.Fatalf("fresh Psi launch must not add a session flag: %v", freshPlan.Args)
		}
	}

	// Ensure PiPsi cannot be called on non-pi coder
	if _, err := PiPsi(m.MustGet("claude")); err == nil {
		t.Fatal("PiPsi applied to claude")
	}
}

func TestPsiFreshSessionPreservesConfiguredArguments(t *testing.T) {
	base := NewManager().MustGet("pi")
	// Assert raw argv on Windows too, without PowerShell wrapping.
	base.WindowsPowerShellWrap = new(bool)
	base.Args = []string{"--model", "space value", "--session-id", "user-picked-id"}
	psi, err := PiPsi(base)
	if err != nil {
		t.Fatal(err)
	}
	fresh, id := FreshSession(psi)
	if id != "" || !reflect.DeepEqual(fresh.Args, base.Args) {
		t.Fatalf("fresh Psi changed configured arguments: id=%q args=%q", id, fresh.Args)
	}
	plan, err := ResolveLaunch(fresh, SpawnRequest{ExtraArgs: []string{"--name", "request title"}}, LaunchOptions{})
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"--model", "space value", "--session-id", "user-picked-id", "--name", "request title"}
	if !reflect.DeepEqual(plan.Args, want) {
		t.Fatalf("fresh Psi argv = %q, want %q", plan.Args, want)
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
