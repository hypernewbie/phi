package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	"github.com/hypernewbie/phi/internal/syncmesh"
	syncmeshb "github.com/hypernewbie/phi/internal/syncmesh/pb"
)

// startTestMesh boots a loopback mesh and publishes one message through the
// real wire, so the endpoint test exercises the same path the browser reads.
func startTestMesh(t *testing.T, messageID, recipient, value string) *syncmesh.Server {
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
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if _, err := syncmeshb.NewSyncMeshClient(conn).Publish(ctx, &syncmeshb.PublishRequest{
		MessageId: messageID,
		Recipient: recipient,
		Value:     []byte(value),
	}); err != nil {
		t.Fatalf("publish: %v", err)
	}
	return mesh
}

// TestSyncPushesEndpointListsAddressedMessages is the browser contract: the
// endpoint reports what was addressed on this Phi, with sender and recipient
// intact so the UI can show the direction.
func TestSyncPushesEndpointListsAddressedMessages(t *testing.T) {
	mesh := startTestMesh(t, "m-1", "pane-b", "hello from a")
	app := &Server{syncMesh: mesh}

	rec := httptest.NewRecorder()
	app.handleSyncPushes(rec, httptest.NewRequest(http.MethodGet, "/api/sync/pushes", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}

	var body struct {
		Messages []SyncPushMessage `json:"messages"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(body.Messages) != 1 {
		t.Fatalf("got %d messages, want 1", len(body.Messages))
	}
	got := body.Messages[0]
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
	mesh := startTestMesh(t, "m-big", "pane-b", big)
	app := &Server{syncMesh: mesh}

	rec := httptest.NewRecorder()
	app.handleSyncPushes(rec, httptest.NewRequest(http.MethodGet, "/api/sync/pushes", nil))

	var body struct {
		Messages []SyncPushMessage `json:"messages"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(body.Messages) != 1 {
		t.Fatalf("got %d messages, want 1", len(body.Messages))
	}
	if !body.Messages[0].Truncated {
		t.Fatal("oversized value was not marked truncated")
	}
	if len(body.Messages[0].Value) != maxSyncPushValueBytes {
		t.Fatalf("value length = %d, want %d", len(body.Messages[0].Value), maxSyncPushValueBytes)
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
	var body struct {
		Messages []SyncPushMessage `json:"messages"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(body.Messages) != 0 {
		t.Fatalf("got %d messages, want none", len(body.Messages))
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
