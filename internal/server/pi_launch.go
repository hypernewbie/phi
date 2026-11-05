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

// Pi launch modes. "pi" is also the meaning of an empty stored default, so an
// existing config file keeps launching Pi.
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
	PsiCommand    string            `json:"psi_command"`
	PsiArgs       []string          `json:"psi_args"`
	PsiEnv        map[string]string `json:"psi_env"`
}

// PiLaunchFromConfig projects the stored launch fields. An empty default is
// reported as Pi so clients never have to guess what the server will do.
func PiLaunchFromConfig(cfg config.Config) PiLaunchState {
	mode := cfg.PiDefaultMode
	if mode == "" {
		mode = piModePi
	}
	args := cfg.PsiArgs
	if args == nil {
		args = []string{}
	}
	env := cfg.PsiEnv
	if env == nil {
		env = map[string]string{}
	}
	return PiLaunchState{
		Revision:      cfg.PiLaunchRevision,
		PiDefaultMode: mode,
		PsiCommand:    cfg.PsiCommand,
		PsiArgs:       args,
		PsiEnv:        env,
	}
}

// validPiMode reports whether mode names a supported agent.
func validPiMode(mode string) bool { return mode == piModePi || mode == piModePsi }

// effectivePiMode normalises a coder's stored mode to "pi" or "psi". Panes
// created before this feature carry an empty mode and are Pi.
func effectivePiMode(c coders.Coder) string {
	if c.PiMode == piModePsi {
		return piModePsi
	}
	return piModePi
}

// effectivePsiCommand is the executable a Psi launch would run. Empty means
// PATH lookup of "psi", matching coders.PiPsi.
func effectivePsiCommand(cmd string) string {
	if cmd == "" {
		return piModePsi
	}
	return cmd
}

// checkPsiExecutable reports whether the configured Psi command can be found
// on this server. It never runs the program, so a hostile or broken binary is
// not executed merely to validate settings.
func checkPsiExecutable(cmd string) error {
	target := effectivePsiCommand(cmd)
	if _, err := exec.LookPath(target); err != nil {
		return fmt.Errorf("psi executable %q is not available on the Phi server: %w", target, err)
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
			mode = cfg.PiDefaultMode
			if mode == "" {
				mode = piModePi
			}
		}
	}
	if !validPiMode(mode) {
		return coders.Coder{}, fmt.Errorf("unknown pi_mode %q", mode)
	}
	if mode == piModePi {
		// The registry never sets PiMode, so a Pi selection needs no transform.
		return c, nil
	}
	// Always take the current command, including an empty one: clearing the
	// setting must fall back to PATH lookup instead of the startup value.
	c.PsiCommand = cfg.PsiCommand
	c.Args = append(slices.Clone(c.Args), cfg.PsiArgs...)
	if len(cfg.PsiEnv) > 0 {
		c.Env = mergePsiEnv(c.Env, cfg.PsiEnv, piEnvCaseInsensitive)
	}
	psi, err := coders.PiPsi(c)
	if err != nil {
		return coders.Coder{}, err
	}
	return psi, nil
}

const piEnvCaseInsensitive = runtime.GOOS == "windows"

// mergePsiEnv applies overrides on top of a copy of base. It only sets or
// replaces values: an inherited variable never disappears.
//
// On a case-insensitive platform every base spelling of an overridden name is
// removed first, so "Foo" and "foo" cannot both survive next to "FOO".
func mergePsiEnv(base, overrides map[string]string, caseInsensitive bool) map[string]string {
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
	return effectiveDefaultMode(a.PiDefaultMode) == effectiveDefaultMode(b.PiDefaultMode) &&
		a.PsiCommand == b.PsiCommand &&
		slices.Equal(a.PsiArgs, b.PsiArgs) &&
		maps.Equal(a.PsiEnv, b.PsiEnv)
}
