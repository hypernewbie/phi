package phicmd

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/hypernewbie/phi/internal/phiaccess"
)

// Every test here pins a bug that a real run exposed. Each one names
// the failure it prevents from coming back.

// The auth column belongs to the server it describes. The roster
// collects probes concurrently, so a flag indexed by profile order
// lands on whatever row finished i-th: venus reported "no auth" while
// demanding a password, and another server's flag moved with it.
func TestCmdServersAuthFlagMapsToItsOwnRow(t *testing.T) {
	// "zz" answers fast, "aa" is slow and needs auth. The roster sorts
	// by id, so the slow server's row comes first while its probe
	// finished last: exactly the order that used to splice.
	fast := newFakeBackend(t)
	fast.mu.Lock()
	fast.ident = map[string]any{"hostname": "fast-host"}
	fast.mu.Unlock()

	mid := newFakeBackend(t)
	mid.mu.Lock()
	mid.ident = map[string]any{"hostname": "mid-host"}
	mid.configDelay = 40 * time.Millisecond
	mid.mu.Unlock()

	slow := newFakeBackend(t)
	slow.mu.Lock()
	slow.ident = map[string]any{"hostname": "slow-host"}
	slow.authEnabled = true
	slow.configDelay = 120 * time.Millisecond
	slow.mu.Unlock()

	prefix, _ := multiProfileEnv(t,
		[2]string{"zz", fast.url()}, [2]string{"mm", mid.url()}, [2]string{"aa", slow.url()})
	out, code := captureRun(t, append(prefix, "servers", "--json")...)
	if code != ExitOK {
		t.Fatalf("exit=%d out=%s", code, out)
	}
	var doc struct {
		Servers []ServerRow `json:"servers"`
	}
	if err := json.Unmarshal([]byte(out), &doc); err != nil {
		t.Fatalf("json: %v\n%s", err, out)
	}
	if len(doc.Servers) != 3 {
		t.Fatalf("rows: %+v", doc.Servers)
	}
	byID := map[string]ServerRow{}
	for _, row := range doc.Servers {
		byID[row.ID] = row
	}
	aa, ok := byID["aa"]
	if !ok {
		t.Fatalf("no aa row: %+v", doc.Servers)
	}
	zz, ok := byID["zz"]
	if !ok {
		t.Fatalf("no zz row: %+v", doc.Servers)
	}
	if !aa.Auth {
		t.Error("aa requires a password but its row claims it does not")
	}
	if zz.Auth {
		t.Error("zz needs no password but its row claims it does")
	}
	mm, ok := byID["mm"]
	if !ok {
		t.Fatalf("no mm row: %+v", doc.Servers)
	}
	if mm.Auth {
		t.Error("mm needs no password but its row claims it does")
	}
	// Identity must stay with its own row too: an auth-gated backend
	// cannot report a hostname, so the two open ones carry the proof.
	if zz.Hostname != "fast-host" || mm.Hostname != "mid-host" {
		t.Errorf("hostnames crossed rows: zz=%q mm=%q", zz.Hostname, mm.Hostname)
	}
}

// `servers` is the roster and `use` is the selector: neither may
// demand a selection before it can be given.
func TestCmdServersAndUseWorkWithoutASelection(t *testing.T) {
	a := newFakeBackend(t)
	b := newFakeBackend(t)
	prefix, _ := multiProfileEnv(t, [2]string{"one", a.url()}, [2]string{"two", b.url()})

	out, code := captureRun(t, append(prefix, "servers", "--json")...)
	if code != ExitOK {
		t.Fatalf("servers without a selection: exit=%d out=%s", code, out)
	}
	var doc struct {
		Servers []ServerRow `json:"servers"`
	}
	if err := json.Unmarshal([]byte(out), &doc); err != nil {
		t.Fatalf("json: %v\n%s", err, out)
	}
	if len(doc.Servers) != 2 {
		t.Fatalf("roster rows: %+v", doc.Servers)
	}

	out, code = captureRun(t, append(prefix, "use", "--server", "two")...)
	if code != ExitOK {
		t.Fatalf("use without a prior selection: exit=%d out=%s", code, out)
	}
	if !strings.Contains(out, "two") {
		t.Fatalf("use did not select the server: %s", out)
	}
}

// A global flag given before the command must survive the client
// rebinding its flag set: registering a flag resets the variable, so
// the parsed value used to vanish and every command fell back to
// "multiple servers configured".
func TestGlobalFlagsSurviveTheRebind(t *testing.T) {
	a := newFakeBackend(t)
	b := newFakeBackend(t)
	prefix, _ := multiProfileEnv(t, [2]string{"one", a.url()}, [2]string{"two", b.url()})

	out, code := captureRun(t, append(prefix, "--server", "two", "status", "--json")...)
	if code != ExitOK {
		t.Fatalf("exit=%d out=%s", code, out)
	}
	// The selected backend is the one that answered.
	b.mu.Lock()
	hit := len(b.requests) > 0
	b.mu.Unlock()
	a.mu.Lock()
	other := len(a.requests) > 0
	a.mu.Unlock()
	if !hit {
		t.Fatal("the selected server was never contacted")
	}
	if other {
		t.Error("an unselected server was contacted")
	}
	if !strings.Contains(out, "\"sessions\"") && !strings.Contains(out, "\"coders\"") {
		t.Fatalf("status json: %s", out)
	}
}

// A login in phic is a login in phi-cmd: the shared store beside the
// profiles document is replayed without a password.
func TestPhiCmdReusesARememberedSession(t *testing.T) {
	b := newFakeBackend(t)
	b.mu.Lock()
	b.authEnabled = true
	b.password = "secret"
	b.mu.Unlock()

	prefix, profilesPath := multiProfileEnv(t, [2]string{"one", b.url()})
	// Prime the store exactly as phic does after a login.
	value := fmt.Sprintf("granted.%d.sig", time.Now().Add(time.Hour).Unix())
	b.mu.Lock()
	b.cookies[value] = true
	b.mu.Unlock()
	store := phiaccess.NewSessionStore(profilesPath)
	if err := store.Save(b.url(), http.Cookie{
		Name: phiaccess.AccessSessionCookieName, Value: value, Path: "/", HttpOnly: true,
	}); err != nil {
		t.Fatal(err)
	}

	// No password anywhere: the remembered session must carry the call.
	out, code := captureRun(t, append(prefix, "--server", "one", "status", "--json")...)
	if code != ExitOK {
		t.Fatalf("remembered session refused: exit=%d out=%s", code, out)
	}
	b.mu.Lock()
	loggedIn := false
	for _, r := range b.requests {
		if strings.Contains(r, "/api/auth/login") {
			loggedIn = true
		}
	}
	b.mu.Unlock()
	if loggedIn {
		t.Error("the client logged in again instead of replaying the session")
	}
}

// And the other direction: logging in with a password saves the
// session, so the next command needs no password at all.
func TestPhiCmdSavesTheSessionAfterALogin(t *testing.T) {
	b := newFakeBackend(t)
	b.mu.Lock()
	b.authEnabled = true
	b.password = "secret"
	b.mu.Unlock()

	prefix, profilesPath := multiProfileEnv(t, [2]string{"one", b.url()})
	pwFile := filepath.Join(t.TempDir(), "pw")
	if err := os.WriteFile(pwFile, []byte("secret"), 0o600); err != nil {
		t.Fatal(err)
	}

	out, code := captureRun(t, append(append(prefix, "--server", "one", "--password-file", pwFile), "status", "--json")...)
	if code != ExitOK {
		t.Fatalf("password login: exit=%d out=%s", code, out)
	}
	store := phiaccess.NewSessionStore(profilesPath)
	cookie, err := store.Load(b.url())
	if err != nil {
		t.Fatal(err)
	}
	if cookie == nil || cookie.Value == "" {
		t.Fatal("the login did not save an access session")
	}

	// The next command needs no password: the saved session is enough.
	out, code = captureRun(t, append(prefix, "--server", "one", "status", "--json")...)
	if code != ExitOK {
		t.Fatalf("saved session refused: exit=%d out=%s", code, out)
	}
}

// A released binary must say which release it is. The first release
// shipped "dev": the build set main.Version but the command declared a
// lowercase variable the linker cannot reach.
func TestVersionFlagPrintsTheRelease(t *testing.T) {
	out, code := captureRun(t, "--version")
	if code != ExitOK {
		t.Fatalf("exit=%d out=%s", code, out)
	}
	if !strings.HasPrefix(strings.TrimSpace(out), "phi-cmd ") {
		t.Fatalf("version banner: %q", out)
	}
}

// The coder roster is an object keyed by coder id, not an array. The
// unit fake once answered an array, so only the real-server
// integration test caught the mismatch.
func TestCoderRosterDecodesTheObjectShape(t *testing.T) {
	b := newFakeBackend(t)
	prefix := profileEnv(t, b)
	out, code := captureRun(t, append(prefix, "status", "--json")...)
	if code != ExitOK {
		t.Fatalf("exit=%d out=%s", code, out)
	}
	if !strings.Contains(out, "\"coders\"") {
		t.Fatalf("status json: %s", out)
	}
}
