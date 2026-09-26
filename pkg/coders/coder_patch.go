package coders

// CoderPatch is the sparse input representation. Each field is a
// pointer (or a slice that distinguishes nil from empty) so a JSON
// patch can preserve "field absent" semantics across decode →
// merge → re-encode (R2):
//
//	{}                     → all fields nil / nil
//	{"is_shell": false}    → IsShell = *false  (explicit)
//	{"is_shell": true}     → IsShell = *true
//	{"presets": []}        → Presets = non-nil empty slice (clears)
//	{"presets": [...]}     → Presets = non-nil populated (replaces)
//
// Merge rules (see (*CoderPatch).Apply):
//
//	scalars     present replaces resolved default
//	slices      present replaces; nil keeps default; empty slice clears
//	pointer-bool nil keeps resolved; non-nil replaces
//	Env         merged by key (lowercased on Windows by the caller);
//	           env keys prefixed "__unset__" remove the resolved entry
//
// CoderPatch is intentionally not used at runtime. It is decoded
// from `~/.phi/backends/*.json` and merged once at startup; the
// resolved Coder is what the launch resolver and adapter factories
// see.
type CoderPatch struct {
	ID                    *string             `json:"id,omitempty"`
	Name                  *string             `json:"name,omitempty"`
	ShortLabel            *string             `json:"short_label,omitempty"`
	Command               *string             `json:"command,omitempty"`
	Args                  *[]string           `json:"args,omitempty"`
	ResumeArgs            *[]string           `json:"resume_args,omitempty"`
	Env                   *map[string]string  `json:"env,omitempty"`
	DefaultCwd            *string             `json:"default_cwd,omitempty"`
	SessionSource         *string             `json:"session_source,omitempty"`
	SidecarClaude         *ClaudeSidecar      `json:"claude,omitempty"`
	Presets               *[]Preset           `json:"presets,omitempty"`
	Logo                  *string             `json:"logo,omitempty"`
	SidebarVisible        *bool               `json:"sidebar_visible,omitempty"`
	IsShell               *bool               `json:"is_shell,omitempty"`
	WindowsPowerShellWrap *bool               `json:"windows_powershell_wrap,omitempty"`
	InputMode             *string             `json:"input_mode,omitempty"`
	ModelSwitchDisabled   *bool               `json:"model_switch_disabled,omitempty"`
	Capabilities          *Capabilities       `json:"capabilities,omitempty"`
}

// Apply merges p onto a copy of base and returns the result. The base
// is never mutated. Field semantics per the package doc above; see
// (*CoderPatch).Apply docs on Coder for the merge policy.
//
// Reserved IDs and empty IDs are rejected — the resolved Coder
// always has a non-empty, non-reserved ID.
func (p *CoderPatch) Apply(base Coder) (Coder, error) {
	out := base

	if p.ID != nil {
		id := *p.ID
		if id == "" || ReservedIDs[id] {
			return Coder{}, ErrReservedID
		}
		out.ID = id
	}
	if p.Name != nil {
		out.Name = *p.Name
	}
	if p.ShortLabel != nil {
		out.ShortLabel = *p.ShortLabel
	}
	if p.Command != nil {
		out.Command = *p.Command
	}
	if p.Args != nil {
		out.Args = append([]string(nil), *p.Args...)
	}
	if p.ResumeArgs != nil {
		out.ResumeArgs = append([]string(nil), *p.ResumeArgs...)
	}
	if p.Env != nil {
		merged := make(map[string]string, len(*p.Env))
		for k, v := range *p.Env {
			if len(k) > 9 && k[:9] == "__unset__" {
				delete(out.Env, k[9:])
				continue
			}
			merged[k] = v
		}
		// Preserve any pre-existing env entries not present in the
		// patch. The patch only *adds* keys; use __unset__ to drop.
		if out.Env == nil {
			out.Env = merged
		} else {
			for k, v := range merged {
				out.Env[k] = v
			}
		}
	}
	if p.DefaultCwd != nil {
		out.DefaultCwd = *p.DefaultCwd
	}
	if p.SessionSource != nil {
		src := *p.SessionSource
		if !IsKnownSessionSource(src) {
			return Coder{}, ErrUnknownSessionSource{src}
		}
		out.SessionSource = src
	}
	if p.SidecarClaude != nil {
		sc := *p.SidecarClaude
		out.SidecarClaude = &sc
	}
	if p.Presets != nil {
		out.Presets = append([]Preset(nil), *p.Presets...)
	}
	if p.Logo != nil {
		out.Logo = *p.Logo
	}
	if p.SidebarVisible != nil {
		out.SidebarVisible = *p.SidebarVisible
	}
	if p.IsShell != nil {
		out.IsShell = *p.IsShell
	}
	if p.WindowsPowerShellWrap != nil {
		b := *p.WindowsPowerShellWrap
		out.WindowsPowerShellWrap = &b
	}
	if p.InputMode != nil {
		out.InputMode = *p.InputMode
	}
	if p.ModelSwitchDisabled != nil {
		out.ModelSwitchDisabled = *p.ModelSwitchDisabled
	}
	if p.Capabilities != nil {
		out.Capabilities = *p.Capabilities
	}

	// Required-field validation on the final shape. A patch that
	// blanks a required field is a programmer error; reject early.
	if out.ID == "" {
		return Coder{}, ErrMissingField("id")
	}
	if out.Name == "" {
		return Coder{}, ErrMissingField("name")
	}
	if out.Command == "" {
		return Coder{}, ErrMissingField("command")
	}
	if out.InputMode != "" && out.InputMode != "staged" && out.InputMode != "direct" {
		return Coder{}, ErrInvalidInputMode{out.InputMode}
	}
	return out, nil
}

// PatchErrors are returned by Apply to signal validation failures.
// They are wrapped by LoadFromDir / LoadCustomBackends so callers see
// a single error per malformed file.
type PatchError struct {
	Field string
	Msg   string
}

func (e PatchError) Error() string {
	if e.Field == "" {
		return e.Msg
	}
	return e.Field + ": " + e.Msg
}

// ErrReservedID signals an attempt to define a custom backend with
// a reserved pseudo-coder ID (review, kanban, pi-rpc).
var ErrReservedID = PatchError{Field: "id", Msg: "reserved id"}

type ErrMissingField string

func (e ErrMissingField) Error() string { return "missing required field: " + string(e) }

type ErrInvalidInputMode struct{ Mode string }

func (e ErrInvalidInputMode) Error() string {
	return "input_mode: invalid value " + e.Mode + " (expected \"staged\" or \"direct\")"
}

type ErrUnknownSessionSource struct{ Source string }

func (e ErrUnknownSessionSource) Error() string {
	return "session_source: unknown adapter " + e.Source
}
