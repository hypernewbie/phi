package phic

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/url"
)

// RawDiff fetches the current diff as text. ansi=true asks
// for colorized output for the pager.
func (a *apiClient) RawDiff(ctx context.Context, dir string, ansi bool) (string, error) {
	v := url.Values{}
	v.Set("cwd", dir)
	if ansi {
		v.Set("ansi", "1")
	}
	return a.getText(ctx, "/api/git/raw-diff?"+v.Encode())
}

// Worktree is one row of /api/git/worktrees.
type Worktree struct {
	Path    string `json:"path"`
	Active  bool   `json:"active"`
	Expanded bool  `json:"expanded"`
}

// Worktrees returns the worktree list for a directory.
func (a *apiClient) Worktrees(ctx context.Context, dir string) ([]Worktree, error) {
	v := url.Values{}
	v.Set("cwd", dir)
	var out []Worktree
	if err := a.getJSON(ctx, "/api/git/worktrees?"+v.Encode(), &out); err != nil {
		return nil, err
	}
	return out, nil
}

func (a *apiClient) getText(ctx context.Context, path string) (string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, a.base.String()+path, nil)
	if err != nil {
		return "", err
	}
	resp, err := a.http.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("phic: GET %s: %s", path, resp.Status)
	}
	b, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", err
	}
	return string(b), nil
}
