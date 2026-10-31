package dshweb

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"
)

// A spawn barrier reproduces Stop winning after exec starts but before
// Starter.Start returns. The old path never installed a Wait owner.
type gatedStarter struct {
	*fakeStarter
	entered chan struct{}
	release chan struct{}
}

func (g *gatedStarter) Start(command string, args []string, dir string, env []string) (Process, io.ReadCloser, io.ReadCloser, error) {
	close(g.entered)
	<-g.release
	return g.fakeStarter.Start(command, args, dir, env)
}
func TestStopDuringSpawnJoinsWaitOwner(t *testing.T) {
	starter := &fakeStarter{}
	defer releaseOnKill(starter)()
	gate := &gatedStarter{starter, make(chan struct{}), make(chan struct{})}
	s := NewService(ServiceConfig{Enabled: true, Command: "/fixture/dsh", Origin: testOrigin(t), DataDir: t.TempDir(), Starter: gate}, allowAll, func() uint64 { return 1 })
	s.Start()
	<-gate.entered
	done := make(chan struct{})
	go func() { s.Stop(); close(done) }()
	<-s.ctx.Done()
	close(gate.release)
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("Stop did not join the spawn/Wait owner")
	}
	select {
	case <-starter.Proc().waited:
	default:
		t.Fatal("spawned child was not waited")
	}
	s.Start()
	s.Stop()
	if starter.Calls() != 1 {
		t.Fatal("Start after Stop spawned another child")
	}
}
func TestConcurrentStartStopIsOneShot(t *testing.T) {
	starter := &fakeStarter{}
	defer releaseOnKill(starter)()
	s := NewService(ServiceConfig{Enabled: true, Command: "/fixture/dsh", Origin: testOrigin(t), DataDir: t.TempDir(), Starter: starter}, allowAll, func() uint64 { return 1 })
	var workers sync.WaitGroup
	for i := 0; i < 20; i++ {
		workers.Add(1)
		go func() { defer workers.Done(); s.Start(); s.Stop() }()
	}
	workers.Wait()
	s.Start()
	s.Stop()
	if starter.Calls() > 1 {
		t.Fatalf("spawned %d children", starter.Calls())
	}
	if s.Status().State != StateStopped {
		t.Fatal("service restarted after shutdown")
	}
}
func TestReadinessStopCancelsSlowHeaders(t *testing.T) {
	entered := make(chan struct{})
	stub := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		close(entered)
		<-r.Context().Done()
	}))
	defer stub.Close()
	starter := &fakeStarter{stdout: fmt.Sprintf("dsh web: %s/?token=x\n", stub.URL)}
	defer releaseOnKill(starter)()
	s := NewService(ServiceConfig{Enabled: true, Command: "/fixture/dsh", Origin: testOrigin(t), DataDir: t.TempDir(), Starter: starter}, allowAll, func() uint64 { return 1 })
	s.Start()
	select {
	case <-entered:
	case <-time.After(3 * time.Second):
		t.Fatal("readiness never dialed")
	}
	done := make(chan struct{})
	go func() { s.Stop(); close(done) }()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("shutdown waited for the 15-second header timeout")
	}
}
func TestReadinessDoesNotWaitForDenialBody(t *testing.T) {
	stub := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("token") != "" {
			name, _ := CookieName("http", r.Host)
			http.SetCookie(w, &http.Cookie{Name: name, Value: "fixture"})
			w.Header().Set("Location", "./")
			w.WriteHeader(http.StatusSeeOther)
		} else {
			w.WriteHeader(http.StatusUnauthorized)
		}
		w.(http.Flusher).Flush()
		<-r.Context().Done()
	}))
	defer stub.Close()
	starter := &fakeStarter{stdout: fmt.Sprintf("dsh web: %s/?token=x\n", stub.URL)}
	defer releaseOnKill(starter)()
	s := NewService(ServiceConfig{Enabled: true, Command: "/fixture/dsh", Origin: testOrigin(t), DataDir: t.TempDir(), Starter: starter}, allowAll, func() uint64 { return 1 })
	defer stopService(s, starter)
	s.Start()
	waitState(t, s, StateReady)
	// Bootstrap must also return after its headers, not hang reading a body.
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	cookie, err := s.BootstrapExchange(ctx, "127.0.0.1:8080")
	if err != nil || ctx.Err() != nil || cookie == nil || cookie.Value != "fixture" {
		t.Fatalf("bootstrap waited for body: cookie=%v err=%v context=%v", cookie, err, ctx.Err())
	}
}
