package gitapi

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestHandleRawDiff(t *testing.T) {
	// Create a temporary directory that represents our Git workspace
	tempDir := t.TempDir()

	// Initialise a new Git repository
	runGit := func(args ...string) {
		t.Helper()
		cmd := exec.Command("git", args...)
		cmd.Dir = tempDir
		if err := cmd.Run(); err != nil {
			t.Fatalf("git %v failed: %v", args, err)
		}
	}

	runGit("init")
	runGit("config", "user.name", "Test User")
	runGit("config", "user.email", "test@example.com")

	// Create and commit a base file with multiple lines
	filePath := filepath.Join(tempDir, "file.txt")
	lines := []string{
		"line 1",
		"line 2",
		"line 3",
		"line 4",
		"line 5",
		"line 6",
		"line 7",
		"line 8",
		"line 9",
		"line 10",
	}
	err := os.WriteFile(filePath, []byte(strings.Join(lines, "\n")+"\n"), 0644)
	if err != nil {
		t.Fatalf("write file: %v", err)
	}

	runGit("add", "file.txt")
	runGit("commit", "-m", "initial commit")

	// Modify the file at line 5
	lines[4] = "line 5 modified"
	err = os.WriteFile(filePath, []byte(strings.Join(lines, "\n")+"\n"), 0644)
	if err != nil {
		t.Fatalf("write file modification: %v", err)
	}

	// Test raw-diff of unstaged changes with default context (3 lines)
	req := httptest.NewRequest(http.MethodGet, "/api/git/raw-diff?cwd="+tempDir+"&context=3", nil)
	w := httptest.NewRecorder()
	testAPI().HandleRawDiff(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("Expected status 200, got %d", w.Code)
	}

	// X-Phi-Git-Head / X-Phi-Git-Branch let the diff review UI anchor
	// comments to a concrete commit hash. Initial-commit repos still
	// have HEAD, so these must be non-empty.
	if head := w.Header().Get("X-Phi-Git-Head"); head == "" {
		t.Errorf("Expected X-Phi-Git-Head to be set, got empty header")
	}
	if branch := w.Header().Get("X-Phi-Git-Branch"); branch == "" {
		t.Errorf("Expected X-Phi-Git-Branch to be set, got empty header")
	}

	body := w.Body.String()
	if !strings.Contains(body, "-line 5") || !strings.Contains(body, "+line 5 modified") {
		t.Errorf("Diff body does not contain expected changes: %s", body)
	}

	// The diff should contain line 2 but not line 10 under U3 (since line 5 is modified, lines 2, 3, 4 and 6, 7, 8 are context)
	if strings.Contains(body, "line 10") {
		t.Errorf("Diff body should not contain line 10 under context=3, got: %s", body)
	}

	// Test raw-diff of unstaged changes with extended context (30 lines)
	req30 := httptest.NewRequest(http.MethodGet, "/api/git/raw-diff?cwd="+tempDir+"&context=30", nil)
	w30 := httptest.NewRecorder()
	testAPI().HandleRawDiff(w30, req30)

	if w30.Code != http.StatusOK {
		t.Fatalf("Expected status 200, got %d", w30.Code)
	}

	body30 := w30.Body.String()
	if !strings.Contains(body30, "line 1") {
		t.Errorf("Diff body should contain line 1 under context=30, got: %s", body30)
	}

	// Untracked files should also appear in the unstaged diff output.
	newFilePath := filepath.Join(tempDir, "new_untracked.txt")
	err = os.WriteFile(newFilePath, []byte("brand new\nfile\n"), 0644)
	if err != nil {
		t.Fatalf("write untracked file: %v", err)
	}

	reqUntracked := httptest.NewRequest(http.MethodGet, "/api/git/raw-diff?cwd="+tempDir+"&context=3", nil)
	wUntracked := httptest.NewRecorder()
	testAPI().HandleRawDiff(wUntracked, reqUntracked)

	if wUntracked.Code != http.StatusOK {
		t.Fatalf("Expected status 200 for untracked diff, got %d", wUntracked.Code)
	}

	bodyUntracked := wUntracked.Body.String()
	if !strings.Contains(bodyUntracked, "diff --git a/new_untracked.txt b/new_untracked.txt") ||
		!strings.Contains(bodyUntracked, "new file mode 100644") ||
		!strings.Contains(bodyUntracked, "@@ -0,0 +1,2 @@") ||
		!strings.Contains(bodyUntracked, "+brand new") {
		t.Errorf("Untracked file missing pretty patch structure: %s", bodyUntracked)
	}

	// Staged changes (git adds) must also appear in the working-tree
	// output. Plain `git diff` hides the staged half, the classic gotcha:
	// after `git add`, neither hunk below would survive without the fix.
	runGit("add", "file.txt", "new_untracked.txt")

	reqStaged := httptest.NewRequest(http.MethodGet, "/api/git/raw-diff?cwd="+tempDir+"&context=3", nil)
	wStaged := httptest.NewRecorder()
	testAPI().HandleRawDiff(wStaged, reqStaged)

	if wStaged.Code != http.StatusOK {
		t.Fatalf("Expected status 200 for staged diff, got %d", wStaged.Code)
	}

	bodyStaged := wStaged.Body.String()
	if !strings.Contains(bodyStaged, "-line 5") || !strings.Contains(bodyStaged, "+line 5 modified") {
		t.Errorf("Staged modification missing from working-tree diff: %s", bodyStaged)
	}
	if !strings.Contains(bodyStaged, "diff --git a/new_untracked.txt b/new_untracked.txt") ||
		!strings.Contains(bodyStaged, "+brand new") {
		t.Errorf("Staged new file missing from working-tree diff: %s", bodyStaged)
	}
}

// TestHandleRawDiff_UnbornHeadStaged: a repo with no commits yet has no
// HEAD for `git diff HEAD` to resolve. The working-tree view must still
// show staged changes (via the --cached fallback) alongside untracked ones.
func TestHandleRawDiff_UnbornHeadStaged(t *testing.T) {
	tempDir := t.TempDir()
	runGit := func(args ...string) {
		t.Helper()
		cmd := exec.Command("git", args...)
		cmd.Dir = tempDir
		if err := cmd.Run(); err != nil {
			t.Fatalf("git %v failed: %v", args, err)
		}
	}
	runGit("init")
	runGit("config", "user.name", "Test User")
	runGit("config", "user.email", "test@example.com")

	if err := os.WriteFile(filepath.Join(tempDir, "staged.txt"), []byte("staged content\n"), 0644); err != nil {
		t.Fatalf("write staged file: %v", err)
	}
	runGit("add", "staged.txt")
	if err := os.WriteFile(filepath.Join(tempDir, "unstaged.txt"), []byte("unstaged content\n"), 0644); err != nil {
		t.Fatalf("write untracked file: %v", err)
	}

	req := httptest.NewRequest(http.MethodGet, "/api/git/raw-diff?cwd="+tempDir+"&context=3", nil)
	w := httptest.NewRecorder()
	testAPI().HandleRawDiff(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("Expected status 200 for unborn-HEAD diff, got %d", w.Code)
	}

	body := w.Body.String()
	if !strings.Contains(body, "+staged content") {
		t.Errorf("Staged file missing from unborn-HEAD working-tree diff: %s", body)
	}
	if !strings.Contains(body, "+unstaged content") {
		t.Errorf("Untracked file missing from unborn-HEAD working-tree diff: %s", body)
	}
}

// TestHandleRawDiff_CancelledContext (L6): a request whose ctx is already
// cancelled must short-circuit through IsGitRepo's `git rev-parse` probe
// (which the ctx kills via exec.CommandContext), not run the actual
// `git diff` subprocess at all. Either observable result is fine, but
// neither must leak the git fatal-stderr spam. Proves the ctx threading
// reaches git, not just the function signature.
func TestHandleRawDiff_CancelledContext(t *testing.T) {
	tempDir := t.TempDir()
	runGit := func(args ...string) {
		t.Helper()
		cmd := exec.Command("git", args...)
		cmd.Dir = tempDir
		if err := cmd.Run(); err != nil {
			t.Fatalf("git %v failed: %v", args, err)
		}
	}
	runGit("init")

	req := httptest.NewRequest(http.MethodGet, "/api/git/raw-diff?cwd="+tempDir, nil)
	ctx, cancel := context.WithCancel(req.Context())
	cancel()
	req = req.WithContext(ctx)

	w := httptest.NewRecorder()
	testAPI().HandleRawDiff(w, req)

	// The cancelled ctx reaches IsGitRepo's git rev-parse probe, which
	// gets killed and returns non-zero — IsGitRepo treats that as
	// "not a repo" and the handler emits the NOT_GIT_REPO sentinel.
	// Either a 200 with that sentinel or a 500 with a context-related
	// error is acceptable; the test invariant is "git fatal-stderr
	// never reaches the wire".
	body := w.Body.String()
	if strings.Contains(body, "fatal: not a git repository") ||
		strings.Contains(body, "fatal: ambiguous") {
		t.Errorf("git stderr leaked into response: %s", body)
	}
	switch w.Code {
	case http.StatusOK:
		if body != "NOT_GIT_REPO" {
			t.Errorf("expected body NOT_GIT_REPO when ctx cancels early, got %q", body)
		}
	case http.StatusInternalServerError:
		if !strings.Contains(body, "context canceled") &&
			!strings.Contains(body, "context deadline exceeded") {
			t.Errorf("expected 500 body to mention context, got %q", body)
		}
	default:
		t.Fatalf("expected 200 (NOT_GIT_REPO) or 500 (context error), got %d: %s", w.Code, body)
	}
}

// TestHandleRawDiff_HeadHashCache (L6): /api/git/raw-diff is polled by
// the diff panel, so lookupGitHead memoises the (HEAD, branch) pair
// per cwd. Asserting the second call within the TTL doesn't re-run
// git rev-parse — i.e. that the cached branch value survives a fresh
// commit on disk, and a refetch after the TTL picks up the new hash.
//
// We don't mock the FS / clock here; instead we observe cache
// behaviour by changing the underlying git state between calls and
// verifying the cache returns the stale value first, then refreshes
// after we manually invalidate.
func TestHandleRawDiff_HeadHashCache(t *testing.T) {
	tempDir := t.TempDir()
	runGit := func(args ...string) {
		t.Helper()
		cmd := exec.Command("git", args...)
		cmd.Dir = tempDir
		if err := cmd.Run(); err != nil {
			t.Fatalf("git %v failed: %v", args, err)
		}
	}
	runGit("init")
	runGit("config", "user.name", "Test User")
	runGit("config", "user.email", "test@example.com")
	if err := os.WriteFile(filepath.Join(tempDir, "f.txt"), []byte("hi\n"), 0644); err != nil {
		t.Fatal(err)
	}
	runGit("add", "f.txt")
	runGit("commit", "-m", "init")

	// Make sure no entry is cached from a previous run sharing this cwd.
	// t.TempDir() gives us a unique path, but be explicit anyway.
	gitHeadCache.Delete(tempDir)

	req := httptest.NewRequest(
		http.MethodGet,
		"/api/git/raw-diff?cwd="+tempDir,
		nil,
	)
	w := httptest.NewRecorder()
	testAPI().HandleRawDiff(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", w.Code)
	}
	firstHead := w.Header().Get("X-Phi-Git-Head")
	firstBranch := w.Header().Get("X-Phi-Git-Branch")
	if firstHead == "" || firstBranch == "" {
		t.Fatalf("expected HEAD/Branch headers populated on first call, got %q/%q", firstHead, firstBranch)
	}

	// Create a fresh commit. The cache should still return the OLD
	// head within the TTL window.
	if err := os.WriteFile(filepath.Join(tempDir, "f.txt"), []byte("hi2\n"), 0644); err != nil {
		t.Fatal(err)
	}
	runGit("add", "f.txt")
	runGit("commit", "-m", "second")

	w2 := httptest.NewRecorder()
	testAPI().HandleRawDiff(w2, req)
	if got := w2.Header().Get("X-Phi-Git-Head"); got != firstHead {
		t.Errorf(
			"cached HEAD should be returned within TTL; got %q want %q",
			got,
			firstHead,
		)
	}

	// Invalidate the cache; the next call must surface the new HEAD.
	gitHeadCache.Delete(tempDir)
	w3 := httptest.NewRecorder()
	testAPI().HandleRawDiff(w3, req)
	if got := w3.Header().Get("X-Phi-Git-Head"); got == firstHead || got == "" {
		t.Errorf("after invalidation HEAD should refresh, got %q (was %q)", got, firstHead)
	}
}

