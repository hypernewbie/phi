package session

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/hypernewbie/phi/pkg/coders"
)

func TestCodexIndexIsReadOnlyScopedAndSupportsNativeHistory(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "state_5.sqlite")
	db, err := openDB(path)
	if err != nil {
		t.Fatal(err)
	}
	_, err = db.Exec(`CREATE TABLE threads (id TEXT, title TEXT, cwd TEXT, updated_at INTEGER, source TEXT, archived INTEGER);
	INSERT INTO threads VALUES ('one','Current Codex thread','/project',1790000000,'cli',0),
	('other','Other project','/other',1790000001,'cli',0),
	('old','Archived','/project',1790000002,'cli',1),
	('child','Child agent','/project',1790000003,'{"subagent":{}}',0);`)
	if err != nil {
		t.Fatal(err)
	}
	db.Close()
	c := coders.NewManager().MustGet("codex")
	c.Env = map[string]string{"CODEX_HOME": t.TempDir(), "CODEX_SQLITE_HOME": root}
	items, err := ListSessions(context.Background(), c, "/project")
	if err != nil || len(items) != 1 || items[0].ID != "one" || items[0].Coder != "codex" || items[0].Title != "Current Codex thread" {
		t.Fatalf("sessions: %+v %v", items, err)
	}
	reader, err := codexDB(context.Background(), c)
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	if _, err := reader.Exec(`DELETE FROM threads`); err == nil {
		t.Fatal("reader can mutate Codex history")
	}
	if _, err := GetTranscript(context.Background(), c, "/project", "one"); !errors.Is(err, ErrTranscriptUnsupported) {
		t.Fatalf("misrepresented transcript: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := ListSessions(ctx, c, "/project"); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancellation: %v", err)
	}
}

func TestCodexMissingHistoryDoesNotCreateOrMigrateFiles(t *testing.T) {
	root := t.TempDir()
	c := coders.NewManager().MustGet("codex")
	c.Env = map[string]string{"CODEX_HOME": root, "CODEX_SQLITE_HOME": ""}
	items, err := ListSessions(context.Background(), c, "")
	if err != nil || len(items) != 0 {
		t.Fatalf("missing history: %v %v", items, err)
	}
	entries, err := os.ReadDir(root)
	if err != nil || len(entries) != 0 {
		t.Fatalf("reader created files: %v %v", entries, err)
	}
}

func TestCodexWindowsPathsAndNormalisation(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "state_5.sqlite")
	db, err := openDB(path)
	if err != nil {
		t.Fatal(err)
	}
	_, err = db.Exec(`CREATE TABLE threads (id TEXT, title TEXT, cwd TEXT, updated_at INTEGER, source TEXT, archived INTEGER);
	INSERT INTO threads VALUES ('win-1','Windows project','C:\\Users\\dev\\project',1790000000,'cli',0),
	('win-2','Forward slash project','C:/Users/dev/other',1790000001,'vscode',0),
	('win-3','Verbatim project','\\?\C:\Users\dev\extended',1790000002,'cli',0),
	('win-4','Verbatim UNC project','\\?\UNC\srv\share\proj',1790000003,'cli',0);`)
	if err != nil {
		t.Fatal(err)
	}
	db.Close()

	c := coders.NewManager().MustGet("codex")
	c.Env = map[string]string{"CODEX_HOME": root, "CODEX_SQLITE_HOME": root}

	// Should match when queried with forward slashes
	items, err := ListSessions(context.Background(), c, "c:/users/dev/project")
	if err != nil || len(items) != 1 || items[0].ID != "win-1" {
		t.Fatalf("expected win-1 for forward slash query: %+v, err: %v", items, err)
	}

	// Should match when queried with backslashes
	items, err = ListSessions(context.Background(), c, `C:\Users\dev\project`)
	if err != nil || len(items) != 1 || items[0].ID != "win-1" {
		t.Fatalf("expected win-1 for backslash query: %+v, err: %v", items, err)
	}

	// Should match forward slash stored path with backslash query
	items, err = ListSessions(context.Background(), c, `c:\users\dev\other`)
	if err != nil || len(items) != 1 || items[0].ID != "win-2" {
		t.Fatalf("expected win-2 for backslash query on forward path: %+v, err: %v", items, err)
	}

	// Codex writes cwds through GetFinalPathNameByHandle, so Windows
	// rows carry the `\\?\` verbatim prefix. A plain query must match,
	// and the cwd handed back to phi must be the plain form (the UI
	// groups by it, resume spawns in it).
	items, err = ListSessions(context.Background(), c, `C:\Users\dev\extended`)
	if err != nil || len(items) != 1 || items[0].ID != "win-3" {
		t.Fatalf("expected win-3 for verbatim stored path: %+v, err: %v", items, err)
	}
	if items[0].Cwd != `C:\Users\dev\extended` {
		t.Fatalf("verbatim prefix leaked into cwd: %q", items[0].Cwd)
	}

	// Same for the verbatim UNC form: `\\?\UNC\srv\share` is
	// `\\srv\share`.
	items, err = ListSessions(context.Background(), c, `\\srv\share\proj`)
	if err != nil || len(items) != 1 || items[0].ID != "win-4" {
		t.Fatalf("expected win-4 for verbatim UNC stored path: %+v, err: %v", items, err)
	}
	if items[0].Cwd != `\\srv\share\proj` {
		t.Fatalf("verbatim UNC prefix leaked into cwd: %q", items[0].Cwd)
	}
}
