package server

import (
	"bytes"
	"encoding/json"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

const (
	syncTopicsPeerQueueFrames = 16
	syncTopicsPeerQueueBytes  = 256 * 1024
)

type syncTopicPeerWrite struct {
	data    []byte
	kind    string
	control string
}

// syncTopicPeerWriter is the only application-data writer on its stream.
// The in-flight frame stays charged until its bounded write completes.
// Heartbeats use WebSocket control frames, not this application queue.
// A failed control enqueue closes the stream; the cohort ledger retains the
// control/result for recovery. A failed batch enqueue leaves its reservation
// at the coordinator for a later pump.
type syncTopicPeerWriter struct {
	ws *websocket.Conn

	mu      sync.Mutex
	queue   []*syncTopicPeerWrite
	bytes   int
	active  *syncTopicPeerWrite
	stopped bool
	wake    chan struct{}
	done    chan struct{}
}

func newSyncTopicPeerWriter(ws *websocket.Conn) *syncTopicPeerWriter {
	w := &syncTopicPeerWriter{ws: ws, wake: make(chan struct{}, 1), done: make(chan struct{})}
	go w.run()
	return w
}

func (w *syncTopicPeerWriter) enqueue(frame syncTopicPeerFrame) error {
	data, err := json.Marshal(frame)
	if err != nil {
		return err
	}
	if err := validatePeerFrameSize(data); err != nil {
		return err
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.stopped {
		return errSyncTopicPeerNotReady
	}
	for _, pending := range w.queue {
		if bytes.Equal(pending.data, data) {
			return nil
		}
	}
	if len(w.queue) >= syncTopicsPeerQueueFrames || len(data) > syncTopicsPeerQueueBytes-w.bytes {
		return errSyncTopicCapacity
	}
	w.queue = append(w.queue, &syncTopicPeerWrite{data: data, kind: frame.Type, control: frame.Control})
	w.bytes += len(data)
	select {
	case w.wake <- struct{}{}:
	default:
	}
	return nil
}

// confirmControl removes unsent retries after their matching result arrives.
// A write already in progress cannot be recalled; the coordinator checks its
// sequence and fingerprint before returning the retained result.
func (w *syncTopicPeerWriter) confirmControl(control string) {
	w.mu.Lock()
	defer w.mu.Unlock()
	kept := w.queue[:0]
	for _, pending := range w.queue {
		if pending != w.active && pending.kind == "control" && pending.control == control {
			w.bytes -= len(pending.data)
			continue
		}
		kept = append(kept, pending)
	}
	clear(w.queue[len(kept):])
	w.queue = kept
}

func (w *syncTopicPeerWriter) close() {
	_ = w.ws.Close()
	w.mu.Lock()
	w.stopped = true
	w.mu.Unlock()
	select {
	case w.wake <- struct{}{}:
	default:
	}
	<-w.done
}

func (w *syncTopicPeerWriter) run() {
	defer close(w.done)
	defer w.ws.Close()
	defer func() {
		w.mu.Lock()
		w.stopped = true
		w.queue = nil
		w.active = nil
		w.bytes = 0
		w.mu.Unlock()
	}()
	for range w.wake {
		for {
			w.mu.Lock()
			if w.stopped {
				w.mu.Unlock()
				return
			}
			if len(w.queue) == 0 {
				w.mu.Unlock()
				break
			}
			pending := w.queue[0]
			w.active = pending
			w.mu.Unlock()
			_ = w.ws.SetWriteDeadline(time.Now().Add(syncTopicsPeerControlTimeout))
			if err := w.ws.WriteMessage(websocket.TextMessage, pending.data); err != nil {
				return
			}
			w.mu.Lock()
			w.bytes -= len(pending.data)
			w.queue[0] = nil
			w.queue = w.queue[1:]
			w.active = nil
			w.mu.Unlock()
		}
	}
}
