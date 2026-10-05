package phic

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

// TestAPIClientRawDiff pins the URL shape and the ansi flag.
func TestAPIClientRawDiff(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/git/raw-diff" {
			http.NotFound(w, r)
			return
		}
		if r.URL.Query().Get("ansi") != "1" {
			t.Errorf("ansi=%q", r.URL.Query().Get("ansi"))
		}
		if r.URL.Query().Get("cwd") != "/x" {
			t.Errorf("cwd=%q", r.URL.Query().Get("cwd"))
		}
		_, _ = w.Write([]byte("diff --git a/x b/x"))
	}))
	defer srv.Close()

	api := mustAPI(t, srv.URL)
	got, err := api.RawDiff(context.Background(), "/x", true)
	if err != nil {
		t.Fatalf("RawDiff: %v", err)
	}
	if got != "diff --git a/x b/x" {
		t.Fatalf("diff body = %q", got)
	}
}

// TestAPIClientWorktrees pins the worktree list shape.
func TestAPIClientWorktrees(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/git/worktrees" {
			http.NotFound(w, r)
			return
		}
		_ = json.NewEncoder(w).Encode([]Worktree{
			{Path: "/x/main", Active: true},
			{Path: "/x/feature"},
		})
	}))
	defer srv.Close()

	api := mustAPI(t, srv.URL)
	got, err := api.Worktrees(context.Background(), "/x")
	if err != nil {
		t.Fatalf("Worktrees: %v", err)
	}
	if len(got) != 2 || !got[0].Active {
		t.Fatalf("got %+v", got)
	}
}
