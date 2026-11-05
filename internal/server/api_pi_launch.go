package server

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/hypernewbie/phi/internal/config"
)

// Revision outcomes the writer reports so the handler can map them to status
// codes. A conflict still returns the current state with 409.
var (
	errPiLaunchConflict  = errors.New("pi launch revision conflict")
	errPiLaunchInvalid   = errors.New("invalid stored pi launch revision")
	errPiLaunchExhausted = errors.New("pi launch revision exhausted")
)

// piLaunchBodyLimit bounds the patch body. The largest legitimate patch is a
// few hundred bytes; this leaves room without accepting bulk data.
const piLaunchBodyLimit = 64 << 10

// handlePiLaunch serves the revisioned Pi launch settings. It is the only
// writer for the launch fields, so concurrent editors compare revisions
// instead of overwriting each other.
func (app *Server) handlePiLaunch(w http.ResponseWriter, r *http.Request) {
	app.servePiLaunch(w, r, app.configStore().Update)
}

// servePiLaunch takes the update path as an argument so disk-failure tests do
// not need a global hook.
func (app *Server) servePiLaunch(w http.ResponseWriter, r *http.Request, update func(func(*config.Config) error) (config.Config, error)) {
	w.Header().Set("Cache-Control", "no-store")
	if r.Method == http.MethodGet {
		cfg, err := app.loadConfigWithError()
		state := PiLaunchFromConfig(cfg)
		if err != nil || state.Revision > MaxPiLaunchRevision {
			http.Error(w, "Failed to read config", http.StatusInternalServerError)
			return
		}
		writePiLaunchState(w, http.StatusOK, state)
		return
	}
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	mediaType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || mediaType != "application/json" {
		http.Error(w, "Expected application/json", http.StatusUnsupportedMediaType)
		return
	}
	revision, patch, status := decodePiLaunchPatch(w, r)
	if status != 0 {
		return
	}

	// Step 1: read, then reject a stale or unusable revision before any
	// filesystem lookup. A read failure is never a Pi default.
	base, err := app.loadConfigWithError()
	if err != nil {
		http.Error(w, "Failed to read config", http.StatusInternalServerError)
		return
	}
	if base.PiLaunchRevision > MaxPiLaunchRevision {
		http.Error(w, "Invalid stored pi launch revision", http.StatusInternalServerError)
		return
	}
	if base.PiLaunchRevision != revision {
		writePiLaunchState(w, http.StatusConflict, PiLaunchFromConfig(base))
		return
	}

	// Step 2: apply the patch to a candidate copy and validate it.
	candidate := base
	if patch.defaultMode != nil {
		candidate.PiDefaultMode = *patch.defaultMode
	}
	if patch.piCommand != nil {
		candidate.PiCommand = *patch.piCommand
	}
	if patch.piArgs != nil {
		candidate.PiArgs = *patch.piArgs
	}
	if patch.piEnv != nil {
		candidate.PiEnv = *patch.piEnv
	}
	if patch.psiCommand != nil {
		candidate.PsiCommand = *patch.psiCommand
	}
	if patch.psiArgs != nil {
		candidate.PsiArgs = *patch.psiArgs
	}
	if patch.psiEnv != nil {
		candidate.PsiEnv = *patch.psiEnv
	}
	// Strict command-form rules apply only to a command the user changed: an
	// existing relative command keeps working without a silent rewrite.
	for _, command := range []struct {
		name    string
		patched *string
		stored  string
	}{
		{"pi_command", patch.piCommand, base.PiCommand},
		{"psi_command", patch.psiCommand, base.PsiCommand},
	} {
		if command.patched == nil || *command.patched == command.stored {
			continue
		}
		if err := validateCommandForm(command.name, *command.patched); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
	}
	// A patch that selects one agent must never require the other one to be
	// installed, so switching the default always stays possible. A patch that
	// edits an agent's fields must leave a launchable command behind.
	// Selecting Pi needs no lookup: Pi is the built-in fallback, and an empty
	// Pi command means the registry default.
	changed := map[string]bool{
		piModePi:  patch.piCommand != nil || patch.piArgs != nil || patch.piEnv != nil,
		piModePsi: patch.psiCommand != nil || patch.psiArgs != nil || patch.psiEnv != nil,
	}
	needLookup := map[string]bool{
		piModePi: changed[piModePi],
		// Psi must be installed before it can become the default.
		piModePsi: changed[piModePsi] || (patch.defaultMode != nil && candidate.PiDefaultMode == piModePsi),
	}
	// Step 3: lookup outside the store lock. Only the touched agent is
	// checked: an uninstalled agent must not block the other one.
	for _, mode := range []string{piModePi, piModePsi} {
		if !needLookup[mode] {
			continue
		}
		settings := launchSettingsFor(candidate, mode)
		if err := validateLaunchFields(mode, settings); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		// An empty Pi command means the registry default, which needs no
		// lookup; clearing the field back to PATH still checks the name.
		if mode == piModePi && settings.Command == "" {
			continue
		}
		if err := checkExecutable(mode, settings.Command); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
	}

	// Steps 4 and 5: recheck the snapshot inside the lock, then apply only the
	// requested fields.
	cfg, err := update(func(cfg *config.Config) error {
		// Update reads the raw file; the base above has defaults applied.
		// Normalize the legacy empty default at this write boundary so the
		// drift check compares the same effective values.
		if cfg.PiDefaultMode == "" {
			cfg.PiDefaultMode = piModePi
		}
		if cfg.PiLaunchRevision > MaxPiLaunchRevision {
			return errPiLaunchInvalid
		}
		if cfg.PiLaunchRevision != revision {
			return errPiLaunchConflict
		}
		// A launch field edited behind the revision counter would make the
		// lookup above describe a different command than the one committed.
		if !sameLaunchFields(*cfg, base) {
			return errPiLaunchConflict
		}
		if cfg.PiLaunchRevision == MaxPiLaunchRevision {
			return errPiLaunchExhausted
		}
		if patch.defaultMode != nil {
			cfg.PiDefaultMode = *patch.defaultMode
		}
		if patch.piCommand != nil {
			cfg.PiCommand = *patch.piCommand
		}
		if patch.piArgs != nil {
			cfg.PiArgs = *patch.piArgs
		}
		if patch.piEnv != nil {
			cfg.PiEnv = *patch.piEnv
		}
		if patch.psiCommand != nil {
			cfg.PsiCommand = *patch.psiCommand
		}
		if patch.psiArgs != nil {
			cfg.PsiArgs = *patch.psiArgs
		}
		if patch.psiEnv != nil {
			cfg.PsiEnv = *patch.psiEnv
		}
		cfg.PiLaunchRevision++
		return nil
	})
	status = http.StatusOK
	switch {
	case errors.Is(err, errPiLaunchConflict):
		status, err = http.StatusConflict, nil
	case errors.Is(err, errPiLaunchInvalid), errors.Is(err, errPiLaunchExhausted):
		status = http.StatusInternalServerError
	}
	if err != nil {
		http.Error(w, "Failed to save config", http.StatusInternalServerError)
		return
	}
	writePiLaunchState(w, status, PiLaunchFromConfig(cfg))
}

// piLaunchPatch is the validated subset of a request body. Nil means the
// field was omitted, which keeps the stored value.
type piLaunchPatch struct {
	defaultMode *string
	piCommand   *string
	piArgs      *[]string
	piEnv       *map[string]string
	psiCommand  *string
	psiArgs     *[]string
	psiEnv      *map[string]string
}

// decodePiLaunchPatch validates the request shape. A non-zero status means the
// response is already written.
func decodePiLaunchPatch(w http.ResponseWriter, r *http.Request) (uint64, piLaunchPatch, int) {
	fail := func(msg string, status int) (uint64, piLaunchPatch, int) {
		http.Error(w, msg, status)
		return 0, piLaunchPatch{}, status
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, piLaunchBodyLimit))
	var body map[string]json.RawMessage
	decodeErr := decoder.Decode(&body)
	if decodeErr == nil {
		if err := decoder.Decode(new(any)); err != io.EOF {
			if err == nil {
				decodeErr = errors.New("trailing JSON")
			} else {
				decodeErr = err
			}
		}
	}
	if decodeErr != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(decodeErr, &tooLarge) {
			return fail("Body too large", http.StatusRequestEntityTooLarge)
		}
		return fail("Invalid JSON body", http.StatusBadRequest)
	}
	if body == nil || len(body) != 2 {
		return fail("Expected revision and fields", http.StatusBadRequest)
	}
	rawRevision, hasRevision := body["revision"]
	rawFields, hasFields := body["fields"]
	if !hasRevision || !hasFields {
		return fail("Expected revision and fields", http.StatusBadRequest)
	}
	var revision uint64
	if len(rawRevision) == 0 || string(rawRevision) == "null" || json.Unmarshal(rawRevision, &revision) != nil || revision > MaxPiLaunchRevision {
		return fail("Invalid revision", http.StatusBadRequest)
	}
	var fields map[string]json.RawMessage
	if json.Unmarshal(rawFields, &fields) != nil || len(fields) == 0 {
		return fail("Expected at least one field", http.StatusBadRequest)
	}
	var patch piLaunchPatch
	for key, raw := range fields {
		switch key {
		case "pi_default_mode":
			var mode *string
			if json.Unmarshal(raw, &mode) != nil || mode == nil {
				return fail("pi_default_mode must be a string", http.StatusBadRequest)
			}
			if !validPiMode(*mode) {
				return fail(`pi_default_mode must be "pi" or "psi"`, http.StatusBadRequest)
			}
			patch.defaultMode = mode
		case "pi_command", "psi_command":
			command, err := decodeCommand(key, raw)
			if err != nil {
				return fail(err.Error(), http.StatusBadRequest)
			}
			if key == "pi_command" {
				patch.piCommand = command
			} else {
				patch.psiCommand = command
			}
		case "pi_args", "psi_args":
			args, err := decodeArgs(key, raw)
			if err != nil {
				return fail(err.Error(), http.StatusBadRequest)
			}
			if key == "pi_args" {
				patch.piArgs = args
			} else {
				patch.psiArgs = args
			}
		case "pi_env", "psi_env":
			env, err := parseLaunchEnv(key, raw)
			if err != nil {
				return fail(err.Error(), http.StatusBadRequest)
			}
			if key == "pi_env" {
				patch.piEnv = &env
			} else {
				patch.psiEnv = &env
			}
		default:
			return fail("Unknown field: "+key, http.StatusBadRequest)
		}
	}
	return revision, patch, 0
}

// decodeCommand accepts one executable setting. Both agents use the same rules.
func decodeCommand(field string, raw json.RawMessage) (*string, error) {
	var command *string
	if json.Unmarshal(raw, &command) != nil || command == nil {
		return nil, fmt.Errorf("%s must be a string", field)
	}
	if err := validateCommandText(field, *command); err != nil {
		return nil, err
	}
	return command, nil
}

// decodeArgs accepts an argument list, rejecting null entries.
func decodeArgs(field string, raw json.RawMessage) (*[]string, error) {
	var rawArgs []*string
	if json.Unmarshal(raw, &rawArgs) != nil || rawArgs == nil {
		return nil, fmt.Errorf("%s must be an array of strings", field)
	}
	args := make([]string, 0, len(rawArgs))
	for i, arg := range rawArgs {
		if arg == nil {
			return nil, fmt.Errorf("%s[%d] must be a string", field, i)
		}
		args = append(args, *arg)
	}
	if err := validateLaunchArgs(field, args); err != nil {
		return nil, err
	}
	return &args, nil
}

// validateCommandText rejects characters that cannot survive the trip to a
// process argument list.
func validateCommandText(field, command string) error {
	if strings.ContainsAny(command, "\x00\r\n") {
		return fmt.Errorf("%s must not contain NUL or line breaks", field)
	}
	return nil
}

// validateCommandForm enforces the stricter form for a changed command. A
// bare name is looked up on PATH; anything with a separator must be absolute,
// because a relative path would resolve against whatever directory a launch
// happens to use. Existing relative commands are not validated here so they
// keep working unchanged.
func validateCommandForm(field, command string) error {
	if command == "" || filepath.IsAbs(command) {
		return nil
	}
	if strings.ContainsAny(command, `/\\`) {
		return fmt.Errorf("%s %q must be an absolute path or a command name without a directory", field, command)
	}
	if strings.HasPrefix(command, "~") {
		return fmt.Errorf("%s %q must not start with ~; use an absolute path", field, command)
	}
	return nil
}

// validateLaunchArgs checks entries that arrive already split by the client.
func validateLaunchArgs(field string, args []string) error {
	for i, arg := range args {
		if arg == "" {
			return fmt.Errorf("%s[%d] is empty", field, i)
		}
		if strings.ContainsAny(arg, "\x00\r\n") {
			return fmt.Errorf("%s[%d] must not contain NUL or line breaks", field, i)
		}
	}
	return nil
}

// launchEnvKeyPattern matches portable environment names.
var launchEnvKeyPattern = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)

// reservedLaunchEnvPrefixes are matched case-insensitively: the PTY layer owns
// these values, so an override would either be overwritten or break the pane.
var reservedLaunchEnvPrefixes = []string{"phi_pi_bridge_"}

var reservedLaunchEnvKeys = map[string]struct{}{
	"path":                   {},
	"phi_clipboard_file":     {},
	"colorterm":              {},
	"phi_pi_attachment_root": {},
}

// parseLaunchEnv decodes an env map member by member so duplicate names are
// caught rather than silently collapsed, which a plain map decode would do.
func parseLaunchEnv(field string, raw json.RawMessage) (map[string]string, error) {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	token, err := decoder.Token()
	if err != nil {
		return nil, fmt.Errorf("%s must be an object of strings", field)
	}
	if delim, ok := token.(json.Delim); !ok || delim != '{' {
		return nil, fmt.Errorf("%s must be an object of strings", field)
	}
	env := map[string]string{}
	seen := map[string]string{}
	for decoder.More() {
		keyToken, err := decoder.Token()
		if err != nil {
			return nil, fmt.Errorf("%s must be an object of strings", field)
		}
		key, ok := keyToken.(string)
		if !ok {
			return nil, fmt.Errorf("%s must be an object of strings", field)
		}
		var value *string
		if err := decoder.Decode(&value); err != nil || value == nil {
			return nil, fmt.Errorf("%s[%q] must be a string", field, key)
		}
		lower := strings.ToLower(key)
		if previous, duplicate := seen[lower]; duplicate {
			return nil, fmt.Errorf("%s declares %q and %q; environment names are case-insensitive", field, previous, key)
		}
		seen[lower] = key
		if err := validateLaunchEnvKey(field, key); err != nil {
			return nil, err
		}
		if strings.ContainsAny(*value, "\x00\r\n") {
			return nil, fmt.Errorf("%s[%q] must not contain NUL or line breaks", field, key)
		}
		env[key] = *value
	}
	if _, err := decoder.Token(); err != nil {
		return nil, fmt.Errorf("%s must be an object of strings", field)
	}
	return env, nil
}

// validateLaunchFields also guards hand-edited config before saving a default
// or creating a process. Errors name fields, never environment values, and a
// field's own name is derived from the agent so both agents report usefully.
func validateLaunchFields(mode string, settings launchSettings) error {
	if err := validateCommandText(mode+"_command", settings.Command); err != nil {
		return err
	}
	if err := validateLaunchArgs(mode+"_args", settings.Args); err != nil {
		return err
	}
	seen := map[string]bool{}
	for key, value := range settings.Env {
		if err := validateLaunchEnvKey(mode+"_env", key); err != nil {
			return err
		}
		lower := strings.ToLower(key)
		if seen[lower] {
			return fmt.Errorf("%s_env contains duplicate case-insensitive names", mode)
		}
		seen[lower] = true
		if strings.ContainsAny(value, "\x00\r\n") {
			return fmt.Errorf("%s_env[%q] must not contain NUL or line breaks", mode, key)
		}
	}
	return nil
}

// validateLaunchEnvKey rejects names the PTY layer owns and names a POSIX
// shell could not receive.
func validateLaunchEnvKey(field, key string) error {
	if !launchEnvKeyPattern.MatchString(key) {
		return fmt.Errorf("%s key %q must match [A-Za-z_][A-Za-z0-9_]*", field, key)
	}
	lower := strings.ToLower(key)
	if _, reserved := reservedLaunchEnvKeys[lower]; reserved {
		return fmt.Errorf("%s key %q is set by Phi and cannot be overridden", field, key)
	}
	for _, prefix := range reservedLaunchEnvPrefixes {
		if strings.HasPrefix(lower, prefix) {
			return fmt.Errorf("%s key %q is set by Phi and cannot be overridden", field, key)
		}
	}
	return nil
}

// writePiLaunchState writes one JSON state document with an explicit status.
func writePiLaunchState(w http.ResponseWriter, status int, state PiLaunchState) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(state)
}
