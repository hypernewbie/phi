package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

type gitActionFixture struct {
	home    string
	global  string
	seed    string
	remote  string
	project string
	peer    string
}

func newGitActionFixture(t *testing.T) *gitActionFixture {
	t.Helper()
	withTempConfig(t)
	base := t.TempDir()
	fixture := &gitActionFixture{
		home:    filepath.Join(base, "home"),
		global:  filepath.Join(base, "global.gitconfig"),
		seed:    filepath.Join(base, "seed"),
		remote:  filepath.Join(base, "remote.git"),
		project: filepath.Join(base, "project"),
		peer:    filepath.Join(base, "peer"),
	}
	for _, dir := range []string{fixture.home, fixture.seed, fixture.remote} {
		if err := os.MkdirAll(dir, 0755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(fixture.global, nil, 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("HOME", fixture.home)
	t.Setenv("USERPROFILE", fixture.home)
	t.Setenv("GIT_CONFIG_GLOBAL", fixture.global)
	t.Setenv("GIT_CONFIG_NOSYSTEM", "1")
	oldCWD, oldPTY := activeCWD, ptyManager
	activeCWD, ptyManager = fixture.project, nil
	t.Cleanup(func() {
		activeCWD, ptyManager = oldCWD, oldPTY
	})

	gitFixtureRun(t, fixture, fixture.seed, "init", "--initial-branch=main")
	gitFixtureRun(t, fixture, fixture.seed, "config", "user.name", "Phi test")
	gitFixtureRun(t, fixture, fixture.seed, "config", "user.email", "phi-test@example.invalid")
	gitFixtureRun(t, fixture, fixture.seed, "config", "commit.gpgsign", "false")
	if err := os.WriteFile(filepath.Join(fixture.seed, "seed.txt"), []byte("seed\n"), 0644); err != nil {
		t.Fatal(err)
	}
	gitFixtureRun(t, fixture, fixture.seed, "add", "seed.txt")
	gitFixtureRun(t, fixture, fixture.seed, "commit", "-m", "seed")
	gitFixtureRun(t, fixture, fixture.remote, "init", "--bare", "--initial-branch=main")
	gitFixtureRun(t, fixture, fixture.seed, "remote", "add", "origin", fixture.remote)
	gitFixtureRun(t, fixture, fixture.seed, "push", "--set-upstream", "origin", "main")
	gitFixtureRun(t, fixture, base, "clone", fixture.remote, fixture.project)
	gitFixtureRun(t, fixture, base, "clone", fixture.remote, fixture.peer)
	for _, dir := range []string{fixture.project, fixture.peer} {
		gitFixtureRun(t, fixture, dir, "config", "user.name", "Phi test")
		gitFixtureRun(t, fixture, dir, "config", "user.email", "phi-test@example.invalid")
		gitFixtureRun(t, fixture, dir, "config", "commit.gpgsign", "false")
	}
	cfg := loadConfig()
	cfg.Workspaces = []string{fixture.project}
	saveConfig(cfg)
	return fixture
}

func gitFixtureTry(fixture *gitActionFixture, dir string, args ...string) ([]byte, error) {
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	cmd.Env = []string{
		"PATH=" + os.Getenv("PATH"),
		"HOME=" + fixture.home,
		"USERPROFILE=" + fixture.home,
		"GIT_CONFIG_GLOBAL=" + fixture.global,
		"GIT_CONFIG_NOSYSTEM=1",
		"GIT_TERMINAL_PROMPT=0",
	}
	return cmd.CombinedOutput()
}

func gitFixtureRun(t *testing.T, fixture *gitActionFixture, dir string, args ...string) []byte {
	t.Helper()
	out, err := gitFixtureTry(fixture, dir, args...)
	if err != nil {
		t.Fatalf("git %s in %s: %v\n%s", strings.Join(args, " "), dir, err, out)
	}
	return out
}

func gitFixtureInfo(t *testing.T, cwd string) (int, gitInfoResponse, *httptest.ResponseRecorder) {
	t.Helper()
	query := url.Values{"cwd": {cwd}}
	req := httptest.NewRequest(http.MethodGet, "/api/git/info?"+query.Encode(), nil)
	w := httptest.NewRecorder()
	handleGitInfo(w, req)
	var response gitInfoResponse
	if w.Code == http.StatusOK {
		if err := json.Unmarshal(w.Body.Bytes(), &response); err != nil {
			t.Fatalf("decode Git info: %v; body=%s", err, w.Body.String())
		}
	}
	return w.Code, response, w
}

func gitFixtureActionRequest(t *testing.T, actionRequest gitActionRequest) *httptest.ResponseRecorder {
	t.Helper()
	body, err := json.Marshal(actionRequest)
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, "/api/git/action", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	handleGitAction(w, req)
	return w
}

func gitFixtureAction(t *testing.T, cwd, action string, target gitActionTarget) *httptest.ResponseRecorder {
	t.Helper()
	return gitFixtureActionRequest(t, gitActionRequest{Cwd: cwd, Action: action, Target: target})
}

func gitFixtureCommitAction(t *testing.T, cwd, message, indexToken string, target gitActionTarget) *httptest.ResponseRecorder {
	t.Helper()
	return gitFixtureActionRequest(t, gitActionRequest{
		Cwd:        cwd,
		Action:     "commit",
		Target:     gitCommitTarget(target),
		Message:    message,
		IndexToken: indexToken,
	})
}

func TestGitActionPullPushHappyPath(t *testing.T) {
	fixture := newGitActionFixture(t)
	stagedBytes := []byte("staged bytes\n")
	unstagedBytes := []byte("unstaged bytes\n")
	untrackedBytes := []byte("untracked bytes\n")
	if err := os.WriteFile(filepath.Join(fixture.project, "staged.txt"), stagedBytes, 0644); err != nil {
		t.Fatal(err)
	}
	gitFixtureRun(t, fixture, fixture.project, "add", "staged.txt")
	if err := os.WriteFile(filepath.Join(fixture.project, "unstaged.txt"), unstagedBytes, 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(fixture.project, "untracked.txt"), untrackedBytes, 0644); err != nil {
		t.Fatal(err)
	}
	stagedIndexBefore := gitFixtureRun(t, fixture, fixture.project, "ls-files", "--stage", "-z", "--", "staged.txt")
	stagedDeltaBefore := gitFixtureRun(t, fixture, fixture.project, "diff", "--cached", "--binary", "--")

	if err := os.WriteFile(filepath.Join(fixture.peer, "peer.txt"), []byte("peer commit\n"), 0644); err != nil {
		t.Fatal(err)
	}
	gitFixtureRun(t, fixture, fixture.peer, "add", "peer.txt")
	gitFixtureRun(t, fixture, fixture.peer, "commit", "-m", "peer change")
	peerHead := strings.TrimSpace(string(gitFixtureRun(t, fixture, fixture.peer, "rev-parse", "HEAD")))
	gitFixtureRun(t, fixture, fixture.peer, "push")

	status, info, infoResponse := gitFixtureInfo(t, fixture.project)
	if status != http.StatusOK || info.NotGitRepo || info.Target == nil || !info.CanPullPush {
		t.Fatalf("Git info: status=%d response=%+v body=%s", status, info, infoResponse.Body.String())
	}
	if got := infoResponse.Header().Get("Cache-Control"); got != "no-store" {
		t.Fatalf("Git info Cache-Control = %q", got)
	}
	pull := gitFixtureAction(t, fixture.project, "pull", *info.Target)
	if pull.Code != http.StatusOK {
		t.Fatalf("Pull status=%d body=%s", pull.Code, pull.Body.String())
	}
	var pullResult map[string]string
	if err := json.Unmarshal(pull.Body.Bytes(), &pullResult); err != nil {
		t.Fatalf("decode Pull response: %v", err)
	}
	canonicalProject, err := filepath.EvalSymlinks(fixture.project)
	if err != nil {
		t.Fatal(err)
	}
	if pullResult["action"] != "pull" || pullResult["root"] != canonicalProject || pullResult["output"] != "Pull completed." {
		t.Fatalf("unexpected Pull response: %+v", pullResult)
	}
	localHead := strings.TrimSpace(string(gitFixtureRun(t, fixture, fixture.project, "rev-parse", "HEAD")))
	bareHead := strings.TrimSpace(string(gitFixtureRun(t, fixture, fixture.remote, "rev-parse", "refs/heads/main")))
	if localHead != peerHead || bareHead != peerHead {
		t.Fatalf("Pull refs: local=%s peer=%s bare=%s", localHead, peerHead, bareHead)
	}
	stagedIndexAfter := gitFixtureRun(t, fixture, fixture.project, "ls-files", "--stage", "-z", "--", "staged.txt")
	stagedDeltaAfter := gitFixtureRun(t, fixture, fixture.project, "diff", "--cached", "--binary", "--")
	if !bytes.Equal(stagedIndexBefore, stagedIndexAfter) || !bytes.Equal(stagedDeltaBefore, stagedDeltaAfter) {
		t.Fatalf("Pull changed staged index data: entry %q -> %q, delta %q -> %q", stagedIndexBefore, stagedIndexAfter, stagedDeltaBefore, stagedDeltaAfter)
	}
	for name, want := range map[string][]byte{
		"unstaged.txt":  unstagedBytes,
		"untracked.txt": untrackedBytes,
		"peer.txt":      []byte("peer commit\n"),
	} {
		got, err := os.ReadFile(filepath.Join(fixture.project, name))
		if err != nil || !bytes.Equal(got, want) {
			t.Fatalf("Pull file %s: got=%q err=%v want=%q", name, got, err, want)
		}
	}
	stagedAfter, err := os.ReadFile(filepath.Join(fixture.project, "staged.txt"))
	if err != nil || !bytes.Equal(stagedAfter, stagedBytes) {
		t.Fatalf("Pull changed staged bytes: got=%q err=%v", stagedAfter, err)
	}

	if err := os.WriteFile(filepath.Join(fixture.project, "push.txt"), []byte("local push\n"), 0644); err != nil {
		t.Fatal(err)
	}
	gitFixtureRun(t, fixture, fixture.project, "add", "push.txt")
	gitFixtureRun(t, fixture, fixture.project, "commit", "-m", "local push")
	gitFixtureRun(t, fixture, fixture.project, "branch", "private/extra")
	gitFixtureRun(t, fixture, fixture.project, "tag", "v1")
	status, info, infoResponse = gitFixtureInfo(t, fixture.project)
	if status != http.StatusOK || info.Target == nil || !info.CanPullPush {
		t.Fatalf("pre-Push Git info: status=%d response=%+v body=%s", status, info, infoResponse.Body.String())
	}
	push := gitFixtureAction(t, fixture.project, "push", *info.Target)
	if push.Code != http.StatusOK {
		t.Fatalf("Push status=%d body=%s", push.Code, push.Body.String())
	}
	localHead = strings.TrimSpace(string(gitFixtureRun(t, fixture, fixture.project, "rev-parse", "HEAD")))
	bareHead = strings.TrimSpace(string(gitFixtureRun(t, fixture, fixture.remote, "rev-parse", "refs/heads/main")))
	if localHead != bareHead {
		t.Fatalf("Push refs differ: local=%s bare=%s", localHead, bareHead)
	}
	refs := string(gitFixtureRun(t, fixture, fixture.remote, "for-each-ref", "--format=%(refname)"))
	if strings.TrimSpace(refs) != "refs/heads/main" {
		t.Fatalf("Push widened refs: %q", refs)
	}
}

func TestGitActionPushIgnoresWideningConfiguration(t *testing.T) {
	fixture := newGitActionFixture(t)
	gitFixtureRun(t, fixture, fixture.project, "commit", "--allow-empty", "-m", "local commit")
	gitFixtureRun(t, fixture, fixture.project, "tag", "-a", "private-tag", "-m", "private tag")
	gitFixtureRun(t, fixture, fixture.project, "branch", "private-branch")
	gitFixtureRun(t, fixture, fixture.project, "config", "remote.origin.mirror", "true")
	gitFixtureRun(t, fixture, fixture.project, "config", "remote.origin.push", "+HEAD:refs/heads/private-destination")
	gitFixtureRun(t, fixture, fixture.project, "config", "push.followTags", "true")
	_, info, response := gitFixtureInfo(t, fixture.project)
	if info.Target == nil || !info.CanPullPush {
		t.Fatalf("Push unavailable: %s", response.Body.String())
	}
	result := gitFixtureAction(t, fixture.project, "push", *info.Target)
	if result.Code != http.StatusOK {
		t.Fatalf("Push status=%d body=%s", result.Code, result.Body.String())
	}
	if refs := strings.TrimSpace(string(gitFixtureRun(t, fixture, fixture.remote, "for-each-ref", "--format=%(refname)"))); refs != "refs/heads/main" {
		t.Fatalf("Push widened refs: %q", refs)
	}
	localHead := gitFixtureRun(t, fixture, fixture.project, "rev-parse", "HEAD")
	remoteHead := gitFixtureRun(t, fixture, fixture.remote, "rev-parse", "refs/heads/main")
	if !bytes.Equal(localHead, remoteHead) {
		t.Fatalf("Push did not update main: local=%s remote=%s", localHead, remoteHead)
	}
}

func TestGitReadersDoNotRefreshIndex(t *testing.T) {
	fixture := newGitActionFixture(t)
	oldTime := time.Date(2000, time.January, 1, 0, 0, 0, 0, time.UTC)
	file := filepath.Join(fixture.project, "seed.txt")
	if err := os.Chtimes(file, oldTime, oldTime); err != nil {
		t.Fatal(err)
	}
	index := filepath.Join(fixture.project, ".git", "index")
	before, err := os.ReadFile(index)
	if err != nil {
		t.Fatal(err)
	}
	for _, reader := range []struct {
		name    string
		commit  string
		handler http.HandlerFunc
	}{
		{"raw-diff", "", handleRawDiff},
		{"raw-diff-unstaged", "unstaged", handleRawDiff},
		{"raw-diff-staged", "staged", handleRawDiff},
		{"raw-status", "", handleRawStatus},
		{"info", "", handleGitInfo},
	} {
		t.Run(reader.name, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodGet, "/api/git/"+reader.name+"?"+url.Values{"cwd": {fixture.project}, "commit": {reader.commit}}.Encode(), nil)
			response := httptest.NewRecorder()
			reader.handler(response, request)
			if response.Code != http.StatusOK {
				t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
			}
			after, err := os.ReadFile(index)
			if err != nil {
				t.Fatal(err)
			}
			if !bytes.Equal(before, after) {
				t.Error("read-only request refreshed the Git index")
			}
			// Restore the original index so every reader is checked independently.
			t.Cleanup(func() {
				if err := os.WriteFile(index, before, 0644); err != nil {
					t.Fatal(err)
				}
			})
		})
	}
}

func TestGitInfoWorkspaceAuthorization(t *testing.T) {
	fixture := newGitActionFixture(t)
	docs := filepath.Join(filepath.Dir(fixture.project), "docs")
	if err := os.MkdirAll(docs, 0755); err != nil {
		t.Fatal(err)
	}
	cfg := loadConfig()
	cfg.Workspaces = append(cfg.Workspaces, docs)
	saveConfig(cfg)
	status, info, _ := gitFixtureInfo(t, docs)
	if status != http.StatusOK || !info.NotGitRepo {
		t.Fatalf("non-repository response: status=%d info=%+v", status, info)
	}

	bare := filepath.Join(fixture.project, "bare.git")
	if err := os.MkdirAll(bare, 0755); err != nil {
		t.Fatal(err)
	}
	gitFixtureRun(t, fixture, bare, "init", "--bare", "--initial-branch=main")
	status, _, response := gitFixtureInfo(t, bare)
	if status != http.StatusForbidden || !strings.Contains(response.Body.String(), "working tree") {
		t.Fatalf("bare repository response: status=%d body=%s", status, response.Body.String())
	}

	base := filepath.Dir(fixture.project)
	outsider := filepath.Join(base, "outsider")
	lookalike := fixture.project + "-lookalike"
	for _, path := range []string{outsider, lookalike} {
		if err := os.MkdirAll(path, 0755); err != nil {
			t.Fatal(err)
		}
		gitFixtureRun(t, fixture, path, "init", "--initial-branch=main")
	}
	for _, path := range []string{outsider, lookalike} {
		status, _, response = gitFixtureInfo(t, path)
		if status != http.StatusForbidden {
			t.Fatalf("unauthorized path %s: status=%d body=%s", path, status, response.Body.String())
		}
	}
	if err := os.Symlink(outsider, filepath.Join(fixture.project, "escape")); err != nil {
		t.Fatal(err)
	}
	status, _, response = gitFixtureInfo(t, filepath.Join(fixture.project, "escape"))
	if status != http.StatusForbidden {
		t.Fatalf("symlink escape: status=%d body=%s", status, response.Body.String())
	}

	sibling := filepath.Join(base, "sibling-worktree")
	gitFixtureRun(t, fixture, fixture.project, "worktree", "add", "-b", "sibling", sibling)
	status, info, response = gitFixtureInfo(t, sibling)
	canonicalSibling, err := filepath.EvalSymlinks(sibling)
	if err != nil {
		t.Fatal(err)
	}
	if status != http.StatusOK || info.Target == nil || info.Target.Root != canonicalSibling {
		t.Fatalf("registered worktree response: status=%d info=%+v body=%s", status, info, response.Body.String())
	}
}

func TestGitInfoRejectsMultipleEffectiveDestinations(t *testing.T) {
	fixture := newGitActionFixture(t)
	second := filepath.Join(filepath.Dir(fixture.project), "second.git")
	third := filepath.Join(filepath.Dir(fixture.project), "third.git")
	for _, remote := range []string{second, third} {
		if err := os.MkdirAll(remote, 0755); err != nil {
			t.Fatal(err)
		}
		gitFixtureRun(t, fixture, remote, "init", "--bare", "--initial-branch=main")
	}
	gitFixtureRun(t, fixture, fixture.project, "remote", "set-url", "--add", "--push", "origin", second)
	gitFixtureRun(t, fixture, fixture.project, "remote", "set-url", "--add", "--push", "origin", third)
	fetchURLs := gitFixtureRun(t, fixture, fixture.project, "remote", "get-url", "--all", "origin")
	pushURLs := gitFixtureRun(t, fixture, fixture.project, "remote", "get-url", "--push", "--all", "origin")

	status, info, response := gitFixtureInfo(t, fixture.project)
	if status != http.StatusOK || info.Target == nil || info.CanPullPush || !strings.Contains(info.Reason, "multiple") {
		t.Fatalf("multiple destination response: status=%d info=%+v fetch=%q push=%q body=%s", status, info, fetchURLs, pushURLs, response.Body.String())
	}
	if bytes.Contains(response.Body.Bytes(), []byte(fixture.remote)) || bytes.Contains(response.Body.Bytes(), []byte(second)) || bytes.Contains(response.Body.Bytes(), []byte(third)) {
		t.Fatalf("Git info exposed a remote URL: %s", response.Body.String())
	}
	action := gitFixtureAction(t, fixture.project, "push", *info.Target)
	if action.Code != http.StatusBadRequest {
		t.Fatalf("incomplete multi-destination target status=%d body=%s", action.Code, action.Body.String())
	}
	for _, remote := range []string{second, third} {
		if _, err := gitFixtureTry(fixture, remote, "show-ref", "--verify", "--quiet", "refs/heads/main"); err == nil {
			t.Fatalf("multi-destination action wrote to %s", remote)
		}
	}
}

func TestGitActionRejectsStaleTargets(t *testing.T) {
	t.Run("head changed", func(t *testing.T) {
		fixture := newGitActionFixture(t)
		status, info, response := gitFixtureInfo(t, fixture.project)
		if status != http.StatusOK || info.Target == nil || !info.CanPullPush {
			t.Fatalf("Git info: status=%d info=%+v body=%s", status, info, response.Body.String())
		}
		if err := os.WriteFile(filepath.Join(fixture.project, "later.txt"), []byte("later\n"), 0644); err != nil {
			t.Fatal(err)
		}
		gitFixtureRun(t, fixture, fixture.project, "add", "later.txt")
		gitFixtureRun(t, fixture, fixture.project, "commit", "-m", "later")
		before := strings.TrimSpace(string(gitFixtureRun(t, fixture, fixture.remote, "rev-parse", "refs/heads/main")))
		action := gitFixtureAction(t, fixture.project, "push", *info.Target)
		if action.Code != http.StatusConflict {
			t.Fatalf("stale HEAD status=%d body=%s", action.Code, action.Body.String())
		}
		after := strings.TrimSpace(string(gitFixtureRun(t, fixture, fixture.remote, "rev-parse", "refs/heads/main")))
		if before != after {
			t.Fatalf("stale target changed remote HEAD: %s -> %s", before, after)
		}
	})

	t.Run("upstream URL changed", func(t *testing.T) {
		fixture := newGitActionFixture(t)
		status, info, response := gitFixtureInfo(t, fixture.project)
		if status != http.StatusOK || info.Target == nil || !info.CanPullPush {
			t.Fatalf("Git info: status=%d info=%+v body=%s", status, info, response.Body.String())
		}
		second := filepath.Join(filepath.Dir(fixture.project), "second.git")
		if err := os.MkdirAll(second, 0755); err != nil {
			t.Fatal(err)
		}
		gitFixtureRun(t, fixture, second, "init", "--bare", "--initial-branch=main")
		gitFixtureRun(t, fixture, fixture.project, "remote", "set-url", "origin", second)
		action := gitFixtureAction(t, fixture.project, "push", *info.Target)
		if action.Code != http.StatusConflict {
			t.Fatalf("stale upstream status=%d body=%s", action.Code, action.Body.String())
		}
		if _, err := gitFixtureTry(fixture, second, "show-ref", "--verify", "--quiet", "refs/heads/main"); err == nil {
			t.Fatal("stale upstream action wrote to the replacement remote")
		}
	})
}

func TestGitActionNonFastForwardFailsWithoutForce(t *testing.T) {
	fixture := newGitActionFixture(t)
	if err := os.WriteFile(filepath.Join(fixture.project, "local.txt"), []byte("local\n"), 0644); err != nil {
		t.Fatal(err)
	}
	gitFixtureRun(t, fixture, fixture.project, "add", "local.txt")
	gitFixtureRun(t, fixture, fixture.project, "commit", "-m", "local commit")
	if err := os.WriteFile(filepath.Join(fixture.peer, "remote.txt"), []byte("remote\n"), 0644); err != nil {
		t.Fatal(err)
	}
	gitFixtureRun(t, fixture, fixture.peer, "add", "remote.txt")
	gitFixtureRun(t, fixture, fixture.peer, "commit", "-m", "remote commit")
	peerHead := strings.TrimSpace(string(gitFixtureRun(t, fixture, fixture.peer, "rev-parse", "HEAD")))
	gitFixtureRun(t, fixture, fixture.peer, "push")
	localHead := strings.TrimSpace(string(gitFixtureRun(t, fixture, fixture.project, "rev-parse", "HEAD")))
	status, info, response := gitFixtureInfo(t, fixture.project)
	if status != http.StatusOK || info.Target == nil || !info.CanPullPush {
		t.Fatalf("Git info: status=%d info=%+v body=%s", status, info, response.Body.String())
	}
	action := gitFixtureAction(t, fixture.project, "push", *info.Target)
	if action.Code != http.StatusInternalServerError || !strings.Contains(action.Body.String(), "Partial effects are possible") {
		t.Fatalf("non-fast-forward response: status=%d body=%s", action.Code, action.Body.String())
	}
	if bytes.Contains(action.Body.Bytes(), []byte(fixture.remote)) || bytes.Contains(action.Body.Bytes(), []byte("remote rejected")) {
		t.Fatalf("Push response exposed raw Git output: %s", action.Body.String())
	}
	remoteHead := strings.TrimSpace(string(gitFixtureRun(t, fixture, fixture.remote, "rev-parse", "refs/heads/main")))
	gotLocalHead := strings.TrimSpace(string(gitFixtureRun(t, fixture, fixture.project, "rev-parse", "HEAD")))
	if remoteHead != peerHead || gotLocalHead != localHead {
		t.Fatalf("non-fast-forward changed refs: remote=%s want=%s local=%s want=%s", remoteHead, peerHead, gotLocalHead, localHead)
	}
}

func TestGitActionPullDoesNotPruneOtherBranches(t *testing.T) {
	fixture := newGitActionFixture(t)
	gitFixtureRun(t, fixture, fixture.peer, "checkout", "-b", "side")
	if err := os.WriteFile(filepath.Join(fixture.peer, "side.txt"), []byte("side\n"), 0644); err != nil {
		t.Fatal(err)
	}
	gitFixtureRun(t, fixture, fixture.peer, "add", "side.txt")
	gitFixtureRun(t, fixture, fixture.peer, "commit", "-m", "side branch")
	gitFixtureRun(t, fixture, fixture.peer, "push", "--set-upstream", "origin", "side")
	gitFixtureRun(t, fixture, fixture.peer, "checkout", "main")
	gitFixtureRun(t, fixture, fixture.project, "fetch", "origin")
	gitFixtureRun(t, fixture, fixture.project, "rev-parse", "--verify", "refs/remotes/origin/side")
	gitFixtureRun(t, fixture, fixture.peer, "push", "origin", "--delete", "side")

	status, info, response := gitFixtureInfo(t, fixture.project)
	if status != http.StatusOK || info.Target == nil || !info.CanPullPush {
		t.Fatalf("Git info: status=%d info=%+v body=%s", status, info, response.Body.String())
	}
	action := gitFixtureAction(t, fixture.project, "pull", *info.Target)
	if action.Code != http.StatusOK {
		t.Fatalf("Pull status=%d body=%s", action.Code, action.Body.String())
	}
	gitFixtureRun(t, fixture, fixture.project, "rev-parse", "--verify", "refs/remotes/origin/side")
	if _, err := gitFixtureTry(fixture, fixture.remote, "show-ref", "--verify", "--quiet", "refs/heads/side"); err == nil {
		t.Fatal("deleted remote branch still exists")
	}
}

func TestGitActionRejectsUnmergedIndexAndConcurrentAction(t *testing.T) {
	t.Run("unmerged index", func(t *testing.T) {
		fixture := newGitActionFixture(t)
		if err := os.WriteFile(filepath.Join(fixture.project, "seed.txt"), []byte("local change\n"), 0644); err != nil {
			t.Fatal(err)
		}
		gitFixtureRun(t, fixture, fixture.project, "add", "seed.txt")
		gitFixtureRun(t, fixture, fixture.project, "commit", "-m", "local conflict side")
		if err := os.WriteFile(filepath.Join(fixture.peer, "seed.txt"), []byte("remote change\n"), 0644); err != nil {
			t.Fatal(err)
		}
		gitFixtureRun(t, fixture, fixture.peer, "add", "seed.txt")
		gitFixtureRun(t, fixture, fixture.peer, "commit", "-m", "remote conflict side")
		gitFixtureRun(t, fixture, fixture.peer, "push")
		gitFixtureRun(t, fixture, fixture.project, "fetch", "origin")
		if _, err := gitFixtureTry(fixture, fixture.project, "merge", "origin/main"); err == nil {
			t.Fatal("expected conflict merge to fail")
		}
		head := strings.TrimSpace(string(gitFixtureRun(t, fixture, fixture.project, "rev-parse", "HEAD")))
		status, info, response := gitFixtureInfo(t, fixture.project)
		if status != http.StatusOK || info.Target == nil || info.CanPullPush {
			t.Fatalf("unmerged Git info: status=%d info=%+v body=%s", status, info, response.Body.String())
		}
		action := gitFixtureAction(t, fixture.project, "pull", *info.Target)
		if action.Code != http.StatusConflict {
			t.Fatalf("unmerged Pull status=%d body=%s", action.Code, action.Body.String())
		}
		gotHead := strings.TrimSpace(string(gitFixtureRun(t, fixture, fixture.project, "rev-parse", "HEAD")))
		if gotHead != head {
			t.Fatalf("rejected Pull changed HEAD: %s -> %s", head, gotHead)
		}
	})

	t.Run("in-process lock", func(t *testing.T) {
		fixture := newGitActionFixture(t)
		status, info, response := gitFixtureInfo(t, fixture.project)
		if status != http.StatusOK || info.Target == nil || !info.CanPullPush {
			t.Fatalf("Git info: status=%d info=%+v body=%s", status, info, response.Body.String())
		}
		repo, notRepo, err := inspectGitRepository(context.Background(), fixture.project)
		if err != nil || notRepo || repo == nil {
			t.Fatalf("inspect test repository: repo=%+v notRepo=%t err=%v", repo, notRepo, err)
		}
		lock := gitActionLock(repo.commonDir)
		lock.Lock()
		defer lock.Unlock()
		action := gitFixtureAction(t, fixture.project, "push", *info.Target)
		if action.Code != http.StatusConflict || !strings.Contains(action.Body.String(), "already in progress") {
			t.Fatalf("concurrent action status=%d body=%s", action.Code, action.Body.String())
		}
	})
}

func TestGitInfoSupportsNewlinePaths(t *testing.T) {
	fixture := newGitActionFixture(t)
	repo := filepath.Join(fixture.project, "line\nbreak")
	if err := os.MkdirAll(repo, 0755); err != nil {
		t.Fatal(err)
	}
	gitFixtureRun(t, fixture, repo, "init", "--initial-branch=main")
	gitFixtureRun(t, fixture, repo, "config", "user.name", "Phi test")
	gitFixtureRun(t, fixture, repo, "config", "user.email", "phi-test@example.invalid")
	if err := os.WriteFile(filepath.Join(repo, "file.txt"), []byte("newline path\n"), 0644); err != nil {
		t.Fatal(err)
	}
	gitFixtureRun(t, fixture, repo, "add", "file.txt")
	gitFixtureRun(t, fixture, repo, "commit", "-m", "newline path")
	canonical, err := filepath.EvalSymlinks(repo)
	if err != nil {
		t.Fatal(err)
	}
	status, info, response := gitFixtureInfo(t, repo)
	if status != http.StatusOK || info.Target == nil || info.Target.Root != canonical {
		t.Fatalf("newline path response: status=%d info=%+v body=%s", status, info, response.Body.String())
	}
}

func TestGitInfoCommitState(t *testing.T) {
	fixture := newGitActionFixture(t)
	status, info, response := gitFixtureInfo(t, fixture.project)
	if status != http.StatusOK || info.Target == nil {
		t.Fatalf("Git info: status=%d info=%+v body=%s", status, info, response.Body.String())
	}
	if info.HasStaged || info.CanCommit || len(info.IndexToken) != sha256.Size*2 {
		t.Fatalf("clean nonempty index state: %+v", info)
	}

	staged := filepath.Join(fixture.project, "staged.txt")
	if err := os.WriteFile(staged, []byte("staged\n"), 0644); err != nil {
		t.Fatal(err)
	}
	gitFixtureRun(t, fixture, fixture.project, "add", "staged.txt")
	status, info, response = gitFixtureInfo(t, fixture.project)
	if status != http.StatusOK || !info.HasStaged || !info.CanCommit || info.CommitReason != "" {
		t.Fatalf("staged state: status=%d info=%+v body=%s", status, info, response.Body.String())
	}

	gitFixtureRun(t, fixture, fixture.project, "checkout", "--detach", "HEAD")
	status, info, response = gitFixtureInfo(t, fixture.project)
	if status != http.StatusOK || info.Target == nil || info.Target.Branch != "" || info.CanCommit || !strings.Contains(info.CommitReason, "branch") {
		t.Fatalf("detached commit state: status=%d info=%+v body=%s", status, info, response.Body.String())
	}
}

func TestGitActionCommitUsesStagedIndex(t *testing.T) {
	fixture := newGitActionFixture(t)
	beforeHead := strings.TrimSpace(string(gitFixtureRun(t, fixture, fixture.project, "rev-parse", "HEAD")))
	beforeRemote := strings.TrimSpace(string(gitFixtureRun(t, fixture, fixture.remote, "rev-parse", "refs/heads/main")))
	file := filepath.Join(fixture.project, "versioned.txt")
	if err := os.WriteFile(file, []byte("version A\n"), 0644); err != nil {
		t.Fatal(err)
	}
	gitFixtureRun(t, fixture, fixture.project, "add", "versioned.txt")
	if err := os.WriteFile(file, []byte("version B\n"), 0644); err != nil {
		t.Fatal(err)
	}
	untracked := filepath.Join(fixture.project, "untracked.txt")
	if err := os.WriteFile(untracked, []byte("untracked bytes\n"), 0644); err != nil {
		t.Fatal(err)
	}

	status, info, response := gitFixtureInfo(t, fixture.project)
	if status != http.StatusOK || info.Target == nil || !info.CanCommit || !info.HasStaged {
		t.Fatalf("Commit info: status=%d info=%+v body=%s", status, info, response.Body.String())
	}
	message := "literal $(touch injected-marker)"
	result := gitFixtureCommitAction(t, fixture.project, message, info.IndexToken, *info.Target)
	if result.Code != http.StatusOK {
		t.Fatalf("Commit status=%d body=%s", result.Code, result.Body.String())
	}
	var resultBody map[string]string
	if err := json.Unmarshal(result.Body.Bytes(), &resultBody); err != nil {
		t.Fatalf("decode Commit response: %v; body=%s", err, result.Body.String())
	}
	if resultBody["action"] != "commit" || resultBody["root"] != info.Target.Root || resultBody["output"] != "Commit completed." {
		t.Fatalf("unexpected Commit response: %+v", resultBody)
	}
	afterHead := strings.TrimSpace(string(gitFixtureRun(t, fixture, fixture.project, "rev-parse", "HEAD")))
	if afterHead == beforeHead {
		t.Fatal("Commit did not advance HEAD")
	}
	if got := string(gitFixtureRun(t, fixture, fixture.project, "show", "HEAD:versioned.txt")); got != "version A\n" {
		t.Fatalf("committed staged bytes = %q", got)
	}
	if got, err := os.ReadFile(file); err != nil || string(got) != "version B\n" {
		t.Fatalf("unstaged bytes = %q err=%v", got, err)
	}
	if got, err := os.ReadFile(untracked); err != nil || string(got) != "untracked bytes\n" {
		t.Fatalf("untracked bytes = %q err=%v", got, err)
	}
	if _, err := os.Stat(filepath.Join(fixture.project, "injected-marker")); !os.IsNotExist(err) {
		t.Fatalf("shell-like message executed: stat err=%v", err)
	}
	if got := strings.TrimSuffix(string(gitFixtureRun(t, fixture, fixture.project, "log", "-1", "--format=%s")), "\n"); got != message {
		t.Fatalf("Commit message = %q want=%q", got, message)
	}
	afterRemote := strings.TrimSpace(string(gitFixtureRun(t, fixture, fixture.remote, "rev-parse", "refs/heads/main")))
	if afterRemote != beforeRemote {
		t.Fatalf("Commit pushed unexpectedly: remote %s -> %s", beforeRemote, afterRemote)
	}
	if !strings.Contains(string(gitFixtureRun(t, fixture, fixture.project, "status", "--short")), " M versioned.txt") {
		t.Fatal("newer working-tree edit is not left unstaged")
	}
}

func TestGitActionCommitUnbornAndLastFileDeletion(t *testing.T) {
	t.Run("unborn branch without upstream", func(t *testing.T) {
		fixture := newGitActionFixture(t)
		unborn := filepath.Join(filepath.Dir(fixture.project), "unborn")
		if err := os.MkdirAll(unborn, 0755); err != nil {
			t.Fatal(err)
		}
		gitFixtureRun(t, fixture, unborn, "init", "--initial-branch=main")
		gitFixtureRun(t, fixture, unborn, "config", "user.name", "Phi test")
		gitFixtureRun(t, fixture, unborn, "config", "user.email", "phi-test@example.invalid")
		if err := os.WriteFile(filepath.Join(unborn, "first.txt"), []byte("first\n"), 0644); err != nil {
			t.Fatal(err)
		}
		gitFixtureRun(t, fixture, unborn, "add", "first.txt")
		cfg := loadConfig()
		cfg.Workspaces = append(cfg.Workspaces, unborn)
		saveConfig(cfg)

		status, info, response := gitFixtureInfo(t, unborn)
		if status != http.StatusOK || info.Target == nil || info.Target.Head != "" || info.Target.Branch != "main" || info.CanPullPush || !info.HasStaged || !info.CanCommit {
			t.Fatalf("unborn Git info: status=%d info=%+v body=%s", status, info, response.Body.String())
		}
		result := gitFixtureCommitAction(t, unborn, "first commit", info.IndexToken, *info.Target)
		if result.Code != http.StatusOK {
			t.Fatalf("first Commit status=%d body=%s", result.Code, result.Body.String())
		}
		if got := strings.TrimSpace(string(gitFixtureRun(t, fixture, unborn, "show", "-s", "--format=%s", "HEAD"))); got != "first commit" {
			t.Fatalf("first commit subject = %q", got)
		}
	})

	t.Run("delete last tracked file", func(t *testing.T) {
		fixture := newGitActionFixture(t)
		beforeRemote := strings.TrimSpace(string(gitFixtureRun(t, fixture, fixture.remote, "rev-parse", "refs/heads/main")))
		gitFixtureRun(t, fixture, fixture.project, "rm", "seed.txt")
		status, info, response := gitFixtureInfo(t, fixture.project)
		if status != http.StatusOK || info.Target == nil || !info.HasStaged || !info.CanCommit {
			t.Fatalf("staged deletion info: status=%d info=%+v body=%s", status, info, response.Body.String())
		}
		if got := gitFixtureRun(t, fixture, fixture.project, "ls-files", "--stage", "-z"); len(got) != 0 {
			t.Fatalf("last tracked file remains in index: %q", got)
		}
		result := gitFixtureCommitAction(t, fixture.project, "delete last file", info.IndexToken, *info.Target)
		if result.Code != http.StatusOK {
			t.Fatalf("deletion Commit status=%d body=%s", result.Code, result.Body.String())
		}
		if got := string(gitFixtureRun(t, fixture, fixture.project, "ls-tree", "-r", "--name-only", "HEAD")); strings.Contains(got, "seed.txt") {
			t.Fatalf("deleted file remains in HEAD: %q", got)
		}
		afterRemote := strings.TrimSpace(string(gitFixtureRun(t, fixture, fixture.remote, "rev-parse", "refs/heads/main")))
		if afterRemote != beforeRemote {
			t.Fatalf("Commit pushed unexpectedly: remote %s -> %s", beforeRemote, afterRemote)
		}
	})
}

func TestGitActionCommitRejectsStaleIndex(t *testing.T) {
	t.Run("intent-to-add transition", func(t *testing.T) {
		fixture := newGitActionFixture(t)
		if err := os.WriteFile(filepath.Join(fixture.project, "other.txt"), []byte("other\n"), 0644); err != nil {
			t.Fatal(err)
		}
		gitFixtureRun(t, fixture, fixture.project, "add", "other.txt")
		if err := os.WriteFile(filepath.Join(fixture.project, "intent-empty.txt"), nil, 0644); err != nil {
			t.Fatal(err)
		}
		gitFixtureRun(t, fixture, fixture.project, "add", "-N", "intent-empty.txt")
		stageBefore := gitFixtureRun(t, fixture, fixture.project, "ls-files", "--stage", "-z")
		status, info, response := gitFixtureInfo(t, fixture.project)
		if status != http.StatusOK || info.Target == nil || !info.CanCommit || !info.HasStaged {
			t.Fatalf("intent-to-add info: status=%d info=%+v body=%s", status, info, response.Body.String())
		}
		gitFixtureRun(t, fixture, fixture.project, "add", "intent-empty.txt")
		stageAfter := gitFixtureRun(t, fixture, fixture.project, "ls-files", "--stage", "-z")
		if !bytes.Equal(stageBefore, stageAfter) {
			t.Fatalf("test requires unchanged stage listing: before=%q after=%q", stageBefore, stageAfter)
		}
		result := gitFixtureCommitAction(t, fixture.project, "must not commit", info.IndexToken, *info.Target)
		if result.Code != http.StatusConflict || !strings.Contains(result.Body.String(), "index changed") {
			t.Fatalf("stale intent-to-add Commit status=%d body=%s", result.Code, result.Body.String())
		}
	})

	t.Run("change after first 64 KiB", func(t *testing.T) {
		fixture := newGitActionFixture(t)
		for i := 0; i < 1200; i++ {
			name := fmt.Sprintf("entry-%04d.txt", i)
			if err := os.WriteFile(filepath.Join(fixture.project, name), []byte("before\n"), 0644); err != nil {
				t.Fatal(err)
			}
		}
		gitFixtureRun(t, fixture, fixture.project, "add", "-A")
		stage := gitFixtureRun(t, fixture, fixture.project, "ls-files", "--stage", "-z")
		if len(stage) <= 64*1024 {
			t.Fatalf("test index is only %d bytes", len(stage))
		}
		status, info, response := gitFixtureInfo(t, fixture.project)
		if status != http.StatusOK || info.Target == nil || !info.CanCommit {
			t.Fatalf("large-index info: status=%d info=%+v body=%s", status, info, response.Body.String())
		}
		name := "entry-1199.txt"
		if err := os.WriteFile(filepath.Join(fixture.project, name), []byte("after\n"), 0644); err != nil {
			t.Fatal(err)
		}
		gitFixtureRun(t, fixture, fixture.project, "add", name)
		_, changed, response := gitFixtureInfo(t, fixture.project)
		if changed.IndexToken == info.IndexToken {
			t.Fatal("index token ignored a change after the first 64 KiB")
		}
		result := gitFixtureCommitAction(t, fixture.project, "must not commit", info.IndexToken, *info.Target)
		if result.Code != http.StatusConflict || !strings.Contains(result.Body.String(), "index changed") {
			t.Fatalf("stale large-index Commit status=%d body=%s", result.Code, result.Body.String())
		}
	})
}

func TestGitActionCommitRejectsInProgressAndUnmerged(t *testing.T) {
	t.Run("operation marker", func(t *testing.T) {
		fixture := newGitActionFixture(t)
		if err := os.WriteFile(filepath.Join(fixture.project, "staged.txt"), []byte("staged\n"), 0644); err != nil {
			t.Fatal(err)
		}
		gitFixtureRun(t, fixture, fixture.project, "add", "staged.txt")
		marker := strings.TrimSpace(string(gitFixtureRun(t, fixture, fixture.project, "rev-parse", "--git-path", "CHERRY_PICK_HEAD")))
		if !filepath.IsAbs(marker) {
			marker = filepath.Join(fixture.project, marker)
		}
		if err := os.WriteFile(marker, []byte("in-progress\n"), 0644); err != nil {
			t.Fatal(err)
		}
		status, info, response := gitFixtureInfo(t, fixture.project)
		if status != http.StatusOK || info.Target == nil || info.CanCommit || !strings.Contains(info.CommitReason, "current Git operation") {
			t.Fatalf("operation marker info: status=%d info=%+v body=%s", status, info, response.Body.String())
		}
		result := gitFixtureCommitAction(t, fixture.project, "must not commit", info.IndexToken, *info.Target)
		if result.Code != http.StatusConflict || !strings.Contains(result.Body.String(), "current Git operation") {
			t.Fatalf("operation marker Commit status=%d body=%s", result.Code, result.Body.String())
		}
	})

	t.Run("unmerged index without operation marker", func(t *testing.T) {
		fixture := newGitActionFixture(t)
		if err := os.WriteFile(filepath.Join(fixture.project, "seed.txt"), []byte("project version\n"), 0644); err != nil {
			t.Fatal(err)
		}
		gitFixtureRun(t, fixture, fixture.project, "add", "seed.txt")
		gitFixtureRun(t, fixture, fixture.project, "commit", "-m", "project change")
		if err := os.WriteFile(filepath.Join(fixture.peer, "seed.txt"), []byte("peer version\n"), 0644); err != nil {
			t.Fatal(err)
		}
		gitFixtureRun(t, fixture, fixture.peer, "add", "seed.txt")
		gitFixtureRun(t, fixture, fixture.peer, "commit", "-m", "peer change")
		gitFixtureRun(t, fixture, fixture.peer, "push")
		gitFixtureRun(t, fixture, fixture.project, "fetch", "origin")
		if output, err := gitFixtureTry(fixture, fixture.project, "merge", "--no-edit", "origin/main"); err == nil {
			t.Fatalf("expected merge conflict; output=%s", output)
		}
		if len(gitFixtureRun(t, fixture, fixture.project, "ls-files", "--unmerged", "-z")) == 0 {
			t.Fatal("fixture did not create unmerged index entries")
		}
		mergeHead := strings.TrimSpace(string(gitFixtureRun(t, fixture, fixture.project, "rev-parse", "--git-path", "MERGE_HEAD")))
		if !filepath.IsAbs(mergeHead) {
			mergeHead = filepath.Join(fixture.project, mergeHead)
		}
		if err := os.Remove(mergeHead); err != nil {
			t.Fatal(err)
		}
		before := strings.TrimSpace(string(gitFixtureRun(t, fixture, fixture.project, "rev-parse", "HEAD")))
		status, info, response := gitFixtureInfo(t, fixture.project)
		if status != http.StatusOK || info.Target == nil || info.CanCommit || !strings.Contains(info.CommitReason, "unmerged files") {
			t.Fatalf("unmerged index info: status=%d info=%+v body=%s", status, info, response.Body.String())
		}
		result := gitFixtureCommitAction(t, fixture.project, "must not commit", info.IndexToken, *info.Target)
		if result.Code != http.StatusConflict || !strings.Contains(result.Body.String(), "unmerged files") {
			t.Fatalf("unmerged Commit status=%d body=%s", result.Code, result.Body.String())
		}
		after := strings.TrimSpace(string(gitFixtureRun(t, fixture, fixture.project, "rev-parse", "HEAD")))
		if after != before {
			t.Fatalf("unmerged Commit changed HEAD: %s -> %s", before, after)
		}
	})
}

func TestGitActionCommitRejectsStaleHead(t *testing.T) {
	fixture := newGitActionFixture(t)
	if err := os.WriteFile(filepath.Join(fixture.project, "staged.txt"), []byte("staged\n"), 0644); err != nil {
		t.Fatal(err)
	}
	gitFixtureRun(t, fixture, fixture.project, "add", "staged.txt")
	_, info, _ := gitFixtureInfo(t, fixture.project)
	tree := strings.TrimSpace(string(gitFixtureRun(t, fixture, fixture.project, "rev-parse", "HEAD^{tree}")))
	parent := strings.TrimSpace(string(gitFixtureRun(t, fixture, fixture.project, "rev-parse", "HEAD")))
	commit := strings.TrimSpace(string(gitFixtureRun(t, fixture, fixture.project, "commit-tree", tree, "-p", parent, "-m", "external head update")))
	gitFixtureRun(t, fixture, fixture.project, "update-ref", "refs/heads/main", commit)

	result := gitFixtureCommitAction(t, fixture.project, "stale target", info.IndexToken, *info.Target)
	if result.Code != http.StatusConflict || !strings.Contains(result.Body.String(), "target changed") {
		t.Fatalf("stale HEAD Commit status=%d body=%s", result.Code, result.Body.String())
	}
}

func TestGitActionCommitValidationAndFailure(t *testing.T) {
	t.Run("no staged changes", func(t *testing.T) {
		fixture := newGitActionFixture(t)
		if err := os.WriteFile(filepath.Join(fixture.project, "unstaged.txt"), []byte("unstaged\n"), 0644); err != nil {
			t.Fatal(err)
		}
		_, info, _ := gitFixtureInfo(t, fixture.project)
		result := gitFixtureCommitAction(t, fixture.project, "must not commit", info.IndexToken, *info.Target)
		if result.Code != http.StatusConflict || !strings.Contains(result.Body.String(), "Stage changes") {
			t.Fatalf("unstaged-only Commit status=%d body=%s", result.Code, result.Body.String())
		}
	})

	t.Run("blank message", func(t *testing.T) {
		fixture := newGitActionFixture(t)
		if err := os.WriteFile(filepath.Join(fixture.project, "staged.txt"), []byte("staged\n"), 0644); err != nil {
			t.Fatal(err)
		}
		gitFixtureRun(t, fixture, fixture.project, "add", "staged.txt")
		_, info, _ := gitFixtureInfo(t, fixture.project)
		before := strings.TrimSpace(string(gitFixtureRun(t, fixture, fixture.project, "rev-parse", "HEAD")))
		result := gitFixtureCommitAction(t, fixture.project, " \n ", info.IndexToken, *info.Target)
		if result.Code != http.StatusBadRequest {
			t.Fatalf("blank message status=%d body=%s", result.Code, result.Body.String())
		}
		after := strings.TrimSpace(string(gitFixtureRun(t, fixture, fixture.project, "rev-parse", "HEAD")))
		if after != before {
			t.Fatalf("blank message changed HEAD: %s -> %s", before, after)
		}
	})

	for _, test := range []struct {
		name  string
		setup func(*testing.T, *gitActionFixture)
	}{
		{name: "missing identity", setup: func(t *testing.T, fixture *gitActionFixture) {
			gitFixtureRun(t, fixture, fixture.project, "config", "--unset", "user.name")
			gitFixtureRun(t, fixture, fixture.project, "config", "--unset", "user.email")
			gitFixtureRun(t, fixture, fixture.project, "config", "user.useConfigOnly", "true")
		}},
		{name: "controlled signing failure", setup: func(t *testing.T, fixture *gitActionFixture) {
			gpg := filepath.Join(fixture.home, "failing-gpg")
			if err := os.WriteFile(gpg, []byte("#!/bin/sh\nexit 1\n"), 0755); err != nil {
				t.Fatal(err)
			}
			gitFixtureRun(t, fixture, fixture.project, "config", "commit.gpgsign", "true")
			gitFixtureRun(t, fixture, fixture.project, "config", "gpg.program", gpg)
			gitFixtureRun(t, fixture, fixture.project, "config", "user.signingkey", "test-key")
		}},
		{name: "rejecting hook", setup: func(t *testing.T, fixture *gitActionFixture) {
			hook := filepath.Join(fixture.project, ".git", "hooks", "pre-commit")
			if err := os.WriteFile(hook, []byte("#!/bin/sh\nexit 1\n"), 0755); err != nil {
				t.Fatal(err)
			}
		}},
	} {
		t.Run(test.name, func(t *testing.T) {
			fixture := newGitActionFixture(t)
			if err := os.WriteFile(filepath.Join(fixture.project, "staged.txt"), []byte("staged\n"), 0644); err != nil {
				t.Fatal(err)
			}
			gitFixtureRun(t, fixture, fixture.project, "add", "staged.txt")
			_, info, _ := gitFixtureInfo(t, fixture.project)
			before := strings.TrimSpace(string(gitFixtureRun(t, fixture, fixture.project, "rev-parse", "HEAD")))
			test.setup(t, fixture)
			result := gitFixtureCommitAction(t, fixture.project, "preserve this message", info.IndexToken, *info.Target)
			if result.Code != http.StatusInternalServerError || !strings.Contains(result.Body.String(), "Git commit failed. Partial effects are possible.") {
				t.Fatalf("failed Commit status=%d body=%s", result.Code, result.Body.String())
			}
			if bytes.Contains(result.Body.Bytes(), []byte(fixture.project)) {
				t.Fatalf("Commit error exposed fixture path: %s", result.Body.String())
			}
			after := strings.TrimSpace(string(gitFixtureRun(t, fixture, fixture.project, "rev-parse", "HEAD")))
			if after != before {
				t.Fatalf("failed Commit changed HEAD: %s -> %s", before, after)
			}
			if len(gitFixtureRun(t, fixture, fixture.project, "diff", "--cached", "--raw", "--no-abbrev", "--no-renames", "-z")) == 0 {
				t.Fatal("failed Commit cleared the staged change")
			}
		})
	}
}

func TestGitRawLog(t *testing.T) {
	fixture := newGitActionFixture(t)
	request := func(method, cwd string) *httptest.ResponseRecorder {
		t.Helper()
		query := url.Values{"cwd": {cwd}}
		req := httptest.NewRequest(method, "/api/git/raw-log?"+query.Encode(), nil)
		w := httptest.NewRecorder()
		handleRawLog(w, req)
		return w
	}

	log := request(http.MethodGet, fixture.project)
	if log.Code != http.StatusOK || !strings.Contains(log.Body.String(), "seed") {
		t.Fatalf("log status=%d body=%q", log.Code, log.Body.String())
	}
	if got := log.Header().Get("Cache-Control"); got != "no-store" {
		t.Fatalf("Cache-Control=%q", got)
	}

	unborn := filepath.Join(fixture.home, "unborn")
	if err := os.MkdirAll(unborn, 0755); err != nil {
		t.Fatal(err)
	}
	gitFixtureRun(t, fixture, unborn, "init", "--initial-branch=main")
	if got := request(http.MethodGet, unborn); got.Code != http.StatusOK || got.Body.Len() != 0 {
		t.Fatalf("unborn log status=%d body=%q", got.Code, got.Body.String())
	}

	nonRepo := filepath.Join(fixture.home, "not-repo")
	if err := os.MkdirAll(nonRepo, 0755); err != nil {
		t.Fatal(err)
	}
	if got := request(http.MethodGet, nonRepo); got.Code != http.StatusOK || got.Body.String() != notGitRepoBody {
		t.Fatalf("non-repository log status=%d body=%q", got.Code, got.Body.String())
	}

	method := request(http.MethodPost, fixture.project)
	if method.Code != http.StatusMethodNotAllowed || method.Header().Get("Allow") != http.MethodGet {
		t.Fatalf("method status=%d Allow=%q", method.Code, method.Header().Get("Allow"))
	}
}

func TestGitAPIRequestBoundaries(t *testing.T) {
	tests := []struct {
		name        string
		method      string
		contentType string
		body        string
		want        int
	}{
		{"method", http.MethodGet, "", "", http.StatusMethodNotAllowed},
		{"content type", http.MethodPost, "text/plain", "{}", http.StatusUnsupportedMediaType},
		{"malformed JSON", http.MethodPost, "application/json", "{", http.StatusBadRequest},
		{"multiple objects", http.MethodPost, "application/json", "{} {}", http.StatusBadRequest},
		{"unknown field", http.MethodPost, "application/json", `{"action":"pull","unknown":true}`, http.StatusBadRequest},
		{"unsupported action", http.MethodPost, "application/json", `{"action":"fetch"}`, http.StatusBadRequest},
		{"oversized body", http.MethodPost, "application/json", strings.Repeat(" ", gitActionBodyLimit+1), http.StatusRequestEntityTooLarge},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			req := httptest.NewRequest(test.method, "/api/git/action", strings.NewReader(test.body))
			if test.contentType != "" {
				req.Header.Set("Content-Type", test.contentType)
			}
			w := httptest.NewRecorder()
			handleGitAction(w, req)
			if w.Code != test.want {
				t.Fatalf("status=%d want=%d body=%s", w.Code, test.want, w.Body.String())
			}
			if got := w.Header().Get("Cache-Control"); got != "no-store" {
				t.Fatalf("Cache-Control=%q", got)
			}
			if test.method == http.MethodGet && w.Header().Get("Allow") != http.MethodPost {
				t.Fatalf("Allow=%q", w.Header().Get("Allow"))
			}
		})
	}
}
