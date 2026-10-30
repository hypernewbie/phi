package main

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/hypernewbie/phi/pkg/fswatch"
	"github.com/hypernewbie/phi/pkg/pty"
	"github.com/hypernewbie/phi/pkg/session"
	"github.com/hypernewbie/phi/pkg/ws"
	"github.com/hypernewbie/phi/pkg/ws/wireproto"
)

type observedSessionTitle struct {
	Type      string `json:"type"`
	PaneID    string `json:"pane_id"`
	SessionID string `json:"session_id"`
	Title     string `json:"title"`
	Revision  uint64 `json:"revision"`
}

func piSessionsDirForTest(home, cwd string) string {
	normalized := filepath.ToSlash(filepath.Clean(cwd))
	normalized = strings.ReplaceAll(strings.Trim(normalized, "/"), ":", "-")
	name := "--" + strings.ReplaceAll(normalized, "/", "-") + "--"
	return filepath.Join(home, ".pi", "agent", "sessions", name)
}

func writePiTitleFileForTest(t *testing.T, home, cwd, id string, records ...string) string {
	t.Helper()
	directory := piSessionsDirForTest(home, cwd)
	if err := os.MkdirAll(directory, 0755); err != nil {
		t.Fatal(err)
	}
	header := fmt.Sprintf(`{"type":"session","version":3,"id":%q,"cwd":%q}`, id, cwd)
	lines := append([]string{header}, records...)
	path := filepath.Join(directory, "not-a-timestamp-name.jsonl")
	if err := os.WriteFile(path, []byte(strings.Join(lines, "\n")+"\n"), 0644); err != nil {
		t.Fatal(err)
	}
	return path
}

func appendPiTitleRecordForTest(t *testing.T, path, record string) {
	t.Helper()
	file, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0644)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := file.WriteString(record + "\n"); err != nil {
		_ = file.Close()
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
}

func spawnPiTitlePaneForTest(t *testing.T, manager *pty.Manager, paneID, cwd, sessionID, title string) *pty.PTYInstance {
	t.Helper()
	shell, args := testMainShell()
	inst, err := manager.SpawnWithOptions(context.Background(), cwd, shell, args, "pi", sessionID, pty.SpawnOptions{ID: paneID, Title: title})
	if err != nil {
		t.Fatalf("spawn Pi title test pane %s: %v", paneID, err)
	}
	return inst
}

func addTitleObserver(hub *ws.Hub, paneID string) *ws.Client {
	client := &ws.Client{Send: make(chan []byte, 256)}
	hub.Register(paneID, client)
	return client
}

func waitForPiTitle(t *testing.T, instance *pty.PTYInstance, want string) {
	t.Helper()
	deadline := time.After(3 * time.Second)
	for {
		if got := instance.Snapshot().Title; got == want {
			return
		}
		select {
		case <-deadline:
			t.Fatalf("pane %s title did not become %q; current=%q", instance.ID, want, instance.Snapshot().Title)
		case <-time.After(5 * time.Millisecond):
		}
	}
}

func waitForPiTitleControl(t *testing.T, client *ws.Client, paneID, sessionID, want string) observedSessionTitle {
	t.Helper()
	deadline := time.After(3 * time.Second)
	for {
		select {
		case frame, ok := <-client.Send:
			if !ok {
				t.Fatal("title observer queue closed before update")
			}
			server, err := wireproto.DecodeServerFrame(frame)
			if err != nil || server.GetTitle() == nil {
				continue
			}
			title := server.GetTitle()
			if title.GetPaneId() == paneID && title.GetSessionId() == sessionID && title.GetTitle() == want {
				return observedSessionTitle{
					Type:      "session-title",
					PaneID:    title.GetPaneId(),
					SessionID: title.GetSessionId(),
					Title:     title.GetTitle(),
					Revision:  title.GetRevision(),
				}
			}
		case <-deadline:
			t.Fatalf("pane %s did not receive title control %q", paneID, want)
		}
	}
}

func cleanupPiTitleTest(t *testing.T, manager *pty.Manager, hub *ws.Hub, service *piTerminalTitleService, clients map[string]*ws.Client) {
	t.Helper()
	t.Cleanup(func() {
		if service != nil {
			service.Close()
		}
		for paneID, client := range clients {
			if _, ok := hub.LookupPane(paneID); ok {
				hub.Unregister(paneID, client)
			}
		}
		for _, instance := range manager.ListActive() {
			_ = manager.Kill(instance.ID)
		}
		_ = manager.FlushSaveState()
	})
}

func TestPiTitleServiceSharesReadersAndIsolatesWorktrees(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	cwdA := filepath.Join(t.TempDir(), "worktree-a")
	cwdB := filepath.Join(t.TempDir(), "worktree-b")
	if err := os.MkdirAll(cwdA, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(cwdB, 0755); err != nil {
		t.Fatal(err)
	}
	const sessionID = "same-native-id"
	pathA := writePiTitleFileForTest(t, home, cwdA, sessionID, `{"type":"session_info","name":"Worktree A"}`)
	writePiTitleFileForTest(t, home, cwdB, sessionID, `{"type":"session_info","name":"Worktree B"}`)

	manager := pty.NewManager()
	hub := ws.NewHub(0)
	paneA1 := spawnPiTitlePaneForTest(t, manager, "pane-a1", cwdA, sessionID, "Saved A1")
	paneA2 := spawnPiTitlePaneForTest(t, manager, "pane-a2", cwdA, sessionID, "Saved A2")
	paneB := spawnPiTitlePaneForTest(t, manager, "pane-b", cwdB, sessionID, "Saved B")
	clients := map[string]*ws.Client{
		paneA1.ID: addTitleObserver(hub, paneA1.ID),
		paneA2.ID: addTitleObserver(hub, paneA2.ID),
		paneB.ID:  addTitleObserver(hub, paneB.ID),
	}
	service := newPiTerminalTitleService(manager, hub)
	cleanupPiTitleTest(t, manager, hub, service, clients)
	service.Start()

	service.mu.Lock()
	if len(service.readers) != 2 || service.panes[paneA1.ID].reader != service.panes[paneA2.ID].reader || service.panes[paneA1.ID].reader == service.panes[paneB.ID].reader {
		service.mu.Unlock()
		t.Fatalf("reader grouping did not share same-CWD panes and isolate worktrees: readers=%d", len(service.readers))
	}
	service.mu.Unlock()

	updateA1 := waitForPiTitleControl(t, clients[paneA1.ID], paneA1.ID, sessionID, "Worktree A")
	updateA2 := waitForPiTitleControl(t, clients[paneA2.ID], paneA2.ID, sessionID, "Worktree A")
	updateB := waitForPiTitleControl(t, clients[paneB.ID], paneB.ID, sessionID, "Worktree B")
	if updateA1.Revision != 1 || updateA2.Revision != 1 || updateB.Revision != 1 {
		t.Fatalf("per-pane title revisions A1=%d A2=%d B=%d", updateA1.Revision, updateA2.Revision, updateB.Revision)
	}
	waitForPiTitle(t, paneA1, "Worktree A")
	waitForPiTitle(t, paneA2, "Worktree A")
	waitForPiTitle(t, paneB, "Worktree B")

	appendPiTitleRecordForTest(t, pathA, `{"type":"session_info","name":"Watched update"}`)
	updateA1 = waitForPiTitleControl(t, clients[paneA1.ID], paneA1.ID, sessionID, "Watched update")
	updateA2 = waitForPiTitleControl(t, clients[paneA2.ID], paneA2.ID, sessionID, "Watched update")
	if updateA1.Revision != 2 || updateA2.Revision != 2 || paneB.Snapshot().Title != "Worktree B" {
		t.Fatalf("worktree-scoped watcher title updates A1=%+v A2=%+v B=%q", updateA1, updateA2, paneB.Snapshot().Title)
	}

	if err := manager.FlushSaveState(); err != nil {
		t.Fatal(err)
	}
	saved, err := pty.ReadSavedTabs()
	if err != nil {
		t.Fatal(err)
	}
	titles := make(map[string]pty.PTYInstanceSnapshot)
	for _, tab := range saved {
		titles[tab.ID] = tab.PTYInstanceSnapshot
	}
	for paneID, want := range map[string]string{paneA1.ID: "Watched update", paneA2.ID: "Watched update", paneB.ID: "Worktree B"} {
		wantRevision := uint64(1)
		if paneID == paneA1.ID || paneID == paneA2.ID {
			wantRevision = 2
		}
		if got := titles[paneID]; got.Title != want || got.TitleRevision != wantRevision {
			t.Fatalf("persisted Pi title for %s = %+v, want %q revision %d", paneID, got, want, wantRevision)
		}
	}

	service.Close()
	service.Close()
	select {
	case <-service.workerDone:
	default:
		t.Fatal("title worker did not join during close")
	}
	service.mu.Lock()
	defer service.mu.Unlock()
	if len(service.panes) != 0 || len(service.readers) != 0 || len(service.queue) != 0 {
		t.Fatalf("service close retained state: panes=%d readers=%d queue=%d", len(service.panes), len(service.readers), len(service.queue))
	}
}

func TestPiTitleServiceRecoveryWithoutWatcherDuringContinuousWrites(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	cwd := filepath.Join(t.TempDir(), "continuous-worktree")
	if err := os.MkdirAll(cwd, 0755); err != nil {
		t.Fatal(err)
	}
	const sessionID = "continuous-native-id"
	path := writePiTitleFileForTest(t, home, cwd, sessionID, `{"type":"session_info","name":"Initial"}`)
	manager := pty.NewManager()
	hub := ws.NewHub(0)
	instance := spawnPiTitlePaneForTest(t, manager, "continuous-pane", cwd, sessionID, "Saved placeholder")
	client := addTitleObserver(hub, instance.ID)
	clients := map[string]*ws.Client{instance.ID: client}
	service := newPiTerminalTitleService(manager, hub)
	service.recoveryInterval = 12 * time.Millisecond
	service.watcherFactory = func(func() []string, func(string)) (*fswatch.Watcher, error) {
		return nil, errors.New("injected watcher creation failure")
	}
	cleanupPiTitleTest(t, manager, hub, service, clients)
	service.Start()
	if service.watcher != nil {
		t.Fatal("watcher failure unexpectedly left a watcher active")
	}
	waitForPiTitleControl(t, client, instance.ID, sessionID, "Initial")

	for index := range 8 {
		name := fmt.Sprintf(`{"type":"session_info","name":"burst-%d"}`, index)
		appendPiTitleRecordForTest(t, path, name)
		time.Sleep(7 * time.Millisecond)
	}
	latest := `{"type":"session_info","name":"continuous final"}`
	appendPiTitleRecordForTest(t, path, latest)
	update := waitForPiTitleControl(t, client, instance.ID, sessionID, "continuous final")
	if update.Revision < 2 {
		t.Fatalf("continuous recovery title revision=%d, want at least 2", update.Revision)
	}
	waitForPiTitle(t, instance, "continuous final")

	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	time.Sleep(60 * time.Millisecond)
	if got := instance.Snapshot().Title; got != "continuous final" {
		t.Fatalf("missing file erased the last title: %q", got)
	}

	writePiTitleFileForTest(t, home, cwd, sessionID, `{"type":"session_info","name":"restored after miss"}`)
	waitForPiTitleControl(t, client, instance.ID, sessionID, "restored after miss")
	waitForPiTitle(t, instance, "restored after miss")

	if err := os.Chmod(path, 0000); err != nil {
		t.Fatal(err)
	}
	file, openErr := os.Open(path)
	if openErr == nil {
		_ = file.Close()
		t.Log("filesystem permits opening mode-000 file; unreadable-file assertion unavailable")
	} else {
		time.Sleep(60 * time.Millisecond)
		if got := instance.Snapshot().Title; got != "restored after miss" {
			t.Fatalf("unreadable file erased the last title: %q", got)
		}
	}
	if err := os.Chmod(path, 0644); err != nil {
		t.Fatal(err)
	}

	service.Close()
	service.mu.Lock()
	if len(service.panes) != 0 || len(service.readers) != 0 || len(service.queue) != 0 {
		service.mu.Unlock()
		t.Fatalf("shutdown retained worker state: panes=%d readers=%d queue=%d", len(service.panes), len(service.readers), len(service.queue))
	}
	service.mu.Unlock()
	select {
	case <-service.workerDone:
	case <-time.After(time.Second):
		t.Fatal("watcher-failure recovery worker did not stop")
	}
	service.directoryChanged(filepath.Dir(path))
	service.Register(instance)
	service.mu.Lock()
	if len(service.queue) != 0 || len(service.panes) != 0 {
		service.mu.Unlock()
		t.Fatal("closed service accepted late callback or registration")
	}
	service.mu.Unlock()
}

func TestPiTitleWorkerStepIsFairAndDoesNotBlockPTYOrHTTP(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("PTY shell-output assertion uses a Unix shell")
	}
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	cwd := filepath.Join(t.TempDir(), "fair-worktree")
	if err := os.MkdirAll(cwd, 0755); err != nil {
		t.Fatal(err)
	}
	manager := pty.NewManager()
	hub := ws.NewHub(0)
	first := spawnPiTitlePaneForTest(t, manager, "fair-first", cwd, "first-native", "First saved")
	second := spawnPiTitlePaneForTest(t, manager, "fair-second", cwd, "second-native", "Second saved")
	client := addTitleObserver(hub, first.ID)
	oldManager := ptyManager
	ptyManager = manager
	t.Cleanup(func() { ptyManager = oldManager })
	service := newPiTerminalTitleService(manager, hub)
	service.watcherFactory = func(func() []string, func(string)) (*fswatch.Watcher, error) {
		return nil, errors.New("test does not need filesystem events")
	}
	service.recoveryInterval = time.Hour
	service.Register(first)
	service.Register(second)
	service.mu.Lock()
	firstReader := service.panes[first.ID].reader
	secondReader := service.panes[second.ID].reader
	service.mu.Unlock()
	started := make(chan struct{})
	release := make(chan struct{})
	events := make(chan string, 4)
	var firstCalls atomic.Int32
	var releaseOnce sync.Once
	releaseStep := func() { releaseOnce.Do(func() { close(release) }) }
	service.refreshStep = func(reader *session.PiTitleReader) (session.PiTitleResult, error) {
		if reader == firstReader {
			if firstCalls.Add(1) == 1 {
				events <- "first-step"
				close(started)
				<-release
				return session.PiTitleResult{More: true}, nil
			}
			events <- "first-continuation"
			return session.PiTitleResult{}, nil
		}
		if reader == secondReader {
			events <- "second-step"
			return session.PiTitleResult{}, nil
		}
		return session.PiTitleResult{}, errors.New("unexpected reader")
	}
	clients := map[string]*ws.Client{first.ID: client}
	cleanupPiTitleTest(t, manager, hub, service, clients)
	t.Cleanup(releaseStep)
	service.Start()
	select {
	case <-started:
	case <-time.After(2 * time.Second):
		t.Fatal("first bounded reader step did not start")
	}
	if event := <-events; event != "first-step" {
		t.Fatalf("first worker event=%q", event)
	}

	ws.StartPTYReadLoop(first, hub)
	const outputMarker = "title-worker-output-marker"
	if _, err := first.Pty.Write([]byte("printf 'title-worker-output-marker\\n'\r")); err != nil {
		t.Fatalf("write PTY output probe: %v", err)
	}
	outputDeadline := time.After(3 * time.Second)
	for {
		select {
		case frame, ok := <-client.Send:
			if !ok {
				t.Fatal("PTY output client queue closed")
			}
			if server, err := wireproto.DecodeServerFrame(frame); err == nil && strings.Contains(string(server.GetOutput().GetData()), outputMarker) {
				goto outputReceived
			}
		case <-outputDeadline:
			t.Fatal("PTY output delivery stalled behind a blocked title step")
		}
	}
outputReceived:
	responseDone := make(chan *httptest.ResponseRecorder, 1)
	go func() {
		w := httptest.NewRecorder()
		handleSpawnTerminal(w, httptest.NewRequest(http.MethodGet, "/api/terminals", nil))
		responseDone <- w
	}()
	select {
	case response := <-responseDone:
		if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), second.ID) {
			t.Fatalf("terminal snapshot response while title read blocked: code=%d body=%s", response.Code, response.Body.String())
		}
	case <-time.After(time.Second):
		t.Fatal("HTTP terminal snapshot blocked behind a title reader step")
	}

	releaseStep()
	if event := <-events; event != "second-step" {
		t.Fatalf("fair queue event after release=%q, want second reader", event)
	}
	if event := <-events; event != "first-continuation" {
		t.Fatalf("fair queue continuation event=%q, want first reader after second", event)
	}
}

func TestPiTitleServiceConcurrentCloseWaitsForBlockedWorker(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	cwd := filepath.Join(t.TempDir(), "close-worktree")
	if err := os.MkdirAll(cwd, 0755); err != nil {
		t.Fatal(err)
	}
	manager := pty.NewManager()
	hub := ws.NewHub(0)
	instance := spawnPiTitlePaneForTest(t, manager, "close-pane", cwd, "close-native", "Saved")
	service := newPiTerminalTitleService(manager, hub)
	service.watcherFactory = func(func() []string, func(string)) (*fswatch.Watcher, error) {
		return nil, errors.New("test does not need filesystem events")
	}
	entered := make(chan struct{})
	release := make(chan struct{})
	var releaseOnce sync.Once
	releaseStep := func() { releaseOnce.Do(func() { close(release) }) }
	service.refreshStep = func(*session.PiTitleReader) (session.PiTitleResult, error) {
		close(entered)
		<-release
		return session.PiTitleResult{More: true}, nil
	}
	service.Register(instance)
	cleanupPiTitleTest(t, manager, hub, service, nil)
	t.Cleanup(releaseStep)
	service.Start()
	select {
	case <-entered:
	case <-time.After(2 * time.Second):
		t.Fatal("blocked reader step did not start")
	}

	closeStarted := make(chan struct{}, 2)
	closeDone := make(chan struct{}, 2)
	for range 2 {
		go func() {
			closeStarted <- struct{}{}
			service.Close()
			closeDone <- struct{}{}
		}()
	}
	<-closeStarted
	<-closeStarted
	select {
	case <-closeDone:
		t.Fatal("Close returned before the worker joined")
	case <-time.After(30 * time.Millisecond):
	}
	releaseStep()
	for range 2 {
		select {
		case <-closeDone:
		case <-time.After(time.Second):
			t.Fatal("concurrent Close caller did not wait for cleanup")
		}
	}
	select {
	case <-service.workerDone:
	default:
		t.Fatal("close completed before worker termination")
	}
	service.mu.Lock()
	if len(service.panes) != 0 || len(service.readers) != 0 || len(service.queue) != 0 {
		service.mu.Unlock()
		t.Fatalf("close retained state: panes=%d readers=%d queue=%d", len(service.panes), len(service.readers), len(service.queue))
	}
	service.mu.Unlock()
}

func TestPiTitleServiceOldInFlightResultCannotTargetSameIdentityReplacement(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	cwd := filepath.Join(t.TempDir(), "same-identity-replacement")
	if err := os.MkdirAll(cwd, 0755); err != nil {
		t.Fatal(err)
	}
	const paneID = "same-identity-pane"
	const sessionID = "same-native-id"
	manager := pty.NewManager()
	hub := ws.NewHub(0)
	original := spawnPiTitlePaneForTest(t, manager, paneID, cwd, sessionID, "Original saved")
	client := addTitleObserver(hub, paneID)
	service := newPiTerminalTitleService(manager, hub)
	service.watcherFactory = func(func() []string, func(string)) (*fswatch.Watcher, error) {
		return nil, errors.New("test does not need filesystem events")
	}
	firstStarted := make(chan struct{})
	releaseFirst := make(chan struct{})
	replacementStarted := make(chan struct{})
	releaseReplacement := make(chan struct{})
	var calls atomic.Int32
	service.refreshStep = func(*session.PiTitleReader) (session.PiTitleResult, error) {
		switch calls.Add(1) {
		case 1:
			close(firstStarted)
			<-releaseFirst
			return session.PiTitleResult{Title: "Stale original result", Ready: true, More: true}, nil
		case 2:
			close(replacementStarted)
			<-releaseReplacement
			return session.PiTitleResult{Title: "Replacement native result", Ready: true}, nil
		default:
			return session.PiTitleResult{}, errors.New("unexpected extra title step")
		}
	}
	clients := map[string]*ws.Client{paneID: client}
	cleanupPiTitleTest(t, manager, hub, service, clients)
	var releaseFirstOnce, releaseReplacementOnce sync.Once
	releaseFirstStep := func() { releaseFirstOnce.Do(func() { close(releaseFirst) }) }
	releaseReplacementStep := func() { releaseReplacementOnce.Do(func() { close(releaseReplacement) }) }
	t.Cleanup(func() {
		releaseFirstStep()
		releaseReplacementStep()
	})
	service.Register(original)
	service.Start()
	select {
	case <-firstStarted:
	case <-time.After(2 * time.Second):
		t.Fatal("original reader step did not start")
	}
	service.mu.Lock()
	originalReader := service.panes[paneID].reader
	service.mu.Unlock()

	if err := manager.Kill(original.ID); err != nil {
		t.Fatal(err)
	}
	replacement := spawnPiTitlePaneForTest(t, manager, paneID, cwd, sessionID, "Replacement saved")
	service.Register(replacement)
	service.mu.Lock()
	replacementReader := service.panes[paneID].reader
	replacementTrack := service.panes[paneID]
	service.mu.Unlock()
	if replacementReader != originalReader {
		t.Fatal("same CWD and native ID did not reuse the shared reader")
	}
	if replacementTrack.instance != replacement {
		t.Fatal("replacement instance did not own the registered track")
	}

	releaseFirstStep()
	select {
	case <-replacementStarted:
	case <-time.After(2 * time.Second):
		t.Fatal("replacement's queued reader step did not get its turn")
	}
	if snapshot := replacement.Snapshot(); snapshot.Title != "Replacement saved" || snapshot.TitleRevision != 0 {
		t.Fatalf("old in-flight result mutated replacement before its step: %+v", snapshot)
	}
	select {
	case frame := <-client.Send:
		t.Fatalf("old in-flight result published to replacement: %v", frame)
	default:
	}

	releaseReplacementStep()
	waitForPiTitle(t, replacement, "Replacement native result")
	update := waitForPiTitleControl(t, client, paneID, sessionID, "Replacement native result")
	if update.Revision != 1 {
		t.Fatalf("replacement title revision=%d, want 1", update.Revision)
	}
}

func TestPiTitleServiceReconcileReleasesDeadRemovedAndReplacementReaders(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	cwd := filepath.Join(t.TempDir(), "reconcile-worktree")
	if err := os.MkdirAll(cwd, 0755); err != nil {
		t.Fatal(err)
	}
	manager := pty.NewManager()
	hub := ws.NewHub(0)
	dead := spawnPiTitlePaneForTest(t, manager, "dead-pane", cwd, "dead-native", "Dead title")
	removed := spawnPiTitlePaneForTest(t, manager, "removed-pane", cwd, "removed-native", "Removed title")
	oldInstance := spawnPiTitlePaneForTest(t, manager, "replacement-pane", cwd, "old-native", "Old title")
	service := newPiTerminalTitleService(manager, hub)
	service.Register(dead)
	service.Register(removed)
	service.Register(oldInstance)
	service.mu.Lock()
	deadReader := service.panes[dead.ID].reader
	removedReader := service.panes[removed.ID].reader
	oldReader := service.panes[oldInstance.ID].reader
	oldTrack := service.panes[oldInstance.ID]
	service.mu.Unlock()
	clients := make(map[string]*ws.Client)
	cleanupPiTitleTest(t, manager, hub, service, clients)
	t.Cleanup(func() { _ = manager.Kill(dead.ID) })

	if err := dead.Pty.Kill(); err != nil {
		t.Fatal(err)
	}
	// Kill requests termination; the PTY waiter publishes death asynchronously.
	// Reconcile must see a dead pane, not race that notification.
	deadline := time.After(3 * time.Second)
	for !dead.IsPtyDead() {
		select {
		case <-deadline:
			t.Fatal("killed pane did not become dead")
		case <-time.After(5 * time.Millisecond):
		}
	}
	if err := manager.Kill(removed.ID); err != nil {
		t.Fatal(err)
	}
	if err := manager.Kill(oldInstance.ID); err != nil {
		t.Fatal(err)
	}
	replacement := spawnPiTitlePaneForTest(t, manager, oldInstance.ID, cwd, "new-native", "Replacement saved")
	client := addTitleObserver(hub, replacement.ID)
	clients[replacement.ID] = client
	service.reconcile()

	service.mu.Lock()
	remaining := len(service.panes)
	track := service.panes[replacement.ID]
	oldReadersRetained := service.readers[deadReader] != nil || service.readers[removedReader] != nil || service.readers[oldReader] != nil
	service.mu.Unlock()
	if remaining != 1 || track == nil || track.instance != replacement || track.sessionID != "new-native" || oldReadersRetained {
		t.Fatalf("reconciliation retained stale references: panes=%d track=%+v oldReadersRetained=%v", remaining, track, oldReadersRetained)
	}
	for label, reader := range map[string]*session.PiTitleReader{"dead": deadReader, "removed": removedReader, "replaced": oldReader} {
		if _, err := reader.RefreshStep(); err == nil {
			t.Fatalf("%s reader remained active after reconciliation", label)
		}
	}
	service.publish([]*piTitleTrack{oldTrack}, "Stale result")
	if got := replacement.Snapshot().Title; got != "Replacement saved" {
		t.Fatalf("stale reader changed replacement title to %q", got)
	}
	select {
	case frame := <-client.Send:
		t.Fatalf("stale reader published a control frame to replacement: %v", frame)
	default:
	}
}

func TestPiTitleServiceRecoveryTickPublishesDuringActiveWriteBurst(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	cwd := filepath.Join(t.TempDir(), "watch-burst-worktree")
	if err := os.MkdirAll(cwd, 0755); err != nil {
		t.Fatal(err)
	}
	const sessionID = "watch-burst-native"
	path := writePiTitleFileForTest(t, home, cwd, sessionID, `{"type":"session_info","name":"Initial"}`)
	manager := pty.NewManager()
	hub := ws.NewHub(0)
	instance := spawnPiTitlePaneForTest(t, manager, "watch-burst-pane", cwd, sessionID, "Saved")
	client := addTitleObserver(hub, instance.ID)
	service := newPiTerminalTitleService(manager, hub)
	service.recoveryInterval = 20 * time.Millisecond
	cleanupPiTitleTest(t, manager, hub, service, map[string]*ws.Client{instance.ID: client})
	service.Start()
	service.mu.Lock()
	watcherStarted := service.watcher != nil
	service.mu.Unlock()
	if !watcherStarted {
		t.Fatal("real filesystem watcher was not created")
	}
	waitForPiTitleControl(t, client, instance.ID, sessionID, "Initial")

	stopWriter := make(chan struct{})
	writerDone := make(chan struct{})
	writerErrors := make(chan error, 1)
	var writing atomic.Bool
	t.Cleanup(func() {
		close(stopWriter)
		select {
		case <-writerDone:
		case <-time.After(time.Second):
			t.Error("test file writer did not stop")
		}
	})
	go func() {
		defer close(writerDone)
		writing.Store(true)
		defer writing.Store(false)
		ticker := time.NewTicker(20 * time.Millisecond)
		defer ticker.Stop()
		for range 60 {
			select {
			case <-stopWriter:
				return
			default:
			}
			file, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0644)
			if err != nil {
				select {
				case writerErrors <- err:
				default:
				}
				return
			}
			_, writeErr := file.WriteString(`{"type":"session_info","name":"during-burst"}` + "\n")
			closeErr := file.Close()
			if writeErr != nil || closeErr != nil {
				if writeErr == nil {
					writeErr = closeErr
				}
				select {
				case writerErrors <- writeErr:
				default:
				}
				return
			}
			select {
			case <-stopWriter:
				return
			case <-ticker.C:
			}
		}
	}()

	update := waitForPiTitleControl(t, client, instance.ID, sessionID, "during-burst")
	select {
	case err := <-writerErrors:
		t.Fatalf("write burst failed: %v", err)
	default:
	}
	if !writing.Load() {
		t.Fatal("title arrived only after the continuous write burst stopped")
	}
	if update.Revision != 2 {
		t.Fatalf("recovery-tick title revision=%d, want 2", update.Revision)
	}
}

func TestPiTitleServiceStartupReconcilesRestoredPanes(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	cwd := filepath.Join(t.TempDir(), "restore-worktree")
	if err := os.MkdirAll(cwd, 0755); err != nil {
		t.Fatal(err)
	}
	const sessionID = "restored-native-id"
	writePiTitleFileForTest(t, home, cwd, sessionID, `{"type":"session_info","name":"Restored native title"}`)
	manager := pty.NewManager()
	hub := ws.NewHub(0)
	instance := spawnPiTitlePaneForTest(t, manager, "restored-pane", cwd, sessionID, "Saved title")
	client := addTitleObserver(hub, instance.ID)
	service := newPiTerminalTitleService(manager, hub)
	service.watcherFactory = func(func() []string, func(string)) (*fswatch.Watcher, error) {
		return nil, errors.New("test does not need filesystem events")
	}
	cleanupPiTitleTest(t, manager, hub, service, map[string]*ws.Client{instance.ID: client})
	service.Start()
	waitForPiTitleControl(t, client, instance.ID, sessionID, "Restored native title")
	service.mu.Lock()
	tracked := service.panes[instance.ID]
	service.mu.Unlock()
	if tracked == nil || tracked.instance != instance {
		t.Fatal("startup reconciliation did not register the restored live pane")
	}
}
