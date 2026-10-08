package ws

import (
	"testing"
	"time"
)

func TestHeartbeatGraceToleratesBackgroundSuspension(t *testing.T) {
	if pongWait < 5*time.Minute {
		t.Fatalf("heartbeat grace %v is too tight for background suspension", pongWait)
	}
	if pingPeriod != 50*time.Second {
		t.Fatalf("ping cadence changed: %v", pingPeriod)
	}
	if pongWait < 5*pingPeriod {
		t.Fatal("heartbeat grace must tolerate several missed pongs")
	}
	if writeWait < time.Minute {
		t.Fatalf("write grace %v is too tight for a paused reader", writeWait)
	}
}
