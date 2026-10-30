package pibridge

import (
	"context"
	"encoding/hex"
	"math"
	"slices"
	"strconv"
	"strings"
	"unicode/utf8"

	pibridgepb "github.com/hypernewbie/phi/internal/pibridge/pb"
)

const (
	maxAttachmentTextBytes = 64 * 1024
	maxAttachmentRefs      = 8
	maxAttachmentBaseBytes = 128
	maxAttachmentRefBytes  = 25 << 20
)

// AttachmentRef is a process-root basename and a content fence, never a
// browser-supplied path.
type AttachmentRef struct {
	Basename  string
	SizeBytes uint64
	MIMEType  string
	Kind      string
	SHA256    string
}

type AttachmentPromptResult struct {
	RequestID string
	Outcome   pibridgepb.AttachmentPromptOutcome
	Reason    string
}

type AttachmentPromptRefusal struct{ Reason string }

func (e *AttachmentPromptRefusal) Error() string { return "pibridge: attachment prompt refused" }

type AttachmentPromptUnknown struct{ RequestID string }

func (e *AttachmentPromptUnknown) Error() string {
	return "pibridge: attachment prompt outcome unknown"
}

type attachmentPromptOp struct {
	id         string
	peer       *peer
	generation uint64
	ch         chan AttachmentPromptResult
}

func validAttachmentIdentity(s string, allowEmpty bool) bool {
	if allowEmpty && s == "" {
		return true
	}
	return len(s) > 0 && len(s) <= maxCompactIdentityChars && utf8.ValidString(s)
}

func validAttachmentBasename(name string) bool {
	if name == "" || len(name) > maxAttachmentBaseBytes || strings.Contains(name, "..") || strings.ContainsAny(name, `/\\`) {
		return false
	}
	for _, r := range name {
		if !((r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '.' || r == '_' || r == '-') {
			return false
		}
	}
	return name != "." && name != ".."
}

func validAttachmentRef(ref AttachmentRef) bool {
	if !validAttachmentBasename(ref.Basename) || ref.SizeBytes > maxAttachmentRefBytes {
		return false
	}
	if len(ref.SHA256) != 64 {
		return false
	}
	if _, err := hex.DecodeString(ref.SHA256); err != nil || strings.ToLower(ref.SHA256) != ref.SHA256 {
		return false
	}
	switch ref.Kind {
	case "image":
		return ref.SizeBytes > 0 && (ref.MIMEType == "image/png" || ref.MIMEType == "image/jpeg") && filepathImageExtension(ref.Basename, ref.MIMEType)
	case "file":
		return ref.MIMEType == "application/octet-stream"
	default:
		return false
	}
}

func filepathImageExtension(name, mime string) bool {
	if mime == "image/png" {
		return strings.HasSuffix(name, ".png")
	}
	return strings.HasSuffix(name, ".jpg")
}

func attachmentReadiness(snap *pibridgepb.StateSnapshot) *pibridgepb.AttachmentReadiness {
	if snap == nil {
		return nil
	}
	return snap.GetAttachmentReadiness()
}

// RequestAttachmentPrompt asks the current Pi process to submit one complete
// user message. A matching ack means the public host call returned normally;
// it does not mean that Pi accepted the input or that a provider got it.
func (s *Server) RequestAttachmentPrompt(ctx context.Context, processID string, generation uint64, sessionID, leafID string, model *pibridgepb.ModelSnapshot, text string, refs []AttachmentRef, imageRequired bool) (AttachmentPromptResult, error) {
	if err := ctx.Err(); err != nil {
		return AttachmentPromptResult{}, &AttachmentPromptRefusal{Reason: "unavailable"}
	}
	if processID == "" || generation == 0 || !validAttachmentIdentity(sessionID, false) || !validAttachmentIdentity(leafID, true) || len(text) > maxAttachmentTextBytes || !utf8.ValidString(text) || len(refs) < 1 || len(refs) > maxAttachmentRefs {
		return AttachmentPromptResult{}, &AttachmentPromptRefusal{Reason: "invalid-item"}
	}
	if model != nil && (!validAttachmentIdentity(model.GetProvider(), false) || !validAttachmentIdentity(model.GetModel(), false)) {
		return AttachmentPromptResult{}, &AttachmentPromptRefusal{Reason: "stale"}
	}
	seen := make(map[string]struct{}, len(refs))
	wireRefs := make([]*pibridgepb.AttachmentRef, 0, len(refs))
	for _, ref := range refs {
		if !validAttachmentRef(ref) {
			return AttachmentPromptResult{}, &AttachmentPromptRefusal{Reason: "invalid-item"}
		}
		if _, duplicate := seen[ref.Basename]; duplicate {
			return AttachmentPromptResult{}, &AttachmentPromptRefusal{Reason: "invalid-item"}
		}
		seen[ref.Basename] = struct{}{}
		wireRefs = append(wireRefs, &pibridgepb.AttachmentRef{
			Basename: ref.Basename, SizeBytes: ref.SizeBytes, MimeType: ref.MIMEType,
			Kind: ref.Kind, Sha256: ref.SHA256,
		})
	}
	l, ok := s.reg.lookupByProcess(processID)
	if !ok {
		return AttachmentPromptResult{}, &AttachmentPromptRefusal{Reason: "unavailable"}
	}
	id, allocated := s.allocAttachmentID()
	if !allocated {
		return AttachmentPromptResult{}, &AttachmentPromptRefusal{Reason: "unavailable"}
	}
	requestID := strconv.FormatUint(id, 10)
	l.mu.Lock()
	p := l.peer
	if l.processID != processID || l.maxGen != generation || p == nil || l.state == leaseRevoked || p.generation != generation {
		l.mu.Unlock()
		return AttachmentPromptResult{}, &AttachmentPromptRefusal{Reason: "stale"}
	}
	if !slices.Contains(l.caps, CapabilityAttachments) {
		l.mu.Unlock()
		return AttachmentPromptResult{}, &AttachmentPromptRefusal{Reason: "unavailable"}
	}
	snap := l.lastState
	if snap == nil || snap.GetAttachmentReadiness() == nil {
		l.mu.Unlock()
		return AttachmentPromptResult{}, &AttachmentPromptRefusal{Reason: "unavailable"}
	}
	if snap.GetSessionId() != sessionID || snap.GetLeafId() != leafID || !sameAttachmentModel(snap.GetModel(), model) {
		l.mu.Unlock()
		return AttachmentPromptResult{}, &AttachmentPromptRefusal{Reason: "stale"}
	}
	ready := snap.GetAttachmentReadiness()
	if !ready.GetIdle() || snap.GetState() == pibridgepb.LogicalState_LOGICAL_STATE_RUNNING {
		l.mu.Unlock()
		return AttachmentPromptResult{}, &AttachmentPromptRefusal{Reason: "busy"}
	}
	if ready.GetHasPendingMessages() {
		l.mu.Unlock()
		return AttachmentPromptResult{}, &AttachmentPromptRefusal{Reason: "queued"}
	}
	if ready.GetCompactionActive() {
		l.mu.Unlock()
		return AttachmentPromptResult{}, &AttachmentPromptRefusal{Reason: "compaction-active"}
	}
	if ready.GetBridgePending() || l.compact != nil || l.attachment != nil {
		l.mu.Unlock()
		return AttachmentPromptResult{}, &AttachmentPromptRefusal{Reason: "pending"}
	}
	if imageRequired && (ready.ImageAvailable == nil || !ready.GetImageAvailable()) {
		l.mu.Unlock()
		return AttachmentPromptResult{}, &AttachmentPromptRefusal{Reason: "unsupported-model"}
	}
	op := &attachmentPromptOp{id: requestID, peer: p, generation: generation, ch: make(chan AttachmentPromptResult, 1)}
	l.attachment = op
	pane, proc := l.paneID, l.processID
	l.mu.Unlock()

	request := &pibridgepb.PhiToPi{
		PaneId: pane, ProcessId: proc, RuntimeGeneration: generation,
		Payload: &pibridgepb.PhiToPi_AttachmentPromptRequest{AttachmentPromptRequest: &pibridgepb.AttachmentPromptRequest{
			RequestId: requestID, ExpectedSessionId: sessionID, ExpectedLeafId: leafID,
			ExpectedModel: model, Text: text, Attachments: wireRefs,
		}},
	}
	if !p.sendNonfatal(request) {
		l.mu.Lock()
		if l.attachment == op {
			l.attachment = nil
		}
		l.mu.Unlock()
		return AttachmentPromptResult{}, &AttachmentPromptRefusal{Reason: "unavailable"}
	}
	select {
	case result := <-op.ch:
		if err := ctx.Err(); err != nil {
			clearAttachmentWaiter(l, op)
			return AttachmentPromptResult{}, &AttachmentPromptUnknown{RequestID: requestID}
		}
		l.mu.Lock()
		current := l.peer == p && p.generation == l.maxGen && l.state != leaseRevoked
		l.mu.Unlock()
		if !current {
			clearAttachmentWaiter(l, op)
			return AttachmentPromptResult{}, &AttachmentPromptUnknown{RequestID: requestID}
		}
		return result, nil
	case <-ctx.Done():
		clearAttachmentWaiter(l, op)
		return AttachmentPromptResult{}, &AttachmentPromptUnknown{RequestID: requestID}
	case <-p.done:
		clearAttachmentWaiter(l, op)
		return AttachmentPromptResult{}, &AttachmentPromptUnknown{RequestID: requestID}
	}
}

func sameAttachmentModel(current *pibridgepb.ModelSnapshot, expected *pibridgepb.ModelSnapshot) bool {
	if current == nil || expected == nil {
		return current == nil && expected == nil
	}
	return current.GetProvider() == expected.GetProvider() && current.GetModel() == expected.GetModel()
}

func clearAttachmentWaiter(l *lease, op *attachmentPromptOp) {
	l.mu.Lock()
	if l.attachment == op {
		l.attachment = nil
	}
	l.mu.Unlock()
}

func (s *Server) allocAttachmentID() (uint64, bool) {
	for {
		cur := s.attachmentSeq.Load()
		if cur == math.MaxUint64 {
			return 0, false
		}
		if s.attachmentSeq.CompareAndSwap(cur, cur+1) {
			return cur + 1, true
		}
	}
}

func (s *Server) deliverAttachmentPrompt(l *lease, p *peer, ack *pibridgepb.AttachmentPromptAck) {
	if ack.GetRequestId() == "" {
		return
	}
	var reason string
	switch ack.GetOutcome() {
	case pibridgepb.AttachmentPromptOutcome_ATTACHMENT_PROMPT_OUTCOME_REFUSED:
		if !safeAttachmentReason(ack.GetReason()) {
			return
		}
		reason = ack.GetReason()
	case pibridgepb.AttachmentPromptOutcome_ATTACHMENT_PROMPT_OUTCOME_DISPATCHED:
		if ack.GetReason() != "" {
			return
		}
	case pibridgepb.AttachmentPromptOutcome_ATTACHMENT_PROMPT_OUTCOME_UNKNOWN:
		if ack.GetReason() != "" && ack.GetReason() != "uncertain" {
			return
		}
		reason = ack.GetReason()
	default:
		return
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	op := l.attachment
	if l.peer != p || l.state == leaseRevoked || p.generation != l.maxGen || op == nil || op.peer != p || op.id != ack.GetRequestId() {
		return
	}
	l.attachment = nil
	result := AttachmentPromptResult{RequestID: op.id, Outcome: ack.GetOutcome(), Reason: reason}
	select {
	case op.ch <- result:
	default:
	}
}

func safeAttachmentReason(reason string) bool {
	switch reason {
	case "unavailable", "stale", "busy", "queued", "compaction-active", "pending", "command", "unsupported-image", "unsupported-model", "missing-item", "invalid-item", "limit", "storage", "uncertain", "error":
		return true
	default:
		return false
	}
}
