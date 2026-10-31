//go:build profiling

package diagnostics

import (
	"net/http"
	"net/http/httptest"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/hypernewbie/phi/pkg/obs"
)

// Hold delivery at its first write, without depending on TCP buffer size or
// scheduling within a short deadline. The common transport test checks the
// deadline itself; this test checks the timing handler's lifecycle around it.
type heldTimingWriter struct {
	*httptest.ResponseRecorder
	started chan struct{}
	release chan struct{}
}

func (w *heldTimingWriter) SetWriteDeadline(time.Time) error { return nil }
func (w *heldTimingWriter) Write([]byte) (int, error) {
	close(w.started)
	<-w.release
	return 0, os.ErrDeadlineExceeded
}

func TestTimingDetachesBeforeFailedDeliveryAndReleasesResources(t *testing.T) {
	s := startTestServer(t, currentProcessReaders())
	writer := &heldTimingWriter{
		ResponseRecorder: httptest.NewRecorder(),
		started:          make(chan struct{}),
		release:          make(chan struct{}),
	}
	var release sync.Once
	unblock := func() { release.Do(func() { close(writer.release) }) }
	t.Cleanup(unblock)
	done := make(chan struct{})
	go func() {
		defer close(done)
		s.handleTiming(writer, httptest.NewRequest(http.MethodGet, "/debug/phi/timing?seconds=1", nil))
	}()
	select {
	case <-writer.started:
	case <-time.After(5 * time.Second):
		t.Fatal("timing profile never reached delivery")
	}
	if active, _ := obs.TimingStatus(); active {
		t.Fatal("slow delivery extended timing collection")
	}
	client := profileClient(t)
	if active, _ := timingStatus(t, client, s); active {
		t.Fatal("status reports active during delivery")
	}
	busy := authorizedProfileRequest(t, client, s, "/debug/pprof/heap")
	busy.Body.Close()
	if busy.StatusCode != http.StatusConflict {
		t.Fatalf("delivery must hold the shared slot: got %d", busy.StatusCode)
	}
	snapshot := authorizedProfileRequest(t, client, s, "/debug/phi")
	snapshot.Body.Close()
	if snapshot.StatusCode != http.StatusOK {
		t.Fatalf("snapshot blocked by delivery: %d", snapshot.StatusCode)
	}
	unblock()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("failed delivery did not exit")
	}
	// Headers were committed before the write failed. Never append an error
	// body to this failed binary download or claim it was delivered.
	if writer.Code != http.StatusOK || writer.Body.Len() != 0 || writer.Header().Get("Content-Length") == "" {
		t.Fatalf("failed delivery response: status=%d body=%q headers=%v", writer.Code, writer.Body.String(), writer.Header())
	}
	if len(s.profileSlot) != 0 {
		t.Fatal("failed delivery retained the shared slot")
	}
	assertNoTemporaryProfiles(t, s.Dir())
	retry := authorizedProfileRequest(t, client, s, "/debug/pprof/goroutine")
	retry.Body.Close()
	if retry.StatusCode != http.StatusOK {
		t.Fatalf("retry after failed delivery: %d", retry.StatusCode)
	}
}
