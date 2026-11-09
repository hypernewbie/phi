package agent

import (
	"errors"
	"fmt"
	"strings"
	"sync"
)

// ErrInvalidCommand indicates the input was not a valid /model command.
var ErrInvalidCommand = errors.New("invalid model command")

// BuildAgyArgs constructs or updates an argv list for agy by setting the --model flag.
// If --model already exists in baseArgs (as "--model", "<val>" or "--model=<val>"),
// it is replaced with the canonical slug. Otherwise, "--model", "<canonicalSlug>"
// is appended.
func BuildAgyArgs(baseArgs []string, modelSlug string) ([]string, error) {
	canonical, err := NormalizeSlug(modelSlug)
	if err != nil {
		return nil, err
	}

	result := make([]string, 0, len(baseArgs)+2)
	replaced := false

	for i := 0; i < len(baseArgs); i++ {
		arg := baseArgs[i]
		if arg == "--model" {
			result = append(result, "--model", canonical)
			replaced = true
			if i+1 < len(baseArgs) && !strings.HasPrefix(baseArgs[i+1], "-") {
				i++ // skip old model value
			}
		} else if strings.HasPrefix(arg, "--model=") {
			result = append(result, "--model="+canonical)
			replaced = true
		} else {
			result = append(result, arg)
		}
	}

	if !replaced {
		result = append(result, "--model", canonical)
	}

	return result, nil
}

// ExtractModel finds and returns the model slug from an argv list if --model is present.
func ExtractModel(args []string) (string, bool) {
	for i := 0; i < len(args); i++ {
		if args[i] == "--model" && i+1 < len(args) {
			return args[i+1], true
		}
		if strings.HasPrefix(args[i], "--model=") {
			return strings.TrimPrefix(args[i], "--model="), true
		}
	}
	return "", false
}

// FormatModelCommand formats a canonical /model slash command string without trailing delimiter.
// Example: "/model gemini-4-argon-high"
func FormatModelCommand(modelSlug string) (string, error) {
	canonical, err := NormalizeSlug(modelSlug)
	if err != nil {
		return "", err
	}
	return "/model " + canonical, nil
}

// FormatModelSlashInput formats a canonical /model slash command with a carriage return
// for terminal injection.
// Example: "/model gemini-4-argon-high\r"
func FormatModelSlashInput(modelSlug string) (string, error) {
	cmd, err := FormatModelCommand(modelSlug)
	if err != nil {
		return "", err
	}
	return cmd + "\r", nil
}

// ParseModelCommand parses a slash command string (e.g. "/model gemini-4-argon-high\r"),
// validates the model argument against the catalog, and returns the canonical model slug.
func ParseModelCommand(input string) (string, error) {
	trimmed := strings.TrimRight(input, "\r\n")
	trimmed = strings.TrimSpace(trimmed)

	if !strings.HasPrefix(trimmed, "/model") {
		return "", fmt.Errorf("%w: command must start with /model", ErrInvalidCommand)
	}

	remainder := strings.TrimSpace(strings.TrimPrefix(trimmed, "/model"))
	if remainder == "" {
		return "", fmt.Errorf("%w: missing model slug (usage: /model <slug>)", ErrInvalidCommand)
	}

	// Handle cases where multiple words or arguments are passed
	parts := strings.Fields(remainder)
	if len(parts) == 0 {
		return "", fmt.Errorf("%w: missing model slug", ErrInvalidCommand)
	}

	slug := parts[0]
	return NormalizeSlug(slug)
}

// SessionState tracks the model selection for an active Antigravity session.
type SessionState struct {
	mu          sync.RWMutex
	currentSlug string
}

// NewSessionState initializes session state with an optional initial model slug.
// If initialModel is non-empty, it is normalized and validated.
func NewSessionState(initialModel string) (*SessionState, error) {
	s := &SessionState{}
	if initialModel != "" {
		canonical, err := NormalizeSlug(initialModel)
		if err != nil {
			return nil, err
		}
		s.currentSlug = canonical
	}
	return s, nil
}

// SetModel updates the active model slug after validation.
func (s *SessionState) SetModel(modelSlug string) error {
	canonical, err := NormalizeSlug(modelSlug)
	if err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.currentSlug = canonical
	return nil
}

// Model returns the currently selected model slug (or empty string if unset).
func (s *SessionState) Model() string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.currentSlug
}

// ModelInfo returns the Model descriptor for the current model selection.
func (s *SessionState) ModelInfo() (Model, bool) {
	s.mu.RLock()
	slug := s.currentSlug
	s.mu.RUnlock()

	if slug == "" {
		return Model{}, false
	}
	return Lookup(slug)
}

// ApplyToArgs updates the given argv slice with the currently selected model.
// If no model is currently set, the original args are returned unmodified.
func (s *SessionState) ApplyToArgs(baseArgs []string) ([]string, error) {
	s.mu.RLock()
	slug := s.currentSlug
	s.mu.RUnlock()

	if slug == "" {
		return baseArgs, nil
	}
	return BuildAgyArgs(baseArgs, slug)
}

// SlashCommand generates the "/model <slug>\r" command for the currently selected model.
func (s *SessionState) SlashCommand() (string, error) {
	s.mu.RLock()
	slug := s.currentSlug
	s.mu.RUnlock()

	if slug == "" {
		return "", errors.New("no model selected")
	}
	return FormatModelSlashInput(slug)
}
