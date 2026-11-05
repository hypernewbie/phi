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
	if patch.psiCommand != nil && *patch.psiCommand != base.PsiCommand {
		if err := validatePsiCommandForm(*patch.psiCommand); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
	}
	// A patch that selects default Pi must not require a working Psi
	// installation, so recovery to Pi stays possible. A patch that edits any
	// Psi field must leave a launchable command behind.
	changedPsi := patch.psiCommand != nil || patch.psiArgs != nil || patch.psiEnv != nil
	needLookup := changedPsi || (patch.defaultMode != nil && candidate.PiDefaultMode == piModePsi)
	// Step 3: lookup outside the store lock.
	if needLookup {
		if err := validatePsiLaunch(candidate); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		if err := checkPsiExecutable(candidate.PsiCommand); err != nil {
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
		case "psi_command":
			var command *string
			if json.Unmarshal(raw, &command) != nil || command == nil {
				return fail("psi_command must be a string", http.StatusBadRequest)
			}
			if err := validatePsiCommandText(*command); err != nil {
				return fail(err.Error(), http.StatusBadRequest)
			}
			patch.psiCommand = command
		case "psi_args":
			var rawArgs []*string
			if json.Unmarshal(raw, &rawArgs) != nil || rawArgs == nil {
				return fail("psi_args must be an array of strings", http.StatusBadRequest)
			}
			args := make([]string, 0, len(rawArgs))
			for i, arg := range rawArgs {
				if arg == nil {
					return fail(fmt.Sprintf("psi_args[%d] must be a string", i), http.StatusBadRequest)
				}
				args = append(args, *arg)
			}
			if err := validatePsiArgs(args); err != nil {
				return fail(err.Error(), http.StatusBadRequest)
			}
			patch.psiArgs = &args
		case "psi_env":
			env, err := parsePsiEnv(raw)
			if err != nil {
				return fail(err.Error(), http.StatusBadRequest)
			}
			patch.psiEnv = &env
		default:
			return fail("Unknown field: "+key, http.StatusBadRequest)
		}
	}
	return revision, patch, 0
}

// validatePsiCommandText rejects characters that cannot survive the trip to a
// process argument list.
func validatePsiCommandText(command string) error {
	if strings.ContainsAny(command, "\x00\r\n") {
		return errors.New("psi_command must not contain NUL or line breaks")
	}
	return nil
}

// validatePsiCommandForm enforces the stricter form for a changed command. A
// bare name is looked up on PATH; anything with a separator must be absolute,
// because a relative path would resolve against whatever directory a launch
// happens to use. Existing relative commands are not validated here so they
// keep working unchanged.
func validatePsiCommandForm(command string) error {
	if command == "" || filepath.IsAbs(command) {
		return nil
	}
	if strings.ContainsAny(command, `/\\`) {
		return fmt.Errorf("psi_command %q must be an absolute path or a command name without a directory", command)
	}
	if strings.HasPrefix(command, "~") {
		return fmt.Errorf("psi_command %q must not start with ~; use an absolute path", command)
	}
	return nil
}

// validatePsiArgs checks entries that arrive already split by the client.
func validatePsiArgs(args []string) error {
	for i, arg := range args {
		if arg == "" {
			return fmt.Errorf("psi_args[%d] is empty", i)
		}
		if strings.ContainsAny(arg, "\x00\r\n") {
			return fmt.Errorf("psi_args[%d] must not contain NUL or line breaks", i)
		}
	}
	return nil
}

// psiEnvKeyPattern matches portable environment names.
var psiEnvKeyPattern = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)

// reservedPsiEnvPrefixes are matched case-insensitively: the PTY layer owns
// these values, so an override would either be overwritten or break the pane.
var reservedPsiEnvPrefixes = []string{"phi_pi_bridge_"}

var reservedPsiEnvKeys = map[string]struct{}{
	"path":                   {},
	"phi_clipboard_file":     {},
	"colorterm":              {},
	"phi_pi_attachment_root": {},
}

// parsePsiEnv decodes psi_env member by member so duplicate names are caught
// rather than silently collapsed, which a plain map decode would do.
func parsePsiEnv(raw json.RawMessage) (map[string]string, error) {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	token, err := decoder.Token()
	if err != nil {
		return nil, errors.New("psi_env must be an object of strings")
	}
	if delim, ok := token.(json.Delim); !ok || delim != '{' {
		return nil, errors.New("psi_env must be an object of strings")
	}
	env := map[string]string{}
	seen := map[string]string{}
	for decoder.More() {
		keyToken, err := decoder.Token()
		if err != nil {
			return nil, errors.New("psi_env must be an object of strings")
		}
		key, ok := keyToken.(string)
		if !ok {
			return nil, errors.New("psi_env must be an object of strings")
		}
		var value *string
		if err := decoder.Decode(&value); err != nil || value == nil {
			return nil, fmt.Errorf("psi_env[%q] must be a string", key)
		}
		lower := strings.ToLower(key)
		if previous, duplicate := seen[lower]; duplicate {
			return nil, fmt.Errorf("psi_env declares %q and %q; environment names are case-insensitive", previous, key)
		}
		seen[lower] = key
		if err := validatePsiEnvKey(key); err != nil {
			return nil, err
		}
		if strings.ContainsAny(*value, "\x00\r\n") {
			return nil, fmt.Errorf("psi_env[%q] must not contain NUL or line breaks", key)
		}
		env[key] = *value
	}
	if _, err := decoder.Token(); err != nil {
		return nil, errors.New("psi_env must be an object of strings")
	}
	return env, nil
}

// validatePsiLaunch also guards hand-edited config before saving a Psi default
// or creating a process. Errors name fields, never environment values.
func validatePsiLaunch(cfg config.Config) error {
	if err := validatePsiCommandText(cfg.PsiCommand); err != nil {
		return err
	}
	if err := validatePsiArgs(cfg.PsiArgs); err != nil {
		return err
	}
	seen := map[string]bool{}
	for key, value := range cfg.PsiEnv {
		if err := validatePsiEnvKey(key); err != nil {
			return err
		}
		lower := strings.ToLower(key)
		if seen[lower] {
			return errors.New("psi_env contains duplicate case-insensitive names")
		}
		seen[lower] = true
		if strings.ContainsAny(value, "\x00\r\n") {
			return fmt.Errorf("psi_env[%q] must not contain NUL or line breaks", key)
		}
	}
	return nil
}

// validatePsiEnvKey rejects names the PTY layer owns and names a POSIX shell
// could not receive.
func validatePsiEnvKey(key string) error {
	if !psiEnvKeyPattern.MatchString(key) {
		return fmt.Errorf("psi_env key %q must match [A-Za-z_][A-Za-z0-9_]*", key)
	}
	lower := strings.ToLower(key)
	if _, reserved := reservedPsiEnvKeys[lower]; reserved {
		return fmt.Errorf("psi_env key %q is set by Phi and cannot be overridden", key)
	}
	for _, prefix := range reservedPsiEnvPrefixes {
		if strings.HasPrefix(lower, prefix) {
			return fmt.Errorf("psi_env key %q is set by Phi and cannot be overridden", key)
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
