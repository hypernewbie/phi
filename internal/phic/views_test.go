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

func TestAPIClientRawDiffCommitAndCommits(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/git/raw-diff":
			if got := r.URL.Query().Get("commit"); got != "ab12cd3" {
				t.Errorf("commit=%q", got)
			}
			_, _ = w.Write([]byte("pretty patch"))
		case "/api/git/commits":
			if got := r.URL.Query().Get("cwd"); got != "/work" {
				t.Errorf("cwd=%q", got)
			}
			_ = json.NewEncoder(w).Encode([]GitCommit{{Hash: "ab12cd3", Subject: "Improve terminal"}})
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	api := mustAPI(t, srv.URL)
	patch, err := api.RawDiffCommit(context.Background(), "/work", "ab12cd3", false)
	if err != nil || patch != "pretty patch" {
		t.Fatalf("RawDiffCommit = %q, %v", patch, err)
	}
	commits, err := api.Commits(context.Background(), "/work")
	if err != nil || len(commits) != 1 || commits[0].Subject != "Improve terminal" {
		t.Fatalf("Commits = %+v, %v", commits, err)
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
