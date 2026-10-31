package main

import (
	"context"
	"encoding/json"
	"net/http"
	"sort"
	"sync"
	"time"

	"github.com/hypernewbie/phi/internal/pibridge"
	pibridgepb "github.com/hypernewbie/phi/internal/pibridge/pb"
)

type testSyncboardMessage struct {
	Key       string `json:"key"`
	Value     string `json:"value"`
	CreatedAt string `json:"created_at"`
	UpdatedAt string `json:"updated_at"`
}

type syncboardGate struct {
	started     chan struct{}
	release     chan struct{}
	startedOnce sync.Once
	releaseOnce sync.Once
}

type testSyncboard struct {
	mu               sync.Mutex
	messages         map[string]testSyncboardMessage
	calls            int
	mutationRequests int
	pending          int
	gate             *syncboardGate
}

func newTestSyncboard() *testSyncboard {
	return &testSyncboard{messages: make(map[string]testSyncboardMessage)}
}

func (s *testSyncboard) holdNext() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.gate != nil {
		return false
	}
	s.gate = &syncboardGate{started: make(chan struct{}), release: make(chan struct{})}
	return true
}

func (s *testSyncboard) release() {
	s.mu.Lock()
	gate := s.gate
	s.mu.Unlock()
	if gate != nil {
		gate.releaseOnce.Do(func() { close(gate.release) })
	}
}

func (s *testSyncboard) stats() (calls, mutations, pending int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.calls, s.mutationRequests, s.pending
}

func (s *testSyncboard) inspect(key string) (testSyncboardMessage, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	message, ok := s.messages[key]
	return message, ok
}

func (s *testSyncboard) handle(ctx context.Context, _ string, req *pibridgepb.SyncboardRequest) *pibridgepb.SyncboardResponse {
	s.mu.Lock()
	s.calls++
	gate := s.gate
	if gate != nil {
		s.pending++
	}
	response := s.respondLocked(req)
	s.mu.Unlock()

	if gate != nil {
		gate.startedOnce.Do(func() { close(gate.started) })
		select {
		case <-gate.release:
		case <-ctx.Done():
			s.mu.Lock()
			s.pending--
			if s.gate == gate {
				s.gate = nil
			}
			s.mu.Unlock()
			return &pibridgepb.SyncboardResponse{
				Outcome: pibridgepb.SyncboardOutcome_SYNCBOARD_OUTCOME_UNKNOWN,
				Reason:  pibridge.SyncboardReasonCancelled,
			}
		}
		s.mu.Lock()
		s.pending--
		if s.gate == gate {
			s.gate = nil
		}
		s.mu.Unlock()
	}
	return response
}

func (s *testSyncboard) respondLocked(req *pibridgepb.SyncboardRequest) *pibridgepb.SyncboardResponse {
	response := func(status int, body []byte) *pibridgepb.SyncboardResponse {
		return &pibridgepb.SyncboardResponse{
			Outcome:    pibridgepb.SyncboardOutcome_SYNCBOARD_OUTCOME_HTTP_RESPONSE,
			HttpStatus: uint32(status),
			BodyJson:   body,
		}
	}
	switch req.GetOperation() {
	case pibridgepb.SyncboardOperation_SYNCBOARD_OPERATION_LIST:
		messages := make([]testSyncboardMessage, 0, len(s.messages))
		for _, message := range s.messages {
			messages = append(messages, message)
		}
		sort.Slice(messages, func(i, j int) bool { return messages[i].Key < messages[j].Key })
		body, _ := json.Marshal(messages)
		return response(http.StatusOK, body)
	case pibridgepb.SyncboardOperation_SYNCBOARD_OPERATION_GET:
		message, ok := s.messages[req.GetKey()]
		if !ok {
			return response(http.StatusNotFound, nil)
		}
		body, _ := json.Marshal(message)
		return response(http.StatusOK, body)
	case pibridgepb.SyncboardOperation_SYNCBOARD_OPERATION_UPSERT:
		s.mutationRequests++
		var value string
		if err := json.Unmarshal(req.GetValueJson(), &value); err != nil {
			value = string(req.GetValueJson())
		}
		now := time.Now().UTC().Format(time.RFC3339Nano)
		message, exists := s.messages[req.GetKey()]
		if !exists {
			message = testSyncboardMessage{Key: req.GetKey(), CreatedAt: now}
		}
		message.Value = value
		message.UpdatedAt = now
		s.messages[message.Key] = message
		body, _ := json.Marshal(message)
		return response(http.StatusOK, body)
	case pibridgepb.SyncboardOperation_SYNCBOARD_OPERATION_DELETE:
		s.mutationRequests++
		if _, exists := s.messages[req.GetKey()]; !exists {
			return response(http.StatusNotFound, nil)
		}
		delete(s.messages, req.GetKey())
		return response(http.StatusOK, nil)
	default:
		return &pibridgepb.SyncboardResponse{
			Outcome: pibridgepb.SyncboardOutcome_SYNCBOARD_OUTCOME_NOT_SENT,
			Reason:  pibridge.SyncboardReasonInvalidRequest,
		}
	}
}

func (s *testSyncboard) waitUntilStarted(ctx context.Context) bool {
	s.mu.Lock()
	gate := s.gate
	s.mu.Unlock()
	if gate == nil {
		return false
	}
	select {
	case <-gate.started:
		return true
	case <-ctx.Done():
		return false
	}
}
