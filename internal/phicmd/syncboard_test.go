package phicmd

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"
)

func syncJSON(t *testing.T, out string, v any) {
	t.Helper()
	if err := json.Unmarshal([]byte(out), v); err != nil {
		t.Fatalf("decode syncboard JSON %q: %v", out, err)
	}
}

func TestCmdSyncboardPostGetRoundTrip(t *testing.T) {
	b := newFakeBackend(t)
	defer b.ts.Close()
	prefix := profileEnv(t, b)

	out, code := captureRun(t, append(prefix, "syncboard", "post", "greet", "hello", "--json")...)
	if code != ExitOK {
		t.Fatalf("post exit %d: %s", code, out)
	}
	var posted SyncEntry
	syncJSON(t, out, &posted)
	if posted.Key != "greet" || posted.Value != "hello" {
		t.Fatalf("posted entry: %+v", posted)
	}
	if posted.CreatedAt == "" || posted.UpdatedAt == "" {
		t.Fatalf("posted entry missing timestamps: %+v", posted)
	}

	out, code = captureRun(t, append(prefix, "syncboard", "get", "greet", "--json")...)
	if code != ExitOK {
		t.Fatalf("get exit %d: %s", code, out)
	}
	var got SyncEntry
	syncJSON(t, out, &got)
	if got != posted {
		t.Fatalf("get %+v != posted %+v", got, posted)
	}

	out, code = captureRun(t, append(prefix, "syncboard", "post", "plain", "hi there")...)
	if code != ExitOK || !strings.Contains(out, "upserted plain") {
		t.Fatalf("human post exit %d: %q", code, out)
	}
	out, code = captureRun(t, append(prefix, "syncboard", "get", "plain")...)
	if code != ExitOK || strings.TrimSpace(out) != "hi there" {
		t.Fatalf("human get exit %d: %q", code, out)
	}
}

func TestCmdSyncboardUpsertOverwrites(t *testing.T) {
	b := newFakeBackend(t)
	defer b.ts.Close()
	prefix := profileEnv(t, b)

	if _, code := captureRun(t, append(prefix, "syncboard", "post", "k", "v1")...); code != ExitOK {
		t.Fatalf("first post exit %d", code)
	}
	out, code := captureRun(t, append(prefix, "syncboard", "post", "k", "v2", "--json")...)
	if code != ExitOK {
		t.Fatalf("second post exit %d: %s", code, out)
	}
	var posted SyncEntry
	syncJSON(t, out, &posted)
	if posted.Value != "v2" {
		t.Fatalf("upsert kept old value: %+v", posted)
	}
}

func TestCmdSyncboardAsJSON(t *testing.T) {
	b := newFakeBackend(t)
	defer b.ts.Close()
	prefix := profileEnv(t, b)

	out, code := captureRun(t, append(prefix, "syncboard", "post", "cfg", `{"a":1}`, "--as-json", "--json")...)
	if code != ExitOK {
		t.Fatalf("post exit %d: %s", code, out)
	}
	out, code = captureRun(t, append(prefix, "syncboard", "get", "cfg", "--json")...)
	if code != ExitOK {
		t.Fatalf("get exit %d: %s", code, out)
	}
	var got SyncEntry
	syncJSON(t, out, &got)
	if got.Value != `{"a":1}` {
		t.Fatalf("object value not preserved raw: %q", got.Value)
	}

	_, code = captureRun(t, append(prefix, "syncboard", "post", "bad", `{nope`, "--as-json")...)
	if code != ExitUsage {
		t.Fatalf("--as-json with invalid JSON exit %d, want %d", code, ExitUsage)
	}
}

func TestCmdSyncboardGetMissingIsNotFound(t *testing.T) {
	b := newFakeBackend(t)
	defer b.ts.Close()
	prefix := profileEnv(t, b)

	_, code := captureRun(t, append(prefix, "syncboard", "get", "absent", "--json")...)
	if code != ExitNotFound {
		t.Fatalf("get missing exit %d, want %d", code, ExitNotFound)
	}
}

func TestCmdSyncboardDeleteIdempotent(t *testing.T) {
	b := newFakeBackend(t)
	defer b.ts.Close()
	prefix := profileEnv(t, b)

	// Absent key deletes clean: scripts must not fail on a clean board.
	out, code := captureRun(t, append(prefix, "syncboard", "delete", "ghost", "--json")...)
	if code != ExitOK {
		t.Fatalf("delete missing exit %d: %s", code, out)
	}
	var res struct {
		Key     string `json:"key"`
		Deleted bool   `json:"deleted"`
	}
	syncJSON(t, out, &res)
	if res.Deleted {
		t.Fatalf("delete reported a missing key as deleted: %+v", res)
	}

	if _, code := captureRun(t, append(prefix, "syncboard", "post", "bye", "x")...); code != ExitOK {
		t.Fatalf("post exit %d", code)
	}
	out, code = captureRun(t, append(prefix, "syncboard", "delete", "bye", "--json")...)
	if code != ExitOK {
		t.Fatalf("delete exit %d: %s", code, out)
	}
	syncJSON(t, out, &res)
	if !res.Deleted {
		t.Fatalf("delete reported an existing key as kept: %+v", res)
	}
	if _, code := captureRun(t, append(prefix, "syncboard", "get", "bye")...); code != ExitNotFound {
		t.Fatalf("get after delete exit %d, want %d", code, ExitNotFound)
	}
}

func TestCmdSyncboardListSortedAndPrefix(t *testing.T) {
	b := newFakeBackend(t)
	defer b.ts.Close()
	prefix := profileEnv(t, b)

	for _, kv := range [][2]string{{"zeta", "1"}, {"alpha", "2"}, {"other:x", "3"}} {
		if _, code := captureRun(t, append(prefix, "syncboard", "post", kv[0], kv[1])...); code != ExitOK {
			t.Fatalf("post %s exit %d", kv[0], code)
		}
	}
	out, code := captureRun(t, append(prefix, "syncboard", "list", "--json")...)
	if code != ExitOK {
		t.Fatalf("list exit %d: %s", code, out)
	}
	var listed struct {
		Messages []SyncEntry `json:"messages"`
	}
	syncJSON(t, out, &listed)
	keys := make([]string, 0, len(listed.Messages))
	for _, e := range listed.Messages {
		keys = append(keys, e.Key)
	}
	want := []string{"alpha", "other:x", "zeta"}
	if strings.Join(keys, ",") != strings.Join(want, ",") {
		t.Fatalf("list order %v, want %v", keys, want)
	}

	out, code = captureRun(t, append(prefix, "syncboard", "list", "--prefix", "other:", "--json")...)
	if code != ExitOK {
		t.Fatalf("list --prefix exit %d: %s", code, out)
	}
	listed.Messages = nil
	syncJSON(t, out, &listed)
	if len(listed.Messages) != 1 || listed.Messages[0].Key != "other:x" {
		t.Fatalf("prefix filter: %+v", listed.Messages)
	}
}

func TestCmdSyncboardNotifyAlarmMarkers(t *testing.T) {
	b := newFakeBackend(t)
	defer b.ts.Close()
	prefix := profileEnv(t, b)

	if _, code := captureRun(t, append(prefix, "syncboard", "notify", "job", "done")...); code != ExitOK {
		t.Fatalf("notify exit %d", code)
	}
	if _, code := captureRun(t, append(prefix, "syncboard", "alarm", "job", "failed")...); code != ExitOK {
		t.Fatalf("alarm exit %d", code)
	}
	out, code := captureRun(t, append(prefix, "syncboard", "list", "--json")...)
	if code != ExitOK {
		t.Fatalf("list exit %d: %s", code, out)
	}
	var listed struct {
		Messages []SyncEntry `json:"messages"`
	}
	syncJSON(t, out, &listed)
	keys := map[string]bool{}
	for _, e := range listed.Messages {
		keys[e.Key] = true
	}
	if !keys["job PHI_NOTIF"] || !keys["job PHI_ALARM"] {
		t.Fatalf("markers missing, keys: %v", keys)
	}
}

func TestCmdSyncboardWaitPresentImmediate(t *testing.T) {
	b := newFakeBackend(t)
	defer b.ts.Close()
	prefix := profileEnv(t, b)

	if _, code := captureRun(t, append(prefix, "syncboard", "post", "ready", "yes")...); code != ExitOK {
		t.Fatalf("post exit %d", code)
	}
	out, code := captureRun(t, append(prefix, "syncboard", "wait", "ready", "--json", "--timeout", "10s")...)
	if code != ExitOK {
		t.Fatalf("wait exit %d: %s", code, out)
	}
	var res syncWaitResult
	syncJSON(t, out, &res)
	if res.Key != "ready" || res.Value != "yes" {
		t.Fatalf("wait result: %+v", res)
	}
}

func TestCmdSyncboardWaitAbsent(t *testing.T) {
	b := newFakeBackend(t)
	defer b.ts.Close()
	prefix := profileEnv(t, b)

	// Never-existing keys already satisfy absent.
	if _, code := captureRun(t, append(prefix, "syncboard", "wait", "gone", "--for", "absent", "--timeout", "5s")...); code != ExitOK {
		t.Fatalf("wait absent on missing key exit %d", code)
	}
	if _, code := captureRun(t, append(prefix, "syncboard", "post", "temp", "x")...); code != ExitOK {
		t.Fatalf("post exit %d", code)
	}
	if _, code := captureRun(t, append(prefix, "syncboard", "delete", "temp")...); code != ExitOK {
		t.Fatalf("delete exit %d", code)
	}
	if _, code := captureRun(t, append(prefix, "syncboard", "wait", "temp", "--for", "absent", "--timeout", "5s")...); code != ExitOK {
		t.Fatalf("wait absent after delete exit %d", code)
	}
}

func postSyncKey(url, key, value string) {
	body := `{"key":` + jsonString(key) + `,"value":` + jsonString(value) + `}`
	_, _ = http.Post(url+"/api/sync/messages", "application/json", strings.NewReader(body))
}

func jsonString(s string) string {
	b, _ := json.Marshal(s)
	return string(b)
}

func TestCmdSyncboardWaitChange(t *testing.T) {
	b := newFakeBackend(t)
	defer b.ts.Close()
	prefix := profileEnv(t, b)

	if _, code := captureRun(t, append(prefix, "syncboard", "post", "prog", "v1")...); code != ExitOK {
		t.Fatalf("post exit %d", code)
	}
	// The change lands after the wait starts: the first read is the
	// baseline, the second read must report movement.
	go func() {
		time.Sleep(300 * time.Millisecond)
		postSyncKey(b.url(), "prog", "v2")
	}()
	out, code := captureRun(t, append(prefix, "syncboard", "wait", "prog", "--for", "change", "--poll", "50ms", "--timeout", "10s", "--json")...)
	if code != ExitOK {
		t.Fatalf("wait change exit %d: %s", code, out)
	}
	var res syncWaitResult
	syncJSON(t, out, &res)
	if res.Value != "v2" {
		t.Fatalf("wait change returned stale entry: %+v", res)
	}

	// --from with the current updated_at must block; with a stale one it
	// must return at once.
	out, code = captureRun(t, append(prefix, "syncboard", "get", "prog", "--json")...)
	if code != ExitOK {
		t.Fatalf("get exit %d: %s", code, out)
	}
	var cur SyncEntry
	syncJSON(t, out, &cur)
	if _, code := captureRun(t, append(prefix, "syncboard", "wait", "prog", "--for", "change", "--from", cur.UpdatedAt, "--poll", "50ms", "--timeout", "500ms")...); code != ExitTimeout {
		t.Fatalf("wait change --from current exit %d, want timeout %d", code, ExitTimeout)
	}
	out, code = captureRun(t, append(prefix, "syncboard", "wait", "prog", "--for", "change", "--from", "2000-01-01T00:00:00Z", "--poll", "50ms", "--timeout", "5s", "--json")...)
	if code != ExitOK {
		t.Fatalf("wait change --from stale exit %d: %s", code, out)
	}
}

func TestCmdSyncboardWaitMatch(t *testing.T) {
	b := newFakeBackend(t)
	defer b.ts.Close()
	prefix := profileEnv(t, b)

	if _, code := captureRun(t, append(prefix, "syncboard", "post", "status", "starting")...); code != ExitOK {
		t.Fatalf("post exit %d", code)
	}
	go func() {
		time.Sleep(300 * time.Millisecond)
		postSyncKey(b.url(), "status", "done-123")
	}()
	out, code := captureRun(t, append(prefix, "syncboard", "wait", "status", "--for", "match", "--match", `done-\d+`, "--poll", "50ms", "--timeout", "10s", "--json")...)
	if code != ExitOK {
		t.Fatalf("wait match exit %d: %s", code, out)
	}
	var res syncWaitResult
	syncJSON(t, out, &res)
	if res.Value != "done-123" {
		t.Fatalf("wait match returned wrong entry: %+v", res)
	}
}

func TestCmdSyncboardWaitAlarmOnly(t *testing.T) {
	b := newFakeBackend(t)
	defer b.ts.Close()
	prefix := profileEnv(t, b)

	go func() {
		time.Sleep(300 * time.Millisecond)
		postSyncKey(b.url(), "job PHI_ALARM", "tests failed")
	}()
	out, code := captureRun(t, append(prefix, "syncboard", "wait", "--alarm-only", "--poll", "50ms", "--timeout", "10s", "--json")...)
	if code != ExitOK {
		t.Fatalf("wait --alarm-only exit %d: %s", code, out)
	}
	var res syncWaitResult
	syncJSON(t, out, &res)
	if res.Key != "job PHI_ALARM" || res.Value != "tests failed" {
		t.Fatalf("wait --alarm-only returned wrong entry: %+v", res)
	}
}

func TestCmdSyncboardWaitTimeout(t *testing.T) {
	b := newFakeBackend(t)
	defer b.ts.Close()
	prefix := profileEnv(t, b)

	// Pins the flag-routing bug this command exposed: --timeout after
	// the command name parses too late for Run's deadline, so the wait
	// ran the full 2m default instead of the requested 300ms. The
	// command must honor a shorter post-command timeout itself.
	start := time.Now()
	_, code := captureRun(t, append(prefix, "syncboard", "wait", "never", "--poll", "50ms", "--timeout", "300ms")...)
	if code != ExitTimeout {
		t.Fatalf("wait timeout exit %d, want %d", code, ExitTimeout)
	}
	if elapsed := time.Since(start); elapsed > 30*time.Second {
		t.Fatalf("wait ignored the post-command --timeout, took %v", elapsed)
	}
}

func TestCmdSyncboardWaitBadArgs(t *testing.T) {
	b := newFakeBackend(t)
	defer b.ts.Close()
	prefix := profileEnv(t, b)

	for _, args := range [][]string{
		{"syncboard", "wait"},
		{"syncboard", "wait", "k", "--for", "someday"},
		{"syncboard", "wait", "k", "--for", "match"},
		{"syncboard", "wait", "k", "--for", "match", "--match", "(unclosed"},
		{"syncboard", "wait", "k", "--match", "x"},
		{"syncboard", "wait", "k", "--poll", "0s"},
		{"syncboard", "wait", "k", "--alarm-only"},
		{"syncboard", "bogus"},
		{"syncboard", "list", "extra"},
		{"syncboard", "get"},
		{"syncboard", "post", "onlykey"},
		{"syncboard", "delete"},
	} {
		if _, code := captureRun(t, append(prefix, args...)...); code != ExitUsage {
			t.Fatalf("%v exit %d, want usage %d", args, code, ExitUsage)
		}
	}
}

func TestCmdSyncboardCoordinatorEnvFallback(t *testing.T) {
	b := newFakeBackend(t)
	defer b.ts.Close()
	// No profiles document at all: the coordinator address alone must be
	// enough to reach the board.
	dir := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", dir)
	t.Setenv("PHI_COORDINATOR", b.url())

	out, code := captureRun(t, "syncboard", "list", "--json")
	if code != ExitOK {
		t.Fatalf("coordinator fallback exit %d: %s", code, out)
	}
}
