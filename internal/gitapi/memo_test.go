package gitapi

import (
	"bytes"
	"context"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// memoTestRepo builds a repository view over dir with an index file present.
func memoTestRepo(t *testing.T) (*gitActionRepository, string) {
	t.Helper()
	dir := t.TempDir()
	indexPath := filepath.Join(dir, "index")
	if err := os.WriteFile(indexPath, []byte("index-bytes"), 0644); err != nil {
		t.Fatal(err)
	}
	return &gitActionRepository{root: dir, commonDir: dir, gitDir: dir}, indexPath
}

func memoLen() int {
	gitInfoMemoMu.Lock()
	defer gitInfoMemoMu.Unlock()
	return len(gitInfoMemo)
}

func resetGitInfoMemo(t *testing.T) {
	t.Helper()
	gitInfoMemoMu.Lock()
	clear(gitInfoMemo)
	gitInfoMemoMu.Unlock()
	t.Cleanup(func() {
		gitInfoMemoMu.Lock()
		clear(gitInfoMemo)
		gitInfoMemoMu.Unlock()
	})
}

// A hit must skip the computation, and a hit must not extend the entry's age.
func TestGitInfoMemoStableHitAndNonSlidingExpiry(t *testing.T) {
	resetGitInfoMemo(t)
	repo, indexPath := memoTestRepo(t)
	target := gitActionTarget{Head: "head-1"}
	calls := 0
	load := func(context.Context) (bool, string, *gitAPIError) {
		calls++
		return true, "token-1", nil
	}

	hasStaged, token, apiErr := gitInfoMemoRead(context.Background(), repo, target, load)
	if apiErr != nil || !hasStaged || token != "token-1" || calls != 1 {
		t.Fatalf("first read = %t %q %v calls=%d", hasStaged, token, apiErr, calls)
	}
	// Seed a still-valid older entry. A hit must preserve its original age.
	cachedAt := time.Now().Add(-gitInfoMemoMaxAge / 2)
	gitInfoMemoMu.Lock()
	entry := gitInfoMemo[repo.gitDir]
	entry.cachedAt = cachedAt
	gitInfoMemo[repo.gitDir] = entry
	gitInfoMemoMu.Unlock()
	if _, token, err := gitInfoMemoRead(context.Background(), repo, target, load); err != nil || token != "token-1" || calls != 1 {
		t.Fatalf("cached read token=%q err=%v calls=%d, want a hit", token, err, calls)
	}
	gitInfoMemoMu.Lock()
	storedAt := gitInfoMemo[repo.gitDir].cachedAt
	gitInfoMemoMu.Unlock()
	if !storedAt.Equal(cachedAt) {
		t.Fatalf("hit changed entry age: %v -> %v", cachedAt, storedAt)
	}

	// Age the entry without touching the index: the next read loads again.
	key, ok := gitInfoMemoKey(repo)
	if !ok {
		t.Fatal("repository is not cacheable")
	}
	info, err := os.Lstat(indexPath)
	if err != nil {
		t.Fatal(err)
	}
	gitInfoMemoStoreAt(key, target.Head, info, true, "token-1", time.Now().Add(-gitInfoMemoMaxAge-time.Second))
	if _, _, err := gitInfoMemoRead(context.Background(), repo, target, load); err != nil || calls != 2 {
		t.Fatalf("expired read calls=%d err=%v, want a reload", calls, err)
	}

	// Touching the index defeats the hit even when HEAD is unchanged.
	later := time.Now().Add(2 * time.Second)
	if err := os.Chtimes(indexPath, later, later); err != nil {
		t.Fatal(err)
	}
	if _, _, err := gitInfoMemoRead(context.Background(), repo, target, load); err != nil || calls != 3 {
		t.Fatalf("changed index calls=%d err=%v, want a reload", calls, err)
	}

	// Git replaces the index atomically. File identity must invalidate even
	// when the replacement has identical bytes, size, mode, and mtime.
	oldInfo, err := os.Lstat(indexPath)
	if err != nil {
		t.Fatal(err)
	}
	replacement := indexPath + ".lock"
	if err := os.WriteFile(replacement, []byte("index-bytes"), oldInfo.Mode()); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(replacement, oldInfo.ModTime(), oldInfo.ModTime()); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(replacement, indexPath); err != nil {
		t.Fatal(err)
	}
	newInfo, err := os.Lstat(indexPath)
	if err != nil {
		t.Fatal(err)
	}
	if os.SameFile(oldInfo, newInfo) || oldInfo.Size() != newInfo.Size() || oldInfo.Mode() != newInfo.Mode() || !oldInfo.ModTime().Equal(newInfo.ModTime()) {
		t.Fatal("test requires a different file identity with matching metadata")
	}
	if _, _, err := gitInfoMemoRead(context.Background(), repo, target, load); err != nil || calls != 4 {
		t.Fatalf("replaced index calls=%d err=%v, want a reload", calls, err)
	}

	// A different HEAD never reuses another commit's entry.
	if _, _, err := gitInfoMemoRead(context.Background(), repo, gitActionTarget{Head: "head-2"}, load); err != nil || calls != 5 {
		t.Fatalf("new head calls=%d err=%v, want a reload", calls, err)
	}
}

// The memo is bounded: filling it clears it instead of growing without limit.
func TestGitInfoMemoCapacityIsBounded(t *testing.T) {
	resetGitInfoMemo(t)
	repo, indexPath := memoTestRepo(t)
	info, err := os.Lstat(indexPath)
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < gitInfoMemoCap; i++ {
		gitInfoMemoStoreAt(filepath.Join(repo.gitDir, "repo-"+string(rune('a'+i%26))+string(rune('a'+i/26))), "head", info, false, "token", time.Now())
	}
	if got := memoLen(); got != gitInfoMemoCap {
		t.Fatalf("memo holds %d entries, want %d", got, gitInfoMemoCap)
	}
	gitInfoMemoStoreAt(filepath.Join(repo.gitDir, "overflow"), "head", info, false, "token", time.Now())
	if got := memoLen(); got != 1 {
		t.Fatalf("memo holds %d entries after clear-on-full, want 1", got)
	}
}

// The read memo must never outlive the facts it was pinned to: a changed index
// or HEAD recomputes, and a config-only change is caught when the entry ages.
func TestGitInfoMemoInvalidatesOnIndexHeadAndConfig(t *testing.T) {
	withTempConfig(t)
	fixture := newGitActionFixture(t)
	repo, notRepo, err := inspectGitRepository(context.Background(), fixture.project)
	if err != nil || notRepo || repo == nil {
		t.Fatalf("inspect repository: %v notRepo=%t", err, notRepo)
	}
	resetGitInfoMemo(t)
	ctx := context.Background()

	target, _, _, err := targetForGitRepository(ctx, repo)
	if err != nil || target.Head == "" {
		t.Fatalf("target: %+v err=%v", target, err)
	}
	if err := os.WriteFile(filepath.Join(fixture.project, "staged.txt"), []byte("staged\n"), 0644); err != nil {
		t.Fatal(err)
	}
	gitFixtureRun(t, fixture, fixture.project, "add", "staged.txt")
	before := gitFixtureRun(t, fixture, fixture.project, "ls-files", "--stage", "-z")
	hasStaged, token, snapErr := gitInfoIndexSnapshot(ctx, repo, target)
	if snapErr != nil || !hasStaged || token == "" {
		t.Fatalf("staged snapshot = %t %q %v", hasStaged, token, snapErr)
	}

	// Unstage without touching HEAD: the token must change.
	gitFixtureRun(t, fixture, fixture.project, "reset")
	if after := gitFixtureRun(t, fixture, fixture.project, "ls-files", "--stage", "-z"); string(after) == string(before) {
		t.Fatal("test requires a changed stage listing")
	}
	hasStaged, token, snapErr = gitInfoIndexSnapshot(ctx, repo, target)
	if snapErr != nil || hasStaged {
		t.Fatalf("after unstage staged=%t err=%v", hasStaged, snapErr)
	}
	// diff.orderFile changes the diff output without changing HEAD or the
	// index. A warm entry may serve its short window, so expiry must refresh.
	// Two staged paths: diff.orderFile only shows up when the output can be
	// reordered, so a single path would leave the token unchanged.
	for _, name := range []string{"zeta.txt", "alpha.txt"} {
		if err := os.WriteFile(filepath.Join(fixture.project, name), []byte(name+"\n"), 0644); err != nil {
			t.Fatal(err)
		}
	}
	gitFixtureRun(t, fixture, fixture.project, "add", "staged.txt", "zeta.txt", "alpha.txt")
	hasStaged, preConfig, snapErr := gitInfoIndexSnapshot(ctx, repo, target)
	if snapErr != nil || !hasStaged {
		t.Fatalf("restaged snapshot = %t %q %v", hasStaged, preConfig, snapErr)
	}
	orderFile := filepath.Join(fixture.home, "orderfile")
	if err := os.WriteFile(orderFile, []byte("zeta.txt\n*\n"), 0644); err != nil {
		t.Fatal(err)
	}
	gitFixtureRun(t, fixture, fixture.project, "config", "diff.orderFile", orderFile)
	key, ok := gitInfoMemoKey(repo)
	if !ok {
		t.Fatal("repository is not cacheable")
	}
	info, statErr := os.Lstat(filepath.Join(repo.gitDir, "index"))
	if statErr != nil {
		t.Fatal(statErr)
	}
	gitInfoMemoStoreAt(key, target.Head, info, hasStaged, preConfig, time.Now().Add(-gitInfoMemoMaxAge-time.Second))
	if _, refreshed, snapErr := gitInfoIndexSnapshot(ctx, repo, target); snapErr != nil || refreshed == preConfig {
		t.Fatalf("config change refreshed token=%q err=%v, want a different token", refreshed, snapErr)
	}

	// A soft reset changes only HEAD: the same index goes from clean to
	// staged. This must miss without relying on an index metadata change.
	gitFixtureRun(t, fixture, fixture.project, "commit", "-m", "staged")
	committedTarget, _, _, err := targetForGitRepository(ctx, repo)
	if err != nil {
		t.Fatal(err)
	}
	hasStaged, cleanToken, snapErr := gitInfoIndexSnapshot(ctx, repo, committedTarget)
	if snapErr != nil || hasStaged {
		t.Fatalf("committed snapshot staged=%t err=%v", hasStaged, snapErr)
	}
	indexPath := filepath.Join(repo.gitDir, "index")
	beforeResetInfo, statErr := os.Lstat(indexPath)
	if statErr != nil {
		t.Fatal(statErr)
	}
	beforeReset, readErr := os.ReadFile(indexPath)
	if readErr != nil {
		t.Fatal(readErr)
	}
	gitFixtureRun(t, fixture, fixture.project, "reset", "--soft", "HEAD~1")
	resetTarget, _, _, err := targetForGitRepository(ctx, repo)
	if err != nil || resetTarget.Head == committedTarget.Head {
		t.Fatalf("soft reset must move HEAD: before=%s after=%s err=%v", committedTarget.Head, resetTarget.Head, err)
	}
	afterResetInfo, statErr := os.Lstat(indexPath)
	if statErr != nil {
		t.Fatal(statErr)
	}
	afterReset, readErr := os.ReadFile(indexPath)
	if readErr != nil {
		t.Fatal(readErr)
	}
	if !sameGitIndexInfo(beforeResetInfo, afterResetInfo) || !bytes.Equal(beforeReset, afterReset) {
		t.Fatal("soft reset must leave index bytes and metadata unchanged")
	}
	if staged, resetToken, snapErr := gitInfoIndexSnapshot(ctx, repo, resetTarget); snapErr != nil || !staged || resetToken == cleanToken {
		t.Fatalf("HEAD-only change: staged=%t token=%q err=%v", staged, resetToken, snapErr)
	}
}

// A computation that runs against a moving index must not be stored, and a
// pinned HEAD must match the uncached result for that same HEAD.
func TestGitInfoMemoDoesNotStoreUnstableIndex(t *testing.T) {
	withTempConfig(t)
	fixture := newGitActionFixture(t)
	repo, notRepo, err := inspectGitRepository(context.Background(), fixture.project)
	if err != nil || notRepo || repo == nil {
		t.Fatalf("inspect repository: %v notRepo=%t", err, notRepo)
	}
	resetGitInfoMemo(t)
	ctx := context.Background()
	target, _, _, err := targetForGitRepository(ctx, repo)
	if err != nil || target.Head == "" {
		t.Fatalf("target: %+v err=%v", target, err)
	}

	// Model HEAD moving after target resolution, before the scan. The old
	// target still needs the old comparison, not the new implicit HEAD.
	if err := os.WriteFile(filepath.Join(fixture.project, "pinned.txt"), []byte("pinned\n"), 0644); err != nil {
		t.Fatal(err)
	}
	gitFixtureRun(t, fixture, fixture.project, "add", "pinned.txt")
	wantStaged, wantToken, wantErr := gitIndexSnapshotForHead(ctx, repo, target.Head)
	if wantErr != nil {
		t.Fatalf("uncached snapshot: %v", wantErr)
	}
	gitFixtureRun(t, fixture, fixture.project, "commit", "-m", "move HEAD during read")
	if staged, token, err := gitIndexSnapshot(ctx, repo); err != nil || staged || token == wantToken || !wantStaged {
		t.Fatalf("test requires different implicit and pinned snapshots: staged=%t token=%q err=%v", staged, token, err)
	}
	gotStaged, gotToken, gotErr := gitInfoIndexSnapshot(ctx, repo, target)
	if gotErr != nil || gotStaged != wantStaged || gotToken != wantToken {
		t.Fatalf("pinned read = %t %q %v, want %t %q", gotStaged, gotToken, gotErr, wantStaged, wantToken)
	}

	// Loading through a moving index leaves nothing cached.
	resetGitInfoMemo(t)
	calls := 0
	load := func(context.Context) (bool, string, *gitAPIError) {
		calls++
		if err := os.Chtimes(filepath.Join(repo.gitDir, "index"), time.Now().Add(3*time.Second), time.Now().Add(3*time.Second)); err != nil {
			t.Errorf("touch index: %v", err)
		}
		return true, "token", nil
	}
	if _, _, err := gitInfoMemoRead(ctx, repo, target, load); err != nil {
		t.Fatal(err)
	}
	if got := memoLen(); got != 0 {
		t.Fatalf("memo stored %d entries from a moving index", got)
	}
	if _, _, err := gitInfoMemoRead(ctx, repo, target, load); err != nil || calls != 2 {
		t.Fatalf("second read calls=%d err=%v, want a reload", calls, err)
	}
}

// Failures and cancellations must not populate the memo, and an action attempt
// clears the entry that its own index change may have invalidated.
func TestGitInfoMemoFailuresAndActionInvalidation(t *testing.T) {
	withTempConfig(t)
	fixture := newGitActionFixture(t)
	repo, notRepo, err := inspectGitRepository(context.Background(), fixture.project)
	if err != nil || notRepo || repo == nil {
		t.Fatalf("inspect repository: %v notRepo=%t", err, notRepo)
	}
	resetGitInfoMemo(t)
	ctx := context.Background()
	target, _, _, err := targetForGitRepository(ctx, repo)
	if err != nil {
		t.Fatal(err)
	}

	calls := 0
	failing := func(context.Context) (bool, string, *gitAPIError) {
		calls++
		return false, "", gitAPIErrorf(http.StatusInternalServerError, "boom")
	}
	if _, _, err := gitInfoMemoRead(ctx, repo, target, failing); err == nil {
		t.Fatal("failing load reported success")
	}
	if got := memoLen(); got != 0 {
		t.Fatalf("memo stored %d entries after a failure", got)
	}

	canceled, cancel := context.WithCancel(ctx)
	cancel()
	// The loader mirrors production: a git command on a canceled context fails.
	if _, _, apiErr := gitInfoMemoRead(canceled, repo, target, func(loadCtx context.Context) (bool, string, *gitAPIError) {
		return false, "", gitReadAPIError(loadCtx)
	}); apiErr == nil {
		t.Fatal("canceled read reported success")
	}
	if got := memoLen(); got != 0 {
		t.Fatalf("memo stored %d entries after cancellation", got)
	}
	// Cancellation can arrive after Git finishes successfully. That result
	// must not populate the cache for the next request either.
	finishing, finishCancel := context.WithCancel(ctx)
	defer finishCancel()
	if _, _, err := gitInfoMemoRead(finishing, repo, target, func(context.Context) (bool, string, *gitAPIError) {
		finishCancel()
		return true, "finished-but-canceled", nil
	}); err != nil {
		t.Fatal(err)
	}
	if got := memoLen(); got != 0 {
		t.Fatalf("memo stored %d entries after cancellation during load", got)
	}

	// A warm entry plus a rejected stale-token action leaves no stale entry.
	status, info, body := gitFixtureInfo(t, fixture.project)
	if status != http.StatusOK || info.Target == nil || info.IndexToken == "" {
		t.Fatalf("info: status=%d body=%s", status, body.Body.String())
	}
	if got := memoLen(); got != 1 {
		t.Fatalf("warm memo holds %d entries, want 1", got)
	}
	if _, _, err := gitInfoMemoRead(canceled, repo, *info.Target, failing); err == nil || err.status != http.StatusGatewayTimeout || calls != 1 {
		t.Fatalf("canceled hit: err=%v loader calls=%d, want timeout without a load", err, calls)
	}
	if err := os.WriteFile(filepath.Join(fixture.project, "late.txt"), []byte("late\n"), 0644); err != nil {
		t.Fatal(err)
	}
	gitFixtureRun(t, fixture, fixture.project, "add", "late.txt")
	result := gitFixtureCommitAction(t, fixture.project, "stale", info.IndexToken, *info.Target)
	if result.Code != http.StatusConflict {
		t.Fatalf("stale commit status=%d body=%s", result.Code, result.Body.String())
	}
	if got := memoLen(); got != 0 {
		t.Fatalf("action left %d memo entries, want the repository entry cleared", got)
	}

	// The guard still rejects: no commit was created by the stale attempt.
	log := gitFixtureRun(t, fixture, fixture.project, "log", "--format=%s")
	if strings.Contains(string(log), "stale") {
		t.Fatalf("stale attempt committed: %s", log)
	}
}
