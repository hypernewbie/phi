package coders

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"
)

func init() {
	if value := os.Getenv("PHI_TEST_OC_VERSION"); value != "" {
		if value == "wait" {
			time.Sleep(10 * time.Second)
		}
		if value == "oversize" {
			fmt.Print(strings.Repeat("x", 40*1024))
		} else {
			fmt.Print(value)
		}
		os.Exit(0)
	}
}

func TestOpenCodeDefaultsToV2Mini(t *testing.T) {
	m := NewManager()
	c, _ := m.Get("opencode")
	if c.Command != "opencode" || c.OpenCodeMode != "mini" || c.SessionSource != "opencode_v2" || !reflect.DeepEqual(c.Args, []string{"mini"}) {
		t.Fatalf("wrong default: %+v", c)
	}
	plan, err := ResolveLaunch(c, SpawnRequest{SessionID: "ses_test", ExtraArgs: []string{"--model", "opencode/big-pickle"}}, LaunchOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(plan.Args, []string{"mini", "--session", "ses_test", "--model", "opencode/big-pickle"}) {
		t.Fatalf("args: %v", plan.Args)
	}
	for _, p := range c.Presets {
		if p.Name == "/models" || p.Name == "/undo" || p.Name == "/sessions" || p.Name == "/copy" {
			t.Fatalf("unsupported mini preset: %+v", p)
		}
	}
	d := c.Descriptor()
	if d.OpenCodeMode != "mini" {
		t.Fatalf("mode missing from descriptor: %+v", d)
	}
	body, _ := json.Marshal(d)
	if strings.Contains(string(body), "session_source") || strings.Contains(string(body), "command") {
		t.Fatalf("private fields in descriptor: %s", body)
	}
}

func TestOpenCodeLegacyOptionAndSeparateCommands(t *testing.T) {
	for _, legacy := range []bool{false, true} {
		m := NewManagerWithOptions(BuiltinOptions{OpenCodeLegacy: legacy, OpenCodeCommand: "/v2 bin/opencode", OpenCodeLegacyCommand: "/v1 bin/opencode"})
		c, _ := m.Get("opencode")
		if legacy {
			if c.Command != "/v1 bin/opencode" || len(c.Args) != 0 || c.SessionSource != "opencode_sqlite" || c.OpenCodeMode != "legacy" || len(c.Presets) != 12 {
				t.Fatalf("wrong legacy: %+v", c)
			}
		} else if c.Command != "/v2 bin/opencode" || c.OpenCodeMode != "mini" {
			t.Fatalf("wrong mini: %+v", c)
		}
		claude, _ := m.Get("claude")
		if claude.Command != "claude" || len(claude.Args) != 0 {
			t.Fatalf("other coder changed: %+v", claude)
		}
	}
	c, _ := NewManagerWithOptions(BuiltinOptions{OpenCodeLegacy: true}).Get("opencode")
	if c.Command != "opencode" {
		t.Fatalf("legacy default executable changed: %s", c.Command)
	}
}

func TestOpenCodeVersionChecks(t *testing.T) {
	for _, tt := range []struct {
		mode, version string
		valid         bool
	}{
		{"mini", "opencode v2.0.21\n", true},
		{"mini", "2.0.21\n", true},
		{"mini", "1.18.34\n", false},
		{"legacy", "1.18.34\n", true},
		{"legacy", "opencode v2.0.21\n", false},
		{"mini", "garbage\n", false},
	} {
		t.Run(tt.mode+tt.version, func(t *testing.T) {
			c := Coder{ID: "opencode", Command: os.Args[0], OpenCodeMode: tt.mode, Env: map[string]string{"PHI_TEST_OC_VERSION": tt.version}}
			err := VerifyOpenCode(context.Background(), c)
			if (err == nil) != tt.valid {
				t.Fatalf("valid=%v, err=%v", tt.valid, err)
			}
			if os.Getenv("PHI_TEST_OC_VERSION") != "" {
				t.Fatal("profile env leaked into server")
			}
		})
	}
}

func TestOpenCodeInspectionOutputBound(t *testing.T) {
	c := Coder{Command: os.Args[0], Env: map[string]string{"PHI_TEST_OC_VERSION": "oversize"}}
	data, err := OpenCodeOutput(context.Background(), c, "--version")
	if err == nil || len(data) > 32*1024 {
		t.Fatalf("unbounded inspection: %d bytes, %v", len(data), err)
	}
}

func TestOpenCodeCustomArgvDoesNotAdvertiseMini(t *testing.T) {
	c, _ := NewManager().Get("opencode")
	args := []string{}
	patched, err := (&CoderPatch{Args: &args}).Apply(c)
	if err != nil || patched.OpenCodeMode != "" {
		t.Fatalf("wrong overridden mode: %+v %v", patched, err)
	}
	if c.OpenCodeMode != "mini" || len(c.Args) != 1 {
		t.Fatal("patch mutated original")
	}
}

func TestOpenCodeVersionCancellation(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	c := Coder{ID: "opencode", Command: os.Args[0], OpenCodeMode: "mini", Env: map[string]string{"PHI_TEST_OC_VERSION": "wait"}}
	if err := VerifyOpenCode(ctx, c); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("got %v", err)
	}
}
