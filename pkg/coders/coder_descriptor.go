package coders

// CoderDescriptor is the allowlisted browser DTO served by /api/coders.
// It contains ONLY the fields the UI needs to render a tab, name it,
// decide whether to show transcript/review/rename/model buttons, and
// format attachments — never the private execution data:
//
//   - command / args / resume_args     (process invocation)
//   - env                              (per-child env overrides; secrets)
//   - default_cwd                      (workspace structure)
//   - session_source                   (internal adapter routing key)
//
// See R2 / R5: env fields with API keys must never appear in any
// browser-visible response or log line.
type CoderDescriptor struct {
	ID string `json:"id"`
	// Order preserves Manager.List's order through the ID-keyed JSON object.
	Order               int          `json:"order"`
	Name                string       `json:"name"`
	ShortLabel          string       `json:"short_label"`
	Logo                string       `json:"logo,omitempty"`
	SidebarVisible      bool         `json:"sidebar_visible"`
	IsShell             bool         `json:"is_shell"`
	InputMode           string       `json:"input_mode"`
	Presets             []Preset     `json:"presets,omitempty"`
	Capabilities        Capabilities `json:"capabilities"`
	ModelSwitchDisabled bool         `json:"model_switch_disabled"`
}

// Descriptor converts a resolved Coder into its public DTO. The
// returned value shares no memory with the source Coder (Presets is
// a fresh slice).
func (c Coder) Descriptor() CoderDescriptor {
	out := CoderDescriptor{
		ID:                  c.ID,
		Name:                c.Name,
		ShortLabel:          shortLabel(c),
		Logo:                c.Logo,
		SidebarVisible:      c.SidebarVisible,
		IsShell:             c.IsShell,
		InputMode:           c.InputMode,
		Capabilities:        c.Capabilities,
		ModelSwitchDisabled: c.ModelSwitchDisabled,
	}
	if c.Presets != nil {
		out.Presets = append([]Preset(nil), c.Presets...)
	}
	return out
}

// shortLabel returns the short label for the coder. Explicit
// ShortLabel wins; otherwise the first whitespace-delimited word of
// Name. The button shows the short label while the title attribute
// shows the full Name (R9).
func shortLabel(c Coder) string {
	if c.ShortLabel != "" {
		return c.ShortLabel
	}
	for i, r := range c.Name {
		if r == ' ' || r == '\t' {
			return c.Name[:i]
		}
	}
	return c.Name
}

// DescriptorsFor returns the public DTOs keyed by ID, with their input
// order encoded explicitly (JSON object keys are sorted by encoding/json).
func DescriptorsFor(cs []Coder) map[string]CoderDescriptor {
	out := make(map[string]CoderDescriptor, len(cs))
	for i, c := range cs {
		d := c.Descriptor()
		d.Order = i
		out[c.ID] = d
	}
	return out
}
