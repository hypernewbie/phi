package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/hypernewbie/phi/pkg/diff"
	"github.com/hypernewbie/phi/pkg/gitutil"
	"github.com/hypernewbie/phi/pkg/obs"
	"github.com/hypernewbie/phi/pkg/pty"
	"github.com/hypernewbie/phi/pkg/ws"
)

// notGitRepoBody is the literal response body the raw git endpoints
// emit when cwd isn't a repo. The diff panel frontend detects this exact
// text and renders a muted "Not a git repository" line instead of
// feeding the raw `fatal: not a git repository ...` stderr into the
// terminal as a giant red message.
const notGitRepoBody = "NOT_GIT_REPO"

// gitHeadCache memoises the (HEAD, branch) pair per cwd so the
// diff-review headers don't cost two extra git subprocesses on every
// poll of /api/git/raw-diff (the diff panel refetches this endpoint
// frequently). TTL is short enough that a fresh commit lands within
// one polling cycle, long enough to absorb rapid-fire refetches.
type gitHeadCacheEntry struct {
	head     string
	branch   string
	cachedAt time.Time
}

var gitHeadCache sync.Map // map[string]gitHeadCacheEntry

const gitHeadCacheTTL = 5 * time.Second

// lookupGitHead returns the cached HEAD/branch pair for cwd, or
// fetches them with two `git rev-parse` calls on cache miss. Empty
// strings indicate a detached HEAD, unborn branch, or non-git cwd —
// callers treat those as "unknown" rather than as errors.
func lookupGitHead(ctx context.Context, cwd string) (string, string) {
	if cwd == "" {
		return "", ""
	}
	if v, ok := gitHeadCache.Load(cwd); ok {
		entry := v.(gitHeadCacheEntry)
		if time.Since(entry.cachedAt) < gitHeadCacheTTL {
			return entry.head, entry.branch
		}
	}
	head, branch := "", ""
	if out, err := runGitRevParse(ctx, cwd, "--short", "HEAD"); err == nil {
		head = strings.TrimSpace(string(out))
	}
	if out, err := runGitRevParse(ctx, cwd, "--abbrev-ref", "HEAD"); err == nil {
		branch = strings.TrimSpace(string(out))
	}
	gitHeadCache.Store(cwd, gitHeadCacheEntry{
		head:     head,
		branch:   branch,
		cachedAt: time.Now(),
	})
	return head, branch
}

func runGitRevParse(ctx context.Context, cwd string, args ...string) ([]byte, error) {
	cmd := exec.CommandContext(ctx, "git", append([]string{"rev-parse"}, args...)...)
	cmd.Dir = cwd
	return cmd.Output()
}

func handleGetDiff(w http.ResponseWriter, r *http.Request) {
	cwd := r.URL.Query().Get("cwd")
	diffType := r.URL.Query().Get("type")
	commit := r.URL.Query().Get("commit")
	if cwd == "" {
		cwd = activeCWD
	}

	if !gitutil.IsGitRepo(r.Context(), cwd) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"notGitRepo":true}`))
		return
	}

	var inst *pty.PTYInstance
	var err error

	if diffType == "log" {
		inst, err = diff.SpawnLog(r.Context(), cwd, ptyManager)
	} else if diffType == "status" {
		inst, err = diff.SpawnStatus(r.Context(), cwd, ptyManager)
	} else {
		inst, err = diff.SpawnDiff(r.Context(), cwd, commit, ptyManager)
	}

	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	ws.StartPTYReadLoop(inst, wsHub)

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]string{
		"pane_id": inst.ID,
	})
}

func appendUntrackedDiff(out []byte, fname string, content []byte, ansi bool) []byte {
	trimmed := strings.TrimRight(string(content), "\n")
	lines := []string{}
	if trimmed != "" {
		lines = strings.Split(trimmed, "\n")
	}
	lineCount := len(lines)

	header := func(s string) string {
		if !ansi {
			return s
		}
		return "\x1b[1m" + s + "\x1b[0m"
	}
	oldFile := func(s string) string {
		if !ansi {
			return s
		}
		return "\x1b[31m" + s + "\x1b[0m"
	}
	newFile := func(s string) string {
		if !ansi {
			return s
		}
		return "\x1b[32m" + s + "\x1b[0m"
	}
	plusLine := func(s string) string {
		if !ansi {
			return s
		}
		return "\x1b[32m" + s + "\x1b[0m"
	}

	out = append(out, []byte(header(fmt.Sprintf("diff --git a/%s b/%s\n", fname, fname)))...)
	out = append(out, []byte("new file mode 100644\n")...)
	out = append(out, []byte(oldFile("--- /dev/null\n"))...)
	out = append(out, []byte(newFile(fmt.Sprintf("+++ b/%s\n", fname)))...)
	out = append(out, []byte(fmt.Sprintf("@@ -0,0 +1,%d @@\n", lineCount))...)
	for _, line := range lines {
		out = append(out, []byte(plusLine("+"+line+"\n"))...)
	}
	if len(lines) == 0 {
		out = append(out, []byte("\n")...)
	}
	return out
}

func handleRawDiff(w http.ResponseWriter, r *http.Request) {
	cwd := r.URL.Query().Get("cwd")
	commit := r.URL.Query().Get("commit")
	contextVal := r.URL.Query().Get("context")
	ansi := r.URL.Query().Get("ansi") == "1"
	if cwd == "" {
		cwd = activeCWD
	}

	if !gitutil.IsGitRepo(r.Context(), cwd) {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		_, _ = w.Write([]byte(notGitRepoBody))
		return
	}

	contextLines := "3"
	if contextVal == "30" {
		contextLines = "30"
	}

	colorFlag := "--no-color"
	if ansi {
		colorFlag = "--color=always"
	}

	spanName := "git.diff"
	if commit != "" && commit != "staged" && commit != "unstaged" {
		spanName = "git.show"
	}
	ctx, end := obs.Span(r.Context(), spanName, "cwd", cwd, "commit", commit)

	var cmd *exec.Cmd
	if commit == "staged" {
		cmd = exec.CommandContext(ctx, "git", "diff", "--cached", "-w", colorFlag, "-U"+contextLines)
	} else if commit == "" || commit == "unstaged" {
		cmd = exec.CommandContext(ctx, "git", "diff", "-w", colorFlag, "-U"+contextLines)
	} else {
		cmd = exec.CommandContext(ctx, "git", "show", "-w", colorFlag, "-U"+contextLines, commit)
	}
	cmd.Dir = cwd

	out, err := cmd.Output()
	end(err)
	if err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok {
			http.Error(w, fmt.Sprintf("Git error: %s", string(exitErr.Stderr)), http.StatusInternalServerError)
			return
		}
		http.Error(w, fmt.Sprintf("Git error: %v", err), http.StatusInternalServerError)
		return
	}

	if commit == "" || commit == "unstaged" {
		statusCtx, statusEnd := obs.Span(r.Context(), "git.status", "cwd", cwd)
		statusCmd := exec.CommandContext(statusCtx, "git", "status", "--porcelain")
		statusCmd.Dir = cwd
		statusOut, statusErr := statusCmd.Output()
		statusEnd(statusErr)
		for _, line := range strings.Split(strings.TrimSpace(string(statusOut)), "\n") {
			if !strings.HasPrefix(line, "?? ") {
				continue
			}
			fname := strings.TrimPrefix(line, "?? ")
			content, readErr := os.ReadFile(filepath.Join(cwd, fname))
			if readErr != nil {
				continue
			}
			if len(out) > 0 && out[len(out)-1] != '\n' {
				out = append(out, '\n')
			}
			out = appendUntrackedDiff(out, fname, content, ansi)
		}
	}

	// Head + branch headers let the frontend anchor review comments to a
	// concrete commit. Cached per-cwd so the diff panel's polling on
	// /api/git/raw-diff doesn't spawn two git subprocesses each tick.
	// Best-effort: a detached HEAD or unborn branch yields empty headers,
	// which the UI treats as "unknown".
	head, branch := lookupGitHead(ctx, cwd)
	if head != "" {
		w.Header().Set("X-Phi-Git-Head", head)
	}
	if branch != "" {
		w.Header().Set("X-Phi-Git-Branch", branch)
	}

	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	_, _ = w.Write(out)
}

func handleRawStatus(w http.ResponseWriter, r *http.Request) {
	cwd := r.URL.Query().Get("cwd")
	if cwd == "" {
		cwd = activeCWD
	}

	if !gitutil.IsGitRepo(r.Context(), cwd) {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		_, _ = w.Write([]byte(notGitRepoBody))
		return
	}

	ctx, end := obs.Span(r.Context(), "git.status", "cwd", cwd)
	cmd := exec.CommandContext(ctx, "git", "--no-pager", "-c", "color.status=always", "status", "--short", "--branch")
	cmd.Dir = cwd
	out, err := cmd.CombinedOutput()
	end(err)
	if err != nil && len(out) == 0 {
		http.Error(w, fmt.Sprintf("Git error: %v", err), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	_, _ = w.Write(out)
}

type CommitEntry struct {
	Hash    string `json:"hash"`
	Subject string `json:"subject"`
}

func handleGetCommits(w http.ResponseWriter, r *http.Request) {
	cwd := r.URL.Query().Get("cwd")
	if cwd == "" {
		cwd = activeCWD
	}

	// Run git log to fetch the last 10 commits on active branch
	ctx, end := obs.Span(r.Context(), "git.log", "cwd", cwd)
	cmd := exec.CommandContext(ctx, "git", "log", "-10", "--format=%h|%s")
	cmd.Dir = cwd
	out, err := cmd.Output()
	end(err)
	if err != nil {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode([]CommitEntry{})
		return
	}

	var commits []CommitEntry
	lines := strings.Split(string(out), "\n")
	for _, line := range lines {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		parts := strings.SplitN(line, "|", 2)
		if len(parts) == 2 {
			commits = append(commits, CommitEntry{
				Hash:    parts[0],
				Subject: parts[1],
			})
		}
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(commits)
}
