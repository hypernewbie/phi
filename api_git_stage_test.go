package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func gitFixtureStatusFiles(t *testing.T, cwd string) (int, gitStatusFilesResponse, *httptest.ResponseRecorder) {
	t.Helper()
	query := url.Values{"cwd": {cwd}}
	req := httptest.NewRequest(http.MethodGet, "/api/git/status-files?"+query.Encode(), nil)
	w := httptest.NewRecorder()
	handleGitStatusFiles(w, req)
	var response gitStatusFilesResponse
	if w.Code == http.StatusOK {
		if err := json.Unmarshal(w.Body.Bytes(), &response); err != nil {
			t.Fatalf("decode Git status files: %v; body=%s", err, w.Body.String())
		}
	}
	return w.Code, response, w
}

func gitFixtureStage(t *testing.T, cwd, action, indexToken string, target gitActionTarget, paths ...string) *httptest.ResponseRecorder {
	t.Helper()
	return gitFixtureActionRequest(t, gitActionRequest{
		Cwd:        cwd,
		Action:     action,
		Target:     gitCommitTarget(target),
		IndexToken: indexToken,
		Paths:      paths,
	})
}

func gitFixturePlainWorkspace(t *testing.T, fixture *gitActionFixture) string {
	t.Helper()
	plain := filepath.Join(filepath.Dir(fixture.project), "plain")
	if err := os.MkdirAll(plain, 0755); err != nil {
		t.Fatal(err)
	}
	cfg := loadConfig()
	cfg.Workspaces = append(cfg.Workspaces, plain)
	saveConfig(cfg)
	return plain
}

func gitFixtureStatusEntry(files []gitStatusFileEntry, path string) (gitStatusFileEntry, bool) {
	for _, file := range files {
		if file.Path == path {
			return file, true
		}
	}
	return gitStatusFileEntry{}, false
}

func gitFixtureIndexState(t *testing.T, fixture *gitActionFixture, dir string) string {
	t.Helper()
	return string(gitFixtureRun(t, fixture, dir, "status", "--porcelain", "--untracked-files=all"))
}

func TestGitStatusFilesReportsIndexAndWorktreeState(t *testing.T) {
	fixture := newGitActionFixture(t)
	for name, content := range map[string]string{
		"staged.txt":    "staged\n",
		"untracked.txt": "untracked\n",
	} {
		if err := os.WriteFile(filepath.Join(fixture.project, name), []byte(content), 0644); err != nil {
			t.Fatal(err)
		}
	}
	gitFixtureRun(t, fixture, fixture.project, "add", "staged.txt")
	if err := os.WriteFile(filepath.Join(fixture.project, "seed.txt"), []byte("modified\n"), 0644); err != nil {
		t.Fatal(err)
	}

	status, response, recorder := gitFixtureStatusFiles(t, fixture.project)
	if status != http.StatusOK {
		t.Fatalf("status files status=%d body=%s", status, recorder.Body.String())
	}
	if response.NotGitRepo {
		t.Fatal("working repository reported as not a Git repository")
	}
	cases := []struct{ path, index, worktree string }{
		{"seed.txt", " ", "M"},
		{"staged.txt", "A", " "},
		{"untracked.txt", "?", "?"},
	}
	if len(response.Files) != len(cases) {
		t.Fatalf("files = %+v", response.Files)
	}
	for _, want := range cases {
		got, ok := gitFixtureStatusEntry(response.Files, want.path)
		if !ok {
			t.Fatalf("missing %s in %+v", want.path, response.Files)
		}
		if got.Index != want.index || got.Worktree != want.worktree {
			t.Fatalf("%s = %q/%q want %q/%q", want.path, got.Index, got.Worktree, want.index, want.worktree)
		}
	}
}

func TestGitStatusFilesReportsNonRepository(t *testing.T) {
	fixture := newGitActionFixture(t)
	plain := gitFixturePlainWorkspace(t, fixture)
	status, response, recorder := gitFixtureStatusFiles(t, plain)
	if status != http.StatusOK || !response.NotGitRepo || len(response.Files) != 0 {
		t.Fatalf("non-repository status=%d response=%+v body=%s", status, response, recorder.Body.String())
	}
}

func TestGitInfoAdvertisesStagingCapability(t *testing.T) {
	fixture := newGitActionFixture(t)
	status, info, response := gitFixtureInfo(t, fixture.project)
	if status != http.StatusOK || !info.CanStage {
		t.Fatalf("repository info: status=%d info=%+v body=%s", status, info, response.Body.String())
	}
	plain := gitFixturePlainWorkspace(t, fixture)
	status, info, response = gitFixtureInfo(t, plain)
	if status != http.StatusOK || info.CanStage || !info.NotGitRepo {
		t.Fatalf("non-repository info: status=%d info=%+v body=%s", status, info, response.Body.String())
	}
}

func TestGitActionStageEnablesCommitAndKeepsWorkingTree(t *testing.T) {
	fixture := newGitActionFixture(t)
	targetFile := filepath.Join(fixture.project, "notes.md")
	if err := os.WriteFile(targetFile, []byte("staged bytes\n"), 0644); err != nil {
		t.Fatal(err)
	}
	status, info, response := gitFixtureInfo(t, fixture.project)
	if status != http.StatusOK || info.Target == nil || !info.CanStage {
		t.Fatalf("initial info: status=%d info=%+v body=%s", status, info, response.Body.String())
	}
	if info.CanCommit || info.HasStaged {
		t.Fatalf("Commit was available before staging: %+v", info)
	}
	staged := gitFixtureStage(t, fixture.project, "stage", info.IndexToken, *info.Target, "notes.md")
	if staged.Code != http.StatusOK {
		t.Fatalf("stage status=%d body=%s", staged.Code, staged.Body.String())
	}
	var stagedBody map[string]string
	if err := json.Unmarshal(staged.Body.Bytes(), &stagedBody); err != nil {
		t.Fatalf("decode stage response: %v; body=%s", err, staged.Body.String())
	}
	if stagedBody["action"] != "stage" || stagedBody["output"] != "Stage completed." {
		t.Fatalf("unexpected stage response: %+v", stagedBody)
	}

	status, info, response = gitFixtureInfo(t, fixture.project)
	if status != http.StatusOK || !info.HasStaged || !info.CanCommit {
		t.Fatalf("info after stage: status=%d info=%+v body=%s", status, info, response.Body.String())
	}

	// Work continues after staging. The commit must hold the staged bytes only.
	if err := os.WriteFile(targetFile, []byte("edited after staging\n"), 0644); err != nil {
		t.Fatal(err)
	}
	status, info, response = gitFixtureInfo(t, fixture.project)
	if status != http.StatusOK || !info.CanCommit {
		t.Fatalf("info before commit: status=%d info=%+v body=%s", status, info, response.Body.String())
	}
	commit := gitFixtureCommitAction(t, fixture.project, "stage then commit", info.IndexToken, *info.Target)
	if commit.Code != http.StatusOK {
		t.Fatalf("commit status=%d body=%s", commit.Code, commit.Body.String())
	}
	if got := string(gitFixtureRun(t, fixture, fixture.project, "show", "HEAD:notes.md")); got != "staged bytes\n" {
		t.Fatalf("committed bytes = %q", got)
	}
	if got, err := os.ReadFile(targetFile); err != nil || string(got) != "edited after staging\n" {
		t.Fatalf("working bytes = %q err=%v", got, err)
	}
}

func TestGitActionUnstageRestoresIndexWithoutTouchingFiles(t *testing.T) {
	fixture := newGitActionFixture(t)
	for _, name := range []string{"one.txt", "two.txt"} {
		if err := os.WriteFile(filepath.Join(fixture.project, name), []byte(name+"\n"), 0644); err != nil {
			t.Fatal(err)
		}
	}
	status, info, response := gitFixtureInfo(t, fixture.project)
	if status != http.StatusOK || info.Target == nil {
		t.Fatalf("info: status=%d info=%+v body=%s", status, info, response.Body.String())
	}
	if got := gitFixtureStage(t, fixture.project, "stage", info.IndexToken, *info.Target, "one.txt", "two.txt"); got.Code != http.StatusOK {
		t.Fatalf("stage status=%d body=%s", got.Code, got.Body.String())
	}
	status, info, _ = gitFixtureInfo(t, fixture.project)
	if status != http.StatusOK || !info.HasStaged {
		t.Fatalf("info after stage: status=%d info=%+v", status, info)
	}
	if got := gitFixtureStage(t, fixture.project, "unstage", info.IndexToken, *info.Target, "one.txt"); got.Code != http.StatusOK {
		t.Fatalf("unstage status=%d body=%s", got.Code, got.Body.String())
	}
	status, files, _ := gitFixtureStatusFiles(t, fixture.project)
	if status != http.StatusOK {
		t.Fatalf("status files status=%d", status)
	}
	if entry, ok := gitFixtureStatusEntry(files.Files, "one.txt"); !ok || entry.Index != "?" || entry.Worktree != "?" {
		t.Fatalf("unstaged entry = %+v present=%t", entry, ok)
	}
	if entry, ok := gitFixtureStatusEntry(files.Files, "two.txt"); !ok || entry.Index != "A" {
		t.Fatalf("still staged entry = %+v present=%t", entry, ok)
	}
	status, info, _ = gitFixtureInfo(t, fixture.project)
	if status != http.StatusOK || !info.HasStaged {
		t.Fatalf("info after partial unstage: status=%d info=%+v", status, info)
	}
	if got := gitFixtureStage(t, fixture.project, "unstage", info.IndexToken, *info.Target, "two.txt"); got.Code != http.StatusOK {
		t.Fatalf("final unstage status=%d body=%s", got.Code, got.Body.String())
	}
	status, info, _ = gitFixtureInfo(t, fixture.project)
	if status != http.StatusOK || info.HasStaged || info.CanCommit {
		t.Fatalf("info after full unstage: status=%d info=%+v", status, info)
	}
	if !strings.Contains(info.CommitReason, "Stage changes") {
		t.Fatalf("Commit reason = %q", info.CommitReason)
	}
	for _, name := range []string{"one.txt", "two.txt"} {
		if _, err := os.Stat(filepath.Join(fixture.project, name)); err != nil {
			t.Fatalf("%s disappeared: %v", name, err)
		}
	}
}

func TestGitActionStageRejectsUnsafePaths(t *testing.T) {
	cases := map[string]string{
		"parent traversal": "../outside.txt",
		"absolute":         "/etc/passwd",
		"option injection": "-rf",
		"pathspec magic":   ":!seed.txt",
		"nul byte":         "a\x00b",
		"empty":            "",
		"current dir":      ".",
	}
	for name, path := range cases {
		t.Run(name, func(t *testing.T) {
			fixture := newGitActionFixture(t)
			status, info, response := gitFixtureInfo(t, fixture.project)
			if status != http.StatusOK || info.Target == nil {
				t.Fatalf("info: status=%d info=%+v body=%s", status, info, response.Body.String())
			}
			before := gitFixtureIndexState(t, fixture, fixture.project)
			got := gitFixtureStage(t, fixture.project, "stage", info.IndexToken, *info.Target, path)
			if got.Code != http.StatusBadRequest {
				t.Fatalf("unsafe path %q status=%d body=%s", path, got.Code, got.Body.String())
			}
			if after := gitFixtureIndexState(t, fixture, fixture.project); after != before {
				t.Fatalf("rejected stage changed the index: %q -> %q", before, after)
			}
		})
	}
}

func TestGitActionStageRejectsMissingPaths(t *testing.T) {
	fixture := newGitActionFixture(t)
	status, info, response := gitFixtureInfo(t, fixture.project)
	if status != http.StatusOK || info.Target == nil {
		t.Fatalf("info: status=%d info=%+v body=%s", status, info, response.Body.String())
	}
	got := gitFixtureStage(t, fixture.project, "stage", info.IndexToken, *info.Target)
	if got.Code != http.StatusBadRequest {
		t.Fatalf("pathless stage status=%d body=%s", got.Code, got.Body.String())
	}
}

func TestGitActionStageRejectsStaleIndexToken(t *testing.T) {
	fixture := newGitActionFixture(t)
	if err := os.WriteFile(filepath.Join(fixture.project, "first.txt"), []byte("first\n"), 0644); err != nil {
		t.Fatal(err)
	}
	status, info, response := gitFixtureInfo(t, fixture.project)
	if status != http.StatusOK || info.Target == nil {
		t.Fatalf("info: status=%d info=%+v body=%s", status, info, response.Body.String())
	}
	staleToken := info.IndexToken
	if err := os.WriteFile(filepath.Join(fixture.project, "second.txt"), []byte("second\n"), 0644); err != nil {
		t.Fatal(err)
	}
	gitFixtureRun(t, fixture, fixture.project, "add", "second.txt")
	got := gitFixtureStage(t, fixture.project, "stage", staleToken, *info.Target, "first.txt")
	if got.Code != http.StatusConflict || !strings.Contains(got.Body.String(), "index changed") {
		t.Fatalf("stale token status=%d body=%s", got.Code, got.Body.String())
	}
	if entry, ok := gitFixtureStatusEntry(mustStatusFiles(t, fixture.project), "first.txt"); ok && entry.Index != "?" {
		t.Fatalf("first.txt was staged with a stale token: %+v", entry)
	}
}

func mustStatusFiles(t *testing.T, cwd string) []gitStatusFileEntry {
	t.Helper()
	status, response, recorder := gitFixtureStatusFiles(t, cwd)
	if status != http.StatusOK {
		t.Fatalf("status files status=%d body=%s", status, recorder.Body.String())
	}
	return response.Files
}

func TestGitActionStageDeletedFile(t *testing.T) {
	fixture := newGitActionFixture(t)
	removed := filepath.Join(fixture.project, "seed.txt")
	if err := os.Remove(removed); err != nil {
		t.Fatal(err)
	}
	status, info, response := gitFixtureInfo(t, fixture.project)
	if status != http.StatusOK || info.Target == nil {
		t.Fatalf("info: status=%d info=%+v body=%s", status, info, response.Body.String())
	}
	if got := gitFixtureStage(t, fixture.project, "stage", info.IndexToken, *info.Target, "seed.txt"); got.Code != http.StatusOK {
		t.Fatalf("stage deletion status=%d body=%s", got.Code, got.Body.String())
	}
	if entry, ok := gitFixtureStatusEntry(mustStatusFiles(t, fixture.project), "seed.txt"); !ok || entry.Index != "D" {
		t.Fatalf("deleted entry = %+v present=%t", entry, ok)
	}
	status, info, _ = gitFixtureInfo(t, fixture.project)
	if status != http.StatusOK || !info.CanCommit {
		t.Fatalf("info after staging deletion: status=%d info=%+v", status, info)
	}
	if got := gitFixtureCommitAction(t, fixture.project, "delete seed", info.IndexToken, *info.Target); got.Code != http.StatusOK {
		t.Fatalf("commit status=%d body=%s", got.Code, got.Body.String())
	}
	if _, err := gitFixtureTry(fixture, fixture.project, "cat-file", "-e", "HEAD:seed.txt"); err == nil {
		t.Fatal("seed.txt still present in HEAD after committing its deletion")
	}
}

func TestGitActionStageAndUnstageOnUnbornBranch(t *testing.T) {
	fixture := newGitActionFixture(t)
	unborn := filepath.Join(filepath.Dir(fixture.project), "unborn-stage")
	if err := os.MkdirAll(unborn, 0755); err != nil {
		t.Fatal(err)
	}
	gitFixtureRun(t, fixture, unborn, "init", "--initial-branch=main")
	gitFixtureRun(t, fixture, unborn, "config", "user.name", "Phi test")
	gitFixtureRun(t, fixture, unborn, "config", "user.email", "phi-test@example.invalid")
	cfg := loadConfig()
	cfg.Workspaces = append(cfg.Workspaces, unborn)
	saveConfig(cfg)
	if err := os.WriteFile(filepath.Join(unborn, "first.txt"), []byte("first\n"), 0644); err != nil {
		t.Fatal(err)
	}
	status, info, response := gitFixtureInfo(t, unborn)
	if status != http.StatusOK || info.Target == nil || !info.CanStage || info.HasStaged {
		t.Fatalf("unborn info: status=%d info=%+v body=%s", status, info, response.Body.String())
	}
	if got := gitFixtureStage(t, unborn, "stage", info.IndexToken, *info.Target, "first.txt"); got.Code != http.StatusOK {
		t.Fatalf("unborn stage status=%d body=%s", got.Code, got.Body.String())
	}
	status, info, _ = gitFixtureInfo(t, unborn)
	if status != http.StatusOK || !info.HasStaged {
		t.Fatalf("unborn info after stage: status=%d info=%+v", status, info)
	}
	if got := gitFixtureStage(t, unborn, "unstage", info.IndexToken, *info.Target, "first.txt"); got.Code != http.StatusOK {
		t.Fatalf("unborn unstage status=%d body=%s", got.Code, got.Body.String())
	}
	status, info, _ = gitFixtureInfo(t, unborn)
	if status != http.StatusOK || info.HasStaged {
		t.Fatalf("unborn info after unstage: status=%d info=%+v", status, info)
	}
	if _, err := gitFixtureTry(fixture, unborn, "rev-parse", "--verify", "--quiet", "HEAD"); err == nil {
		t.Fatal("unstaging on an unborn branch created a commit")
	}
	if _, err := os.Stat(filepath.Join(unborn, "first.txt")); err != nil {
		t.Fatalf("working file disappeared: %v", err)
	}
}
