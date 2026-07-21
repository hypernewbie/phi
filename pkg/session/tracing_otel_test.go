//go:build otel

package session

import (
	"context"
	"database/sql"
	"os"
	"path/filepath"
	"testing"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/codes"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
)

// withSpanRecorder installs a fresh SpanRecorder-backed TracerProvider as
// the global one, restoring the previous global provider on cleanup.
// otel.SetTracerProvider is global state, so — per plan's L5 test hygiene
// note — every test using this must NOT call t.Parallel().
func withSpanRecorder(t *testing.T) (*tracetest.SpanRecorder, *sdktrace.TracerProvider) {
	t.Helper()
	sr := tracetest.NewSpanRecorder()
	tp := sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(sr))
	prev := otel.GetTracerProvider()
	otel.SetTracerProvider(tp)
	t.Cleanup(func() { otel.SetTracerProvider(prev) })
	return sr, tp
}

// TestOTelSpans_DBQueryParentsUnderCaller (L5) drives the otelsql-wrapped
// DB path (ListOpenCodeSessions -> openDB -> db.QueryContext) over the
// same SQLite fixture shape as TestListOpenCodeSessions_DBQuery, under a
// root span, and asserts the resulting DB span is parented under it —
// proof the ctx-threading from M5a actually propagates all the way into
// the driver. An orphan span (no matching parent) means it didn't.
func TestOTelSpans_DBQueryParentsUnderCaller(t *testing.T) {
	sr, tp := withSpanRecorder(t)

	mockHome := setupMockHome(t)
	dbDir := filepath.Join(mockHome, ".local", "share", "opencode")
	if err := os.MkdirAll(dbDir, 0755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	dbPath := filepath.Join(dbDir, "opencode.db")
	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		t.Fatalf("open fixture db: %v", err)
	}
	if _, err := db.Exec(`
		CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT);
		CREATE TABLE session (
			id TEXT PRIMARY KEY, title TEXT, directory TEXT, project_id TEXT,
			parent_id TEXT, time_archived INTEGER, time_updated TEXT
		);
		INSERT INTO project (id, worktree) VALUES ('proj1', '/mock/cwd');
		INSERT INTO session (id, title, directory, project_id, parent_id, time_archived, time_updated)
		VALUES ('sess-1', 'Mock', '', 'proj1', NULL, 0, '2026-01-01T00:00:00Z');
	`); err != nil {
		t.Fatalf("seed fixture db: %v", err)
	}
	if err := db.Close(); err != nil {
		t.Fatalf("close fixture db: %v", err)
	}

	tracer := tp.Tracer("test")
	ctx, rootSpan := tracer.Start(context.Background(), "root")

	if _, err := ListOpenCodeSessions(ctx, "/mock/cwd"); err != nil {
		t.Fatalf("ListOpenCodeSessions: %v", err)
	}
	rootSpan.End()

	root := rootSpan.(sdktrace.ReadOnlySpan)
	var dbSpan sdktrace.ReadOnlySpan
	for _, s := range sr.Ended() {
		for _, a := range s.Attributes() {
			if string(a.Key) == "db.system" && a.Value.AsString() == "sqlite" {
				dbSpan = s
				break
			}
		}
		if dbSpan != nil {
			break
		}
	}
	if dbSpan == nil {
		t.Fatal("expected at least one recorded span with db.system=sqlite (the otelsql-wrapped query) — DB instrumentation didn't fire")
	}

	if dbSpan.Parent().SpanID() != root.SpanContext().SpanID() {
		t.Errorf("db span's parent SpanID = %s, want root's SpanID %s — ctx wasn't threaded into the query",
			dbSpan.Parent().SpanID(), root.SpanContext().SpanID())
	}
	if dbSpan.Parent().TraceID() != root.SpanContext().TraceID() {
		t.Errorf("db span's parent TraceID = %s, want root's TraceID %s",
			dbSpan.Parent().TraceID(), root.SpanContext().TraceID())
	}
}

// TestOTelSpans_GitWorktreeListSpan (L5) drives the git path over a temp
// repo under a root span and asserts the resulting "git.worktree.list"
// span is named correctly and parented under the caller.
func TestOTelSpans_GitWorktreeListSpan(t *testing.T) {
	sr, tp := withSpanRecorder(t)

	dir := t.TempDir()

	tracer := tp.Tracer("test")
	ctx, rootSpan := tracer.Start(context.Background(), "root")

	if _, err := ListGitWorktrees(ctx, dir); err != nil {
		t.Fatalf("ListGitWorktrees: %v", err)
	}
	rootSpan.End()

	root := rootSpan.(sdktrace.ReadOnlySpan)
	var gitSpan sdktrace.ReadOnlySpan
	for _, s := range sr.Ended() {
		if s.Name() == "git.worktree.list" {
			gitSpan = s
			break
		}
	}
	if gitSpan == nil {
		t.Fatal("expected a recorded span named git.worktree.list")
	}
	if gitSpan.Parent().SpanID() != root.SpanContext().SpanID() {
		t.Errorf("git.worktree.list span's parent SpanID = %s, want root's SpanID %s",
			gitSpan.Parent().SpanID(), root.SpanContext().SpanID())
	}
}

// TestOTelSpans_GitStatusErrorPath (L5) forces the underlying git command
// to fail (nonexistent working dir) and asserts the resulting "git.status"
// span records the error and sets codes.Error status.
func TestOTelSpans_GitStatusErrorPath(t *testing.T) {
	sr, tp := withSpanRecorder(t)

	tracer := tp.Tracer("test")
	ctx, rootSpan := tracer.Start(context.Background(), "root")

	_ = hasUnstagedChanges(ctx, filepath.Join(t.TempDir(), "does-not-exist"))
	rootSpan.End()

	var statusSpan sdktrace.ReadOnlySpan
	for _, s := range sr.Ended() {
		if s.Name() == "git.status" {
			statusSpan = s
			break
		}
	}
	if statusSpan == nil {
		t.Fatal("expected a recorded span named git.status")
	}
	if statusSpan.Status().Code != codes.Error {
		t.Errorf("expected git.status span to have codes.Error status on a failed git invocation, got %v", statusSpan.Status().Code)
	}
}
