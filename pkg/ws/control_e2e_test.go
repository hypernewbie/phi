//go:build integration

package ws

import (
	"os/exec"
	"testing"
	"time"

	"github.com/hypernewbie/phi/pkg/rpc"
	wspb "github.com/hypernewbie/phi/pkg/ws/pb"
)

func TestControlE2ERealPi(t *testing.T) {
	if _, err := exec.LookPath("pi"); err != nil {
		t.Skip("pi not on PATH")
	}
	c := helloDial(t, rpc.NewManager())

	// spawn via the control op (full production path).
	sid := spawnedSid(t, mustCall(t, c, &wspb.ControlCall{
		Id:   "sp",
		Call: &wspb.ControlCall_Spawn{Spawn: &wspb.SpawnCall{Cwd: protoString(t.TempDir())}},
	}))

	// prompt -> messageEnd event over the socket.
	mustCall(t, c, &wspb.ControlCall{
		Id:   "p1",
		Call: &wspb.ControlCall_Prompt{Prompt: &wspb.PromptCall{Sid: sid, Message: "Reply with the single word: pong"}},
	})
	deadline := time.Now().Add(60 * time.Second)
	for {
		if time.Now().After(deadline) {
			t.Fatal("no messageEnd within 60s")
		}
		_ = c.SetReadDeadline(deadline)
		ev := readFrame(t, c).GetEvent()
		if ev != nil && ev.GetSid() == sid && ev.GetMessageEnd() != nil {
			return // pass
		}
	}
}
