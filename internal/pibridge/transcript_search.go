package pibridge

import (
	"context"
	"fmt"
	"regexp"
	"slices"
	"strconv"
	"unicode/utf8"

	pibridgepb "github.com/hypernewbie/phi/internal/pibridge/pb"
)

// TranscriptSearchRequest names one bounded page in the active branch.
// Initial pages use empty origin fields; continuations echo the first page.
type TranscriptSearchRequest struct {
	Query        string
	SessionID    string
	AnchorLeafID string
	StartIndex   uint32
	Initial      bool
}

type transcriptSearchWaiter struct {
	ch        chan TranscriptSearchResult
	request   TranscriptSearchRequest
	sessionID string
}

// TranscriptSearchMatch is a bounded visible-text match from one Pi entry.
type TranscriptSearchMatch struct {
	EntryID string `json:"entry_id"`
	Role    string `json:"role"`
	Snippet string `json:"snippet"`
}

// TranscriptSearchResult is one validated response, stamped with the peer
// that answered so callers can fence the result against pane replacement.
type TranscriptSearchResult struct {
	SessionID    string
	AnchorLeafID string
	NextIndex    uint32
	Matches      []TranscriptSearchMatch
	Complete     bool
	Unavailable  bool
	ProcessID    string
	Generation   uint64
}

// IsTranscriptSearchQuery applies the shared UTF-8 and Unicode code-point
// bounds before a request reaches a Pi runtime.
func IsTranscriptSearchQuery(query string) bool {
	return utf8.ValidString(query) && query != "" && len(query) <= maxTranscriptQueryBytes && utf8.RuneCountInString(query) <= maxTranscriptQueryRunes
}

func validTranscriptSearchIdentity(value string, allowEmpty bool) bool {
	return (allowEmpty || value != "") && utf8.ValidString(value) && len(value) <= maxTranscriptIdentityBytes
}

func validateTranscriptSearchRequest(req TranscriptSearchRequest) error {
	if !IsTranscriptSearchQuery(req.Query) {
		return fmt.Errorf("pibridge: invalid transcript query")
	}
	if req.Initial {
		if req.SessionID != "" || req.AnchorLeafID != "" || req.StartIndex != 0 {
			return fmt.Errorf("pibridge: invalid initial transcript cursor")
		}
		return nil
	}
	if !validTranscriptSearchIdentity(req.SessionID, false) || !validTranscriptSearchIdentity(req.AnchorLeafID, false) || req.StartIndex == 0 {
		return fmt.Errorf("pibridge: invalid transcript continuation")
	}
	return nil
}

func unavailableTranscriptSearch(sessionID, anchorLeafID string, start uint32, processID string, generation uint64) TranscriptSearchResult {
	return TranscriptSearchResult{
		SessionID: sessionID, AnchorLeafID: anchorLeafID,
		NextIndex: start, Matches: []TranscriptSearchMatch{},
		Unavailable: true, ProcessID: processID, Generation: generation,
	}
}

func validateTranscriptSearchResponse(req TranscriptSearchRequest, sessionID, requestID string, res *pibridgepb.TranscriptSearchResponse) ([]TranscriptSearchMatch, bool) {
	if res == nil || res.GetRequestId() != requestID || res.GetSessionId() != sessionID ||
		!validTranscriptSearchIdentity(res.GetAnchorLeafId(), true) ||
		uint64(res.GetNextIndex()) < uint64(req.StartIndex) ||
		uint64(res.GetNextIndex()) > uint64(req.StartIndex)+maxTranscriptSearchEntries ||
		len(res.GetMatches()) > maxTranscriptSearchMatches ||
		(res.GetComplete() && res.GetUnavailable()) {
		return nil, false
	}
	if req.Initial {
		if res.GetAnchorLeafId() == "" && !res.GetUnavailable() &&
			(!res.GetComplete() || res.GetNextIndex() != 0 || len(res.GetMatches()) != 0) {
			return nil, false
		}
	} else if res.GetAnchorLeafId() != req.AnchorLeafID {
		return nil, false
	}
	if res.GetUnavailable() {
		return []TranscriptSearchMatch{}, res.GetNextIndex() == req.StartIndex && len(res.GetMatches()) == 0
	}
	if !res.GetComplete() && res.GetNextIndex() <= req.StartIndex {
		return nil, false
	}
	matches := make([]TranscriptSearchMatch, 0, len(res.GetMatches()))
	seen := make(map[string]struct{}, len(res.GetMatches()))
	pattern := regexp.MustCompile("(?i)" + regexp.QuoteMeta(req.Query))
	for _, match := range res.GetMatches() {
		entryID, role, snippet := match.GetEntryId(), match.GetRole(), match.GetSnippet()
		if !validTranscriptSearchIdentity(entryID, false) ||
			!utf8.ValidString(snippet) || snippet == "" || len(snippet) > maxTranscriptSnippetBytes ||
			(role != "user" && role != "assistant" && role != "toolResult") ||
			!pattern.MatchString(snippet) {
			return nil, false
		}
		if _, duplicate := seen[entryID]; duplicate {
			return nil, false
		}
		seen[entryID] = struct{}{}
		matches = append(matches, TranscriptSearchMatch{EntryID: entryID, Role: role, Snippet: snippet})
	}
	return matches, true
}

// RequestTranscriptSearch asks one capability-negotiated peer for a bounded
// active-branch page. Every generation, session, and peer is fenced before
// dispatch and again before a reply can fulfill the waiter.
func (s *Server) RequestTranscriptSearch(ctx context.Context, processID string, expectedGeneration uint64, req TranscriptSearchRequest) (TranscriptSearchResult, error) {
	if err := ctx.Err(); err != nil {
		return TranscriptSearchResult{}, err
	}
	if err := validateTranscriptSearchRequest(req); err != nil {
		return TranscriptSearchResult{}, err
	}
	l, ok := s.reg.lookupByProcess(processID)
	if !ok {
		return TranscriptSearchResult{}, fmt.Errorf("pibridge: unknown process")
	}
	id := "t" + strconv.FormatUint(s.transcriptSeq.Add(1), 10)
	l.mu.Lock()
	p := l.peer
	if p == nil || l.state == leaseRevoked {
		l.mu.Unlock()
		return TranscriptSearchResult{}, fmt.Errorf("pibridge: no live peer")
	}
	if p.generation != expectedGeneration || p.generation != l.maxGen {
		l.mu.Unlock()
		return TranscriptSearchResult{}, fmt.Errorf("pibridge: transcript search generation stale")
	}
	if !slices.Contains(l.caps, CapabilityTranscriptSearch) {
		l.mu.Unlock()
		return TranscriptSearchResult{}, fmt.Errorf("pibridge: transcript search capability not negotiated")
	}
	sessionID := l.sessionID
	if sessionID == "" || (!req.Initial && req.SessionID != sessionID) {
		l.mu.Unlock()
		return TranscriptSearchResult{}, fmt.Errorf("pibridge: transcript search session stale")
	}
	p.transcriptMu.Lock()
	if len(p.transcriptPending) >= maxTranscriptSearchPending {
		p.transcriptMu.Unlock()
		l.mu.Unlock()
		return TranscriptSearchResult{}, fmt.Errorf("pibridge: too many pending transcript searches")
	}
	ch := make(chan TranscriptSearchResult, 1)
	p.transcriptPending[id] = transcriptSearchWaiter{ch: ch, request: req, sessionID: sessionID}
	pane, proc, gen := l.paneID, l.processID, p.generation
	p.transcriptMu.Unlock()
	l.mu.Unlock()

	wireReq := &pibridgepb.TranscriptSearchRequest{
		RequestId: id, Query: req.Query, SessionId: sessionID,
		AnchorLeafId: req.AnchorLeafID, StartIndex: req.StartIndex, Initial: req.Initial,
	}
	if !p.sendNonfatal(&pibridgepb.PhiToPi{
		PaneId: pane, ProcessId: proc, RuntimeGeneration: gen,
		Payload: &pibridgepb.PhiToPi_TranscriptSearchRequest{TranscriptSearchRequest: wireReq},
	}) {
		p.transcriptMu.Lock()
		delete(p.transcriptPending, id)
		p.transcriptMu.Unlock()
		return TranscriptSearchResult{}, fmt.Errorf("pibridge: transcript search request not admitted")
	}
	select {
	case res := <-ch:
		if err := ctx.Err(); err != nil {
			return TranscriptSearchResult{}, err
		}
		l.mu.Lock()
		current := l.peer == p && p.generation == expectedGeneration && p.generation == l.maxGen &&
			l.state != leaseRevoked && l.sessionID == sessionID
		l.mu.Unlock()
		if !current {
			return TranscriptSearchResult{}, fmt.Errorf("pibridge: transcript search peer replaced")
		}
		return res, nil
	case <-ctx.Done():
		p.transcriptMu.Lock()
		delete(p.transcriptPending, id)
		p.transcriptMu.Unlock()
		return TranscriptSearchResult{}, fmt.Errorf("pibridge: transcript search: %w", ctx.Err())
	case <-p.done:
		p.transcriptMu.Lock()
		delete(p.transcriptPending, id)
		p.transcriptMu.Unlock()
		if err := p.closeErr(); err != nil {
			return TranscriptSearchResult{}, err
		}
		return TranscriptSearchResult{}, fmt.Errorf("pibridge: transcript search peer gone")
	}
}

// deliverTranscriptSearch consumes only a correlated response from the still
// current peer. Malformed search results fail this read without closing the
// lifecycle stream.
func (s *Server) deliverTranscriptSearch(l *lease, p *peer, res *pibridgepb.TranscriptSearchResponse) {
	if res.GetRequestId() == "" {
		return
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.peer != p || l.state == leaseRevoked || p.generation != l.maxGen {
		return
	}
	p.transcriptMu.Lock()
	waiter, ok := p.transcriptPending[res.GetRequestId()]
	if ok {
		delete(p.transcriptPending, res.GetRequestId())
	}
	p.transcriptMu.Unlock()
	if !ok {
		return
	}
	matches, valid := validateTranscriptSearchResponse(waiter.request, waiter.sessionID, res.GetRequestId(), res)
	result := unavailableTranscriptSearch(waiter.sessionID, waiter.request.AnchorLeafID, waiter.request.StartIndex, l.processID, p.generation)
	if valid {
		result = TranscriptSearchResult{
			SessionID: res.GetSessionId(), AnchorLeafID: res.GetAnchorLeafId(),
			NextIndex: res.GetNextIndex(), Matches: matches,
			Complete: res.GetComplete(), Unavailable: res.GetUnavailable(),
			ProcessID: l.processID, Generation: p.generation,
		}
	}
	select {
	case waiter.ch <- result:
	default:
	}
}
