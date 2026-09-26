package coders

import (
	"sort"
	"sync"
)

// Preset is one button rendered in the presets row under a terminal tab.
// Value is sent verbatim to the PTY, so control bytes (\r, \x1b, \x03...)
// are intentionally allowed.
type Preset struct {
	Name  string `json:"name"`
	Value string `json:"value"`
}

// Capabilities describes what session-history and UI actions a backend
// supports. Set explicitly by the resolver — never inferred from
// SessionSource string comparisons (R5).
type Capabilities struct {
	List       bool `json:"list"`
	Transcript bool `json:"transcript"`
	Rename     bool `json:"rename"`
	PiRpc      bool `json:"pi_rpc"`
}

// ClaudeSidecar holds typed options for the claude_files adapter.
// Kept as a typed field (not a generic map) so per-profile storage
// roots never bleed into the global process environment (R5).
type ClaudeSidecar struct {
	ConfigDir string `json:"config_dir,omitempty"`
}

// Coder is the fully resolved server definition. It is created once at
// startup by NewManager and consumed (read-only) by the launch resolver,
// the session adapter factories, and the descriptor serializer. Mutating
// a Coder after construction is undefined behaviour; consumers must
// always receive a deep copy from Manager.Snapshot.
//
// Three representations per R2:
//
//	CoderPatch   — sparse input (omitempty, *bool); see coder_patch.go.
//	Coder        — this struct, fully resolved with defaults materialized.
//	CoderDescriptor — allowlisted browser DTO; see coder_descriptor.go.
type Coder struct {
	ID                    string            `json:"id"`
	Name                  string            `json:"name"`
	ShortLabel            string            `json:"short_label"`
	Command               string            `json:"command"`
	Args                  []string          `json:"args"`
	ResumeArgs            []string          `json:"resume_args,omitempty"`
	Env                   map[string]string `json:"env,omitempty"`
	DefaultCwd            string            `json:"default_cwd,omitempty"`
	SessionSource         string            `json:"session_source,omitempty"`
	SidecarClaude         *ClaudeSidecar    `json:"claude,omitempty"`
	Presets               []Preset          `json:"presets,omitempty"`
	Logo                  string            `json:"logo,omitempty"`
	SidebarVisible        bool              `json:"sidebar_visible"`
	IsShell               bool              `json:"is_shell"`
	WindowsPowerShellWrap *bool             `json:"windows_powershell_wrap,omitempty"`
	InputMode             string            `json:"input_mode"` // "staged" | "direct"
	ModelSwitchDisabled   bool              `json:"model_switch_disabled"`
	Capabilities          Capabilities      `json:"capabilities"`
}

// Reserved IDs cannot appear in custom backend files. They name
// pseudo-coders (UI-only tabs) or alternate execution paths that
// are not user-launchable PTY profiles (R1).
var ReservedIDs = map[string]bool{
	"review": true,
	"kanban": true,
	"pi-rpc": true,
}

// DefaultRegistry returns the built-in coder definitions. Frozen at
// package init time — callers must not mutate the returned value.
// NewManager deep-copies this on construction.
func DefaultRegistry() map[string]Coder {
	opencodeWrap := true
	claudeWrap := true
	agyWrap := true
	bashWrap := false
	pwshWrap := false

	return map[string]Coder{
		"opencode": {
			ID:             "opencode",
			Name:           "OpenCode",
			ShortLabel:     "OpenCode",
			Command:        "opencode",
			Args:           []string{},
			ResumeArgs:     []string{"--session", "{session_id}"},
			SessionSource:  "opencode_sqlite",
			SidebarVisible: true,
			IsShell:        false,
			WindowsPowerShellWrap: &opencodeWrap,
			InputMode:      "staged",
			Logo:           "vendor/logos/opencode.png",
			Capabilities:   Capabilities{List: true, Transcript: true},
			Presets: []Preset{
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
			},
		},
		"claude": {
			ID:             "claude",
			Name:           "Claude Code",
			ShortLabel:     "Claude",
			Command:        "claude",
			Args:           []string{},
			ResumeArgs:     []string{"--resume", "{session_id}"},
			SessionSource:  "claude_files",
			SidebarVisible: true,
			IsShell:        false,
			WindowsPowerShellWrap: &claudeWrap,
			InputMode:      "staged",
			Logo:           "vendor/logos/claude.png",
			Capabilities:   Capabilities{List: true, Rename: true},
			Presets: []Preset{
				{Name: "/exit", Value: "/exit\r"},
				{Name: "/model", Value: "/model\r"},
				{Name: "/compact", Value: "/compact\r"},
				{Name: "/undo", Value: "/undo\r"},
				{Name: "/copy", Value: "/copy\r"},
				{Name: "/help", Value: "/help\r"},
				{Name: "ctrl+c", Value: "\x03"},
				{Name: "ctrl+o", Value: "\x0f"},
				{Name: "y↵", Value: "y\r"},
				{Name: "esc", Value: "\x1b"},
				{Name: "/clear", Value: "/clear\r"},
			},
		},
		"agy": {
			ID:             "agy",
			Name:           "Antigravity",
			ShortLabel:     "Agy",
			Command:        "agy",
			Args:           []string{},
			ResumeArgs:     []string{"--conversation", "{session_id}"},
			SessionSource:  "agy_files",
			SidebarVisible: true,
			IsShell:        false,
			WindowsPowerShellWrap: &agyWrap,
			InputMode:      "staged",
			Logo:           "vendor/logos/agy.png",
			Capabilities:   Capabilities{List: true, Rename: true},
			// Models dropup is hidden for agy today (R10): it has a
			// configured model preset list, but live model switching
			// is not exposed in the UI.
			ModelSwitchDisabled: true,
			Presets: []Preset{
				{Name: "/resume", Value: "/resume\r"},
				{Name: "/model", Value: "/model\r"},
				{Name: "/rewind", Value: "/rewind\r"},
				{Name: "/clear", Value: "/clear\r"},
				{Name: "/diff", Value: "/diff\r"},
				{Name: "/config", Value: "/config\r"},
				{Name: "/fork", Value: "/fork\r"},
				{Name: "/exit", Value: "/exit\r"},
				{Name: "/help", Value: "/help\r"},
				{Name: "ctrl+c", Value: "\x03"},
				{Name: "y↵", Value: "y\r"},
			},
		},
		"pi": {
			ID:             "pi",
			Name:           "Pi Coder",
			ShortLabel:     "Pi",
			Command:        "pi",
			Args:           []string{},
			ResumeArgs:     []string{"--session", "{session_id}"},
			SessionSource:  "pi_files",
			SidebarVisible: true,
			IsShell:        false,
			InputMode:      "staged",
			Logo:           "vendor/logos/pi.png",
			// Pi has both: the legacy transcript endpoint AND the
			// modern Pi RPC chat. Frontend prefers PiRpc when both
			// are advertised; the transcript remains available for
			// clients that haven't migrated to the chat surface.
			Capabilities:   Capabilities{List: true, Transcript: true, PiRpc: true},
			Presets: []Preset{
				{Name: "/quit", Value: "/quit\r"},
				{Name: "/resume", Value: "/resume\r"},
				{Name: "/model", Value: "/model\r"},
				{Name: "/compact", Value: "/compact\r"},
				{Name: "/copy", Value: "/copy\r"},
				{Name: "ctrl+c", Value: "\x03"},
				{Name: "ctrl+o", Value: "\x0f"},
				{Name: "y↵", Value: "y\r"},
				{Name: "esc", Value: "\x1b"},
				{Name: "/clear", Value: "/clear\r"},
			},
		},
		"bash": {
			ID:             "bash",
			Name:           "Shell",
			ShortLabel:     "Shell",
			Command:        "bash",
			Args:           []string{"-l"},
			SessionSource:  "none",
			SidebarVisible: true,
			IsShell:        true,
			WindowsPowerShellWrap: &bashWrap,
			InputMode:      "direct",
			Logo:           "vendor/logos/bash.jpg",
			Presets: []Preset{
				{Name: "ctrl+c", Value: "\x03"},
				{Name: "ctrl+d", Value: "\x04"},
				{Name: "clear", Value: "clear\r"},
				{Name: "exit", Value: "exit\r"},
			},
		},
		"pwsh": {
			ID:             "pwsh",
			Name:           "PowerShell",
			ShortLabel:     "PowerShell",
			Command:        "pwsh",
			Args:           []string{"-NoLogo"},
			SessionSource:  "none",
			SidebarVisible: false, // matches the static UI which only shows five tabs
			IsShell:        true,
			WindowsPowerShellWrap: &pwshWrap,
			InputMode:      "direct",
			Logo:           "vendor/logos/bash.jpg",
			Presets: []Preset{
				{Name: "ctrl+c", Value: "\x03"},
				{Name: "ctrl+d", Value: "\x04"},
				{Name: "cls", Value: "cls\r"},
				{Name: "exit", Value: "exit\r"},
			},
		},
	}
}

// OrderedBuiltinIDs returns the built-in coders in their canonical
// sidebar order. Order is meaningful: the frontend renders tabs and
// quick-launch buttons in this order, and the default active coder
// is the first visible one. Keep this stable across releases.
func OrderedBuiltinIDs() []string {
	return []string{"opencode", "claude", "agy", "pi", "bash", "pwsh"}
}

// frozenCoder is a deep copy of a Coder, safe to hand to consumers
// without aliasing the Manager's internal state. All slices and maps
// are independent; pointer-typed fields are deep-copied where they
// could share memory (SidecarConfig).
func frozenCoder(in Coder) Coder {
	out := Coder{
		ID:                  in.ID,
		Name:                in.Name,
		ShortLabel:          in.ShortLabel,
		Command:             in.Command,
		DefaultCwd:          in.DefaultCwd,
		SessionSource:       in.SessionSource,
		Logo:                in.Logo,
		SidebarVisible:      in.SidebarVisible,
		IsShell:             in.IsShell,
		InputMode:           in.InputMode,
		ModelSwitchDisabled: in.ModelSwitchDisabled,
		Capabilities:        in.Capabilities,
	}
	if in.Args != nil {
		out.Args = append([]string(nil), in.Args...)
	}
	if in.ResumeArgs != nil {
		out.ResumeArgs = append([]string(nil), in.ResumeArgs...)
	}
	if in.Env != nil {
		out.Env = make(map[string]string, len(in.Env))
		for k, v := range in.Env {
			out.Env[k] = v
		}
	}
	if in.SidecarClaude != nil {
		sc := *in.SidecarClaude
		out.SidecarClaude = &sc
	}
	if in.Presets != nil {
		out.Presets = append([]Preset(nil), in.Presets...)
	}
	if in.WindowsPowerShellWrap != nil {
		b := *in.WindowsPowerShellWrap
		out.WindowsPowerShellWrap = &b
	}
	return out
}

// Manager holds the immutable server-side coder registry. The
// snapshot is built once at startup (NewManager + LoadFromDir) and
// served via Snapshot(). Consumers must treat the returned value as
// read-only; the deep copy in frozenCoder protects the snapshot's
// internals from accidental aliasing.
type Manager struct {
	mu   sync.RWMutex
	data map[string]Coder
	// order records the sidebar-visible coder IDs in insertion order.
	// Built-ins come first (OrderedBuiltinIDs), custom backends append.
	order []string
}

// NewManager constructs a Manager seeded with the built-in registry.
// It does NOT scan any filesystem; LoadFromDir is a separate step
// so the resolver never reads disk on the hot path.
func NewManager() *Manager {
	m := &Manager{}
	defaults := DefaultRegistry()
	m.data = make(map[string]Coder, len(defaults))
	for id, c := range defaults {
		m.data[id] = frozenCoder(c)
	}
	m.order = append([]string(nil), OrderedBuiltinIDs()...)
	return m
}

// Get returns a deep-copied Coder by ID. Missing IDs return
// (zero-value, false). The deep copy is per-call; the Manager's
// internal state is never aliased.
func (m *Manager) Get(id string) (Coder, bool) {
	m.mu.RLock()
	c, ok := m.data[id]
	m.mu.RUnlock()
	if !ok {
		return Coder{}, false
	}
	return frozenCoder(c), true
}

// MustGet returns the deep-copied Coder for id, or a zero-value if
// unknown. Convenient for handlers that have already validated id
// elsewhere; unknown IDs surface as a no-op launch attempt.
func (m *Manager) MustGet(id string) Coder {
	c, _ := m.Get(id)
	return c
}

// List returns every registered coder as deep-copied (id, Coder) pairs.
// The order is the registry's canonical order (built-ins first, then
// custom backends in load order).
func (m *Manager) List() []Coder {
	m.mu.RLock()
	out := make([]Coder, 0, len(m.order))
	for _, id := range m.order {
		if c, ok := m.data[id]; ok {
			out = append(out, frozenCoder(c))
		}
	}
	m.mu.RUnlock()
	return out
}

// IDs returns just the registered IDs in canonical order. Useful for
// callers that don't need full Coder copies.
func (m *Manager) IDs() []string {
	m.mu.RLock()
	out := append([]string(nil), m.order...)
	m.mu.RUnlock()
	return out
}

// Add inserts a Coder into the snapshot. Used by LoadFromDir after
// validation; reserved IDs are rejected silently (the caller logs).
// Returns true if accepted.
func (m *Manager) Add(c Coder) bool {
	if c.ID == "" || ReservedIDs[c.ID] {
		return false
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, exists := m.data[c.ID]; !exists {
		m.order = append(m.order, c.ID)
	}
	m.data[c.ID] = frozenCoder(c)
	return true
}

// AddMany inserts a slice of Coders in order. Per-coder rejection
// (reserved ID, empty ID) is logged and skipped; the rest are added.
// The whole batch is one critical section so concurrent readers
// never see a partial state.
func (m *Manager) AddMany(in []Coder) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, c := range in {
		if c.ID == "" || ReservedIDs[c.ID] {
			continue
		}
		if _, exists := m.data[c.ID]; !exists {
			m.order = append(m.order, c.ID)
		}
		m.data[c.ID] = frozenCoder(c)
	}
}

// Len reports the number of registered coders.
func (m *Manager) Len() int {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return len(m.data)
}

// ─────────────────────────────────────────────────────────────────────────
// Backwards-compatible shims
// ─────────────────────────────────────────────────────────────────────────

// Registry is a process-wide map mirror of the default built-in
// registry. It exists for legacy call sites that still index by ID;
// new code should prefer *Manager. The values are the deep copies
// Manager.NewManager uses — mutating them is a programming error
// (the resolver operates on its own Snapshot result, never on this).
//
// Deprecated: use Manager.Get / Manager.List instead.
var Registry = func() map[string]Coder {
	m := DefaultRegistry()
	out := make(map[string]Coder, len(m))
	for id, c := range m {
		out[id] = c
	}
	return out
}()

// knownSessionSources lists the registered session adapters. Custom
// backends may use any value here; unknown values are rejected by
// LoadCustomBackends. The empty string is treated as "none" for
// backward compatibility.
var knownSessionSources = map[string]bool{
	"":               true, // == none
	"none":           true,
	"opencode_sqlite": true,
	"claude_files":    true,
	"pi_files":        true,
	"agy_files":       true,
}

// IsKnownSessionSource reports whether the named adapter is
// registered. Used by LoadCustomBackends validation.
func IsKnownSessionSource(src string) bool {
	return knownSessionSources[src]
}

// sortedIDs returns a deterministic, sorted copy of the input. Used
// by LoadFromDir to keep patch application order independent of
// os.ReadDir's filesystem-dependent ordering.
func sortedIDs(in []string) []string {
	out := append([]string(nil), in...)
	sort.Strings(out)
	return out
}
