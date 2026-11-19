package pibridge

import (
	"errors"
	"testing"
)

func topicAdmissionFixture() (*Server, *lease, SyncboardOwner) {
	l := &lease{
		paneID: "pane", processID: "proc", state: leaseLive, maxGen: 1,
		runtimeID: "runtime", sessionID: "session", caps: []string{CapabilitySyncboardTopics},
		topicEpoch: "epoch", topicBinding: 1, topicNextBinding: 1, peer: &peer{},
	}
	s := &Server{reg: newRegistry(), syncboardTopicEpoch: "epoch"}
	s.reg.byPane[l.paneID], s.reg.byProcess[l.processID] = l, l
	owner := SyncboardOwner{PaneID: l.paneID, ProcessID: l.processID, RuntimeID: l.runtimeID, SessionID: l.sessionID, Generation: l.maxGen}
	return s, l, owner
}

func TestSyncTopicBindRejectsDisplacedRegistryMapping(t *testing.T) {
	s, l, _ := topicAdmissionFixture()
	s.reg.byPane[l.paneID] = &lease{paneID: l.paneID, processID: "replacement"}
	if _, _, err := s.BindSyncboardTopic(l.processID, "epoch"); !errors.Is(err, ErrTopicUnavailable) {
		t.Fatal("a process displaced from its pane obtained a binding")
	}
}

func TestSyncTopicRetirementCallbackRunsOutsideBridgeLocks(t *testing.T) {
	for _, permanent := range []bool{false, true} {
		t.Run(map[bool]string{false: "epoch", true: "authority"}[permanent], func(t *testing.T) {
			s, l, _ := topicAdmissionFixture()
			l.peer = nil
			called := false
			s.SetSyncboardTopicRetireHandler(func(r SyncboardTopicRetirement) {
				called = true
				if !s.topicEpochMu.TryLock() {
					t.Error("retirement callback holds the epoch lock")
				} else {
					s.topicEpochMu.Unlock()
				}
				if !s.reg.mu.TryLock() {
					t.Error("retirement callback holds the registry lock")
				} else {
					s.reg.mu.Unlock()
				}
				if !l.mu.TryLock() {
					t.Error("retirement callback holds the lease lock")
				} else {
					l.mu.Unlock()
				}
			})
			if permanent {
				s.RetireSyncboardTopicBindings("peer-revoked")
			} else {
				s.SetSyncboardTopicEpoch("replacement")
			}
			if !called {
				t.Fatal("binding retirement was not published")
			}
		})
	}
}

func TestSyncTopicAdmissionPinsOnlyCurrentBoundOwners(t *testing.T) {
	cases := []struct {
		name   string
		change func(*Server, *lease)
		valid  bool
	}{
		{"current", func(*Server, *lease) {}, true},
		{"disconnected", func(_ *Server, l *lease) { l.peer = nil }, true},
		{"removed-process", func(s *Server, l *lease) { delete(s.reg.byProcess, l.processID) }, false},
		{"displaced-pane", func(s *Server, l *lease) { s.reg.byPane[l.paneID] = &lease{} }, false},
		{"runtime", func(_ *Server, l *lease) { l.runtimeID = "replacement" }, false},
		{"session", func(_ *Server, l *lease) { l.sessionID = "replacement" }, false},
		{"generation", func(_ *Server, l *lease) { l.maxGen++ }, false},
		{"capability", func(_ *Server, l *lease) { l.caps = nil }, false},
		{"retired", func(_ *Server, l *lease) { l.topicRetiredThrough = l.topicBinding }, false},
		{"withdrawn", func(_ *Server, l *lease) { l.topicWithdrawnGen = l.maxGen }, false},
		{"epoch", func(_ *Server, l *lease) { l.topicEpoch = "replacement" }, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			s, l, owner := topicAdmissionFixture()
			tc.change(s, l)
			called := false
			// Duplicate selections must acquire a shared lease only once.
			err := s.WithSyncboardTopicOwners([]SyncboardOwner{owner, owner}, "epoch", func(valid []SyncboardOwner) error {
				called = true
				if (len(valid) == 2) != tc.valid || (!tc.valid && len(valid) != 0) {
					t.Fatalf("selected %d owners, valid=%v", len(valid), tc.valid)
				}
				if s.reg.mu.TryLock() {
					s.reg.mu.Unlock()
					t.Error("registry replacement can cross admission commit")
				}
				if tc.valid && l.mu.TryLock() {
					l.mu.Unlock()
					t.Error("native identity replacement can cross admission commit")
				}
				for _, selected := range valid {
					if selected != owner {
						t.Error("admission retargeted a captured identity")
					}
				}
				return nil
			})
			if err != nil || !called {
				t.Fatalf("admission did not finish: %v", err)
			}
		})
	}
}

func TestSyncTopicAdmissionOrdersRegistryReplacementAfterCommit(t *testing.T) {
	s, l, owner := topicAdmissionFixture()
	l.peer = nil
	entered, release, committed := make(chan struct{}), make(chan struct{}), make(chan struct{})
	admitted := make(chan error, 1)
	go func() {
		admitted <- s.WithSyncboardTopicOwners([]SyncboardOwner{owner}, "epoch", func(valid []SyncboardOwner) error {
			if len(valid) != 1 {
				return errors.New("current owner was not selected")
			}
			close(entered)
			<-release
			close(committed)
			return nil
		})
	}()
	<-entered
	started, replaced := make(chan struct{}), make(chan error, 1)
	go func() {
		close(started)
		s.Revoke(owner.ProcessID)
		_, _, err := s.RegisterPending(owner.PaneID)
		if err == nil {
			select {
			case <-committed:
			default:
				err = errors.New("registry replacement crossed the admission commit")
			}
		}
		replaced <- err
	}()
	<-started
	close(release)
	if err := <-admitted; err != nil {
		t.Fatal(err)
	}
	if err := <-replaced; err != nil {
		t.Fatal(err)
	}
	if err := s.WithSyncboardTopicOwners([]SyncboardOwner{owner}, "epoch", func(valid []SyncboardOwner) error {
		if len(valid) != 0 {
			t.Fatal("next admission reused the displaced owner")
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}

func TestSyncTopicAdmissionEpochAndCommitRefusals(t *testing.T) {
	s, _, owner := topicAdmissionFixture()
	if err := s.WithSyncboardTopicOwners([]SyncboardOwner{owner}, "stale", func([]SyncboardOwner) error {
		t.Fatal("stale epoch reached commit")
		return nil
	}); !errors.Is(err, ErrTopicUnavailable) {
		t.Fatalf("stale epoch = %v", err)
	}
	refused := errors.New("commit refused")
	if err := s.WithSyncboardTopicOwners([]SyncboardOwner{owner}, "epoch", func([]SyncboardOwner) error { return refused }); err != refused {
		t.Fatal("commit refusal was not preserved")
	}
	// Every refusal must release all locks for the next admission.
	if err := s.WithSyncboardTopicOwners([]SyncboardOwner{owner}, "epoch", func(valid []SyncboardOwner) error {
		if len(valid) != 1 {
			t.Fatal("refusal changed the existing binding")
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}

func TestSyncTopicProcessRevocationPublishesOneRetirement(t *testing.T) {
	s, l, owner := topicAdmissionFixture()
	l.peer = nil
	var got []SyncboardTopicRetirement
	s.SetSyncboardTopicRetireHandler(func(r SyncboardTopicRetirement) {
		got = append(got, r)
		if _, ok := s.reg.lookupByProcess(owner.ProcessID); ok {
			t.Error("retirement callback preceded registry removal")
		}
	})
	s.Revoke(owner.ProcessID)
	s.Revoke(owner.ProcessID)
	if len(got) != 1 || got[0].Owner != owner || got[0].Epoch != "epoch" || got[0].Through != 1 {
		t.Fatalf("revocation published %d retirements, want exactly the captured binding", len(got))
	}
	if l.topicBinding != 0 || l.state != leaseRevoked {
		t.Fatal("revocation retained an active binding")
	}
}
