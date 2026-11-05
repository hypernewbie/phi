package server

import (
	"fmt"
	"maps"
	"os/exec"
	"runtime"
	"slices"
	"strings"

	"github.com/hypernewbie/phi/internal/config"
	"github.com/hypernewbie/phi/pkg/coders"
)

// MaxPiLaunchRevision caps the stored revision at the JS safe integer so a
// browser can round-trip it without losing precision.
const MaxPiLaunchRevision uint64 = 9007199254740991

// Pi launch modes. Each agent has its own executable, argument, and
// environment settings; the default only selects which agent a new tab runs.
const (
	piModePi  = "pi"
	piModePsi = "psi"
)

// PiLaunchState is both the feature endpoint's response and the projection of
// the stored launch fields. Args and env are always present, never null, so a
// client can render them without null checks.
type PiLaunchState struct {
	Revision      uint64            `json:"revision"`
	PiDefaultMode string            `json:"pi_default_mode"`
	PiCommand     string            `json:"pi_command"`
	PiArgs        []string          `json:"pi_args"`
	PiEnv         map[string]string `json:"pi_env"`
	PsiCommand    string            `json:"psi_command"`
	PsiArgs       []string          `json:"psi_args"`
	PsiEnv        map[string]string `json:"psi_env"`
}

// PiLaunchFromConfig projects the stored launch fields. The store migrates
// an empty default to an explicit "pi" on load, so this is a direct copy.
func PiLaunchFromConfig(cfg config.Config) PiLaunchState {
	return PiLaunchState{
		Revision:      cfg.PiLaunchRevision,
		PiDefaultMode: cfg.PiDefaultMode,
		PiCommand:     cfg.PiCommand,
		PiArgs:        nonNilArgs(cfg.PiArgs),
		PiEnv:         nonNilEnv(cfg.PiEnv),
		PsiCommand:    cfg.PsiCommand,
		PsiArgs:       nonNilArgs(cfg.PsiArgs),
		PsiEnv:        nonNilEnv(cfg.PsiEnv),
	}
}

func nonNilArgs(args []string) []string {
	if args == nil {
		return []string{}
	}
	return args
}

func nonNilEnv(env map[string]string) map[string]string {
	if env == nil {
		return map[string]string{}
	}
	return env
}

// validPiMode reports whether mode names a supported agent.
func validPiMode(mode string) bool { return mode == piModePi || mode == piModePsi }

// effectivePanePiMode normalises a pane's stored agent for reattach: panes
// saved before this feature carry an empty mode and are Pi. This is pane
// metadata, not the config default, so no migration applies.
func effectivePanePiMode(mode string) string {
	if mode == "" {
		return piModePi
	}
	return mode
}

// effectivePiMode normalises a coder's stored mode to "pi" or "psi". Panes
// created before this feature carry an empty mode and are Pi.
func effectivePiMode(c coders.Coder) string {
	if c.PiMode == piModePsi {
		return piModePsi
	}
	return piModePi
}

// launchSettings are the stored per-agent settings for one executable.
type launchSettings struct {
	Command string
	Args    []string
	Env     map[string]string
}

// launchSettingsFor returns the stored settings for one agent.
func launchSettingsFor(cfg config.Config, mode string) launchSettings {
	if mode == piModePsi {
		return launchSettings{Command: cfg.PsiCommand, Args: cfg.PsiArgs, Env: cfg.PsiEnv}
	}
	return launchSettings{Command: cfg.PiCommand, Args: cfg.PiArgs, Env: cfg.PiEnv}
}

// effectiveCommand is the executable a launch of this agent would run. Empty
// means PATH lookup of the agent name.
func effectiveCommand(mode, cmd string) string {
	if cmd == "" {
		return mode
	}
	return cmd
}

// checkExecutable reports whether the configured command for one agent can be
// found on this server. It never runs the program, so a hostile or broken
// binary is not executed merely to validate settings.
func checkExecutable(mode, cmd string) error {
	target := effectiveCommand(mode, cmd)
	if _, err := exec.LookPath(target); err != nil {
		return fmt.Errorf("%s executable %q is not available on the Phi server: %w", mode, target, err)
	}
	return nil
}

// selectPiLaunch applies one launch's mode to the Pi profile and returns the
// coder to spawn. The caller must pass a Pi coder.
//
// Resolution order: explicit pi_mode, then the legacy pi_psi flag, then the
// saved default. An empty explicit mode means "no override", never "Pi".
func selectPiLaunch(c coders.Coder, explicitMode string, legacyPsi bool, cfg config.Config) (coders.Coder, error) {
	if c.ID != "pi" {
		return c, nil
	}
	mode := explicitMode
	if mode == "" {
		if legacyPsi {
			mode = piModePsi
		} else {
			// The store migrates an empty default on load; anything still
			// empty or invalid here is rejected, never silently Pi.
			mode = cfg.PiDefaultMode
		}
	}
	if !validPiMode(mode) {
		return coders.Coder{}, fmt.Errorf("unknown pi_mode %q", mode)
	}
	// Each agent keeps its own executable, arguments, and environment.
	settings := launchSettingsFor(cfg, mode)
	c.Args = append(slices.Clone(c.Args), settings.Args...)
	if len(settings.Env) > 0 {
		c.Env = mergeLaunchEnv(c.Env, settings.Env, piEnvCaseInsensitive)
	}
	if mode == piModePi {
		// An empty setting keeps the registry command (and any test or host
		// override of it); a configured one replaces it.
		if settings.Command != "" {
			c.Command = settings.Command
		}
		c.PiMode = piModePi
		return c, nil
	}
	// Always take the current Psi command, including an empty one: clearing
	// the setting must fall back to PATH lookup instead of the startup value.
	c.PsiCommand = settings.Command
	psi, err := coders.PiPsi(c)
	if err != nil {
		return coders.Coder{}, err
	}
	return psi, nil
}

const piEnvCaseInsensitive = runtime.GOOS == "windows"

// mergeLaunchEnv applies overrides on top of a copy of base. It only sets or
// replaces values: an inherited variable never disappears.
//
// On a case-insensitive platform every base spelling of an overridden name is
// removed first, so "Foo" and "foo" cannot both survive next to "FOO".
func mergeLaunchEnv(base, overrides map[string]string, caseInsensitive bool) map[string]string {
	out := make(map[string]string, len(base)+len(overrides))
	for key, value := range base {
		out[key] = value
	}
	for key, value := range overrides {
		if caseInsensitive {
			for existing := range out {
				if strings.EqualFold(existing, key) {
					delete(out, existing)
				}
			}
		}
		out[key] = value
	}
	return out
}

// sameLaunchFields reports whether two configs carry the same launch settings.
// The revision counter is excluded so a concurrent unrelated launch save is
// distinguishable from a hand edit of the fields themselves.
func sameLaunchFields(a, b config.Config) bool {
	return a.PiDefaultMode == b.PiDefaultMode &&
		a.PiCommand == b.PiCommand &&
		slices.Equal(a.PiArgs, b.PiArgs) &&
		maps.Equal(a.PiEnv, b.PiEnv) &&
		a.PsiCommand == b.PsiCommand &&
		slices.Equal(a.PsiArgs, b.PsiArgs) &&
		maps.Equal(a.PsiEnv, b.PsiEnv)
}
