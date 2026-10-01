package session

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/hypernewbie/phi/pkg/coders"
)

func init() {
	if path := os.Getenv("PHI_TEST_OC2_DB"); path != "" {
		fmt.Println(path)
		os.Exit(0)
	}
}

func v2Fixture(t *testing.T) (*sql.DB, string) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "OpenCode data.db")
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	_, err = db.Exec(`
		CREATE TABLE project (id text PRIMARY KEY, worktree text);
		CREATE TABLE session_v2 (id text PRIMARY KEY, project_id text, slug text, title text, directory text, parent_id text, time_archived integer, time_updated integer);
		CREATE TABLE session_message (id text PRIMARY KEY, session_id text, type text, seq integer, data text);
		INSERT INTO project VALUES ('p', '/repo');
		INSERT INTO session_v2 VALUES ('root','p','slug',NULL,'/repo',NULL,NULL,1760000000000);
		INSERT INTO session_v2 VALUES ('fallback','p','fallback','Earlier','',NULL,0,1750000000000);
		INSERT INTO session_v2 VALUES ('other','p','other','Other','/other',NULL,NULL,1760000000001);
		INSERT INTO session_v2 VALUES ('child','p','child','Child','/repo','root',NULL,1760000000002);
		INSERT INTO session_v2 VALUES ('archived','p','archived','Archived','/repo',NULL,1,1760000000003);
		INSERT INTO session_message VALUES ('later','root','assistant',3,'{"content":[{"type":"reasoning","text":"private thought"},{"type":"text","text":"answer "},{"type":"tool","text":"not speech"},{"type":"text","text":"done"}]}');
		INSERT INTO session_message VALUES ('before','root','user',1,'{"text":"question\n    code"}');
		INSERT INTO session_message VALUES ('meta','root','model-switched',2,'{}');
		INSERT INTO session_message VALUES ('bad','root','assistant',4,'not json');
		INSERT INTO session_message VALUES ('foreign','other','user',1,'{"text":"other session"}');
	`)
	if err != nil {
		t.Fatal(err)
	}
	return db, path
}

func TestOpenCodeV2SessionList(t *testing.T) {
	db, _ := v2Fixture(t)
	rows, err := listOpenCodeV2SessionsFromDB(context.Background(), db, "/repo", "custom-v2")
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 2 || rows[0].ID != "root" || rows[1].ID != "fallback" || rows[0].Title != "slug" || rows[0].Coder != "custom-v2" || rows[1].Cwd != "/repo" {
		t.Fatalf("unexpected sessions: %+v", rows)
	}
	if rows[0].TimeUpdated.UnixMilli() != 1760000000000 {
		t.Fatalf("timestamp: %v", rows[0].TimeUpdated)
	}
}

func TestOpenCodeV2TranscriptShapeAndOrdering(t *testing.T) {
	db, _ := v2Fixture(t)
	rows, err := getOpenCodeV2TranscriptFromDB(context.Background(), db, "root")
	if err != nil {
		t.Fatal(err)
	}
	want := []Message{{Role: "user", Text: "question\n    code"}, {Role: "assistant", Text: "answer done"}}
	if !reflect.DeepEqual(rows, want) {
		t.Fatalf("got %+v, want %+v", rows, want)
	}
	rows, err = getOpenCodeV2TranscriptFromDB(context.Background(), db, "root' OR 1=1 --")
	if err != nil || len(rows) != 0 {
		t.Fatalf("ID was not bound safely: %+v %v", rows, err)
	}
}

func TestOpenCodeV2UsesCLIPathAndReadOnlyDB(t *testing.T) {
	_, path := v2Fixture(t)
	c := coders.Coder{ID: "opencode", Command: os.Args[0], SessionSource: "opencode_v2", Env: map[string]string{"PHI_TEST_OC2_DB": path}}
	a, err := AdapterFor(c)
	if err != nil {
		t.Fatal(err)
	}
	rows, err := a.List(context.Background(), "/repo")
	if err != nil || len(rows) != 2 {
		t.Fatalf("list: %+v %v", rows, err)
	}
	messages, err := a.Transcript(context.Background(), "/repo", "root")
	if err != nil || len(messages) != 2 {
		t.Fatalf("transcript: %+v %v", messages, err)
	}
	db, err := openCodeV2DB(context.Background(), c)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err := db.Exec(`DELETE FROM session_v2`); err == nil {
		t.Fatal("history connection allowed writes")
	}
	if os.Getenv("PHI_TEST_OC2_DB") != "" {
		t.Fatal("child env escaped into server")
	}
}

func TestOpenCodeV2ResumeNeverCreatesMissingSessions(t *testing.T) {
	_, path := v2Fixture(t)
	c := coders.Coder{ID: "opencode", Command: os.Args[0], Env: map[string]string{"PHI_TEST_OC2_DB": path}}
	if err := ValidateOpenCodeV2Resume(context.Background(), c, "root"); err != nil {
		t.Fatal(err)
	}
	if err := ValidateOpenCodeV2Resume(context.Background(), c, "stale-v1-id"); err == nil {
		t.Fatal("missing ID would create an empty conversation")
	}
}

func TestOpenCodeV2MissingDBDoesNotCreateOrMigrate(t *testing.T) {
	path := filepath.Join(t.TempDir(), "not-created.db")
	c := coders.Coder{ID: "opencode", Command: os.Args[0], Env: map[string]string{"PHI_TEST_OC2_DB": path}}
	db, err := openCodeV2DB(context.Background(), c)
	if err != nil || db != nil {
		t.Fatalf("missing DB: %v %v", db, err)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("created missing DB: %v", err)
	}
	old, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = old.Exec(`CREATE TABLE session(id text); INSERT INTO session VALUES ('v1-only')`); err != nil {
		t.Fatal(err)
	}
	old.Close()
	db, err = openCodeV2DB(context.Background(), c)
	if err != nil || db != nil {
		t.Fatalf("v1-only DB: %v %v", db, err)
	}
	old, err = sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	defer old.Close()
	var count int
	old.QueryRow(`SELECT count(*) FROM sqlite_master WHERE name='session_v2'`).Scan(&count)
	if count != 0 {
		t.Fatal("Phi migrated the user's DB")
	}
}

func TestOpenCodeV2CancellationAndUnsupportedPath(t *testing.T) {
	c := coders.Coder{Command: os.Args[0], Env: map[string]string{"PHI_TEST_OC2_DB": "relative-path"}}
	if _, err := openCodeV2DB(context.Background(), c); err == nil {
		t.Fatal("accepted a malformed CLI path")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := openCodeV2DB(ctx, c); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancellation lost: %v", err)
	}
}
