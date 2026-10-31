package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
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

// worktreeDiffOutput returns staged plus unstaged tracked changes as one
// patch. With a resolvable HEAD a single `git diff HEAD` covers both
// halves; on an unborn branch HEAD does not exist, so the staged
// (`--cached`) and unstaged halves are concatenated instead.
func worktreeDiffOutput(ctx context.Context, cwd, colorFlag, contextLines string) ([]byte, error) {
	run := func(args ...string) ([]byte, error) {
		cmd := exec.CommandContext(ctx, "git", args...)
		cmd.Dir = cwd
		return cmd.Output()
	}
	if _, err := run("rev-parse", "--verify", "--quiet", "HEAD"); err == nil {
		return run("diff", "HEAD", "-w", colorFlag, "-U"+contextLines)
	}
	staged, err := run("diff", "--cached", "-w", colorFlag, "-U"+contextLines)
	if err != nil {
		return staged, err
	}
	unstaged, err := run("diff", "-w", colorFlag, "-U"+contextLines)
	if err != nil {
		return unstaged, err
	}
	if len(staged) > 0 && len(unstaged) > 0 && staged[len(staged)-1] != '\n' {
		staged = append(staged, '\n')
	}
	return append(staged, unstaged...), nil
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

	// An empty commit selects the whole working tree (phic): staged changes
	// (git adds) plus unstaged ones. Plain `git diff` hides the staged
	// half, the classic gotcha. The explicit "unstaged" selector keeps
	// plain `git diff` semantics for the web panel.
	var out []byte
	var err error
	if commit == "" {
		out, err = worktreeDiffOutput(ctx, cwd, colorFlag, contextLines)
	} else {
		var cmd *exec.Cmd
		if commit == "staged" {
			cmd = exec.CommandContext(ctx, "git", "diff", "--cached", "-w", colorFlag, "-U"+contextLines)
		} else if commit == "unstaged" {
			cmd = exec.CommandContext(ctx, "git", "diff", "-w", colorFlag, "-U"+contextLines)
		} else {
			cmd = exec.CommandContext(ctx, "git", "show", "-w", colorFlag, "-U"+contextLines, commit)
		}
		cmd.Dir = cwd
		out, err = cmd.Output()
	}
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

func handleRawLog(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", http.MethodGet)
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), gitReadTimeout)
	defer cancel()
	cwd := r.URL.Query().Get("cwd")
	if cwd == "" {
		cwd = activeCWD
	}
	repo, notRepo, err := inspectGitRepository(ctx, cwd)
	if err != nil {
		writeGitAPIError(w, err)
		return
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	if notRepo {
		_, _ = w.Write([]byte(notGitRepoBody))
		return
	}
	if _, _, err := gitOutput(ctx, repo.root, "rev-parse", "--verify", "--quiet", "HEAD"); err != nil {
		if isExitCode(err, 1) && ctx.Err() == nil {
			return
		}
		writeGitAPIError(w, gitReadAPIError(ctx))
		return
	}
	out, _, err := gitOutput(ctx, repo.root, "--no-pager", "log", "--oneline", "-10", "--color=always")
	if err != nil {
		writeGitAPIError(w, gitReadAPIError(ctx))
		return
	}
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

const (
	gitReadTimeout     = 5 * time.Second
	gitMutationTimeout = 120 * time.Second
	gitActionBodyLimit = 64 << 10
)

type gitActionTarget struct {
	Root        string `json:"root"`
	Head        string `json:"head"`
	Branch      string `json:"branch"`
	Remote      string `json:"remote"`
	RemoteRef   string `json:"remote_ref"`
	RemoteToken string `json:"remote_token"`
}

type gitInfoResponse struct {
	NotGitRepo   bool             `json:"notGitRepo"`
	Target       *gitActionTarget `json:"target"`
	CanPullPush  bool             `json:"can_pull_push"`
	Reason       string           `json:"reason"`
	HasStaged    bool             `json:"has_staged"`
	IndexToken   string           `json:"index_token"`
	CanCommit    bool             `json:"can_commit"`
	CommitReason string           `json:"commit_reason"`
}

type gitActionRequest struct {
	Cwd        string          `json:"cwd"`
	Action     string          `json:"action"`
	Target     gitActionTarget `json:"target"`
	Message    string          `json:"message"`
	IndexToken string          `json:"index_token"`
}

type gitActionRepository struct {
	root      string
	commonDir string
	bare      bool
}

type gitAPIError struct {
	status  int
	message string
}

func (e *gitAPIError) Error() string { return e.message }

func gitAPIErrorf(status int, message string) *gitAPIError {
	return &gitAPIError{status: status, message: message}
}

func gitReadAPIError(ctx context.Context) *gitAPIError {
	if ctx.Err() != nil {
		return gitAPIErrorf(http.StatusGatewayTimeout, "Git information timed out")
	}
	return gitAPIErrorf(http.StatusInternalServerError, "Git information unavailable")
}

func writeGitAPIError(w http.ResponseWriter, err error) {
	var apiErr *gitAPIError
	if errors.As(err, &apiErr) {
		http.Error(w, apiErr.message, apiErr.status)
		return
	}
	http.Error(w, "Git information unavailable", http.StatusInternalServerError)
}

func gitEnvironment() []string {
	blocked := map[string]bool{
		"GIT_DIR": true, "GIT_WORK_TREE": true, "GIT_COMMON_DIR": true,
		"GIT_INDEX_FILE": true, "GIT_OBJECT_DIRECTORY": true,
		"GIT_ALTERNATE_OBJECT_DIRECTORIES": true, "GIT_NAMESPACE": true,
		"GIT_CONFIG": true, "GIT_CONFIG_COUNT": true,
		"GIT_CONFIG_PARAMETERS": true, "GIT_TERMINAL_PROMPT": true,
		"GCM_INTERACTIVE": true, "SSH_ASKPASS_REQUIRE": true,
		"GIT_ASKPASS": true, "SSH_ASKPASS": true,
	}
	env := make([]string, 0, len(os.Environ())+5)
	for _, entry := range os.Environ() {
		key, _, ok := strings.Cut(entry, "=")
		if !ok || blocked[key] || strings.HasPrefix(key, "GIT_CONFIG_KEY_") || strings.HasPrefix(key, "GIT_CONFIG_VALUE_") {
			continue
		}
		env = append(env, entry)
	}
	return append(env,
		"GIT_TERMINAL_PROMPT=0",
		"GCM_INTERACTIVE=Never",
		"SSH_ASKPASS_REQUIRE=never",
		"GIT_ASKPASS=",
		"SSH_ASKPASS=",
	)
}

func gitCommand(ctx context.Context, cwd string, args ...string) *exec.Cmd {
	fullArgs := append([]string{"-c", "credential.interactive=false", "-c", "core.askPass="}, args...)
	cmd := exec.CommandContext(ctx, "git", fullArgs...)
	cmd.Dir = cwd
	cmd.Env = gitEnvironment()
	cmd.WaitDelay = 2 * time.Second
	return cmd
}

func gitOutput(ctx context.Context, cwd string, args ...string) ([]byte, []byte, error) {
	cmd := gitCommand(ctx, cwd, args...)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err := cmd.Run()
	return stdout.Bytes(), stderr.Bytes(), err
}

func isGitNotRepository(err error, stderr []byte) bool {
	var exitErr *exec.ExitError
	return errors.As(err, &exitErr) && exitErr.ExitCode() == 128 && bytes.Contains(stderr, []byte("not a git repository"))
}

func outputLine(data []byte) string {
	return strings.TrimSuffix(string(data), "\n")
}

func canonicalGitDirectory(path string) (string, error) {
	abs, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}
	real, err := filepath.EvalSymlinks(abs)
	if err != nil {
		return "", err
	}
	info, err := os.Stat(real)
	if err != nil || !info.IsDir() {
		if err == nil {
			err = fmt.Errorf("not a directory")
		}
		return "", err
	}
	return real, nil
}

func gitPathWithin(path, root string) bool {
	rel, err := filepath.Rel(root, path)
	if err != nil || filepath.IsAbs(rel) {
		return false
	}
	return rel == "." || (rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)))
}

func gitPathWithinAny(path string, roots []string) bool {
	for _, root := range roots {
		if gitPathWithin(path, root) {
			return true
		}
	}
	return false
}

func trustedGitRoots() []string {
	seen := make(map[string]bool)
	var roots []string
	for _, root := range workspaceRoots(loadConfig()) {
		canonical, err := canonicalGitDirectory(root)
		if err != nil || seen[canonical] {
			continue
		}
		seen[canonical] = true
		roots = append(roots, canonical)
	}
	return roots
}

func inspectGitRepository(ctx context.Context, cwd string) (*gitActionRepository, bool, error) {
	bareOut, stderr, err := gitOutput(ctx, cwd, "rev-parse", "--is-bare-repository")
	if err != nil {
		if isGitNotRepository(err, stderr) {
			return nil, true, nil
		}
		return nil, false, gitReadAPIError(ctx)
	}
	bare := outputLine(bareOut) == "true"
	if !bare && outputLine(bareOut) != "false" {
		return nil, false, gitAPIErrorf(http.StatusInternalServerError, "Git information unavailable")
	}
	if bare {
		return &gitActionRepository{bare: true}, false, nil
	}
	topOut, stderr, err := gitOutput(ctx, cwd, "rev-parse", "--show-toplevel")
	if err != nil {
		if isGitNotRepository(err, stderr) {
			return nil, true, nil
		}
		return nil, false, gitReadAPIError(ctx)
	}
	root, err := canonicalGitDirectory(outputLine(topOut))
	if err != nil {
		return nil, false, gitReadAPIError(ctx)
	}
	commonOut, _, err := gitOutput(ctx, root, "rev-parse", "--path-format=absolute", "--git-common-dir")
	if err != nil {
		return nil, false, gitReadAPIError(ctx)
	}
	commonDir, err := canonicalGitDirectory(outputLine(commonOut))
	if err != nil {
		return nil, false, gitReadAPIError(ctx)
	}
	return &gitActionRepository{root: root, commonDir: commonDir}, false, nil
}

func parseGitWorktreeRoots(output []byte) []string {
	seen := make(map[string]bool)
	var roots []string
	for _, field := range bytes.Split(output, []byte{0}) {
		if !bytes.HasPrefix(field, []byte("worktree ")) {
			continue
		}
		root := string(field[len("worktree "):])
		if root != "" && !seen[root] {
			seen[root] = true
			roots = append(roots, root)
		}
	}
	return roots
}

func registeredGitWorktrees(ctx context.Context, trustedRoots []string) ([]string, error) {
	seen := make(map[string]bool)
	var registered []string
	for _, trusted := range trustedRoots {
		out, stderr, err := gitOutput(ctx, trusted, "worktree", "list", "--porcelain", "-z")
		if err != nil {
			if isGitNotRepository(err, stderr) {
				continue
			}
			if ctx.Err() != nil {
				return nil, gitAPIErrorf(http.StatusGatewayTimeout, "Git information timed out")
			}
			return nil, gitAPIErrorf(http.StatusInternalServerError, "Git information unavailable")
		}
		source, notRepo, sourceErr := inspectGitRepository(ctx, trusted)
		if sourceErr != nil {
			return nil, sourceErr
		}
		if notRepo || source == nil || source.bare {
			continue
		}
		for _, listed := range parseGitWorktreeRoots(out) {
			root, err := canonicalGitDirectory(listed)
			if err != nil || seen[root] {
				continue
			}
			candidate, notRepo, candidateErr := inspectGitRepository(ctx, root)
			if candidateErr != nil {
				if ctx.Err() != nil {
					return nil, gitReadAPIError(ctx)
				}
				continue
			}
			if notRepo || candidate == nil || candidate.bare || candidate.root != root || candidate.commonDir != source.commonDir {
				continue
			}
			seen[root] = true
			registered = append(registered, root)
		}
	}
	return registered, nil
}

func resolveAuthorizedGitRepository(ctx context.Context, cwd string) (*gitActionRepository, bool, error) {
	if cwd == "" {
		cwd = activeCWD
	}
	if cwd == "" {
		return nil, false, gitAPIErrorf(http.StatusNotFound, "Git workspace not found")
	}
	requested, err := canonicalGitDirectory(cwd)
	if err != nil {
		return nil, false, gitAPIErrorf(http.StatusNotFound, "Git workspace not found")
	}
	trusted := trustedGitRoots()
	var allowedRoots []string
	insideTrusted := gitPathWithinAny(requested, trusted)
	if insideTrusted {
		allowedRoots = trusted
	} else {
		registered, err := registeredGitWorktrees(ctx, trusted)
		if err != nil {
			return nil, false, err
		}
		if !gitPathWithinAny(requested, registered) {
			return nil, false, gitAPIErrorf(http.StatusForbidden, "Git workspace is not authorized")
		}
		allowedRoots = registered
	}
	repo, notRepo, err := inspectGitRepository(ctx, requested)
	if err != nil {
		return nil, false, err
	}
	if notRepo {
		return nil, true, nil
	}
	if repo.bare {
		return nil, false, gitAPIErrorf(http.StatusForbidden, "Git actions require a working tree")
	}
	if !gitPathWithinAny(repo.root, allowedRoots) {
		return nil, false, gitAPIErrorf(http.StatusForbidden, "Git workspace is not authorized")
	}
	return repo, false, nil
}

func targetForGitRepository(ctx context.Context, repo *gitActionRepository) (gitActionTarget, bool, string, error) {
	target := gitActionTarget{Root: repo.root}
	headOut, headErrOut, headErr := gitOutput(ctx, repo.root, "rev-parse", "--verify", "--quiet", "HEAD")
	branchOut, branchErrOut, branchErr := gitOutput(ctx, repo.root, "symbolic-ref", "--quiet", "--short", "HEAD")
	if ctx.Err() != nil {
		return target, false, "", gitReadAPIError(ctx)
	}
	if headErr == nil {
		target.Head = outputLine(headOut)
		if target.Head == "" {
			return target, false, "", gitReadAPIError(ctx)
		}
	} else if branchErr == nil {
		target.Branch = outputLine(branchOut)
		if target.Branch == "" {
			return target, false, "", gitReadAPIError(ctx)
		}
		ref := "refs/heads/" + target.Branch
		_, showErrOut, showErr := gitOutput(ctx, repo.root, "show-ref", "--verify", "--quiet", ref)
		if showErr == nil || !isExitCode(showErr, 1) || len(showErrOut) != 0 {
			return target, false, "", gitReadAPIError(ctx)
		}
	} else {
		if !isExitCode(headErr, 1) || len(headErrOut) != 0 || !isExitCode(branchErr, 1) || len(branchErrOut) != 0 {
			return target, false, "", gitReadAPIError(ctx)
		}
		return target, false, "Git HEAD is invalid.", nil
	}
	if branchErr == nil {
		target.Branch = outputLine(branchOut)
	} else if !isExitCode(branchErr, 1) || len(branchErrOut) != 0 {
		return target, false, "", gitReadAPIError(ctx)
	}
	if target.Head == "" {
		return target, false, "This branch has no commits yet.", nil
	}
	if target.Branch == "" {
		return target, false, "Check out a branch before Pull or Push.", nil
	}
	upstreamOut, _, err := gitOutput(ctx, repo.root, "for-each-ref", "--format=%(upstream:remotename)%00%(upstream:remoteref)", "refs/heads/"+target.Branch)
	if err != nil {
		return target, false, "", gitReadAPIError(ctx)
	}
	upstream := outputLine(upstreamOut)
	parts := strings.SplitN(upstream, "\x00", 2)
	if len(parts) != 2 || parts[0] == "" || parts[0] == "." || parts[1] == "" || !strings.HasPrefix(parts[1], "refs/heads/") || strings.ContainsAny(parts[0]+parts[1], "\r\n") {
		return target, false, "This branch has no supported remote upstream.", nil
	}
	target.Remote = parts[0]
	target.RemoteRef = parts[1]
	if _, _, err := gitOutput(ctx, repo.root, "check-ref-format", target.RemoteRef); err != nil {
		if ctx.Err() != nil {
			return target, false, "", gitReadAPIError(ctx)
		}
		return target, false, "The upstream branch is not supported.", nil
	}
	fetchURLs, _, fetchErr := gitOutput(ctx, repo.root, "remote", "get-url", "--all", "--", target.Remote)
	pushURLs, _, pushErr := gitOutput(ctx, repo.root, "remote", "get-url", "--push", "--all", "--", target.Remote)
	if fetchErr != nil || pushErr != nil {
		if ctx.Err() != nil {
			return target, false, "", gitReadAPIError(ctx)
		}
		return target, false, "The upstream remote has no usable URL.", nil
	}
	if !oneGitURL(fetchURLs) || !oneGitURL(pushURLs) {
		return target, false, "The upstream remote has multiple or invalid destinations.", nil
	}
	h := sha256.New()
	_, _ = h.Write(fetchURLs)
	_, _ = h.Write([]byte{0})
	_, _ = h.Write(pushURLs)
	target.RemoteToken = hex.EncodeToString(h.Sum(nil))
	if reason, err := gitMutationPrecondition(ctx, repo, "Pull or Push"); err != nil {
		return target, false, "", err
	} else if reason != "" {
		return target, false, reason, nil
	}
	return target, true, "", nil
}

func oneGitURL(output []byte) bool {
	line := outputLine(output)
	return len(line) > 0 && !strings.ContainsAny(line, "\r\n")
}

func isExitCode(err error, code int) bool {
	var exitErr *exec.ExitError
	return errors.As(err, &exitErr) && exitErr.ExitCode() == code
}

func gitIndexSnapshot(ctx context.Context, repo *gitActionRepository) (bool, string, *gitAPIError) {
	stageHash := sha256.New()
	stageCmd := gitCommand(ctx, repo.root, "ls-files", "--stage", "-z")
	stageCmd.Stdout = stageHash
	stageCmd.Stderr = io.Discard
	if err := stageCmd.Run(); err != nil {
		return false, "", gitReadAPIError(ctx)
	}

	deltaHash := sha256.New()
	deltaCmd := gitCommand(ctx, repo.root,
		"diff", "--cached", "--raw", "--no-abbrev", "--no-renames",
		"--no-ext-diff", "--no-textconv", "--ita-invisible-in-index",
		"--ignore-submodules=none", "-z", "--exit-code", "--",
	)
	deltaCmd.Stdout = deltaHash
	deltaCmd.Stderr = io.Discard
	deltaErr := deltaCmd.Run()
	hasStaged := deltaErr != nil
	if deltaErr != nil && !isExitCode(deltaErr, 1) {
		return false, "", gitReadAPIError(ctx)
	}

	combined := sha256.Sum256([]byte(fmt.Sprintf("%x:%x", stageHash.Sum(nil), deltaHash.Sum(nil))))
	return hasStaged, hex.EncodeToString(combined[:]), nil
}

func gitCommitTarget(target gitActionTarget) gitActionTarget {
	target.Remote = ""
	target.RemoteRef = ""
	target.RemoteToken = ""
	return target
}

func gitCanCommit(ctx context.Context, repo *gitActionRepository, target gitActionTarget, hasStaged bool) (bool, string, *gitAPIError) {
	if target.Branch == "" {
		return false, "Check out a branch before Commit.", nil
	}
	if reason, err := gitMutationPrecondition(ctx, repo, "Commit"); err != nil {
		return false, "", err
	} else if reason != "" {
		return false, reason, nil
	}
	if !hasStaged {
		return false, "Stage changes in Git before committing.", nil
	}
	return true, "", nil
}

func gitMutationPrecondition(ctx context.Context, repo *gitActionRepository, action string) (string, *gitAPIError) {
	for _, marker := range []string{
		"MERGE_HEAD",
		"CHERRY_PICK_HEAD",
		"REVERT_HEAD",
		"rebase-apply",
		"rebase-merge",
		"sequencer",
	} {
		pathOut, _, err := gitOutput(ctx, repo.root, "rev-parse", "--git-path", marker)
		if err != nil {
			return "", gitReadAPIError(ctx)
		}
		path := outputLine(pathOut)
		if !filepath.IsAbs(path) {
			path = filepath.Join(repo.root, path)
		}
		if _, err := os.Lstat(path); err == nil {
			return fmt.Sprintf("Finish the current Git operation before %s.", action), nil
		} else if !os.IsNotExist(err) {
			return "", gitReadAPIError(ctx)
		}
	}
	unmerged, _, err := gitOutput(ctx, repo.root, "ls-files", "--unmerged", "-z")
	if err != nil {
		return "", gitReadAPIError(ctx)
	}
	if len(unmerged) != 0 {
		return fmt.Sprintf("Resolve unmerged files before %s.", action), nil
	}
	return "", nil
}

func handleGitInfo(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), gitReadTimeout)
	defer cancel()
	repo, notRepo, err := resolveAuthorizedGitRepository(ctx, r.URL.Query().Get("cwd"))
	if err != nil {
		writeGitAPIError(w, err)
		return
	}
	if notRepo {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]bool{"notGitRepo": true})
		return
	}
	target, canPullPush, reason, err := targetForGitRepository(ctx, repo)
	if err != nil {
		writeGitAPIError(w, err)
		return
	}
	hasStaged, indexToken, indexErr := gitIndexSnapshot(ctx, repo)
	if indexErr != nil {
		writeGitAPIError(w, indexErr)
		return
	}
	canCommit, commitReason, commitErr := gitCanCommit(ctx, repo, target, hasStaged)
	if commitErr != nil {
		writeGitAPIError(w, commitErr)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(gitInfoResponse{
		Target:       &target,
		CanPullPush:  canPullPush,
		Reason:       reason,
		HasStaged:    hasStaged,
		IndexToken:   indexToken,
		CanCommit:    canCommit,
		CommitReason: commitReason,
	})
}

func decodeGitActionRequest(w http.ResponseWriter, r *http.Request) (gitActionRequest, int, string) {
	mediaType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || mediaType != "application/json" {
		return gitActionRequest{}, http.StatusUnsupportedMediaType, "Content-Type must be application/json"
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, gitActionBodyLimit))
	if err != nil {
		var maxErr *http.MaxBytesError
		if errors.As(err, &maxErr) {
			return gitActionRequest{}, http.StatusRequestEntityTooLarge, "Request body is too large"
		}
		return gitActionRequest{}, http.StatusBadRequest, "Invalid request body"
	}
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	var req gitActionRequest
	if err := decoder.Decode(&req); err != nil {
		return gitActionRequest{}, http.StatusBadRequest, "Invalid request body"
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		return gitActionRequest{}, http.StatusBadRequest, "Request must contain one JSON object"
	}
	if req.Action == "commit" {
		if req.Target.Root == "" || req.Target.Branch == "" ||
			strings.TrimSpace(req.Message) == "" || strings.ContainsRune(req.Message, '\x00') ||
			req.Target.Remote != "" || req.Target.RemoteRef != "" || req.Target.RemoteToken != "" ||
			len(req.IndexToken) != sha256.Size*2 {
			return gitActionRequest{}, http.StatusBadRequest, "A commit message and complete local Git target are required"
		}
		if _, err := hex.DecodeString(req.IndexToken); err != nil {
			return gitActionRequest{}, http.StatusBadRequest, "A commit message and complete local Git target are required"
		}
		return req, 0, ""
	}
	if req.Action != "pull" && req.Action != "push" {
		return gitActionRequest{}, http.StatusBadRequest, "Unsupported Git action"
	}
	if req.Target.Root == "" || req.Target.Head == "" || req.Target.Branch == "" || req.Target.Remote == "" || req.Target.RemoteRef == "" || len(req.Target.RemoteToken) != sha256.Size*2 {
		return gitActionRequest{}, http.StatusBadRequest, "A complete Git target is required"
	}
	if _, err := hex.DecodeString(req.Target.RemoteToken); err != nil {
		return gitActionRequest{}, http.StatusBadRequest, "A complete Git target is required"
	}
	return req, 0, ""
}

func gitActionLock(commonDir string) *sync.Mutex {
	value, _ := gitActionLocks.LoadOrStore(commonDir, &sync.Mutex{})
	return value.(*sync.Mutex)
}

var gitActionLocks sync.Map

func gitConfigMirrorOption(remote string) string {
	escaped := strings.NewReplacer("\\", "\\\\", "\"", "\\\"").Replace(remote)
	return "remote.\"" + escaped + "\".mirror=false"
}

func handleGitAction(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost)
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	req, status, message := decodeGitActionRequest(w, r)
	if status != 0 {
		http.Error(w, message, status)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), gitMutationTimeout)
	defer cancel()
	repo, notRepo, err := resolveAuthorizedGitRepository(ctx, req.Cwd)
	if err != nil {
		writeGitAPIError(w, err)
		return
	}
	if notRepo {
		http.Error(w, "Not a Git repository", http.StatusNotFound)
		return
	}
	lock := gitActionLock(repo.commonDir)
	if !lock.TryLock() {
		http.Error(w, "Git action already in progress", http.StatusConflict)
		return
	}
	defer lock.Unlock()
	fresh, canPullPush, reason, err := targetForGitRepository(ctx, repo)
	if err != nil {
		writeGitAPIError(w, err)
		return
	}
	if req.Action == "commit" {
		fresh = gitCommitTarget(fresh)
		if fresh != req.Target {
			http.Error(w, "Git target changed; refresh before trying again", http.StatusConflict)
			return
		}
		hasStaged, indexToken, indexErr := gitIndexSnapshot(ctx, repo)
		if indexErr != nil {
			writeGitAPIError(w, indexErr)
			return
		}
		if indexToken != req.IndexToken {
			http.Error(w, "Git index changed; refresh before committing", http.StatusConflict)
			return
		}
		canCommit, commitReason, commitErr := gitCanCommit(ctx, repo, fresh, hasStaged)
		if commitErr != nil {
			writeGitAPIError(w, commitErr)
			return
		}
		if !canCommit {
			http.Error(w, commitReason, http.StatusConflict)
			return
		}
	} else {
		if fresh != req.Target {
			http.Error(w, "Git target changed; refresh before trying again", http.StatusConflict)
			return
		}
		if !canPullPush {
			http.Error(w, reason, http.StatusConflict)
			return
		}
	}
	if err := ctx.Err(); err != nil {
		http.Error(w, "Git result unconfirmed. Inspect Git state before running again.", http.StatusGatewayTimeout)
		return
	}
	var cmd *exec.Cmd
	switch req.Action {
	case "pull":
		cmd = gitCommand(ctx, repo.root, "pull", "--ff-only", "--no-rebase", "--no-autostash", "--no-recurse-submodules", "--", fresh.Remote, fresh.RemoteRef)
	case "push":
		cmd = gitCommand(ctx, repo.root, "-c", gitConfigMirrorOption(fresh.Remote), "push", "--no-force", "--no-follow-tags", "--recurse-submodules=no", "--", fresh.Remote, "HEAD:"+fresh.RemoteRef)
	case "commit":
		cmd = gitCommand(ctx, repo.root, "commit", "--file=-")
		cmd.Stdin = strings.NewReader(req.Message)
	}
	cmd.Stdout = io.Discard
	cmd.Stderr = io.Discard
	gitHeadCache.Clear()
	err = cmd.Run()
	if err != nil {
		if ctx.Err() != nil {
			http.Error(w, "Git result unconfirmed. Inspect Git state before running again.", http.StatusGatewayTimeout)
			return
		}
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) && exitErr.ExitCode() >= 0 {
			http.Error(w, fmt.Sprintf("Git %s failed. Partial effects are possible. Inspect Git before running again.", req.Action), http.StatusInternalServerError)
			return
		}
		http.Error(w, "Git result unconfirmed. Inspect Git state before running again.", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]string{
		"action": req.Action,
		"root":   fresh.Root,
		"output": strings.ToUpper(req.Action[:1]) + req.Action[1:] + " completed.",
	})
}
