package coders

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"os/exec"
	"regexp"
	"strings"
	"time"
)

// BuiltinOptions select the installed OpenCode generation before custom
// backend patches are applied. Command values are executable names/paths,
// never shell command strings. Empty values use "opencode".
type BuiltinOptions struct {
	OpenCodeLegacy        bool
	OpenCodeCommand       string
	OpenCodeLegacyCommand string
}

func OpenCodeMiniPresets() []Preset {
	return []Preset{
		{Name: "/exit", Value: "/exit\r"},
		{Name: "/compact", Value: "/compact\r"},
		{Name: "/new", Value: "/new\r"},
		{Name: "/settings", Value: "/settings\r"},
		{Name: "menu", Value: "\x10"},
		{Name: "clear", Value: "\x0c"},
		{Name: "ctrl+c", Value: "\x03"},
		{Name: "y↵", Value: "y\r"},
		{Name: "esc", Value: "\x1b"},
	}
}

// OpenCodeMini selects Mini for one launch, without modifying the registry
// or changing the generation selected by the user's legacy config option.
func OpenCodeMini(c Coder) (Coder, error) {
	if c.ID != "opencode" || c.SessionSource != "opencode_v2" || c.OpenCodeMode == "legacy" {
		return Coder{}, fmt.Errorf("Mini requires the OpenCode 2 backend")
	}
	out := frozenCoder(c)
	if len(out.Args) == 0 || out.Args[0] != "mini" {
		out.Args = append([]string{"mini"}, out.Args...)
	}
	out.OpenCodeMode = "mini"
	out.Presets = OpenCodeMiniPresets()
	return out, nil
}

// OpenCodeTUI restores the full presentation of a v2 launch profile without
// changing the registry's default or its configured command/environment.
func OpenCodeTUI(c Coder) Coder {
	out := frozenCoder(c)
	if len(out.Args) > 0 && out.Args[0] == "mini" {
		out.Args = out.Args[1:]
	}
	out.OpenCodeMode = "tui"
	out.Presets = DefaultRegistry()["opencode"].Presets
	return out
}

func legacyOpenCodePresets() []Preset {
	return []Preset{
		{Name: "/exit", Value: "/exit\r"},
		{Name: "/context", Value: "/context\r"},
		{Name: "/model", Value: "/model\r"},
		{Name: "/compact", Value: "/compact\r"},
		{Name: "/undo", Value: "/undo\r"},
		{Name: "/copy", Value: "/copy\r"},
		{Name: "/sessions", Value: "/sessions\r"},
		{Name: "ctrl+c", Value: "\x03"},
		{Name: "ctrl+o", Value: "\x0f"},
		{Name: "y↵", Value: "y\r"},
		{Name: "esc", Value: "\x1b"},
		{Name: "/clear", Value: "/clear\r"},
	}
}

var openCodeVersionPattern = regexp.MustCompile(`^[12]\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$`)

type openCodeProbeOutput struct{ buffer bytes.Buffer }

func (b *openCodeProbeOutput) Bytes() []byte { return b.buffer.Bytes() }

func (b *openCodeProbeOutput) Write(p []byte) (int, error) {
	remaining := 32*1024 - b.buffer.Len()
	if len(p) > remaining {
		n, _ := b.buffer.Write(p[:remaining])
		return n, fmt.Errorf("OpenCode inspection output exceeds 32 KiB")
	}
	return b.buffer.Write(p)
}

// OpenCodeOutput runs a bounded, noninteractive CLI inspection. Use the
// profile's child environment and Windows wrapper without changing the
// server environment or starting OpenCode's background service.
func OpenCodeOutput(ctx context.Context, c Coder, args ...string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	probe := c
	probe.Args = args
	probe.ResumeArgs = nil
	plan, err := ResolveLaunch(probe, SpawnRequest{}, LaunchOptions{})
	if err != nil {
		return nil, err
	}
	cmd := exec.CommandContext(ctx, plan.Command, plan.Args...)
	cmd.Env = os.Environ()
	for key, value := range plan.Env {
		cmd.Env = append(cmd.Env, key+"="+value)
	}
	cmd.WaitDelay = time.Second
	var output openCodeProbeOutput
	cmd.Stdout = &output
	err = cmd.Run()
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}
	return output.Bytes(), err
}

// VerifyOpenCode rejects the wrong installed generation instead of silently
// launching a v1 mini experiment or the v2 full-screen TUI in legacy mode.
func VerifyOpenCode(ctx context.Context, c Coder) error {
	if c.ID != "opencode" || (c.OpenCodeMode != "mini" && c.OpenCodeMode != "tui" && c.OpenCodeMode != "legacy") {
		return nil
	}
	out, err := OpenCodeOutput(ctx, c, "--version")
	version := strings.TrimSpace(string(out))
	version = strings.TrimPrefix(version, "opencode ")
	version = strings.TrimPrefix(version, "v")
	prefix := "2."
	if c.OpenCodeMode == "legacy" {
		prefix = "1."
	}
	if err == nil && strings.HasPrefix(version, prefix) && openCodeVersionPattern.MatchString(version) {
		return nil
	}
	if ctx.Err() != nil {
		return ctx.Err()
	}
	if c.OpenCodeMode == "legacy" {
		return fmt.Errorf("legacy OpenCode requires a v1 binary; set opencode_legacy_command to its executable path and restart Phi")
	}
	return fmt.Errorf("OpenCode 2 requires a v2 binary; install OpenCode 2 (https://opencode.ai/v2/docs/migrate-v1/) or set opencode_legacy=true and restart Phi")
}
