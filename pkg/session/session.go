package session

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/hypernewbie/phi/pkg/coders"
)

type Session struct {
	ID          string    `json:"id"`
	Title       string    `json:"title"`
	Cwd         string    `json:"cwd"`
	Coder       string    `json:"coder"`
	SessionPath string    `json:"session_path,omitempty"`
	TimeUpdated time.Time `json:"time_updated"`
}

type Message struct {
	Role string `json:"role"`
	Text string `json:"text"`
}

// Adapter is the contract every session-history backend implements
// (R5). List returns the conversations visible to the supplied CWD.
// Transcript returns the messages for one session ID, or
// ErrTranscriptUnsupported when the source has no transcript. Both
// honour ctx cancellation.
type Adapter interface {
	List(ctx context.Context, cwd string) ([]Session, error)
	Transcript(ctx context.Context, cwd, id string) ([]Message, error)
}

// ErrTranscriptUnsupported signals a session source that lists
// conversations but does not store a transcript the UI can render
// (e.g. claude_files today: history.jsonl is a session metadata log,
// not a transcript). Callers map this to a 400 with "unsupported".
var ErrTranscriptUnsupported = errors.New("session source has no transcript")

// ErrAdapterUnknown is returned by ListSessions/GetTranscript when
// the resolved coder declares an unknown session_source.
var ErrAdapterUnknown = errors.New("unknown session_source")

// AdapterFactory builds an Adapter from a resolved Coder, picking
// up typed sidecar options (ClaudeConfigDir, PiRoot, etc.) without
// touching global environment (R5).
type AdapterFactory func(c coders.Coder) Adapter

// adapterFactories is the closed set of named adapters. Adding a
// new adapter requires a code change here; the CoderPatch side only
// references the name.
var adapterFactories = map[string]AdapterFactory{
	"":                noneAdapter,
	"none":            noneAdapter,
	"opencode_sqlite": opencodeAdapter,
	"claude_files":    claudeAdapter,
	"pi_files":        piAdapter,
	"agy_files":       agyAdapter,
}

func noneAdapter(c coders.Coder) Adapter { return noneAdapterImpl{c: c} }

type noneAdapterImpl struct{ c coders.Coder }

func (noneAdapterImpl) List(ctx context.Context, cwd string) ([]Session, error) {
	return []Session{}, nil
}
func (noneAdapterImpl) Transcript(ctx context.Context, cwd, id string) ([]Message, error) {
	return nil, ErrTranscriptUnsupported
}

func opencodeAdapter(c coders.Coder) Adapter { return opencodeAdapterImpl{} }

type opencodeAdapterImpl struct{}

func (opencodeAdapterImpl) List(ctx context.Context, cwd string) ([]Session, error) {
	return ListOpenCodeSessions(ctx, cwd)
}
func (opencodeAdapterImpl) Transcript(ctx context.Context, cwd, id string) ([]Message, error) {
	return GetOpenCodeSessionTranscript(ctx, id)
}

func claudeAdapter(c coders.Coder) Adapter {
	return claudeAdapterImpl{c: c}
}

type claudeAdapterImpl struct{ c coders.Coder }

// List threads a per-profile CLAUDE_CONFIG_DIR through to the
// internal listClaudeSessions helper. The public ListClaudeSessions
// (empty configDir) reads $CLAUDE_CONFIG_DIR at call time; we do
// NOT mutate os.Setenv — concurrent requests for two different
// profiles would race on the global env, and a panic in the
// adapter would leak the override. configDir is plumbed through
// the call chain instead. R5.
func (a claudeAdapterImpl) List(ctx context.Context, cwd string) ([]Session, error) {
	var configDir string
	if a.c.SidecarClaude != nil {
		configDir = a.c.SidecarClaude.ConfigDir
	}
	return listClaudeSessions(cwd, configDir)
}

func (claudeAdapterImpl) Transcript(ctx context.Context, cwd, id string) ([]Message, error) {
	return nil, ErrTranscriptUnsupported
}

func piAdapter(c coders.Coder) Adapter { return piAdapterImpl{c: c} }

type piAdapterImpl struct{ c coders.Coder }

func (a piAdapterImpl) List(ctx context.Context, cwd string) ([]Session, error) {
	return ListPiSessions(cwd)
}

func (a piAdapterImpl) Transcript(ctx context.Context, cwd, id string) ([]Message, error) {
	if id == "" {
		return nil, ErrTranscriptUnsupported
	}
	return GetPiSessionTranscript(cwd, id)
}

func agyAdapter(c coders.Coder) Adapter { return agyAdapterImpl{} }

type agyAdapterImpl struct{}

func (agyAdapterImpl) List(ctx context.Context, cwd string) ([]Session, error) {
	return ListAgySessions(cwd)
}
func (agyAdapterImpl) Transcript(ctx context.Context, cwd, id string) ([]Message, error) {
	return nil, ErrTranscriptUnsupported
}

// AdapterFor returns the registered adapter for a coder's
// SessionSource. Empty / "none" returns the no-op adapter.
func AdapterFor(c coders.Coder) (Adapter, error) {
	factory, ok := adapterFactories[c.SessionSource]
	if !ok {
		return nil, fmt.Errorf("%w: %q", ErrAdapterUnknown, c.SessionSource)
	}
	return factory(c), nil
}

// ListSessions routes a request through the adapter registry (R5).
// The caller must pass the resolved coder (Manager.Get result), not
// a coder ID — list semantics depend on the coder's typed options.
func ListSessions(ctx context.Context, c coders.Coder, cwd string) ([]Session, error) {
	a, err := AdapterFor(c)
	if err != nil {
		return nil, err
	}
	return a.List(ctx, cwd)
}

// GetTranscript routes through the adapter registry and converts
// ErrTranscriptUnsupported into a 400-mappable error.
func GetTranscript(ctx context.Context, c coders.Coder, cwd, id string) ([]Message, error) {
	a, err := AdapterFor(c)
	if err != nil {
		return nil, err
	}
	msgs, err := a.Transcript(ctx, cwd, id)
	if errors.Is(err, ErrTranscriptUnsupported) {
		return nil, err
	}
	return msgs, err
}

func expandHome(path string) string {
	if len(path) > 0 && path[0] == '~' {
		home, err := os.UserHomeDir()
		if err == nil {
			return filepath.Clean(filepath.Join(home, filepath.FromSlash(path[1:])))
		}
	}
	return filepath.Clean(path)
}

func parseRawTime(val interface{}) time.Time {
	if val == nil {
		return time.Now()
	}
	switch v := val.(type) {
	case int64:
		if v > 2000000000 { // milliseconds
			return time.Unix(v/1000, (v%1000)*1000000)
		}
		return time.Unix(v, 0)
	case int:
		v64 := int64(v)
		if v64 > 2000000000 {
			return time.Unix(v64/1000, 0)
		}
		return time.Unix(v64, 0)
	case float64:
		return time.Unix(int64(v), 0)
	case string:
		for _, layout := range []string{
			time.RFC3339,
			"2006-01-02 15:04:05",
			"2006-01-02T15:04:05Z",
		} {
			if t, err := time.Parse(layout, v); err == nil {
				return t
			}
		}
	}
	return time.Now()
}

// NormalisePath cleans and standardises a workspace path for OS-agnostic comparisons.
func NormalisePath(p string) string {
	p = filepath.ToSlash(filepath.Clean(p))
	p = strings.TrimSuffix(p, "/")
	return strings.ToLower(p)
}
