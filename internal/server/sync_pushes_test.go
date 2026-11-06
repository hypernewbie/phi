package server

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	"github.com/hypernewbie/phi/internal/syncmesh"
	syncmeshb "github.com/hypernewbie/phi/internal/syncmesh/pb"
)

// startTestMesh boots a loopback mesh and returns a publish function, so a
// test can push messages through the real wire the same way the browser
// reads them.
func startTestMesh(t *testing.T) (*syncmesh.Server, func(messageID, recipient, value string)) {
	t.Helper()
	mesh := syncmesh.New()
	done := make(chan error, 1)
	go func() { done <- mesh.Serve("127.0.0.1:0") }()
	t.Cleanup(func() {
		mesh.Stop()
		<-done
	})
	deadline := time.Now().Add(5 * time.Second)
	for mesh.Addr() == "" {
		if time.Now().After(deadline) {
			t.Fatal("mesh did not bind")
		}
		time.Sleep(10 * time.Millisecond)
	}

	conn, err := grpc.NewClient(mesh.Addr(), grpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	client := syncmeshb.NewSyncMeshClient(conn)
	return mesh, func(messageID, recipient, value string) {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if _, err := client.Publish(ctx, &syncmeshb.PublishRequest{
			MessageId: messageID,
			Recipient: recipient,
			Value:     []byte(value),
		}); err != nil {
			t.Fatalf("publish: %v", err)
		}
	}
}

// TestSyncPushesEndpointListsAddressedMessages is the browser contract: the
// endpoint reports what was addressed on this Phi, with sender and recipient
// intact so the UI can show the direction.
func TestSyncPushesEndpointListsAddressedMessages(t *testing.T) {
	mesh, publish := startTestMesh(t)
	publish("m-1", "pane-b", "hello from a")
	app := &Server{syncMesh: mesh}

	rec := httptest.NewRecorder()
	app.handleSyncPushes(rec, httptest.NewRequest(http.MethodGet, "/api/sync/pushes", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}

	var body []SyncPushMessage
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(body) != 1 {
		t.Fatalf("got %d messages, want 1", len(body))
	}
	got := body[0]
	if got.MessageID != "m-1" || got.Recipient != "pane-b" || got.Value != "hello from a" {
		t.Fatalf("message = %+v", got)
	}
	if got.Sender == "" {
		t.Fatal("sender is empty; the UI cannot show a direction")
	}
}

// TestSyncPushesTruncatesLargeValues proves a huge message cannot make the
// list response unbounded, and that truncation is stated rather than hidden.
func TestSyncPushesTruncatesLargeValues(t *testing.T) {
	big := strings.Repeat("a", maxSyncPushValueBytes+100)
	mesh, publish := startTestMesh(t)
	publish("m-big", "pane-b", big)
	app := &Server{syncMesh: mesh}

	rec := httptest.NewRecorder()
	app.handleSyncPushes(rec, httptest.NewRequest(http.MethodGet, "/api/sync/pushes", nil))

	var body []SyncPushMessage
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(body) != 1 {
		t.Fatalf("got %d messages, want 1", len(body))
	}
	if !body[0].Truncated {
		t.Fatal("oversized value was not marked truncated")
	}
	if len(body[0].Value) != maxSyncPushValueBytes {
		t.Fatalf("value length = %d, want %d", len(body[0].Value), maxSyncPushValueBytes)
	}
}

// TestSyncPushesTruncatesOnARuneBoundary keeps a truncated value valid UTF-8.
// Cutting at a byte offset splits the last character, so the browser showed a
// replacement glyph and the message looked corrupted, not shortened.
func TestSyncPushesTruncatesOnARuneBoundary(t *testing.T) {
	// Three-byte runes straddle the limit: 1366 runes fill 4098 bytes, so the
	// cut at 4096 lands inside the 1366th character.
	big := strings.Repeat("世", maxSyncPushValueBytes/3+1)
	mesh, publish := startTestMesh(t)
	publish("m-rune", "pane-b", big)
	app := &Server{syncMesh: mesh}

	rec := httptest.NewRecorder()
	app.handleSyncPushes(rec, httptest.NewRequest(http.MethodGet, "/api/sync/pushes", nil))

	var body []SyncPushMessage
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	got := body[0]
	if !got.Truncated {
		t.Fatal("oversized value was not marked truncated")
	}
	if !utf8.ValidString(got.Value) {
		t.Fatal("truncated value is not valid UTF-8; the browser renders U+FFFD")
	}
	if len(got.Value) > maxSyncPushValueBytes {
		t.Fatalf("value = %d bytes, want at most %d", len(got.Value), maxSyncPushValueBytes)
	}
}

// TestSyncPushesListsTheNewestWindow proves the list is the newest messages
// and not the first ones: the panel exists to show what just arrived, so an
// overflowing hub must drop the oldest entries, and the sequence must keep
// rising so the browser can order messages that share a timestamp.
func TestSyncPushesListsTheNewestWindow(t *testing.T) {
	mesh, publish := startTestMesh(t)
	published := maxSyncPushList + 5
	for i := 1; i <= published; i++ {
		publish(fmt.Sprintf("m-%03d", i), "pane-b", "body")
	}
	app := &Server{syncMesh: mesh}

	rec := httptest.NewRecorder()
	app.handleSyncPushes(rec, httptest.NewRequest(http.MethodGet, "/api/sync/pushes", nil))

	var body []SyncPushMessage
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(body) != maxSyncPushList {
		t.Fatalf("got %d messages, want %d", len(body), maxSyncPushList)
	}
	if body[0].MessageID != "m-006" {
		t.Fatalf("oldest listed = %s, want m-006", body[0].MessageID)
	}
	last := body[len(body)-1]
	if last.MessageID != fmt.Sprintf("m-%03d", published) {
		t.Fatalf("newest listed = %s, want m-%03d", last.MessageID, published)
	}
	if last.Seq <= body[0].Seq {
		t.Fatalf("sequence did not rise: first %d, last %d", body[0].Seq, last.Seq)
	}
}

// TestSyncPushesWithoutMeshIsEmpty proves the endpoint degrades quietly when
// the mesh is off, instead of failing or reporting an error.
func TestSyncPushesWithoutMeshIsEmpty(t *testing.T) {
	app := &Server{}
	rec := httptest.NewRecorder()
	app.handleSyncPushes(rec, httptest.NewRequest(http.MethodGet, "/api/sync/pushes", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	var body []SyncPushMessage
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(body) != 0 {
		t.Fatalf("got %d messages, want none", len(body))
	}
}

// TestSyncPushesRejectsNonGET guards the method contract.
func TestSyncPushesRejectsNonGET(t *testing.T) {
	app := &Server{}
	rec := httptest.NewRecorder()
	app.handleSyncPushes(rec, httptest.NewRequest(http.MethodPost, "/api/sync/pushes", nil))
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("status = %d, want 405", rec.Code)
	}
}
