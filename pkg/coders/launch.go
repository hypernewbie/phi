package coders

import (
	"fmt"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"unicode"
)

// LaunchPlan is the result of ResolveLaunch: the resolved command,
// argv, working directory, and per-child env overrides. Every field
// is independently consumable; the caller picks which to honour.
//
// Env semantics (R4):
//
//   - The map is *overrides*, not a full environment. The PTY layer
//     merges it into its existing os.Environ-derived construction;
//     keys the resolver did not set are untouched.
//
//   - On Windows the merge is case-insensitive (Windows env vars
//     are case-insensitive in practice, even if the runtime keeps
//     the original case).
//
//   - The SHELL-on-Windows strip in pkg/pty stays in place unless
//     the override map explicitly carries a "SHELL" key — a custom
//     profile that wants SHELL set must say so.
type LaunchPlan struct {
	Command string
	Args    []string
	Cwd     string
	Env     map[string]string
}

// ResumeIDPlaceholder is the only token allowed inside ResumeArgs.
// Substituted with the literal session ID at launch time; the
// substituted value is rejected if it contains control bytes
// (newlines, NULs, escape sequences) — those would break argv
// parsing for every supported shell.
const ResumeIDPlaceholder = "{session_id}"

// SpawnRequest is the subset of api_handlers.SpawnRequest that the
// resolver consumes. Defined here so pkg/coders doesn't depend on
// the root package.
type SpawnRequest struct {
	Coder     string
	Cwd       string
	SessionID string
	ExtraArgs []string
}

// LaunchOptions carries the cross-cutting inputs the resolver needs:
// the active config (for PiOffline / ClaudeSkipPerms flags) and the
// fallback CWD for new sessions when neither request nor profile
// specifies one.
type LaunchOptions struct {
	Config          ConfigView
	DefaultCwd      string
	PlatformWindows bool // override for tests; defaults to runtime.GOOS=="windows"
}

// ConfigView is the read-only slice of *main.Config the resolver
// needs. Decoupling the type keeps pkg/coders import-free of the
// root package.
type ConfigView struct {
	PiOffline                        bool
	ClaudeDangerouslySkipPermissions bool
}

// ResolveLaunch computes the LaunchPlan for a single spawn. All
// platform-specific wrapping and flag-injection rules live here;
// callers pass the resolved plan to pty.Spawn verbatim.
//
// Behaviour preserved from the previous buildCoderArgs +
// handleSpawnTerminal hardcoded branches (R4):
//
//   - Args is copied (so the registry's slice is never mutated).
//   - ResumeArgs is appended as a single argv group with the
//     session ID substituted into {session_id} placeholders.
//   - PiOffline appends --offline to a pi spawn.
//   - ClaudeDangerouslySkipPermissions appends --dangerously-skip-permissions
//     to a claude spawn.
//   - ExtraArgs is appended last.
//   - On Unix, when the resolved profile is a shell with command
//     "bash" and $SHELL is set + on PATH, $SHELL is used so PATH and
//     aliases from the user's shell config apply.
//   - On Windows, when the resolved profile is a shell with command
//     "bash", the launch avoids System32\bash.exe (the WSL launcher)
//     and falls back to PowerShell if no safe bash is found.
//   - On Windows, non-shell profiles are wrapped in PowerShell's
//     call operator (& 'cmd' 'arg' 'arg'...) so npm script wrappers
//     resolve cleanly.
//   - CWD: req.Cwd → c.DefaultCwd → opts.DefaultCwd. Empty stays
//     empty (PTY inherits server cwd).
func ResolveLaunch(c Coder, req SpawnRequest, opts LaunchOptions) (LaunchPlan, error) {
	platformWindows := opts.PlatformWindows
	if !platformWindows && runtime.GOOS == "windows" {
		platformWindows = true
	}

	// 1. Copy base args (never mutate the registry's slice).
	args := append([]string(nil), c.Args...)

	// 2. Resume args: substitute {session_id} if both the profile
	//    and the request carry a session ID.
	if req.SessionID != "" && len(c.ResumeArgs) > 0 {
		if err := validateSessionID(req.SessionID); err != nil {
			return LaunchPlan{}, err
		}
		for _, ra := range c.ResumeArgs {
			args = append(args, strings.ReplaceAll(ra, ResumeIDPlaceholder, req.SessionID))
		}
	}

	// 3. Legacy opt-in flags. Scoped to the matching ID: pi and
	//    claude would otherwise reject unknown flags, and other
	//    coders would reject these specific flags. The IDs are
	//    the built-in ones; custom profiles cannot opt into these
	//    toggles because they're root-config-only by design.
	switch c.ID {
	case "pi":
		if opts.Config.PiOffline {
			args = append(args, "--offline")
		}
	case "claude":
		if opts.Config.ClaudeDangerouslySkipPermissions {
			args = append(args, "--dangerously-skip-permissions")
		}
	}

	// 4. Caller-supplied extras last.
	if len(req.ExtraArgs) > 0 {
		args = append(args, req.ExtraArgs...)
	}

	// 5. Command resolution.
	command := c.Command

	// 5a. Unix: prefer $SHELL for bash shells.
	if !platformWindows && c.IsShell && c.Command == "bash" {
		if shell := os.Getenv("SHELL"); shell != "" {
			if _, err := exec.LookPath(shell); err == nil {
				command = shell
			}
		}
	}

	// 5b. Windows: bash → resolve bash.exe carefully.
	command, args = resolveWindowsCommand(command, args, c, platformWindows)

	// 6. CWD resolution.
	cwd := req.Cwd
	if cwd == "" {
		cwd = c.DefaultCwd
	}
	if cwd == "" {
		cwd = opts.DefaultCwd
	}

	// 7. Env overrides: a deep copy so callers can keep mutating
	//    their source.
	env := make(map[string]string, len(c.Env))
	for k, v := range c.Env {
		env[k] = v
	}

	return LaunchPlan{
		Command: command,
		Args:    args,
		Cwd:     cwd,
		Env:     env,
	}, nil
}

// resolveWindowsCommand applies the platform-specific wrapping. On
// non-Windows it returns the inputs unchanged. The wrapping logic
// is split out so ResolveLaunch reads as a linear sequence of steps
// and so the test can exercise the helper directly.
func resolveWindowsCommand(command string, args []string, c Coder, windows bool) (string, []string) {
	if !windows {
		return command, args
	}

	// 5b. Shell-on-Windows: bash profile resolves bash.exe with
	// WSL avoidance, falling back to PowerShell if no safe binary.
	if c.IsShell && c.Command == "bash" {
		usePowerShell := true
		if lp, err := exec.LookPath("bash"); err == nil {
			if !strings.Contains(strings.ToLower(lp), "system32") {
				usePowerShell = false
				command = lp
			}
		}
		if usePowerShell {
			command = getPreferredPowerShell()
			args = []string{"-NoLogo"}
		}
		return command, args
	}

	// 5c. Non-shell on Windows: wrap in PowerShell call operator
	// unless the profile has explicitly opted out.
	if c.IsShell {
		return command, args
	}
	if c.WindowsPowerShellWrap != nil && !*c.WindowsPowerShellWrap {
		return command, args
	}
	shellCmd := getPreferredPowerShell()
	parts := make([]string, 0, len(args)+1)
	parts = append(parts, fmt.Sprintf("& '%s'", strings.ReplaceAll(command, "'", "''")))
	for _, a := range args {
		parts = append(parts, fmt.Sprintf("'%s'", strings.ReplaceAll(a, "'", "''")))
	}
	command = shellCmd
	args = []string{"-NoLogo", "-Command", strings.Join(parts, " ")}
	return command, args
}

// getPreferredPowerShell mirrors the helper in api_handlers.go. Kept
// here so the launch resolver is self-contained and testable.
func getPreferredPowerShell() string {
	if _, err := exec.LookPath("pwsh"); err == nil {
		return "pwsh.exe"
	}
	return "powershell.exe"
}

// validateSessionID rejects control bytes that would break argv
// parsing. The resolver substitutes this value into ResumeArgs
// argv entries, so anything that breaks the shell's quoting rules
// must be rejected at the boundary.
func validateSessionID(id string) error {
	for _, r := range id {
		if r == 0 || r == '\n' || r == '\r' || unicode.IsControl(r) {
			return fmt.Errorf("session id contains control character: %q", r)
		}
	}
	return nil
}

// ValidateLogo checks a logo string against the v1 prefix policy
// (R9). vendor/, emoji:, text: are accepted; everything else
// (data:, file:, http://, https://, javascript:, path traversal,
// absolute paths) falls back to the caller. Returns the logo string
// when valid, "" when not. Logo scheme enforcement lives here so the
// frontend and backend agree on what is renderable.
//
// Empty string is accepted (means "use the fallback glyph").
func ValidateLogo(s string) string {
	if s == "" {
		return ""
	}
	if strings.HasPrefix(s, "vendor/") {
		if strings.Contains(s, "..") {
			return ""
		}
		return s
	}
	if strings.HasPrefix(s, "emoji:") {
		return s
	}
	if strings.HasPrefix(s, "text:") {
		return s
	}
	return ""
}

// ValidateAttachmentSyntax accepts only literal templates safe to
// substitute into the staged-input payload. {path} is the only
// supported placeholder; CR/LF/Esc are rejected (R8).
//
// Allowed forms:
//
//	""           → identity (raw path)
//	"{path}"     → raw path
//	"@{path}"    → "@" + raw path
//
// Anything else (commands, prompt text, multi-line scripts) is
// rejected — those would require the separate "command submit"
// pipeline explicitly called out in R8.
func ValidateAttachmentSyntax(s string) string {
	if s == "" {
		return ""
	}
	for _, r := range s {
		if r == '\r' || r == '\n' || r == 0x1b || (r < 0x20 && r != '\t') {
			return ""
		}
	}
	// Whitelist the only two supported literal templates. Anything
	// else falls back to the raw-path default.
	if s == "{path}" || s == "@{path}" {
		return s
	}
	return ""
}
