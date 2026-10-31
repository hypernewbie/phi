package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/hypernewbie/phi/internal/pibridge"
	pibridgepb "github.com/hypernewbie/phi/internal/pibridge/pb"
)

const piSyncboardHTTPTimeout = 10 * time.Second

func (b *Bridge) handleSyncboard(ctx context.Context, processID string, req *pibridgepb.SyncboardRequest) *pibridgepb.SyncboardResponse {
	refuse := func(reason string) *pibridgepb.SyncboardResponse {
		return &pibridgepb.SyncboardResponse{Outcome: pibridgepb.SyncboardOutcome_SYNCBOARD_OUTCOME_NOT_SENT, Reason: reason}
	}
	b.mu.Lock()
	owned, closed := false, b.closed
	for _, pane := range b.panes {
		if pane.managed && pane.processID == processID {
			owned = true
			break
		}
	}
	var addr *net.TCPAddr
	if b.listenerAddr != nil {
		copy := *b.listenerAddr
		copy.IP = append(net.IP(nil), b.listenerAddr.IP...)
		addr = &copy
	}
	b.mu.Unlock()
	if !owned || closed {
		return refuse(pibridge.SyncboardReasonUnavailable)
	}
	if ctx.Err() != nil {
		return refuse(pibridge.SyncboardReasonCancelled)
	}
	cfg, err := loadConfigWithError()
	if err != nil {
		return refuse(pibridge.SyncboardReasonInvalidConfig)
	}
	if cfg.SyncCoordinator == "" && addr == nil {
		return refuse(pibridge.SyncboardReasonNotReady)
	}
	base, err := parseSyncboardBase(cfg.syncCoordinatorURL(addr))
	if err != nil {
		return refuse(pibridge.SyncboardReasonInvalidConfig)
	}
	if cfg.SyncCoordinator == "" || syncboardIsSelfTarget(cfg.SyncCoordinator, addr) {
		return callSyncboardInternal(ctx, req)
	}
	return callSyncboardHTTP(ctx, base, req)
}

func syncboardIsSelfTarget(raw string, addr *net.TCPAddr) bool {
	if addr == nil || len(addr.IP) == 0 || addr.IP.IsUnspecified() {
		return false
	}
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "http" || u.Host == "" || u.Opaque != "" || u.User != nil ||
		u.RawQuery != "" || u.ForceQuery || u.Fragment != "" ||
		(u.Path != "" && u.Path != "/") || (u.RawPath != "" && u.RawPath != "/") || strings.HasSuffix(u.Host, ":") {
		return false
	}
	host := u.Hostname()
	zone := ""
	if i := strings.LastIndexByte(host, '%'); i >= 0 {
		host, zone = host[:i], host[i+1:]
	}
	ip := net.ParseIP(host)
	if ip == nil || !addr.IP.Equal(ip) || zone != addr.Zone {
		return false
	}
	port := 80
	if rawPort := u.Port(); rawPort != "" {
		parsed, err := strconv.Atoi(rawPort)
		if err != nil || parsed < 1 || parsed > 65535 {
			return false
		}
		port = parsed
	}
	return port == addr.Port
}

type syncboardResponseBuffer struct {
	header   http.Header
	status   int
	body     []byte
	tooLarge bool
}

func (w *syncboardResponseBuffer) Header() http.Header { return w.header }

func (w *syncboardResponseBuffer) WriteHeader(status int) {
	if w.status == 0 {
		w.status = status
	}
}

func (w *syncboardResponseBuffer) Write(body []byte) (int, error) {
	if w.status == 0 {
		w.status = http.StatusOK
	}
	remaining := pibridge.MaxSyncboardResponseBytes - len(w.body)
	keep := min(len(body), max(remaining, 0))
	w.body = append(w.body, body[:keep]...)
	if keep != len(body) {
		w.tooLarge = true
	}
	return len(body), nil
}

func callSyncboardInternal(ctx context.Context, req *pibridgepb.SyncboardRequest) *pibridgepb.SyncboardResponse {
	refuse := func(reason string) *pibridgepb.SyncboardResponse {
		return &pibridgepb.SyncboardResponse{Outcome: pibridgepb.SyncboardOutcome_SYNCBOARD_OUTCOME_NOT_SENT, Reason: reason}
	}
	unknown := func(reason string) *pibridgepb.SyncboardResponse {
		return &pibridgepb.SyncboardResponse{Outcome: pibridgepb.SyncboardOutcome_SYNCBOARD_OUTCOME_UNKNOWN, Reason: reason}
	}
	if ctx.Err() != nil {
		return refuse(pibridge.SyncboardReasonCancelled)
	}
	method, keyPath, encoded, ok := syncboardRequestParts(req)
	if !ok {
		return refuse(pibridge.SyncboardReasonInvalidRequest)
	}
	path := "/api/sync/messages"
	if keyPath {
		path += "/" + req.GetKey()
	}
	var body io.ReadCloser = http.NoBody
	if encoded != nil {
		body = io.NopCloser(bytes.NewReader(encoded))
	}
	request := (&http.Request{
		Method: method,
		URL:    &url.URL{Path: path},
		Header: make(http.Header),
		Body:   body,
	}).WithContext(ctx)
	writer := &syncboardResponseBuffer{header: make(http.Header)}
	handleSyncMessages(writer, request)
	if ctx.Err() != nil {
		return unknown(pibridge.SyncboardReasonCancelled)
	}
	if writer.tooLarge {
		return unknown(pibridge.SyncboardReasonTooLarge)
	}
	status := writer.status
	if status == 0 {
		status = http.StatusOK
	}
	return syncboardAPIResponse(req, status, writer.body)
}

func parseSyncboardBase(raw string) (*url.URL, error) {
	u, err := url.Parse(raw)
	if err != nil {
		return nil, errInvalidSyncboardConfig
	}
	if u == nil || !u.IsAbs() || u.Host == "" || u.Opaque != "" || u.User != nil || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" {
		return nil, errInvalidSyncboardConfig
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return nil, errInvalidSyncboardConfig
	}
	return u, nil
}

var errInvalidSyncboardConfig = errors.New("invalid syncboard config")

func syncboardURL(base *url.URL) (*url.URL, error) {
	u := *base
	path := strings.TrimSuffix(base.EscapedPath(), "/") + "/api/sync/messages"
	decoded, err := url.PathUnescape(path)
	if err != nil {
		return nil, err
	}
	u.Path = decoded
	u.RawPath = path
	return &u, nil
}

func syncboardKeyURL(base *url.URL, key string) (*url.URL, error) {
	u, err := syncboardURL(base)
	if err != nil {
		return nil, err
	}
	u.RawPath = strings.TrimSuffix(u.EscapedPath(), "/") + "/" + url.PathEscape(key)
	path, err := url.PathUnescape(u.RawPath)
	if err != nil {
		return nil, err
	}
	u.Path = path
	return u, nil
}

func syncboardRequestParts(req *pibridgepb.SyncboardRequest) (method string, keyPath bool, body []byte, ok bool) {
	switch req.GetOperation() {
	case pibridgepb.SyncboardOperation_SYNCBOARD_OPERATION_LIST:
		return http.MethodGet, false, nil, true
	case pibridgepb.SyncboardOperation_SYNCBOARD_OPERATION_GET:
		return http.MethodGet, true, nil, true
	case pibridgepb.SyncboardOperation_SYNCBOARD_OPERATION_UPSERT:
		encoded, err := json.Marshal(struct {
			Key   string          `json:"key"`
			Value json.RawMessage `json:"value"`
		}{Key: req.GetKey(), Value: json.RawMessage(req.GetValueJson())})
		return http.MethodPost, false, encoded, err == nil
	case pibridgepb.SyncboardOperation_SYNCBOARD_OPERATION_DELETE:
		return http.MethodDelete, true, nil, true
	default:
		return "", false, nil, false
	}
}

func callSyncboardHTTP(ctx context.Context, base *url.URL, req *pibridgepb.SyncboardRequest) *pibridgepb.SyncboardResponse {
	refuse := func(reason string) *pibridgepb.SyncboardResponse {
		return &pibridgepb.SyncboardResponse{Outcome: pibridgepb.SyncboardOutcome_SYNCBOARD_OUTCOME_NOT_SENT, Reason: reason}
	}
	unknown := func(reason string) *pibridgepb.SyncboardResponse {
		return &pibridgepb.SyncboardResponse{Outcome: pibridgepb.SyncboardOutcome_SYNCBOARD_OUTCOME_UNKNOWN, Reason: reason}
	}
	if ctx.Err() != nil {
		return refuse(pibridge.SyncboardReasonCancelled)
	}
	method, keyPath, encoded, ok := syncboardRequestParts(req)
	if !ok {
		return refuse(pibridge.SyncboardReasonInvalidRequest)
	}
	var target *url.URL
	var err error
	if keyPath {
		target, err = syncboardKeyURL(base, req.GetKey())
	} else {
		target, err = syncboardURL(base)
	}
	if err != nil || target == nil {
		return refuse(pibridge.SyncboardReasonInvalidConfig)
	}
	var body io.Reader
	if encoded != nil {
		body = bytes.NewReader(encoded)
	}
	requestCtx, cancel := context.WithTimeout(ctx, piSyncboardHTTPTimeout)
	defer cancel()
	httpReq, err := http.NewRequestWithContext(requestCtx, method, target.String(), body)
	if err != nil {
		return refuse(pibridge.SyncboardReasonInvalidConfig)
	}
	if method == http.MethodPost {
		httpReq.Header.Set("Content-Type", "application/json")
	}
	client := &http.Client{
		Timeout: piSyncboardHTTPTimeout,
		CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
	transportFailure := func() *pibridgepb.SyncboardResponse {
		switch requestCtx.Err() {
		case context.DeadlineExceeded:
			return unknown(pibridge.SyncboardReasonTimeout)
		case context.Canceled:
			return unknown(pibridge.SyncboardReasonCancelled)
		default:
			return unknown(pibridge.SyncboardReasonTransportError)
		}
	}
	response, err := client.Do(httpReq)
	if err != nil {
		return transportFailure()
	}
	defer response.Body.Close()
	responseBody, err := io.ReadAll(io.LimitReader(response.Body, int64(pibridge.MaxSyncboardResponseBytes)+1))
	if err != nil {
		return transportFailure()
	}
	if len(responseBody) > pibridge.MaxSyncboardResponseBytes {
		return unknown(pibridge.SyncboardReasonTooLarge)
	}
	return syncboardAPIResponse(req, response.StatusCode, responseBody)
}

func syncboardAPIResponse(req *pibridgepb.SyncboardRequest, status int, body []byte) *pibridgepb.SyncboardResponse {
	unknown := func(reason string) *pibridgepb.SyncboardResponse {
		return &pibridgepb.SyncboardResponse{Outcome: pibridgepb.SyncboardOutcome_SYNCBOARD_OUTCOME_UNKNOWN, Reason: reason}
	}
	if status == http.StatusNotFound && (req.GetOperation() == pibridgepb.SyncboardOperation_SYNCBOARD_OPERATION_GET || req.GetOperation() == pibridgepb.SyncboardOperation_SYNCBOARD_OPERATION_DELETE) {
		return &pibridgepb.SyncboardResponse{
			Outcome: pibridgepb.SyncboardOutcome_SYNCBOARD_OUTCOME_HTTP_RESPONSE, HttpStatus: http.StatusNotFound,
		}
	}
	if status != http.StatusOK {
		return &pibridgepb.SyncboardResponse{
			Outcome:    pibridgepb.SyncboardOutcome_SYNCBOARD_OUTCOME_HTTP_RESPONSE,
			HttpStatus: uint32(status), Reason: pibridge.SyncboardReasonHTTPError,
		}
	}
	if req.GetOperation() == pibridgepb.SyncboardOperation_SYNCBOARD_OPERATION_DELETE {
		if len(bytes.TrimSpace(body)) != 0 {
			return unknown(pibridge.SyncboardReasonInvalidResponse)
		}
		return &pibridgepb.SyncboardResponse{
			Outcome: pibridgepb.SyncboardOutcome_SYNCBOARD_OUTCOME_HTTP_RESPONSE, HttpStatus: http.StatusOK,
		}
	}
	if !validSyncboardAPIResponse(req, body) {
		return unknown(pibridge.SyncboardReasonInvalidResponse)
	}
	return &pibridgepb.SyncboardResponse{
		Outcome:    pibridgepb.SyncboardOutcome_SYNCBOARD_OUTCOME_HTTP_RESPONSE,
		HttpStatus: http.StatusOK, BodyJson: body,
	}
}

func validSyncboardAPIResponse(req *pibridgepb.SyncboardRequest, body []byte) bool {
	if len(body) == 0 || !json.Valid(body) {
		return false
	}
	if req.GetOperation() == pibridgepb.SyncboardOperation_SYNCBOARD_OPERATION_LIST {
		var rows []json.RawMessage
		if json.Unmarshal(body, &rows) != nil || rows == nil {
			return false
		}
		for _, row := range rows {
			if !validSyncboardMessage(row, "") {
				return false
			}
		}
		return true
	}
	return (req.GetOperation() == pibridgepb.SyncboardOperation_SYNCBOARD_OPERATION_UPSERT || req.GetOperation() == pibridgepb.SyncboardOperation_SYNCBOARD_OPERATION_GET) && validSyncboardMessage(body, req.GetKey())
}

func validSyncboardMessage(raw json.RawMessage, expectedKey string) bool {
	var fields map[string]json.RawMessage
	if json.Unmarshal(raw, &fields) != nil || fields == nil {
		return false
	}
	keyJSON, hasKey := fields["key"]
	valueJSON, hasValue := fields["value"]
	createdJSON, hasCreated := fields["created_at"]
	updatedJSON, hasUpdated := fields["updated_at"]
	if !hasKey || !hasValue || !hasCreated || !hasUpdated {
		return false
	}
	var key, value *string
	var created, updated string
	if json.Unmarshal(keyJSON, &key) != nil || json.Unmarshal(valueJSON, &value) != nil || key == nil || value == nil ||
		json.Unmarshal(createdJSON, &created) != nil || json.Unmarshal(updatedJSON, &updated) != nil {
		return false
	}
	if expectedKey != "" && *key != expectedKey {
		return false
	}
	_, createdErr := time.Parse(time.RFC3339Nano, created)
	_, updatedErr := time.Parse(time.RFC3339Nano, updated)
	return createdErr == nil && updatedErr == nil
}
