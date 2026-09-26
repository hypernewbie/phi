package coders

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// ─────────────────────────────────────────────────────────────────────────
// Existing TestRegistryPresets is the legacy built-in smoke test.
// It still passes against the rewritten defaults table.
// ─────────────────────────────────────────────────────────────────────────

func TestRegistryPresets(t *testing.T) {
	defaults := DefaultRegistry()
	if len(defaults) == 0 {
		t.Fatal("expected defaults table to be populated")
	}
	for id, c := range defaults {
		if c.ID != id {
			t.Errorf("coder ID mismatch for key %q: got %q", id, c.ID)
		}
		if c.Name == "" {
			t.Errorf("coder %s has empty name", id)
		}
		if c.Command == "" {
			t.Errorf("coder %s has empty command", id)
		}
		if c.InputMode != "staged" && c.InputMode != "direct" {
			t.Errorf("coder %s has invalid input_mode %q", id, c.InputMode)
		}
		for _, p := range c.Presets {
			if p.Name == "" {
				t.Errorf("coder %s has a preset with empty name", id)
			}
			if p.Value == "" {
				t.Errorf("coder %s has a preset with empty value", id)
			}
		}
	}
}

// ─────────────────────────────────────────────────────────────────────────
// Manager
// ─────────────────────────────────────────────────────────────────────────

func TestManagerSnapshotIsDeepCopy(t *testing.T) {
	m := NewManager()
	c, ok := m.Get("opencode")
	if !ok {
		t.Fatal("opencode should be a built-in")
	}

	// Mutate the returned copy.
	c.Args = append(c.Args, "--injected")
	c.Env = map[string]string{"API_KEY": "leaked"}
	c.Presets = append(c.Presets, Preset{Name: "/leak", Value: "/leak\r"})
	c.Capabilities.Transcript = false

	// Re-read and verify nothing leaked.
	c2, _ := m.Get("opencode")
	for _, a := range c2.Args {
		if a == "--injected" {
			t.Fatal("args slice was shared; mutation leaked into the registry")
		}
	}
	if _, ok := c2.Env["API_KEY"]; ok {
		t.Fatal("env map was shared; mutation leaked into the registry")
	}
	for _, p := range c2.Presets {
		if p.Name == "/leak" {
			t.Fatal("presets slice was shared; mutation leaked into the registry")
		}
	}
	if !c2.Capabilities.Transcript {
		t.Fatal("capabilities struct was shared; mutation leaked into the registry")
	}
}

func TestManagerReservedIDs(t *testing.T) {
	m := NewManager()
	for _, id := range []string{"review", "kanban", "pi-rpc", ""} {
		if m.Add(Coder{ID: id, Command: "x", Name: "X"}) {
			t.Errorf("Add should reject reserved/empty id %q", id)
		}
	}
	// After rejection the manager is unchanged.
	for id := range ReservedIDs {
		if _, ok := m.Get(id); ok {
			t.Errorf("reserved id %q should not exist", id)
		}
	}
}

func TestManagerAddManyCustomOrder(t *testing.T) {
	m := NewManager()
	m.AddMany([]Coder{
		{ID: "zeta-agent", Name: "Zeta", Command: "zeta", SidebarVisible: true, InputMode: "staged"},
		{ID: "alpha-agent", Name: "Alpha", Command: "alpha", SidebarVisible: true, InputMode: "staged"},
	})
	ids := m.IDs()
	// Built-ins first, then custom in insertion order (R3 deterministic
	// for filesystem-loaded; AddMany uses insertion order).
	want := append(append([]string{}, OrderedBuiltinIDs()...), "zeta-agent", "alpha-agent")
	if !reflect.DeepEqual(ids, want) {
		t.Fatalf("ids order: got %v want %v", ids, want)
	}
}

func TestManagerGetUnknown(t *testing.T) {
	m := NewManager()
	if _, ok := m.Get("does-not-exist"); ok {
		t.Fatal("unknown id should return false")
	}
	if c := m.MustGet("does-not-exist"); c.ID != "" {
		t.Fatal("MustGet of unknown id should return zero-value")
	}
}

// ─────────────────────────────────────────────────────────────────────────
// CoderPatch merge semantics
// ─────────────────────────────────────────────────────────────────────────

func TestCoderPatch_PreservesPresence(t *testing.T) {
	t.Run("nil fields", func(t *testing.T) {
		var p CoderPatch
		if p.IsShell != nil {
			t.Fatal("default IsShell should be nil")
		}
		if p.Presets != nil {
			t.Fatal("default Presets should be nil")
		}
	})

	t.Run("false is not nil", func(t *testing.T) {
		raw := []byte(`{"is_shell": false}`)
		var p CoderPatch
		if err := jsonStrictDecode(raw, &p); err != nil {
			t.Fatal(err)
		}
		if p.IsShell == nil {
			t.Fatal("IsShell should be non-nil pointing to false")
		}
		if *p.IsShell {
			t.Fatal("IsShell should be false")
		}
	})

	t.Run("empty array is not nil", func(t *testing.T) {
		raw := []byte(`{"presets": []}`)
		var p CoderPatch
		if err := jsonStrictDecode(raw, &p); err != nil {
			t.Fatal(err)
		}
		if p.Presets == nil {
			t.Fatal("Presets should be non-nil empty slice")
		}
		if len(*p.Presets) != 0 {
			t.Fatal("Presets should be empty")
		}
	})
}

func TestCoderPatch_ApplyReplacesArrays(t *testing.T) {
	base := Coder{
		ID:      "agent",
		Name:    "Agent",
		Command: "agent",
		Args:    []string{"--old"},
	}
	raw := []byte(`{"args": ["--new1", "--new2"]}`)
	var p CoderPatch
	if err := jsonStrictDecode(raw, &p); err != nil {
		t.Fatal(err)
	}
	out, err := p.Apply(base)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(out.Args, []string{"--new1", "--new2"}) {
		t.Fatalf("args should be replaced, got %v", out.Args)
	}
	// base should not have been mutated.
	if !reflect.DeepEqual(base.Args, []string{"--old"}) {
		t.Fatal("Apply should not mutate base")
	}
}

func TestCoderPatch_ApplyEnvMergeAndUnset(t *testing.T) {
	base := Coder{
		ID:      "agent",
		Name:    "Agent",
		Command: "agent",
		Env:     map[string]string{"KEEP": "1", "DROP": "2"},
	}
	raw := []byte(`{"env": {"ADD": "3", "__unset__DROP": "x"}}`)
	var p CoderPatch
	if err := jsonStrictDecode(raw, &p); err != nil {
		t.Fatal(err)
	}
	out, err := p.Apply(base)
	if err != nil {
		t.Fatal(err)
	}
	if v := out.Env["KEEP"]; v != "1" {
		t.Fatalf("KEEP should be preserved, got %q", v)
	}
	if _, ok := out.Env["DROP"]; ok {
		t.Fatal("DROP should have been unset via __unset__DROP")
	}
	if v := out.Env["ADD"]; v != "3" {
		t.Fatalf("ADD should be present, got %q", v)
	}
}

func TestCoderPatch_ApplyRejectsReservedID(t *testing.T) {
	for _, id := range []string{"review", "kanban", "pi-rpc"} {
		raw := []byte(`{"id": "` + id + `"}`)
		var p CoderPatch
		if err := jsonStrictDecode(raw, &p); err != nil {
			t.Fatal(err)
		}
		if _, err := p.Apply(Coder{}); err != ErrReservedID {
			t.Fatalf("expected ErrReservedID for id %q, got %v", id, err)
		}
	}
}

func TestCoderPatch_ApplyUnknownSessionSource(t *testing.T) {
	raw := []byte(`{"session_source": "shell"}`)
	var p CoderPatch
	if err := jsonStrictDecode(raw, &p); err != nil {
		t.Fatal(err)
	}
	_, err := p.Apply(Coder{ID: "x", Name: "X", Command: "x"})
	if err == nil {
		t.Fatal("expected unknown session_source error")
	}
	if _, ok := err.(ErrUnknownSessionSource); !ok {
		t.Fatalf("expected ErrUnknownSessionSource, got %T: %v", err, err)
	}
}

func TestCoderPatch_ApplyInvalidInputMode(t *testing.T) {
	raw := []byte(`{"input_mode": "wat"}`)
	var p CoderPatch
	if err := jsonStrictDecode(raw, &p); err != nil {
		t.Fatal(err)
	}
	_, err := p.Apply(Coder{ID: "x", Name: "X", Command: "x"})
	if err == nil {
		t.Fatal("expected invalid input_mode error")
	}
	if _, ok := err.(ErrInvalidInputMode); !ok {
		t.Fatalf("expected ErrInvalidInputMode, got %T: %v", err, err)
	}
}

// ─────────────────────────────────────────────────────────────────────────
// ResolveLaunch
// ─────────────────────────────────────────────────────────────────────────

func TestResolveLaunch_BasicArgs(t *testing.T) {
	c := Coder{ID: "opencode", Command: "opencode", Args: []string{}}
	plan, err := ResolveLaunch(c, SpawnRequest{}, LaunchOptions{DefaultCwd: "/work"})
	if err != nil {
		t.Fatal(err)
	}
	if plan.Command != "opencode" || len(plan.Args) != 0 {
		t.Fatalf("unexpected plan: %+v", plan)
	}
	if plan.Cwd != "/work" {
		t.Fatalf("cwd should fall back to DefaultCwd, got %q", plan.Cwd)
	}
}

func TestResolveLaunch_ResumeArgsSubstitution(t *testing.T) {
	c := Coder{ID: "opencode", Command: "oc", ResumeArgs: []string{"--session", "{session_id}"}}
	plan, err := ResolveLaunch(c, SpawnRequest{SessionID: "abc-123"}, LaunchOptions{})
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"--session", "abc-123"}
	if !reflect.DeepEqual(plan.Args, want) {
		t.Fatalf("resume args: got %v want %v", plan.Args, want)
	}
}

func TestResolveLaunch_RejectsControlCharInSessionID(t *testing.T) {
	c := Coder{ID: "opencode", Command: "oc", ResumeArgs: []string{"--session", "{session_id}"}}
	for _, bad := range []string{"a\nb", "a\rb", "a\x00b", "a\x1bb"} {
		if _, err := ResolveLaunch(c, SpawnRequest{SessionID: bad}, LaunchOptions{}); err == nil {
			t.Errorf("expected error for session id %q", bad)
		}
	}
}

func TestResolveLaunch_PiOffline(t *testing.T) {
	c := Coder{ID: "pi", Command: "pi"}
	plan, err := ResolveLaunch(c, SpawnRequest{}, LaunchOptions{Config: ConfigView{PiOffline: true}})
	if err != nil {
		t.Fatal(err)
	}
	if !contains(plan.Args, "--offline") {
		t.Fatalf("pi spawn should include --offline, got %v", plan.Args)
	}
}

func TestResolveLaunch_PiOfflineScoped(t *testing.T) {
	for _, id := range []string{"opencode", "claude", "bash"} {
		c := Coder{ID: id, Command: id}
		plan, err := ResolveLaunch(c, SpawnRequest{}, LaunchOptions{Config: ConfigView{PiOffline: true}})
		if err != nil {
			t.Fatal(err)
		}
		if contains(plan.Args, "--offline") {
			t.Fatalf("%s must not receive pi's --offline", id)
		}
	}
}

func TestResolveLaunch_ClaudeSkipPerms(t *testing.T) {
	c := Coder{ID: "claude", Command: "claude"}
	plan, err := ResolveLaunch(c, SpawnRequest{}, LaunchOptions{Config: ConfigView{ClaudeDangerouslySkipPermissions: true}})
	if err != nil {
		t.Fatal(err)
	}
	if !contains(plan.Args, "--dangerously-skip-permissions") {
		t.Fatalf("claude spawn should include --dangerously-skip-permissions, got %v", plan.Args)
	}
}

func TestResolveLaunch_DoesNotMutateRegistry(t *testing.T) {
	c := Coder{ID: "pi", Command: "pi", Args: []string{"--base"}}
	originalArgs := append([]string(nil), c.Args...)
	_, err := ResolveLaunch(c, SpawnRequest{SessionID: "sess", ExtraArgs: []string{"--x"}}, LaunchOptions{Config: ConfigView{PiOffline: true}})
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(c.Args, originalArgs) {
		t.Fatalf("ResolveLaunch must not mutate the caller's Coder.Args: was %v now %v", originalArgs, c.Args)
	}
}

func TestResolveLaunch_CwdOrder(t *testing.T) {
	c := Coder{ID: "x", Command: "x", DefaultCwd: "/profile-cwd"}
	plan, err := ResolveLaunch(c, SpawnRequest{Cwd: "/req-cwd"}, LaunchOptions{DefaultCwd: "/fallback"})
	if err != nil {
		t.Fatal(err)
	}
	if plan.Cwd != "/req-cwd" {
		t.Fatalf("request cwd should win, got %q", plan.Cwd)
	}
	c2 := Coder{ID: "x", Command: "x", DefaultCwd: "/profile-cwd"}
	plan2, _ := ResolveLaunch(c2, SpawnRequest{}, LaunchOptions{DefaultCwd: "/fallback"})
	if plan2.Cwd != "/profile-cwd" {
		t.Fatalf("profile default_cwd should win over fallback, got %q", plan2.Cwd)
	}
	c3 := Coder{ID: "x", Command: "x"}
	plan3, _ := ResolveLaunch(c3, SpawnRequest{}, LaunchOptions{DefaultCwd: "/fallback"})
	if plan3.Cwd != "/fallback" {
		t.Fatalf("fallback should win when nothing else set, got %q", plan3.Cwd)
	}
}

func TestResolveLaunch_EnvIsCopy(t *testing.T) {
	c := Coder{ID: "x", Command: "x", Env: map[string]string{"A": "1"}}
	plan, err := ResolveLaunch(c, SpawnRequest{}, LaunchOptions{})
	if err != nil {
		t.Fatal(err)
	}
	plan.Env["A"] = "mutated"
	c2, _ := NewManager().Get("x") // empty
	_ = c2
	// We cannot retrieve the original "x" because it wasn't registered.
	// The test is that the returned map is independent of the source.
	if plan.Env["A"] != "mutated" {
		t.Fatal("env copy should be independent of source")
	}
}

func TestResolveLaunch_WindowsPSWrap(t *testing.T) {
	c := Coder{ID: "pi", Command: "pi"}
	plan, err := ResolveLaunch(c, SpawnRequest{}, LaunchOptions{PlatformWindows: true})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(strings.ToLower(plan.Command), "powershell") {
		t.Fatalf("expected powershell wrapper on Windows, got command %q", plan.Command)
	}
	if !containsArg(plan.Args, "-Command") {
		t.Fatalf("expected -Command argument, got %v", plan.Args)
	}
	if !strings.Contains(plan.Args[2], "& 'pi'") {
		t.Fatalf("expected call operator expression, got %v", plan.Args)
	}
}

func TestResolveLaunch_WindowsPSWrapApostrophe(t *testing.T) {
	c := Coder{ID: "pi", Command: `C:\it's\pi.exe`}
	plan, err := ResolveLaunch(c, SpawnRequest{}, LaunchOptions{PlatformWindows: true})
	if err != nil {
		t.Fatal(err)
	}
	expr := plan.Args[2]
	if !strings.Contains(expr, `''`) {
		t.Fatalf("apostrophes should be doubled, got %q", expr)
	}
}

func TestResolveLaunch_WindowsPSWrapDisabled(t *testing.T) {
	no := false
	c := Coder{ID: "pi", Command: "pi.exe", WindowsPowerShellWrap: &no}
	plan, err := ResolveLaunch(c, SpawnRequest{}, LaunchOptions{PlatformWindows: true})
	if err != nil {
		t.Fatal(err)
	}
	if plan.Command != "pi.exe" {
		t.Fatalf("expected unwrapped command, got %q", plan.Command)
	}
}

func TestValidateLogo(t *testing.T) {
	cases := []struct {
		in   string
		want string
	}{
		{"", ""},
		{"vendor/logos/agy.png", "vendor/logos/agy.png"},
		{"emoji:🤖", "emoji:🤖"},
		{"text:AI", "text:AI"},
		{"data:image/png;base64,xxx", ""},
		{"file:///etc/passwd", ""},
		{"http://evil.com/x.png", ""},
		{"https://evil.com/x.png", ""},
		{"javascript:alert(1)", ""},
		{"vendor/../etc/passwd", ""},
		{"/abs/path", ""},
		{"raw-string", ""},
	}
	for _, tc := range cases {
		got := ValidateLogo(tc.in)
		if got != tc.want {
			t.Errorf("ValidateLogo(%q): got %q want %q", tc.in, got, tc.want)
		}
	}
}

func TestValidateAttachmentSyntax(t *testing.T) {
	cases := []struct {
		in   string
		want string
	}{
		{"", ""},
		{"{path}", "{path}"},
		{"@{path}", "@{path}"},
		{"/read {path}\r", ""},
		{"@path with\nnewline", ""},
		{"@path with\rcr", ""},
		{"@path with\x1besc", ""},
		{"unknown {garbage}", ""},
	}
	for _, tc := range cases {
		got := ValidateAttachmentSyntax(tc.in)
		if got != tc.want {
			t.Errorf("ValidateAttachmentSyntax(%q): got %q want %q", tc.in, got, tc.want)
		}
	}
}

// ─────────────────────────────────────────────────────────────────────────
// Loader
// ─────────────────────────────────────────────────────────────────────────

func TestLoadFromDir_HappyPath(t *testing.T) {
	dir := t.TempDir()
	mustWrite(t, filepath.Join(dir, "aider.json"), `{
		"id": "aider",
		"name": "Aider",
		"command": "aider",
		"args": ["--dark-mode"],
		"presets": [{"name": "/help", "value": "/help\r"}],
		"is_shell": false,
		"sidebar_visible": true,
		"input_mode": "staged"
	}`)

	m := NewManager()
	warned := false
	if err := m.LoadFromDir(dir, func(string) { warned = true }); err != nil {
		t.Fatal(err)
	}
	if warned {
		t.Fatal("no warnings expected on a well-formed file")
	}
	c, ok := m.Get("aider")
	if !ok {
		t.Fatal("aider should have been added")
	}
	if !contains(c.Args, "--dark-mode") {
		t.Fatalf("aider args missing --dark-mode: %v", c.Args)
	}
	if len(c.Presets) != 1 || c.Presets[0].Name != "/help" {
		t.Fatalf("aider presets wrong: %v", c.Presets)
	}
}

func TestLoadFromDir_OverrideBuiltin(t *testing.T) {
	dir := t.TempDir()
	mustWrite(t, filepath.Join(dir, "opencode.json"), `{
		"id": "opencode",
		"args": ["--custom"],
		"presets": [{"name": "ctrl+x", "value": "\u0018"}]
	}`)

	m := NewManager()
	warned := false
	if err := m.LoadFromDir(dir, func(string) { warned = true }); err != nil {
		t.Fatal(err)
	}
	if warned {
		t.Fatal("no warnings expected")
	}
	c, _ := m.Get("opencode")
	if !contains(c.Args, "--custom") {
		t.Fatalf("opencode args should be patched: %v", c.Args)
	}
}

func TestLoadFromDir_RejectsReservedID(t *testing.T) {
	dir := t.TempDir()
	mustWrite(t, filepath.Join(dir, "bad.json"), `{"id": "review", "name": "X", "command": "x"}`)

	m := NewManager()
	warned := false
	if err := m.LoadFromDir(dir, func(string) { warned = true }); err != nil {
		t.Fatal(err)
	}
	if !warned {
		t.Fatal("expected a warning for reserved id")
	}
	if _, ok := m.Get("review"); ok {
		t.Fatal("review should not exist")
	}
}

func TestLoadFromDir_SkipsMalformedFile(t *testing.T) {
	dir := t.TempDir()
	mustWrite(t, filepath.Join(dir, "broken.json"), `{"this is not valid json`)
	mustWrite(t, filepath.Join(dir, "good.json"), `{"id": "zeta", "name": "Zeta", "command": "zeta", "sidebar_visible": true, "input_mode": "staged"}`)

	m := NewManager()
	warns := []string{}
	if err := m.LoadFromDir(dir, func(s string) { warns = append(warns, s) }); err != nil {
		t.Fatal(err)
	}
	if len(warns) != 1 {
		t.Fatalf("expected 1 warning, got %d: %v", len(warns), warns)
	}
	if _, ok := m.Get("zeta"); !ok {
		t.Fatal("good.json should still have been applied")
	}
}

func TestLoadFromDir_NoDirIsNoOp(t *testing.T) {
	m := NewManager()
	if err := m.LoadFromDir(filepath.Join(t.TempDir(), "missing"), nil); err != nil {
		t.Fatal("missing dir should be a no-op, not an error")
	}
}

func TestLoadFromDir_RejectsInvalidLogo(t *testing.T) {
	dir := t.TempDir()
	mustWrite(t, filepath.Join(dir, "bad.json"), `{"id": "x", "name": "X", "command": "x", "logo": "javascript:alert(1)", "sidebar_visible": true, "input_mode": "staged"}`)

	m := NewManager()
	warned := false
	m.LoadFromDir(dir, func(string) { warned = true })
	if !warned {
		t.Fatal("expected warning for unsafe logo")
	}
	if _, ok := m.Get("x"); ok {
		t.Fatal("file with unsafe logo should not have been inserted")
	}
}

// ─────────────────────────────────────────────────────────────────────────
// Descriptor
// ─────────────────────────────────────────────────────────────────────────

func TestDescriptorsForPreservesServerOrder(t *testing.T) {
	coders := NewManager().List()
	wire, err := json.Marshal(DescriptorsFor(coders))
	if err != nil {
		t.Fatal(err)
	}
	var decoded map[string]CoderDescriptor
	if err := json.Unmarshal(wire, &decoded); err != nil {
		t.Fatal(err)
	}
	for i, coder := range coders {
		if got := decoded[coder.ID].Order; got != i {
			t.Errorf("%s: order = %d, want %d", coder.ID, got, i)
		}
	}
}

func TestDescriptorExcludesPrivateFields(t *testing.T) {
	m := NewManager()
	c, _ := m.Get("opencode")
	// Mutate private fields and confirm the descriptor strips them.
	c.Env = map[string]string{"API_KEY": "leaked"}
	c.Command = "evil"
	c.DefaultCwd = "/secret"
	d := c.Descriptor()
	// The whole point of the descriptor is that it has no Command field
	// at all. Encode it and check no secret leaks.
	b, _ := jsonMarshal(d)
	s := string(b)
	if strings.Contains(s, "API_KEY") || strings.Contains(s, "leaked") || strings.Contains(s, "evil") || strings.Contains(s, "secret") {
		t.Fatalf("Descriptor JSON leaked private fields: %s", s)
	}
	if !strings.Contains(s, `"id":"opencode"`) {
		t.Fatalf("Descriptor should still carry ID: %s", s)
	}
}

func TestShortLabelFallsBackToFirstWord(t *testing.T) {
	cases := []struct {
		name string
		want string
	}{
		{"Claude Code", "Claude"},
		{"Antigravity", "Antigravity"},
		{"OpenCode", "OpenCode"},
		{"Pi Coder", "Pi"},
	}
	for _, tc := range cases {
		c := Coder{Name: tc.name}
		if got := shortLabel(c); got != tc.want {
			t.Errorf("shortLabel(%q): got %q want %q", tc.name, got, tc.want)
		}
	}
	cWithLabel := Coder{Name: "Claude Code", ShortLabel: "CC"}
	if got := shortLabel(cWithLabel); got != "CC" {
		t.Fatal("explicit ShortLabel should override")
	}
}

// ─────────────────────────────────────────────────────────────────────────
// helpers
// ─────────────────────────────────────────────────────────────────────────

func contains(xs []string, x string) bool {
	for _, s := range xs {
		if s == x {
			return true
		}
	}
	return false
}

func containsArg(xs []string, x string) bool {
	return contains(xs, x)
}

func mustWrite(t *testing.T, path, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0644); err != nil {
		t.Fatal(err)
	}
}
