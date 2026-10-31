// Command testserver is the M1 Go ↔ TypeScript interop harness. It owns one
// local IPC endpoint and bridge Server, then executes JSON control ops from
// stdin and reports JSON results on stdout. Request IDs cross the control
// surface as decimal strings to preserve uint64 range. Never log tokens.
package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strconv"
	"sync"
	"time"

	"github.com/hypernewbie/phi/internal/pibridge"
	pibridgepb "github.com/hypernewbie/phi/internal/pibridge/pb"
)

type request struct {
	Op            string                 `json:"op"`
	Pane          string                 `json:"pane"`
	Process       string                 `json:"process"`
	Count         int                    `json:"count"`
	Generation    uint64                 `json:"generation"`
	Revision      uint64                 `json:"revision"`
	RunID         uint64                 `json:"runId"`
	ContextRev    uint64                 `json:"contextRev"`
	TimeoutMs     int                    `json:"timeoutMs"`
	Call          string                 `json:"call"`
	Session       string                 `json:"session"`
	Leaf          string                 `json:"leaf"`
	Provider      string                 `json:"provider"`
	Model         string                 `json:"model"`
	Text          string                 `json:"text"`
	ImageRequired bool                   `json:"imageRequired"`
	Attachments   []attachmentRefRequest `json:"attachments"`
	Key           string                 `json:"key"`
}

type attachmentRefRequest struct {
	Basename  string `json:"basename"`
	SizeBytes uint64 `json:"size_bytes"`
	MIMEType  string `json:"mime_type"`
	Kind      string `json:"kind"`
	SHA256    string `json:"sha256"`
}

type response struct {
	OK                 bool                  `json:"ok"`
	Error              string                `json:"error,omitempty"`
	Code               int                   `json:"code,omitempty"`
	Process            string                `json:"process,omitempty"`
	Token              string                `json:"token,omitempty"`
	Sent               int                   `json:"sent,omitempty"`
	Active             int                   `json:"active,omitempty"`
	Leases             int                   `json:"leases,omitempty"`
	HasPeer            bool                  `json:"hasPeer,omitempty"`
	HasState           bool                  `json:"hasState,omitempty"`
	State              int32                 `json:"state,omitempty"`
	Revision           string                `json:"revision,omitempty"`
	JournalFirst       string                `json:"journalFirst,omitempty"`
	JournalLast        string                `json:"journalLast,omitempty"`
	JournalGap         bool                  `json:"journalGap,omitempty"`
	Generation         string                `json:"generation,omitempty"`
	RuntimeID          string                `json:"runtimeId,omitempty"`
	PubRev             string                `json:"pubRev,omitempty"`
	Call               string                `json:"call,omitempty"`
	Outcome            string                `json:"outcome,omitempty"`
	Reason             string                `json:"reason,omitempty"`
	RequestID          string                `json:"requestId,omitempty"`
	Caps               []string              `json:"caps,omitempty"`
	Session            string                `json:"session,omitempty"`
	Leaf               string                `json:"leaf,omitempty"`
	Model              string                `json:"model,omitempty"`
	SyncboardCalls     int                   `json:"syncboardCalls,omitempty"`
	SyncboardMutations int                   `json:"syncboardMutations,omitempty"`
	SyncboardPending   int                   `json:"syncboardPending,omitempty"`
	SyncboardMessage   *testSyncboardMessage `json:"syncboardMessage,omitempty"`
}

func fail(format string, args ...any) response {
	return response{OK: false, Error: fmt.Sprintf(format, args...)}
}

// compactCall tracks one in-flight RequestCompact. Dispatch is async
// because the control loop is sequential: tests must issue a second
// dispatch while the first is still held to prove pending refusal.
type compactCall struct {
	done chan compactOutcome
}

type compactOutcome struct {
	result pibridge.CompactResult
	err    error
}

func clampTimeout(ms int) time.Duration {
	if ms <= 0 || ms > 30_000 {
		return 5 * time.Second
	}
	return time.Duration(ms) * time.Millisecond
}

func compactResponse(out compactOutcome) response {
	if out.err == nil {
		return response{OK: true, RequestID: out.result.RequestID, Outcome: out.result.Outcome.String(), Reason: out.result.Reason}
	}
	var refusal *pibridge.CompactRefusal
	var unknown *pibridge.CompactUnknown
	switch {
	case errors.As(out.err, &refusal):
		return response{OK: false, Error: "refusal:" + refusal.Reason}
	case errors.As(out.err, &unknown):
		return response{OK: false, Error: "unknown:" + unknown.RequestID, RequestID: unknown.RequestID}
	default:
		return response{OK: false, Error: "unavailable:" + out.err.Error()}
	}
}

type reloadCall struct {
	done chan reloadOutcome
}

type reloadOutcome struct {
	result pibridge.ReloadResult
	err    error
}

func reloadResponse(out reloadOutcome) response {
	if out.err == nil {
		return response{OK: true, RequestID: out.result.RequestID, Outcome: out.result.Outcome.String(), Reason: out.result.Reason}
	}
	var refusal *pibridge.ReloadRefusal
	var unknown *pibridge.ReloadUnknown
	switch {
	case errors.As(out.err, &refusal):
		return response{OK: false, Error: "refusal:" + refusal.Reason}
	case errors.As(out.err, &unknown):
		return response{OK: false, Error: "unknown:" + unknown.RequestID, RequestID: unknown.RequestID}
	default:
		return response{OK: false, Error: "unavailable:" + out.err.Error()}
	}
}

func main() {
	if err := run(); err != nil {
		enc := json.NewEncoder(os.Stdout)
		_ = enc.Encode(fail("%v", err))
		os.Exit(1)
	}
}

func run() error {
	ep, err := pibridge.NewEndpoint()
	if err != nil {
		return err
	}
	lis, err := ep.Listen()
	if err != nil {
		ep.Cleanup()
		return err
	}
	srv := pibridge.NewServer()
	syncboard := newTestSyncboard()
	srv.SetSyncboardHandler(syncboard.handle)
	serveErr := make(chan error, 1)
	go func() { serveErr <- srv.GRPCServer().Serve(lis) }()
	var callsMu sync.Mutex
	calls := map[string]*compactCall{}
	reloadCalls := map[string]*reloadCall{}
	var callSeq uint64
	var reloadCallSeq uint64

	enc := json.NewEncoder(os.Stdout)
	// Ready line first; integration asserts the target shape.
	if err := enc.Encode(map[string]any{"ready": true, "target": ep.Target}); err != nil {
		return err
	}

	scan := bufio.NewScanner(os.Stdin)
	scan.Buffer(make([]byte, 64*1024), 64*1024)
	for scan.Scan() {
		line := scan.Bytes()
		if len(line) == 0 {
			continue
		}
		var req request
		if err := json.Unmarshal(line, &req); err != nil {
			_ = enc.Encode(fail("bad control json: %v", err))
			continue
		}
		switch req.Op {
		case "register":
			proc, token, err := srv.RegisterPending(req.Pane)
			if err != nil {
				_ = enc.Encode(fail("%v", err))
				continue
			}
			_ = enc.Encode(response{OK: true, Process: proc, Token: token})
		case "complete":
			srv.Complete(req.Process)
			_ = enc.Encode(response{OK: true})
		case "revoke":
			srv.Revoke(req.Process)
			_ = enc.Encode(response{OK: true})
		case "flood":
			sent := srv.FloodForTest(req.Process, req.Count)
			_ = enc.Encode(response{OK: true, Sent: sent})
		case "stats":
			active, leases := srv.Stats()
			_ = enc.Encode(response{OK: true, Active: active, Leases: leases})
		case "inspect":
			view, found := srv.InspectForTest(req.Process)
			if !found {
				_ = enc.Encode(fail("unknown process"))
				continue
			}
			_ = enc.Encode(response{
				OK: true, HasPeer: view.HasPeer, HasState: view.HasState,
				State: int32(view.State), Revision: strconv.FormatUint(view.Revision, 10),
				JournalFirst: strconv.FormatUint(view.JournalFirst, 10),
				JournalLast:  strconv.FormatUint(view.JournalLast, 10),
				JournalGap:   view.JournalGap,
				Generation:   strconv.FormatUint(view.Generation, 10), RuntimeID: view.RuntimeID,
				PubRev: strconv.FormatUint(view.PubRev, 10),
				Caps:   view.Caps, Session: view.SessionID, Leaf: view.LeafID, Model: view.Model,
			})
		case "syncboard-hold":
			if !syncboard.holdNext() {
				_ = enc.Encode(fail("Syncboard handler is already held"))
				continue
			}
			_ = enc.Encode(response{OK: true})
		case "syncboard-wait":
			ctx, cancel := context.WithTimeout(context.Background(), clampTimeout(req.TimeoutMs))
			started := syncboard.waitUntilStarted(ctx)
			cancel()
			if !started {
				_ = enc.Encode(fail("Syncboard handler did not start"))
				continue
			}
			_ = enc.Encode(response{OK: true})
		case "syncboard-release":
			syncboard.release()
			_ = enc.Encode(response{OK: true})
		case "syncboard-stats":
			calls, mutations, pending := syncboard.stats()
			_ = enc.Encode(response{OK: true, SyncboardCalls: calls, SyncboardMutations: mutations, SyncboardPending: pending})
		case "syncboard-inspect":
			message, found := syncboard.inspect(req.Key)
			if !found {
				_ = enc.Encode(fail("unknown Syncboard key"))
				continue
			}
			_ = enc.Encode(response{OK: true, SyncboardMessage: &message})
		case "attachment":
			var model *pibridgepb.ModelSnapshot
			if req.Provider != "" || req.Model != "" {
				model = &pibridgepb.ModelSnapshot{Provider: req.Provider, Model: req.Model}
			}
			refs := make([]pibridge.AttachmentRef, 0, len(req.Attachments))
			for _, ref := range req.Attachments {
				refs = append(refs, pibridge.AttachmentRef{
					Basename: ref.Basename, SizeBytes: ref.SizeBytes, MIMEType: ref.MIMEType,
					Kind: ref.Kind, SHA256: ref.SHA256,
				})
			}
			ctx, cancel := context.WithTimeout(context.Background(), clampTimeout(req.TimeoutMs))
			result, err := srv.RequestAttachmentPrompt(ctx, req.Process, req.Generation, req.Session, req.Leaf, model, req.Text, refs, req.ImageRequired)
			cancel()
			if err == nil {
				_ = enc.Encode(response{OK: true, RequestID: result.RequestID, Outcome: result.Outcome.String(), Reason: result.Reason})
				continue
			}
			var refusal *pibridge.AttachmentPromptRefusal
			var unknown *pibridge.AttachmentPromptUnknown
			switch {
			case errors.As(err, &refusal):
				_ = enc.Encode(response{OK: false, Error: "refusal:" + refusal.Reason, Outcome: pibridgepb.AttachmentPromptOutcome_ATTACHMENT_PROMPT_OUTCOME_REFUSED.String(), Reason: refusal.Reason})
			case errors.As(err, &unknown):
				_ = enc.Encode(response{OK: false, Error: "unknown:" + unknown.RequestID, RequestID: unknown.RequestID, Outcome: pibridgepb.AttachmentPromptOutcome_ATTACHMENT_PROMPT_OUTCOME_UNKNOWN.String(), Reason: "uncertain"})
			default:
				_ = enc.Encode(response{OK: false, Error: "unavailable", Outcome: pibridgepb.AttachmentPromptOutcome_ATTACHMENT_PROMPT_OUTCOME_REFUSED.String(), Reason: "unavailable"})
			}
		case "compact":
			callsMu.Lock()
			callSeq++
			id := "c" + strconv.FormatUint(callSeq, 10)
			call := &compactCall{done: make(chan compactOutcome, 1)}
			calls[id] = call
			callsMu.Unlock()
			go func() {
				ctx, cancel := context.WithTimeout(context.Background(), clampTimeout(req.TimeoutMs))
				defer cancel()
				res, err := srv.RequestCompact(ctx, req.Process, req.Generation, req.Revision)
				call.done <- compactOutcome{result: res, err: err}
			}()
			_ = enc.Encode(response{OK: true, Call: id})
		case "compact-wait":
			callsMu.Lock()
			call, ok := calls[req.Call]
			callsMu.Unlock()
			if !ok {
				_ = enc.Encode(fail("unknown call %q", req.Call))
				continue
			}
			select {
			case out := <-call.done:
				callsMu.Lock()
				delete(calls, req.Call)
				callsMu.Unlock()
				_ = enc.Encode(compactResponse(out))
			case <-time.After(clampTimeout(req.TimeoutMs)):
				_ = enc.Encode(fail("wait-timeout"))
			}
		case "reload":
			callsMu.Lock()
			reloadCallSeq++
			id := "r" + strconv.FormatUint(reloadCallSeq, 10)
			call := &reloadCall{done: make(chan reloadOutcome, 1)}
			reloadCalls[id] = call
			process, generation, revision := req.Process, req.Generation, req.Revision
			runID, contextRev, timeoutMs := req.RunID, req.ContextRev, req.TimeoutMs
			callsMu.Unlock()
			go func() {
				ctx, cancel := context.WithTimeout(context.Background(), clampTimeout(timeoutMs))
				defer cancel()
				res, err := srv.RequestReload(ctx, process, generation, revision, runID, contextRev)
				call.done <- reloadOutcome{result: res, err: err}
			}()
			_ = enc.Encode(response{OK: true, Call: id})
		case "reload-wait":
			callsMu.Lock()
			call, ok := reloadCalls[req.Call]
			callsMu.Unlock()
			if !ok {
				_ = enc.Encode(fail("unknown call %q", req.Call))
				continue
			}
			select {
			case out := <-call.done:
				callsMu.Lock()
				delete(reloadCalls, req.Call)
				callsMu.Unlock()
				_ = enc.Encode(reloadResponse(out))
			case <-time.After(clampTimeout(req.TimeoutMs)):
				_ = enc.Encode(fail("wait-timeout"))
			}
		case "shutdown":
			_ = enc.Encode(response{OK: true})
			srv.Stop()
			_ = lis.Close()
			ep.Cleanup()
			return nil
		default:
			_ = enc.Encode(fail("unknown op %q", req.Op))
		}
	}
	if err := scan.Err(); err != nil {
		srv.Stop()
		_ = lis.Close()
		ep.Cleanup()
		return err
	}
	srv.Stop()
	_ = lis.Close()
	ep.Cleanup()
	return nil
}
