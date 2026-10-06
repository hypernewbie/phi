package coders

import (
	"reflect"
	"strings"
	"testing"
)

func TestCodexLaunchResumeAndSafetyDefaults(t *testing.T) {
	c := NewManager().MustGet("codex")
	for _, tc := range []struct {
		id   string
		want []string
	}{
		{"", []string{"--no-alt-screen"}},
		{"01984de2-8f74-7c91-a3b2-5c5e937cf318", []string{"--no-alt-screen", "resume", "01984de2-8f74-7c91-a3b2-5c5e937cf318"}},
	} {
		plan, err := ResolveLaunch(c, SpawnRequest{SessionID: tc.id, Cwd: "/project"}, LaunchOptions{})
		if err != nil || plan.Command != "codex" || !reflect.DeepEqual(plan.Args, tc.want) || plan.Cwd != "/project" {
			t.Fatalf("bad launch: %+v %v", plan, err)
		}
	}
	if c.SessionSource != "codex_sqlite" || !c.Capabilities.List || c.Capabilities.Transcript {
		t.Fatalf("wrong capabilities: %+v", c)
	}
	for _, arg := range c.Args {
		if strings.Contains(arg, "dangerously") || strings.Contains(arg, "model") {
			t.Fatalf("unsafe or stale default: %q", arg)
		}
	}
	var hasConfirm bool
	for _, preset := range c.Presets {
		if preset.Name == "y↵" && preset.Value == "y\r" {
			hasConfirm = true
		}
		if strings.HasPrefix(preset.Value, "/model ") {
			t.Fatal("/model has no inline arguments")
		}
	}
	if !hasConfirm {
		t.Fatal("missing y↵ confirmation preset")
	}
	if !IsKnownSessionSource(c.SessionSource) {
		t.Fatal("adapter not registered")
	}
	plan, err := ResolveLaunch(c, SpawnRequest{SessionID: "uuid", ExtraArgs: []string{"--model", "gpt-6.1-sol"}}, LaunchOptions{})
	if err != nil || !reflect.DeepEqual(plan.Args, []string{"--no-alt-screen", "resume", "uuid", "--model", "gpt-6.1-sol"}) {
		t.Fatalf("extra args: %+v %v", plan, err)
	}
}
