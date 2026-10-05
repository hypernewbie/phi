package phic

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
)

func TestMatchingPanesFiltersByDirAndCoder(t *testing.T) {
	panes := []TerminalView{{ID: "a", Dir: "/x", Coder: "pi"}, {ID: "b", Dir: "/x", Coder: "bash"}, {ID: "c", Dir: "/x", Coder: "pi", ActiveWSCount: 1}, {ID: "d", Dir: "/y", Coder: "pi"}}
	for _, tc := range []struct{ dir, coder, want string }{{"/x", "pi", "a"}, {"/x", "", "a,b"}, {"", "pi", "a,d"}} {
		ids := idsOf(matchingPanes(panes, tc.dir, tc.coder))
		sort.Strings(ids)
		if strings.Join(ids, ",") != tc.want {
			t.Fatalf("matching(%s,%s): %v", tc.dir, tc.coder, ids)
		}
	}
}
func idsOf(in []TerminalView) []string {
	out := make([]string, len(in))
	for i, v := range in {
		out[i] = v.ID
	}
	return out
}
func TestQuotedIDEscapesControlBytes(t *testing.T) {
	for _, tc := range []struct{ in, want string }{{"", `""`}, {"abc", `"abc"`}, {"\x1b[2J", `"\x1b[2J"`}, {"hi\nthere", `"hi\x0athere"`}, {`a"b\c`, `"a\"b\\c"`}} {
		if got := QuotedID(tc.in); got != tc.want {
			t.Fatalf("QuotedID(%q)=%q want %q", tc.in, got, tc.want)
		}
	}
}
func selectionServer(t *testing.T, panes []TerminalView) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/coders" {
			_ = json.NewEncoder(w).Encode(map[string]CoderDescriptor{"pi": {ID: "pi", Name: "Pi"}})
			return
		}
		_ = json.NewEncoder(w).Encode(panes)
	}))
	t.Cleanup(srv.Close)
	return srv
}
func TestSelectExactPaneUsesServerIdentityWithoutDirectoryArgument(t *testing.T) {
	srv := selectionServer(t, []TerminalView{{ID: "exact-id", Dir: "/server-directory", Coder: "pi", OpenCodeMode: "mini"}})
	c := &client{cfg: config{Pane: "exact-id"}, api: mustAPI(t, srv.URL)}
	got, err := c.Select(context.Background())
	if err != nil || got.PaneID != "exact-id" || got.Existing == nil || got.Existing.Dir != "/server-directory" || got.Existing.OpenCodeMode != "mini" {
		t.Fatalf("selection: %+v err=%v", got, err)
	}
	c.cfg.Pane = "missing"
	if _, err := c.Select(context.Background()); err == nil {
		t.Fatal("nonexistent pane accepted")
	}
}
func TestSelectNewRequiresCoder(t *testing.T) {
	srv := selectionServer(t, nil)
	c := &client{cfg: config{Dir: t.TempDir(), NewPane: true}, api: mustAPI(t, srv.URL)}
	if _, err := c.Select(context.Background()); err == nil || !strings.Contains(err.Error(), "--new requires --coder") {
		t.Fatalf("wrong error: %v", err)
	}
}
func TestSelectUniqueMatchAutoAttaches(t *testing.T) {
	dir, err := resolveDir(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	srv := selectionServer(t, []TerminalView{{ID: "p1", Dir: dir, Coder: "pi"}})
	c := &client{cfg: config{Dir: dir}, api: mustAPI(t, srv.URL)}
	got, err := c.Select(context.Background())
	if err != nil || got.PaneID != "p1" || got.Existing == nil {
		t.Fatalf("selection: %+v %v", got, err)
	}
}
func TestSelectAmbiguousRequiresMenu(t *testing.T) {
	dir, err := resolveDir(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	srv := selectionServer(t, []TerminalView{{ID: "p1", Dir: dir, Coder: "pi"}, {ID: "p2", Dir: dir, Coder: "bash"}})
	c := &client{cfg: config{Dir: dir}, api: mustAPI(t, srv.URL)}
	if _, err := c.Select(context.Background()); err == nil || !strings.Contains(err.Error(), "requires a terminal") {
		t.Fatalf("selection bypassed menu: %v", err)
	}
}
func TestResolveDirectoryAndSymlink(t *testing.T) {
	dir := t.TempDir()
	link := filepath.Join(t.TempDir(), "project-link")
	if err := os.Symlink(dir, link); err != nil {
		t.Skipf("symlink unavailable: %v", err)
	}
	want, err := resolveDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	got, err := resolveDir(link)
	if err != nil || got != want {
		t.Fatalf("directory alias: %q %v", got, err)
	}
}
func TestSpawnRejectsUnadvertisedCoder(t *testing.T) {
	srv := selectionServer(t, nil)
	c := &client{cfg: config{Dir: t.TempDir(), NewPane: true, Coder: "not-advertised"}, api: mustAPI(t, srv.URL)}
	if _, err := c.Select(context.Background()); err == nil || !strings.Contains(err.Error(), "not advertised") {
		t.Fatalf("unadvertised backend accepted: %v", err)
	}
}
func mustAPI(t *testing.T, base string) *apiClient {
	t.Helper()
	a, err := newAPIClient(base)
	if err != nil {
		t.Fatal(err)
	}
	return a
}
