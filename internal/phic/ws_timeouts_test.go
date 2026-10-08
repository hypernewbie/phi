package phic

import (
	"testing"
	"time"
)

func TestNativeConnectionGraceOutlastsServerHeartbeat(t *testing.T) {
	if paneReadTimeout < 6*time.Minute {
		t.Fatalf("native read grace %v must outlast the server heartbeat grace", paneReadTimeout)
	}
	if paneWriteTimeout < time.Minute {
		t.Fatalf("native write grace %v is too tight for a suspended connection", paneWriteTimeout)
	}
}
