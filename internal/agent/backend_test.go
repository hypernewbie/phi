package agent

import (
	"errors"
	"reflect"
	"sync"
	"testing"
)

func TestBuildAgyArgs(t *testing.T) {
	tests := []struct {
		name      string
		baseArgs  []string
		model     string
		wantArgs  []string
		wantErrIs error
	}{
		{
			name:     "empty base args",
			baseArgs: []string{},
			model:    "gemini-4-argon-high",
			wantArgs: []string{"--model", "gemini-4-argon-high"},
		},
		{
			name:     "existing non-model args",
			baseArgs: []string{"--foo", "bar"},
			model:    "gemini-3.8-flash-medium",
			wantArgs: []string{"--foo", "bar", "--model", "gemini-3.8-flash-medium"},
		},
		{
			name:     "replace existing spaced --model",
			baseArgs: []string{"--model", "gemini-1.5-pro", "--something"},
			model:    "claude-opus-5-5-high",
			wantArgs: []string{"--model", "claude-opus-5-5-high", "--something"},
		},
		{
			name:     "replace existing equal --model",
			baseArgs: []string{"--model=gemini-1.5-pro", "--something"},
			model:    "claude-sonnet-5-5-medium",
			wantArgs: []string{"--model=claude-sonnet-5-5-medium", "--something"},
		},
		{
			name:     "alias resolution in model slug",
			baseArgs: []string{"--agent", "auto"},
			model:    "claude-5.5-sonnet",
			wantArgs: []string{"--agent", "auto", "--model", "claude-sonnet-5-5-medium"},
		},
		{
			name:      "haiku rejected",
			baseArgs:  []string{},
			model:     "claude-5.5-haiku",
			wantErrIs: ErrHaikuNotSupported,
		},
		{
			name:      "unknown model rejected",
			baseArgs:  []string{},
			model:     "bogus-model",
			wantErrIs: ErrModelNotFound,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got, err := BuildAgyArgs(tc.baseArgs, tc.model)
			if tc.wantErrIs != nil {
				if !errors.Is(err, tc.wantErrIs) {
					t.Fatalf("BuildAgyArgs() err = %v, want %v", err, tc.wantErrIs)
				}
				return
			}
			if err != nil {
				t.Fatalf("BuildAgyArgs() unexpected err: %v", err)
			}
			if !reflect.DeepEqual(got, tc.wantArgs) {
				t.Errorf("BuildAgyArgs() = %v, want %v", got, tc.wantArgs)
			}
		})
	}
}

func TestExtractModel(t *testing.T) {
	tests := []struct {
		args      []string
		wantModel string
		wantFound bool
	}{
		{[]string{"--foo", "--model", "gemini-4-argon-high", "--bar"}, "gemini-4-argon-high", true},
		{[]string{"--model=claude-opus-5-5-medium"}, "claude-opus-5-5-medium", true},
		{[]string{"--foo", "bar"}, "", false},
		{[]string{"--model"}, "", false},
	}

	for _, tc := range tests {
		got, found := ExtractModel(tc.args)
		if found != tc.wantFound || got != tc.wantModel {
			t.Errorf("ExtractModel(%v) = (%q, %v), want (%q, %v)", tc.args, got, found, tc.wantModel, tc.wantFound)
		}
	}
}

func TestFormatModelCommandAndSlashInput(t *testing.T) {
	cmd, err := FormatModelCommand("gemini-4-argon-high")
	if err != nil {
		t.Fatalf("FormatModelCommand failed: %v", err)
	}
	if cmd != "/model gemini-4-argon-high" {
		t.Errorf("FormatModelCommand = %q, want %q", cmd, "/model gemini-4-argon-high")
	}

	// Alias resolution
	cmd, err = FormatModelCommand("claude-5.5-sonnet")
	if err != nil {
		t.Fatalf("FormatModelCommand alias failed: %v", err)
	}
	if cmd != "/model claude-sonnet-5-5-medium" {
		t.Errorf("FormatModelCommand alias = %q, want %q", cmd, "/model claude-sonnet-5-5-medium")
	}

	input, err := FormatModelSlashInput("gemini-4-argon-high")
	if err != nil {
		t.Fatalf("FormatModelSlashInput failed: %v", err)
	}
	if input != "/model gemini-4-argon-high\r" {
		t.Errorf("FormatModelSlashInput = %q, want %q", input, "/model gemini-4-argon-high\r")
	}

	// Invalid
	if _, err := FormatModelCommand("bad-model"); !errors.Is(err, ErrModelNotFound) {
		t.Errorf("FormatModelCommand(bad-model) err = %v, want ErrModelNotFound", err)
	}
	if _, err := FormatModelSlashInput("claude-haiku"); !errors.Is(err, ErrHaikuNotSupported) {
		t.Errorf("FormatModelSlashInput(claude-haiku) err = %v, want ErrHaikuNotSupported", err)
	}
}

func TestParseModelCommand(t *testing.T) {
	tests := []struct {
		name      string
		input     string
		wantSlug  string
		wantErrIs error
	}{
		{
			name:     "clean command",
			input:    "/model gemini-4-argon-high",
			wantSlug: "gemini-4-argon-high",
		},
		{
			name:     "carriage return suffix",
			input:    "/model gemini-3.8-flash-medium\r",
			wantSlug: "gemini-3.8-flash-medium",
		},
		{
			name:     "newline and carriage return suffix",
			input:    "/model gpt-oss-120b-medium\r\n",
			wantSlug: "gpt-oss-120b-medium",
		},
		{
			name:     "extra whitespace and alias",
			input:    "   /model    claude-5.5-sonnet-high   \r",
			wantSlug: "claude-sonnet-5-5-high",
		},
		{
			name:      "missing argument",
			input:     "/model\r",
			wantErrIs: ErrInvalidCommand,
		},
		{
			name:      "wrong command",
			input:     "/compact\r",
			wantErrIs: ErrInvalidCommand,
		},
		{
			name:      "haiku rejected",
			input:     "/model claude-5.5-haiku\r",
			wantErrIs: ErrHaikuNotSupported,
		},
		{
			name:      "unknown model",
			input:     "/model nonexistent\r",
			wantErrIs: ErrModelNotFound,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got, err := ParseModelCommand(tc.input)
			if tc.wantErrIs != nil {
				if !errors.Is(err, tc.wantErrIs) {
					t.Fatalf("ParseModelCommand(%q) err = %v, want %v", tc.input, err, tc.wantErrIs)
				}
				return
			}
			if err != nil {
				t.Fatalf("ParseModelCommand(%q) unexpected err: %v", tc.input, err)
			}
			if got != tc.wantSlug {
				t.Errorf("ParseModelCommand(%q) = %q, want %q", tc.input, got, tc.wantSlug)
			}
		})
	}
}

func TestSessionState(t *testing.T) {
	// Empty init
	state, err := NewSessionState("")
	if err != nil {
		t.Fatalf("NewSessionState(\"\") failed: %v", err)
	}
	if state.Model() != "" {
		t.Errorf("state.Model() = %q, want empty", state.Model())
	}
	if _, ok := state.ModelInfo(); ok {
		t.Error("state.ModelInfo() returned ok=true for empty model")
	}
	if _, err := state.SlashCommand(); err == nil {
		t.Error("state.SlashCommand() expected error for empty model, got nil")
	}

	// ApplyToArgs with no model should return unmodified args
	origArgs := []string{"--foo", "bar"}
	args, err := state.ApplyToArgs(origArgs)
	if err != nil || !reflect.DeepEqual(args, origArgs) {
		t.Errorf("state.ApplyToArgs(orig) = (%v, %v), want (%v, nil)", args, err, origArgs)
	}

	// Set valid model
	if err := state.SetModel("claude-5.5-sonnet"); err != nil {
		t.Fatalf("SetModel failed: %v", err)
	}
	if state.Model() != "claude-sonnet-5-5-medium" {
		t.Errorf("state.Model() = %q, want %q", state.Model(), "claude-sonnet-5-5-medium")
	}
	info, ok := state.ModelInfo()
	if !ok || info.DisplayName != "Claude Sonnet 5.5 (Medium)" {
		t.Errorf("state.ModelInfo() = (%+v, %v)", info, ok)
	}

	// SlashCommand
	cmd, err := state.SlashCommand()
	if err != nil || cmd != "/model claude-sonnet-5-5-medium\r" {
		t.Errorf("state.SlashCommand() = (%q, %v), want %q", cmd, err, "/model claude-sonnet-5-5-medium\r")
	}

	// ApplyToArgs
	applied, err := state.ApplyToArgs([]string{"--prompt", "hello"})
	if err != nil {
		t.Fatalf("ApplyToArgs failed: %v", err)
	}
	wantApplied := []string{"--prompt", "hello", "--model", "claude-sonnet-5-5-medium"}
	if !reflect.DeepEqual(applied, wantApplied) {
		t.Errorf("ApplyToArgs = %v, want %v", applied, wantApplied)
	}

	// Concurrency test
	var wg sync.WaitGroup
	for i := 0; i < 50; i++ {
		wg.Add(2)
		go func() {
			defer wg.Done()
			_ = state.SetModel("gemini-4-argon-high")
		}()
		go func() {
			defer wg.Done()
			_ = state.Model()
			_, _ = state.SlashCommand()
		}()
	}
	wg.Wait()
}
