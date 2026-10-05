package phic

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sort"
	"strings"
	"testing"
)

// TestMatchingPanesFiltersByDirAndCoder pins the rules in
// PHIC_PLAN.md section 2: matching means same dir, optional
// same coder, and no other client already attached.
func TestMatchingPanesFiltersByDirAndCoder(t *testing.T) {
	panes := []TerminalView{
		{ID: "a", Dir: "/x", Coder: "pi", ActiveWSCount: 0},
		{ID: "b", Dir: "/x", Coder: "bash", ActiveWSCount: 0},
		{ID: "c", Dir: "/x", Coder: "pi", ActiveWSCount: 1}, // attached
		{ID: "d", Dir: "/y", Coder: "pi", ActiveWSCount: 0},
	}
	got := matchingPanes(panes, "/x", "pi")
	if len(got) != 1 || got[0].ID != "a" {
		t.Fatalf("want [a], got %v", got)
	}
	got = matchingPanes(panes, "/x", "")
	ids := idsOf(got)
	sort.Strings(ids)
	if strings.Join(ids, ",") != "a,b" {
		t.Fatalf("want [a b], got %v", got)
	}
	got = matchingPanes(panes, "", "pi")
	ids = idsOf(got)
	sort.Strings(ids)
	// c is filtered because it has ActiveWSCount > 0.
	if strings.Join(ids, ",") != "a,d" {
		t.Fatalf("want [a d], got %v", got)
	}
}

func idsOf(in []TerminalView) []string {
	out := make([]string, len(in))
	for i, v := range in {
		out[i] = v.ID
	}
	return out
}

// TestQuotedIDEscapesControlBytes pins the metadata-safety
// rule from the plan: control bytes become \xNN escapes.
func TestQuotedIDEscapesControlBytes(t *testing.T) {
	cases := []struct{ in, want string }{
		{"", `""`},
		{"abc", `"abc"`},
		{"\x1b[2J", `"\x1b[2J"`},
		{"hi\nthere", `"hi\x0athere"`},
		{`a"b\c`, `"a\"b\\c"`},
	}
	for _, c := range cases {
		got := QuotedID(c.in)
		if got != c.want {
			t.Fatalf("QuotedID(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

// TestSelectExactPane verifies that --pane short-circuits the
// selection.
func TestSelectExactPane(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode([]TerminalView{})
	}))
	defer srv.Close()

	c := &client{
		cfg: config{Server: srv.URL, Pane: "exact-id", Dir: "/x"},
		api: mustAPI(t, srv.URL),
	}
	got, err := c.Select(context.Background())
	if err != nil {
		t.Fatalf("Select: %v", err)
	}
	if got.PaneID != "exact-id" {
		t.Fatalf("pane id = %q", got.PaneID)
	}
}

// TestSelectNewRequiresCoder pins the --new + no --coder case.
func TestSelectNewRequiresCoder(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode([]TerminalView{})
	}))
	defer srv.Close()

	c := &client{
		cfg: config{Server: srv.URL, Dir: "/x", NewPane: true},
		api: mustAPI(t, srv.URL),
	}
	if _, err := c.Select(context.Background()); err == nil {
		t.Fatalf("expected --new without --coder to fail")
	}
}

// TestSelectUniqueMatchAutoAttaches covers the "one matching
// pane" branch.
func TestSelectUniqueMatchAutoAttaches(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode([]TerminalView{
			{ID: "p1", Dir: "/x", Coder: "pi", ActiveWSCount: 0},
		})
	}))
	defer srv.Close()

	c := &client{
		cfg: config{Server: srv.URL, Dir: "/x"},
		api: mustAPI(t, srv.URL),
	}
	got, err := c.Select(context.Background())
	if err != nil {
		t.Fatalf("Select: %v", err)
	}
	if got.PaneID != "p1" || got.Existing == nil {
		t.Fatalf("got %+v", got)
	}
}

// TestSelectAmbiguousRequiresMenu covers the "ambiguous" branch.
func TestSelectAmbiguousRequiresMenu(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode([]TerminalView{
			{ID: "p1", Dir: "/x", Coder: "pi", ActiveWSCount: 0},
			{ID: "p2", Dir: "/x", Coder: "bash", ActiveWSCount: 0},
		})
	}))
	defer srv.Close()

	c := &client{
		cfg: config{Server: srv.URL, Dir: "/x"},
		api: mustAPI(t, srv.URL),
	}
	if _, err := c.Select(context.Background()); err == nil {
		t.Fatalf("expected ambiguous error")
	}
}

func mustAPI(t *testing.T, base string) *apiClient {
	t.Helper()
	a, err := newAPIClient(base)
	if err != nil {
		t.Fatalf("newAPIClient: %v", err)
	}
	return a
}
