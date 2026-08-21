package rpc

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// fakeProc implements Cmd with pipe-backed stdio.
type fakeProc struct {
	stdoutR  io.ReadCloser
	stdoutW  io.WriteCloser
	stdinR   io.ReadCloser
	stdinW   io.WriteCloser
	commands chan map[string]any
}

func newFakeProc() *fakeProc {
	sr, sw := io.Pipe()
	ir, iw := io.Pipe()
	commands := make(chan map[string]any, 8)
	go func() {
		defer close(commands)
		decoder := json.NewDecoder(ir)
		for {
			var command map[string]any
			if err := decoder.Decode(&command); err != nil {
				return
			}
			commands <- command
		}
	}()
	return &fakeProc{stdoutR: sr, stdoutW: sw, stdinR: ir, stdinW: iw, commands: commands}
}

// Kill: no-op; the rpcExited broadcast is what tests assert.
func (f *fakeProc) Kill() error { return nil }

// Wait: never called on fakes in P0 tests.
func (f *fakeProc) Wait() error { return nil }

type failingStdin struct{}

func (failingStdin) Write([]byte) (int, error) { return 0, io.ErrClosedPipe }
func (failingStdin) Close() error              { return nil }

type trackingCmd struct {
	killed bool
}

func (c *trackingCmd) Wait() error { return nil }
func (c *trackingCmd) Kill() error {
	c.killed = true
	return nil
}

func TestManagerSpawnReadLoopAndKill(t *testing.T) {
	fp := newFakeProc()
	m := NewManager()
	m.spawnFn = func(SpawnOptions) (Cmd, WriteCloser, ReadCloser, error) {
		return fp, fp.stdinW, fp.stdoutR, nil
	}
	inst, err := m.Spawn(SpawnOptions{Cwd: "/w/demo"})
	if err != nil {
		t.Fatal(err)
	}
	sub := inst.Subscribe()
	go func() {
		_, _ = fp.stdoutW.Write([]byte(
			`{"type":"message_end","message":{"role":"assistant","content":"hello"}}` + "\n"))
	}()
	e := <-sub.Channel()
	if e.Evt != EvtMessageEnd || e.Seq != 1 {
		t.Fatalf("bad event %+v", e)
	}
	if len(inst.SnapshotCopy().Messages) != 1 {
		t.Fatal("message not appended to snapshot")
	}
	if err := m.Kill(inst.ID); err != nil {
		t.Fatal(err)
	}
	e2 := <-sub.Channel()
	if e2.Evt != EvtRpcExited {
		t.Fatalf("want rpcExited, got %+v", e2)
	}
	if inst.IsAlive() {
		t.Fatal("instance should be dead")
	}
}

func TestManagerSpawnSeedsDeepCopiedSnapshot(t *testing.T) {
	fp := newFakeProc()
	m := NewManagerWithSpawner(func(SpawnOptions) (Cmd, WriteCloser, ReadCloser, error) {
		return fp, fp.stdinW, fp.stdoutR, nil
	})
	initial := []Message{{Role: "user", Content: []byte(`"saved"`)}}
	inst, err := m.Spawn(SpawnOptions{
		Cwd:             "/w/resume",
		SessionPath:     "/sessions/resume.jsonl",
		InitialMessages: initial,
	})
	if err != nil {
		t.Fatal(err)
	}
	initial[0].Role = "changed"
	initial[0].Content[1] = 'x'
	snap := inst.SnapshotCopy()
	if snap.LastSeq != 0 || len(snap.Messages) != 1 {
		t.Fatalf("unexpected seeded snapshot: %+v", snap)
	}
	if snap.Messages[0].Role != "user" || string(snap.Messages[0].Content) != `"saved"` {
		t.Fatalf("seeded snapshot was not copied: %+v", snap.Messages[0])
	}
	snap.Messages[0].Content[1] = 'x'
	if got := string(inst.SnapshotCopy().Messages[0].Content); got != `"saved"` {
		t.Fatalf("SnapshotCopy returned aliased content: %q", got)
	}
	if inst.SessionPathCopy() != "/sessions/resume.jsonl" {
		t.Fatalf("unexpected session path: %q", inst.SessionPathCopy())
	}
}

func TestManagerSpawnReusesLiveSessionPathConcurrently(t *testing.T) {
	var calls atomic.Int32
	m := NewManagerWithSpawner(func(SpawnOptions) (Cmd, WriteCloser, ReadCloser, error) {
		calls.Add(1)
		fp := newFakeProc()
		return fp, fp.stdinW, fp.stdoutR, nil
	})
	const workers = 16
	instances := make(chan *Instance, workers)
	errs := make(chan error, workers)
	var wg sync.WaitGroup
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			inst, err := m.Spawn(SpawnOptions{Cwd: "/w/resume", SessionPath: "/sessions/resume.jsonl"})
			if err != nil {
				errs <- err
				return
			}
			instances <- inst
		}()
	}
	wg.Wait()
	close(instances)
	close(errs)
	for err := range errs {
		t.Fatal(err)
	}
	var first *Instance
	for inst := range instances {
		if first == nil {
			first = inst
		} else if inst != first {
			t.Fatalf("same session path spawned distinct instances")
		}
	}
	if first == nil || calls.Load() != 1 {
		t.Fatalf("want one live child, got instance=%v calls=%d", first != nil, calls.Load())
	}
}

func TestManagerSpawnDeadSessionPathAllowsNewChild(t *testing.T) {
	var calls atomic.Int32
	m := NewManagerWithSpawner(func(SpawnOptions) (Cmd, WriteCloser, ReadCloser, error) {
		calls.Add(1)
		fp := newFakeProc()
		return fp, fp.stdinW, fp.stdoutR, nil
	})
	first, err := m.Spawn(SpawnOptions{Cwd: "/w/resume", SessionPath: "/sessions/resume.jsonl"})
	if err != nil {
		t.Fatal(err)
	}
	first.OnExit("dead")
	second, err := m.Spawn(SpawnOptions{Cwd: "/w/resume", SessionPath: "/sessions/resume.jsonl"})
	if err != nil {
		t.Fatal(err)
	}
	if first == second || calls.Load() != 2 {
		t.Fatalf("dead session path was reused: first=%p second=%p calls=%d", first, second, calls.Load())
	}
	if got := len(m.List()); got != 1 || m.List()[0] != second {
		t.Fatalf("dead child was not evicted from manager: list=%v", m.List())
	}
}

func TestManagerSpawnEmptyPathAlwaysCreatesChild(t *testing.T) {
	var calls atomic.Int32
	m := NewManagerWithSpawner(func(SpawnOptions) (Cmd, WriteCloser, ReadCloser, error) {
		calls.Add(1)
		fp := newFakeProc()
		return fp, fp.stdinW, fp.stdoutR, nil
	})
	first, err := m.Spawn(SpawnOptions{Cwd: "/w/new"})
	if err != nil {
		t.Fatal(err)
	}
	second, err := m.Spawn(SpawnOptions{Cwd: "/w/new"})
	if err != nil {
		t.Fatal(err)
	}
	if first == second || calls.Load() != 2 {
		t.Fatalf("empty session paths were reused: first=%p second=%p calls=%d", first, second, calls.Load())
	}
}

func TestManagerSpawnBootstrapFailureKillsAndRemovesReservation(t *testing.T) {
	cmd := &trackingCmd{}
	m := NewManagerWithSpawner(func(SpawnOptions) (Cmd, WriteCloser, ReadCloser, error) {
		stdoutR, stdoutW := io.Pipe()
		_ = stdoutW
		return cmd, failingStdin{}, stdoutR, nil
	})
	lease, err := m.BeginSpawn(context.Background(), SpawnOptions{
		Cwd:         "/w/fail",
		SessionPath: "/sessions/fail.jsonl",
	})
	if err != nil {
		t.Fatal(err)
	}
	bootstrapErr := errors.New("bootstrap failed")
	if err := m.FinishSpawn(lease, bootstrapErr); err != bootstrapErr {
		t.Fatalf("want bootstrap error, got %v", err)
	}
	if !cmd.killed {
		t.Fatal("bootstrap failure did not kill child")
	}
	if got := len(m.List()); got != 0 {
		t.Fatalf("failed bootstrap left %d instances", got)
	}
	if _, err := m.BeginSpawn(context.Background(), SpawnOptions{
		Cwd:         "/w/fail",
		SessionPath: "/sessions/fail.jsonl",
	}); err != nil {
		t.Fatalf("failed reservation was not released: %v", err)
	}
}

func TestManagerSpawnRequiresCwd(t *testing.T) {
	if _, err := NewManager().Spawn(SpawnOptions{}); err != ErrEmptyCwd {
		t.Fatalf("want ErrEmptyCwd got %v", err)
	}
}

func TestManagerLookupUnknown(t *testing.T) {
	if _, err := NewManager().Lookup("nope"); err == nil {
		t.Fatal("expected error")
	}
}

func TestManagerListCreationOrdered(t *testing.T) {
	m := NewManager()
	for _, dir := range []string{"/w/a", "/w/b"} {
		fp := newFakeProc()
		m.spawnFn = func(SpawnOptions) (Cmd, WriteCloser, ReadCloser, error) {
			return fp, fp.stdinW, fp.stdoutR, nil
		}
		if _, err := m.Spawn(SpawnOptions{Cwd: dir}); err != nil {
			t.Fatal(err)
		}
	}
	got := m.List()
	if len(got) != 2 || got[0].CreatedAt.After(got[1].CreatedAt) {
		t.Fatalf("want creation order, got %+v", got)
	}
}

func TestBeginSpawnWaitsForCreatorBeforeReusingSessionPath(t *testing.T) {
	var calls atomic.Int32
	m := NewManagerWithSpawner(func(SpawnOptions) (Cmd, WriteCloser, ReadCloser, error) {
		calls.Add(1)
		fp := newFakeProc()
		return fp, fp.stdinW, fp.stdoutR, nil
	})
	const path = "/sessions/pending.jsonl"
	creator, err := m.BeginSpawn(context.Background(), SpawnOptions{Cwd: "/w/pending", SessionPath: path})
	if err != nil || !creator.Created() {
		t.Fatalf("creator lease = %#v err=%v", creator, err)
	}
	defer creator.Instance().Kill()
	waiterDone := make(chan struct {
		lease *SpawnLease
		err   error
	}, 1)
	go func() {
		lease, waitErr := m.BeginSpawn(context.Background(), SpawnOptions{Cwd: "/w/pending", SessionPath: path})
		waiterDone <- struct {
			lease *SpawnLease
			err   error
		}{lease, waitErr}
	}()
	select {
	case result := <-waiterDone:
		t.Fatalf("reservation was returned before bootstrap finished: %#v", result)
	case <-time.After(30 * time.Millisecond):
	}
	if calls.Load() != 1 {
		t.Fatalf("same-path waiter spawned another child: %d", calls.Load())
	}
	if err := m.FinishSpawn(creator, nil); err != nil {
		t.Fatal(err)
	}
	select {
	case result := <-waiterDone:
		if result.err != nil {
			t.Fatal(result.err)
		}
		if result.lease == nil || result.lease.Created() || result.lease.Instance() != creator.Instance() {
			t.Fatalf("waiter did not receive reused published instance: %#v", result.lease)
		}
	case <-time.After(time.Second):
		t.Fatal("same-path waiter did not receive creator outcome")
	}
}

func TestBeginSpawnWaiterReceivesCreatorFailureWithoutSecondChild(t *testing.T) {
	var calls atomic.Int32
	m := NewManagerWithSpawner(func(SpawnOptions) (Cmd, WriteCloser, ReadCloser, error) {
		calls.Add(1)
		fp := newFakeProc()
		return fp, fp.stdinW, fp.stdoutR, nil
	})
	const path = "/sessions/failure.jsonl"
	creator, err := m.BeginSpawn(context.Background(), SpawnOptions{Cwd: "/w/failure", SessionPath: path})
	if err != nil {
		t.Fatal(err)
	}
	waiterDone := make(chan error, 1)
	go func() {
		_, waitErr := m.BeginSpawn(context.Background(), SpawnOptions{Cwd: "/w/failure", SessionPath: path})
		waiterDone <- waitErr
	}()
	// Let the waiter enter the reservation before publishing the failure;
	// otherwise a scheduler could start it after the reservation is removed.
	time.Sleep(30 * time.Millisecond)
	bootstrapErr := errors.New("bootstrap unavailable")
	if err := m.FinishSpawn(creator, bootstrapErr); err != bootstrapErr {
		t.Fatalf("FinishSpawn error = %v, want %v", err, bootstrapErr)
	}
	select {
	case waitErr := <-waiterDone:
		if waitErr != bootstrapErr {
			t.Fatalf("waiter error = %v, want creator error %v", waitErr, bootstrapErr)
		}
	case <-time.After(time.Second):
		t.Fatal("failure waiter did not receive creator outcome")
	}
	if calls.Load() != 1 || len(m.List()) != 0 {
		t.Fatalf("failure spawned/published extra child: calls=%d list=%d", calls.Load(), len(m.List()))
	}
}

func TestManagerSessionPathUpdateChangesDedupOwnership(t *testing.T) {
	var calls atomic.Int32
	m := NewManagerWithSpawner(func(SpawnOptions) (Cmd, WriteCloser, ReadCloser, error) {
		calls.Add(1)
		fp := newFakeProc()
		return fp, fp.stdinW, fp.stdoutR, nil
	})
	first, err := m.Spawn(SpawnOptions{Cwd: "/w/path", SessionPath: "/sessions/old.jsonl"})
	if err != nil {
		t.Fatal(err)
	}
	defer first.Kill()
	m.UpdateSessionPath(first, "/sessions/new.jsonl")
	oldLease, err := m.BeginSpawn(context.Background(), SpawnOptions{Cwd: "/w/path", SessionPath: "/sessions/old.jsonl"})
	if err != nil || !oldLease.Created() {
		t.Fatalf("old path unexpectedly reused after update: lease=%#v err=%v", oldLease, err)
	}
	defer oldLease.Instance().Kill()
	if err := m.FinishSpawn(oldLease, nil); err != nil {
		t.Fatal(err)
	}
	newLease, err := m.BeginSpawn(context.Background(), SpawnOptions{Cwd: "/w/path", SessionPath: "/sessions/new.jsonl"})
	if err != nil {
		t.Fatal(err)
	}
	if newLease.Created() || newLease.Instance() != first {
		t.Fatalf("new path did not reuse synchronized owner: created=%v instance=%p first=%p", newLease.Created(), newLease.Instance(), first)
	}
	if calls.Load() != 2 {
		t.Fatalf("unexpected child count after path ownership update: %d", calls.Load())
	}
}

func TestManagerDetachGraceCancelsAndExpires(t *testing.T) {
	m := NewManagerWithSpawner(func(SpawnOptions) (Cmd, WriteCloser, ReadCloser, error) {
		fp := newFakeProc()
		return fp, fp.stdinW, fp.stdoutR, nil
	})
	m.detachGrace = 20 * time.Millisecond
	inst, err := m.Spawn(SpawnOptions{Cwd: "/w/grace"})
	if err != nil {
		t.Fatal(err)
	}
	first := m.Subscribe(inst)
	if first == nil {
		t.Fatal("first subscription was not created")
	}
	first.CloseThis()
	second := m.Subscribe(inst)
	if second == nil {
		t.Fatal("reconnection was not created")
	}
	time.Sleep(40 * time.Millisecond)
	if _, err := m.Lookup(inst.ID); err != nil {
		t.Fatalf("reconnection did not cancel detach timer: %v", err)
	}
	second.CloseThis()
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		if _, err := m.Lookup(inst.ID); err != nil {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("detach grace did not evict the instance")
}

func TestManagerNaturalExitEvictsInstance(t *testing.T) {
	child := newFakeProc()
	m := NewManagerWithSpawner(func(SpawnOptions) (Cmd, WriteCloser, ReadCloser, error) {
		return child, child.stdinW, child.stdoutR, nil
	})
	inst, err := m.Spawn(SpawnOptions{Cwd: "/w/natural-exit"})
	if err != nil {
		t.Fatal(err)
	}
	if err := child.stdoutW.Close(); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		if _, err := m.Lookup(inst.ID); err != nil {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("natural child exit did not evict the instance")
}

func TestManagerPublishesAfterCreatorSubscriptionClosesAndArmsGrace(t *testing.T) {
	m := NewManagerWithSpawner(func(SpawnOptions) (Cmd, WriteCloser, ReadCloser, error) {
		fp := newFakeProc()
		return fp, fp.stdinW, fp.stdoutR, nil
	})
	m.detachGrace = 20 * time.Millisecond
	lease, err := m.BeginSpawn(context.Background(), SpawnOptions{Cwd: "/w/creator-close"})
	if err != nil {
		t.Fatal(err)
	}
	sub := m.Subscribe(lease.Instance())
	if sub == nil {
		t.Fatal("creator subscription was not created")
	}
	sub.CloseThis()
	if err := m.FinishSpawn(lease, nil); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		if _, err := m.Lookup(lease.Instance().ID); err != nil {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("published creator child did not enter detach grace")
}

func TestManagerKillEvictsPendingDetachTimer(t *testing.T) {
	m := NewManagerWithSpawner(func(SpawnOptions) (Cmd, WriteCloser, ReadCloser, error) {
		fp := newFakeProc()
		return fp, fp.stdinW, fp.stdoutR, nil
	})
	m.detachGrace = 200 * time.Millisecond
	inst, err := m.Spawn(SpawnOptions{Cwd: "/w/kill-detach"})
	if err != nil {
		t.Fatal(err)
	}
	sub := m.Subscribe(inst)
	if sub == nil {
		t.Fatal("subscription was not created")
	}
	sub.CloseThis()
	if err := m.Kill(inst.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := m.Lookup(inst.ID); err == nil {
		t.Fatal("killed instance remained discoverable")
	}
	time.Sleep(250 * time.Millisecond)
	if _, err := m.Lookup(inst.ID); err == nil {
		t.Fatal("stopped detach timer later revived or retained killed instance")
	}
}

func TestManagerStaleDetachExpiryAfterReplacementIsHarmless(t *testing.T) {
	m := NewManagerWithSpawner(func(SpawnOptions) (Cmd, WriteCloser, ReadCloser, error) {
		fp := newFakeProc()
		return fp, fp.stdinW, fp.stdoutR, nil
	})
	m.detachGrace = 100 * time.Millisecond
	inst, err := m.Spawn(SpawnOptions{Cwd: "/w/stale-detach"})
	if err != nil {
		t.Fatal(err)
	}
	first := m.Subscribe(inst)
	if first == nil {
		t.Fatal("first subscription was not created")
	}
	first.CloseThis()
	m.subMu.Lock()
	oldGeneration := m.detachGenerations[inst]
	m.subMu.Unlock()
	second := m.Subscribe(inst)
	if second == nil {
		t.Fatal("replacement subscription was not created")
	}
	second.CloseThis()
	m.expireDetach(inst, oldGeneration)
	if _, err := m.Lookup(inst.ID); err != nil {
		t.Fatalf("stale detach expiry evicted current instance: %v", err)
	}
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		if _, err := m.Lookup(inst.ID); err != nil {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("current replacement detach timer did not eventually evict instance")
}

func TestManagerDetachOverflowArmsGrace(t *testing.T) {
	m := NewManagerWithSpawner(func(SpawnOptions) (Cmd, WriteCloser, ReadCloser, error) {
		fp := newFakeProc()
		return fp, fp.stdinW, fp.stdoutR, nil
	})
	m.detachGrace = 20 * time.Millisecond
	inst, err := m.Spawn(SpawnOptions{Cwd: "/w/overflow"})
	if err != nil {
		t.Fatal(err)
	}
	sub := m.Subscribe(inst)
	if sub == nil {
		t.Fatal("subscription was not created")
	}
	for i := 0; i < 257; i++ {
		inst.Emit(EvtStateChanged, nil, nil)
	}
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		if _, err := m.Lookup(inst.ID); err != nil {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("overflow did not start detach grace")
}
