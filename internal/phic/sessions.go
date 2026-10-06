package phic

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"
	"unicode"
)

// TerminalView mirrors GET /api/terminals. Only the fields
// phic consumes are decoded.
type TerminalView struct {
	ID            string `json:"id"`
	Title         string `json:"title,omitempty"`
	Dir           string `json:"cwd,omitempty"`
	Workspace     string `json:"workspace,omitempty"`
	Coder         string `json:"coder"`
	SessionID     string `json:"session_id,omitempty"`
	OpenCodeMode  string `json:"opencode_mode,omitempty"`
	ActiveWSCount int    `json:"ActiveWSCount"`
	CreatedAt     string `json:"created_at,omitempty"`
	LastOutputSeq uint64 `json:"last_output_seq"`
	Pinned        bool   `json:"pinned,omitempty"`
	Marked        bool   `json:"marked,omitempty"`
}

// Session is the saved-session view returned by /api/sessions.
type Session struct {
	ID          string    `json:"id"`
	Title       string    `json:"title"`
	Workspace   string    `json:"cwd"`
	SessionPath string    `json:"session_path,omitempty"`
	Coder       string    `json:"coder"`
	TimeUpdated time.Time `json:"time_updated"`
}

// ListTerminals returns the live panes.
func (a *apiClient) ListTerminals(ctx context.Context, dir string) ([]TerminalView, error) {
	// The server returns all panes. Directory filtering is client-side.
	p := "/api/terminals"
	var out []TerminalView
	if err := a.getJSON(ctx, p, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// ListSessions returns saved sessions for one backend and dir.
func (a *apiClient) ListSessions(ctx context.Context, coder, dir string) ([]Session, error) {
	v := url.Values{}
	if coder != "" {
		v.Set("coder", coder)
	}
	if dir != "" {
		v.Set("cwd", dir)
	}
	p := "/api/sessions?" + v.Encode()
	var out []Session
	if err := a.getJSON(ctx, p, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// SpawnRequest is the body of POST /api/terminals.
type SpawnRequest struct {
	Coder        string   `json:"coder"`
	Dir          string   `json:"cwd"`
	Cols         uint16   `json:"cols,omitempty"`
	Rows         uint16   `json:"rows,omitempty"`
	SessionID    string   `json:"session_id,omitempty"`
	Title        string   `json:"title,omitempty"`
	Workspace    string   `json:"workspace,omitempty"`
	ExtraArgs    []string `json:"extra_args,omitempty"`
	OpenCodeMini bool     `json:"opencode_mini,omitempty"`
}

// SpawnResponse is the JSON returned by POST /api/terminals.
type SpawnResponse struct {
	PaneID       string `json:"pane_id"`
	SessionID    string `json:"session_id"`
	OpenCodeMode string `json:"opencode_mode,omitempty"`
}

// Spawn creates or resumes a pane.
func (a *apiClient) Spawn(ctx context.Context, req SpawnRequest) (SpawnResponse, error) {
	body, err := json.Marshal(req)
	if err != nil {
		return SpawnResponse{}, err
	}
	var out SpawnResponse
	if err := a.postJSON(ctx, "/api/terminals", body, &out); err != nil {
		return SpawnResponse{}, fmt.Errorf("phic: spawn: %w", err)
	}
	return out, nil
}

// DeleteTerminal terminates a pane process. A 404 is treated as already gone
// so a double close cannot fail the UI.
func (a *apiClient) DeleteTerminal(ctx context.Context, id string) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodDelete, a.base.String()+"/api/terminals/"+url.PathEscape(id), nil)
	if err != nil {
		return err
	}
	resp, err := a.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		return nil
	}
	if resp.StatusCode != http.StatusOK {
		return &apiError{Code: resp.StatusCode, Message: "DELETE /api/terminals/" + id + ": " + resp.Status}
	}
	return nil
}

// SetPaneTitle, SetPanePinned, and SetPaneMarked mirror the website's tab
// actions. They change server-side metadata only and never touch pane output.
func (a *apiClient) SetPaneTitle(ctx context.Context, id, title string) error {
	return a.postPaneAction(ctx, id, "title", map[string]string{"title": title})
}

func (a *apiClient) SetPanePinned(ctx context.Context, id string, pinned bool) error {
	return a.postPaneAction(ctx, id, "pin", map[string]bool{"pinned": pinned})
}

func (a *apiClient) SetPaneMarked(ctx context.Context, id string, marked bool) error {
	return a.postPaneAction(ctx, id, "mark", map[string]bool{"marked": marked})
}

func (a *apiClient) postPaneAction(ctx context.Context, id, action string, payload any) error {
	body, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, a.base.String()+"/api/terminals/"+url.PathEscape(id)+"/"+action, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := a.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return &apiError{Code: resp.StatusCode, Message: "POST /api/terminals/" + id + "/" + action + ": " + resp.Status}
	}
	return nil
}

// ListCoders returns the available backend descriptors.
func (a *apiClient) ListCoders(ctx context.Context) ([]CoderDescriptor, error) {
	var registry map[string]CoderDescriptor
	if err := a.getJSON(ctx, "/api/coders", &registry); err != nil {
		return nil, err
	}
	out := make([]CoderDescriptor, 0, len(registry))
	for id, descriptor := range registry {
		if descriptor.ID != id {
			return nil, fmt.Errorf("phic: inconsistent backend ID")
		}
		out = append(out, descriptor)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Order == out[j].Order {
			return out[i].ID < out[j].ID
		}
		return out[i].Order < out[j].Order
	})
	return out, nil
}

// CoderDescriptor mirrors /api/coders.
type CoderDescriptor struct {
	ID           string `json:"id"`
	Name         string `json:"name"`
	Order        int    `json:"order"`
	IsShell      bool   `json:"is_shell"`
	Mode         string `json:"opencode_mode,omitempty"`
	Capabilities struct {
		List bool `json:"list"`
	} `json:"capabilities"`
}

// QuotedID returns a control-character-safe view of an
// identifier. The plan: "Metadata must not inject terminal
// commands."
func QuotedID(s string) string {
	if s == "" {
		return `""`
	}
	safe := make([]rune, 0, len(s)+2)
	safe = append(safe, '"')
	for _, r := range s {
		if r < 0x20 || r == 0x7f {
			hex := "0123456789abcdef"
			safe = append(safe, '\\', 'x', rune(hex[r>>4]), rune(hex[r&0xf]))
			continue
		}
		if unicode.IsControl(r) || unicode.Is(unicode.Cf, r) {
			return fmt.Sprintf("%+q", s)
		}
		if r == '"' || r == '\\' {
			safe = append(safe, '\\')
		}
		safe = append(safe, r)
	}
	safe = append(safe, '"')
	return string(safe)
}

// MatchDir returns true if viewDir matches the wanted dir.
// Empty want matches anything.
func MatchDir(viewDir, want string) bool {
	if want == "" {
		return true
	}
	return strings.TrimRight(viewDir, "/") == strings.TrimRight(want, "/")
}
