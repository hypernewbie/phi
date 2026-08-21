//go:build integration

package ws

import (
	"encoding/json"
	"os/exec"
	"testing"
	"time"

	"github.com/hypernewbie/phi/pkg/rpc"
)

func TestControlE2ERealPi(t *testing.T) {
	if _, err := exec.LookPath("pi"); err != nil {
		t.Skip("pi not on PATH")
	}
	c := helloDial(t, rpc.NewManager())

	// spawn via the control op (full production path).
	if err := c.WriteJSON(Envelope{Type: "call", ID: "sp", Op: "spawn",
		Args: []byte(`{"cwd":` + jsonString(t.TempDir()) + `}`)}); err != nil {
		t.Fatal(err)
	}
	var spawnRes Envelope
	if err := c.ReadJSON(&spawnRes); err != nil {
		t.Fatal(err)
	}
	if spawnRes.Ok == nil || !*spawnRes.Ok {
		t.Fatalf("spawn failed: %+v", spawnRes)
	}
	var sp struct {
		Sid string `json:"sid"`
	}
	if err := json.Unmarshal(spawnRes.Data, &sp); err != nil {
		t.Fatal(err)
	}
	if sp.Sid == "" {
		t.Fatalf("no sid in spawn res: %s", spawnRes.Data)
	}

	// prompt -> messageEnd event over the socket.
	if err := c.WriteJSON(Envelope{Type: "call", ID: "p1", Op: "prompt",
		Sid: sp.Sid, Args: []byte(`{"message":"Reply with the single word: pong"}`)}); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(60 * time.Second)
	for {
		if time.Now().After(deadline) {
			t.Fatal("no messageEnd within 60s")
		}
		_ = c.SetReadDeadline(deadline)
		var env Envelope
		if err := c.ReadJSON(&env); err != nil {
			t.Fatal(err)
		}
		if env.Type == "evt" && env.Evt == "messageEnd" && env.Sid == sp.Sid {
			return // pass
		}
	}
}

func jsonString(s string) string {
	b, _ := json.Marshal(s)
	return string(b)
}
