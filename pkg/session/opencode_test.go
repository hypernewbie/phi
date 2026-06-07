package session

import (
	"database/sql"
	"testing"

	_ "modernc.org/sqlite"
)

func TestGetOpenCodeSessionTranscriptNestedFormat(t *testing.T) {
	db, err := sql.Open("sqlite", "file::memory:?cache=shared")
	if err != nil {
		t.Fatalf("failed to open memory db: %v", err)
	}
	defer db.Close()

	// 1. Create tables
	_, err = db.Exec(`
		CREATE TABLE message (
			id text PRIMARY KEY,
			session_id text NOT NULL,
			time_created integer NOT NULL,
			time_updated integer NOT NULL,
			data text NOT NULL
		);
	`)
	if err != nil {
		t.Fatalf("failed to create message table: %v", err)
	}

	_, err = db.Exec(`
		CREATE TABLE part (
			id text PRIMARY KEY,
			message_id text NOT NULL,
			session_id text NOT NULL,
			time_created integer NOT NULL,
			time_updated integer NOT NULL,
			data text NOT NULL
		);
	`)
	if err != nil {
		t.Fatalf("failed to create part table: %v", err)
	}

	sessionID := "test-session-123"
	msgID := "test-msg-1"

	// 2. Insert test data imitating the nested format that was failing
	// {"type":"message", "message":{"role":"user"}}
	_, err = db.Exec(
		`INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, 0, 0, ?)`,
		msgID, sessionID, `{"type":"message","message":{"role":"user"}}`,
	)
	if err != nil {
		t.Fatalf("failed to insert message: %v", err)
	}

	// Insert text part
	_, err = db.Exec(
		`INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, 0, 0, ?)`,
		"part-1", msgID, sessionID, `{"type":"text","text":"Hello World!"}`,
	)
	if err != nil {
		t.Fatalf("failed to insert part: %v", err)
	}

	// 3. Test the function
	messages, err := getOpenCodeSessionTranscriptFromDB(db, sessionID)
	if err != nil {
		t.Fatalf("getOpenCodeSessionTranscriptFromDB returned error: %v", err)
	}

	// 4. Assert
	if len(messages) != 1 {
		t.Fatalf("expected 1 message, got %d", len(messages))
	}

	if messages[0].Role != "user" {
		t.Errorf("expected role 'user', got %q", messages[0].Role)
	}

	if messages[0].Text != "Hello World!" {
		t.Errorf("expected text 'Hello World!', got %q", messages[0].Text)
	}
}

func TestGetOpenCodeSessionTranscriptOldFormat(t *testing.T) {
	db, err := sql.Open("sqlite", "file::memory:?cache=shared")
	if err != nil {
		t.Fatalf("failed to open memory db: %v", err)
	}
	defer db.Close()

	// 1. Create tables
	_, err = db.Exec(`
		CREATE TABLE message (
			id text PRIMARY KEY,
			session_id text NOT NULL,
			time_created integer NOT NULL,
			time_updated integer NOT NULL,
			data text NOT NULL
		);
	`)
	if err != nil {
		t.Fatalf("failed to create message table: %v", err)
	}

	_, err = db.Exec(`
		CREATE TABLE part (
			id text PRIMARY KEY,
			message_id text NOT NULL,
			session_id text NOT NULL,
			time_created integer NOT NULL,
			time_updated integer NOT NULL,
			data text NOT NULL
		);
	`)
	if err != nil {
		t.Fatalf("failed to create part table: %v", err)
	}

	sessionID := "test-session-old"
	msgID := "test-msg-old"

	// 2. Insert test data imitating the old root format
	// {"role":"assistant"}
	_, err = db.Exec(
		`INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, 0, 0, ?)`,
		msgID, sessionID, `{"role":"assistant"}`,
	)
	if err != nil {
		t.Fatalf("failed to insert message: %v", err)
	}

	// Insert text part
	_, err = db.Exec(
		`INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, 0, 0, ?)`,
		"part-old", msgID, sessionID, `{"type":"text","text":"Old Format Text"}`,
	)
	if err != nil {
		t.Fatalf("failed to insert part: %v", err)
	}

	// 3. Test the function
	messages, err := getOpenCodeSessionTranscriptFromDB(db, sessionID)
	if err != nil {
		t.Fatalf("getOpenCodeSessionTranscriptFromDB returned error: %v", err)
	}

	// 4. Assert
	if len(messages) != 1 {
		t.Fatalf("expected 1 message, got %d", len(messages))
	}

	if messages[0].Role != "assistant" {
		t.Errorf("expected role 'assistant', got %q", messages[0].Role)
	}

	if messages[0].Text != "Old Format Text" {
		t.Errorf("expected text 'Old Format Text', got %q", messages[0].Text)
	}
}
