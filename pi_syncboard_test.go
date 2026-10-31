package main

import (
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/hypernewbie/phi/internal/pibridge"
	pibridgepb "github.com/hypernewbie/phi/internal/pibridge/pb"
)

const syncboardTestMessage = `{"key":"card-a","value":"false","created_at":"2025-01-02T03:04:05Z","updated_at":"2025-01-02T03:04:05Z"}`

func TestPiSyncboardSelfTargetMatchesOnlyObviousRootAddresses(t *testing.T) {
	v4 := &net.TCPAddr{IP: net.ParseIP("127.0.0.1"), Port: 7070}
	v6 := &net.TCPAddr{IP: net.ParseIP("::1"), Port: 7070}
	cases := []struct {
		name string
		raw  string
		addr *net.TCPAddr
		want bool
	}{
		{name: "matching IPv4", raw: "http://127.0.0.1:7070", addr: v4, want: true},
		{name: "root slash", raw: "http://127.0.0.1:7070/", addr: v4, want: true},
		{name: "matching IPv6", raw: "http://[::1]:7070", addr: v6, want: true},
		{name: "hostname remains HTTP", raw: "http://localhost:7070", addr: v4},
		{name: "different port", raw: "http://127.0.0.1:7071", addr: v4},
		{name: "path prefix", raw: "http://127.0.0.1:7070/prefix", addr: v4},
		{name: "HTTPS", raw: "https://127.0.0.1:7070", addr: v4},
		{name: "other address", raw: "http://127.0.0.2:7070", addr: v4},
		{name: "wildcard listener", raw: "http://127.0.0.1:7070", addr: &net.TCPAddr{IP: net.IPv4zero, Port: 7070}},
	}
	for _, item := range cases {
		t.Run(item.name, func(t *testing.T) {
			if got := syncboardIsSelfTarget(item.raw, item.addr); got != item.want {
				t.Fatalf("syncboardIsSelfTarget(%q) = %v, want %v", item.raw, got, item.want)
			}
		})
	}
}

func TestPiSyncboardSelfDispatchUsesLocalHandler(t *testing.T) {
	withTempConfig(t)
	var outbound atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		outbound.Add(1)
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer server.Close()
	addr := server.Listener.Addr().(*net.TCPAddr)
	saveConfig(Config{SyncCoordinator: server.URL})
	oldSyncPath := testSyncPath
	testSyncPath = t.TempDir() + "/syncboard.json"
	syncMu.Lock()
	oldStore := syncStore
	syncStore = make(map[string]*SyncMessage)
	syncMu.Unlock()
	t.Cleanup(func() {
		_ = FlushSyncStore()
		syncMu.Lock()
		syncStore = oldStore
		syncMu.Unlock()
		testSyncPath = oldSyncPath
	})
	bridge := &Bridge{
		panes: map[string]*bridgePane{
			"pane": {processID: "proc", managed: true},
		},
		listenerAddr: addr,
	}
	upsert := bridge.handleSyncboard(context.Background(), "proc", &pibridgepb.SyncboardRequest{
		Operation: pibridgepb.SyncboardOperation_SYNCBOARD_OPERATION_UPSERT,
		Key:       "local-card", ValueJson: []byte(`{"state":"self"}`),
	})
	if upsert.GetOutcome() != pibridgepb.SyncboardOutcome_SYNCBOARD_OUTCOME_HTTP_RESPONSE || upsert.GetHttpStatus() != http.StatusOK {
		t.Fatalf("self upsert = %v", upsert)
	}
	get := bridge.handleSyncboard(context.Background(), "proc", &pibridgepb.SyncboardRequest{
		Operation: pibridgepb.SyncboardOperation_SYNCBOARD_OPERATION_GET, Key: "local-card",
	})
	if get.GetOutcome() != pibridgepb.SyncboardOutcome_SYNCBOARD_OUTCOME_HTTP_RESPONSE || !validSyncboardAPIResponse(&pibridgepb.SyncboardRequest{Operation: pibridgepb.SyncboardOperation_SYNCBOARD_OPERATION_GET, Key: "local-card"}, get.GetBodyJson()) {
		t.Fatalf("self get = %v", get)
	}
	var created, fetched SyncMessage
	if err := json.Unmarshal(upsert.GetBodyJson(), &created); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(get.GetBodyJson(), &fetched); err != nil {
		t.Fatal(err)
	}
	if created != fetched {
		t.Fatalf("local result differs from the stored message: upsert=%+v get=%+v", created, fetched)
	}
	cancelled, cancel := context.WithCancel(context.Background())
	cancel()
	refused := bridge.handleSyncboard(cancelled, "proc", &pibridgepb.SyncboardRequest{
		Operation: pibridgepb.SyncboardOperation_SYNCBOARD_OPERATION_UPSERT,
		Key:       "must-not-exist", ValueJson: []byte(`true`),
	})
	if refused.GetOutcome() != pibridgepb.SyncboardOutcome_SYNCBOARD_OUTCOME_NOT_SENT || refused.GetReason() != pibridge.SyncboardReasonCancelled {
		t.Fatalf("pre-cancelled self-target result = %v", refused)
	}
	syncMu.RLock()
	original := syncStore["local-card"]
	_, cancelledMutationApplied := syncStore["must-not-exist"]
	syncMu.RUnlock()
	if cancelledMutationApplied {
		t.Fatal("pre-cancelled mutation reached the local Syncboard store")
	}
	syncMu.Lock()
	syncStore["large-a"] = &SyncMessage{Key: "large-a", Value: strings.Repeat("x", 100*1024), CreatedAt: time.Now(), UpdatedAt: time.Now()}
	syncStore["large-b"] = &SyncMessage{Key: "large-b", Value: strings.Repeat("x", 100*1024), CreatedAt: time.Now(), UpdatedAt: time.Now()}
	syncMu.Unlock()
	large := bridge.handleSyncboard(context.Background(), "proc", &pibridgepb.SyncboardRequest{
		Operation: pibridgepb.SyncboardOperation_SYNCBOARD_OPERATION_LIST,
	})
	if large.GetOutcome() != pibridgepb.SyncboardOutcome_SYNCBOARD_OUTCOME_UNKNOWN || large.GetReason() != pibridge.SyncboardReasonTooLarge {
		t.Fatalf("oversized local response = %v", large)
	}
	syncMu.Lock()
	syncStore = map[string]*SyncMessage{"local-card": original}
	syncMu.Unlock()
	saveConfig(Config{})
	deleted := bridge.handleSyncboard(context.Background(), "proc", &pibridgepb.SyncboardRequest{
		Operation: pibridgepb.SyncboardOperation_SYNCBOARD_OPERATION_DELETE, Key: "local-card",
	})
	missing := bridge.handleSyncboard(context.Background(), "proc", &pibridgepb.SyncboardRequest{
		Operation: pibridgepb.SyncboardOperation_SYNCBOARD_OPERATION_GET, Key: "local-card",
	})
	if deleted.GetHttpStatus() != http.StatusOK || missing.GetHttpStatus() != http.StatusNotFound {
		t.Fatalf("unset-coordinator CRUD = delete %v, get %v", deleted, missing)
	}
	if got := outbound.Load(); got != 0 {
		t.Fatalf("self-target made %d outbound HTTP calls, want 0", got)
	}
}

func TestPiSyncboardDefaultTargetMatchesConfigForBoundListeners(t *testing.T) {
	withTempConfig(t)
	saveConfig(Config{})
	listeners := []struct {
		name    string
		network string
		address string
	}{
		{name: "IPv4", network: "tcp4", address: "127.0.0.1:0"},
		{name: "wildcard IPv4", network: "tcp4", address: "0.0.0.0:0"},
		{name: "IPv6", network: "tcp6", address: "[::1]:0"},
	}
	for _, item := range listeners {
		t.Run(item.name, func(t *testing.T) {
			listener, err := net.Listen(item.network, item.address)
			if err != nil {
				if item.network == "tcp6" {
					t.Skipf("IPv6 loopback is unavailable: %v", err)
				}
				t.Fatal(err)
			}
			defer listener.Close()
			addr := listener.Addr().(*net.TCPAddr)
			request := httptest.NewRequest(http.MethodGet, "/api/config", nil)
			request = request.WithContext(context.WithValue(request.Context(), http.LocalAddrContextKey, addr))
			response := httptest.NewRecorder()
			handleConfig(response, request)
			var body map[string]any
			if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
				t.Fatal(err)
			}
			want := (Config{}).syncCoordinatorURL(addr)
			if got := body["sync_coordinator"]; got != want {
				t.Fatalf("GET /api/config target = %v, syncCoordinatorURL = %q", got, want)
			}
		})
	}
}

func TestPiSyncboardUsesConfiguredCustomPort(t *testing.T) {
	withTempConfig(t)
	var calls atomic.Int32
	var gotPath string
	coordinator := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		gotPath = r.URL.EscapedPath()
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `[]`)
	}))
	defer coordinator.Close()
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	addr := listener.Addr().(*net.TCPAddr)
	saveConfig(Config{SyncCoordinator: coordinator.URL + "/custom"})
	request := httptest.NewRequest(http.MethodGet, "/api/config", nil)
	request = request.WithContext(context.WithValue(request.Context(), http.LocalAddrContextKey, addr))
	configResponse := httptest.NewRecorder()
	handleConfig(configResponse, request)
	var configBody map[string]any
	if err := json.Unmarshal(configResponse.Body.Bytes(), &configBody); err != nil {
		t.Fatal(err)
	}
	if configBody["sync_coordinator"] != coordinator.URL+"/custom" {
		t.Fatalf("GET /api/config coordinator = %v", configBody["sync_coordinator"])
	}
	bridge := &Bridge{
		panes:        map[string]*bridgePane{"pane": {processID: "proc", managed: true}},
		listenerAddr: addr,
	}
	result := bridge.handleSyncboard(context.Background(), "proc", &pibridgepb.SyncboardRequest{
		Operation: pibridgepb.SyncboardOperation_SYNCBOARD_OPERATION_LIST,
	})
	if result.GetOutcome() != pibridgepb.SyncboardOutcome_SYNCBOARD_OUTCOME_HTTP_RESPONSE || result.GetHttpStatus() != http.StatusOK {
		t.Fatalf("configured list = %v", result)
	}
	if calls.Load() != 1 || gotPath != "/custom/api/sync/messages" {
		t.Fatalf("configured route calls=%d path=%q", calls.Load(), gotPath)
	}
}

func TestPiSyncboardRefusesBeforeListenerPublicationOrConfigRead(t *testing.T) {
	withTempConfig(t)
	saveConfig(Config{})
	bridge := &Bridge{panes: map[string]*bridgePane{"pane": {processID: "proc", managed: true}}}
	request := &pibridgepb.SyncboardRequest{Operation: pibridgepb.SyncboardOperation_SYNCBOARD_OPERATION_LIST}
	result := bridge.handleSyncboard(context.Background(), "proc", request)
	if result.GetOutcome() != pibridgepb.SyncboardOutcome_SYNCBOARD_OUTCOME_NOT_SENT || result.GetReason() != pibridge.SyncboardReasonNotReady {
		t.Fatalf("unpublished listener result = %v", result)
	}
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	bridge.listenerAddr = listener.Addr().(*net.TCPAddr)
	oldConfigPath := testConfigPath
	testConfigPath = t.TempDir()
	t.Cleanup(func() { testConfigPath = oldConfigPath })
	result = bridge.handleSyncboard(context.Background(), "proc", request)
	if result.GetOutcome() != pibridgepb.SyncboardOutcome_SYNCBOARD_OUTCOME_NOT_SENT || result.GetReason() != pibridge.SyncboardReasonInvalidConfig {
		t.Fatalf("unreadable config result = %v", result)
	}
}

func TestPiSyncboardHTTPListAndUpsert(t *testing.T) {
	var gotMethod, gotPath, gotBody string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod, gotPath = r.Method, r.URL.EscapedPath()
		data, _ := io.ReadAll(r.Body)
		gotBody = string(data)
		w.Header().Set("Content-Type", "application/json")
		if r.Method == http.MethodGet {
			_, _ = io.WriteString(w, "["+syncboardTestMessage+"]")
			return
		}
		_, _ = io.WriteString(w, syncboardTestMessage)
	}))
	defer server.Close()
	base, err := parseSyncboardBase(server.URL + "/prefix/")
	if err != nil {
		t.Fatal(err)
	}

	list := callSyncboardHTTP(t.Context(), base, &pibridgepb.SyncboardRequest{
		Operation: pibridgepb.SyncboardOperation_SYNCBOARD_OPERATION_LIST,
	})
	if list.GetOutcome() != pibridgepb.SyncboardOutcome_SYNCBOARD_OUTCOME_HTTP_RESPONSE || list.GetHttpStatus() != http.StatusOK {
		t.Fatalf("list response = %v", list)
	}
	if gotMethod != http.MethodGet || gotPath != "/prefix/api/sync/messages" {
		t.Fatalf("list route = %s %s", gotMethod, gotPath)
	}

	upsert := callSyncboardHTTP(t.Context(), base, &pibridgepb.SyncboardRequest{
		Operation: pibridgepb.SyncboardOperation_SYNCBOARD_OPERATION_UPSERT,
		Key:       "card-a",
		ValueJson: []byte(`false`),
	})
	if upsert.GetOutcome() != pibridgepb.SyncboardOutcome_SYNCBOARD_OUTCOME_HTTP_RESPONSE || upsert.GetHttpStatus() != http.StatusOK {
		t.Fatalf("upsert response = %v", upsert)
	}
	if gotMethod != http.MethodPost || gotPath != "/prefix/api/sync/messages" {
		t.Fatalf("upsert route = %s %s", gotMethod, gotPath)
	}
	var posted struct {
		Key   string          `json:"key"`
		Value json.RawMessage `json:"value"`
	}
	if err := json.Unmarshal([]byte(gotBody), &posted); err != nil {
		t.Fatal(err)
	}
	if posted.Key != "card-a" || string(posted.Value) != "false" {
		t.Fatalf("posted = %+v", posted)
	}
}

func TestPiSyncboardHTTPGetDeleteEscapedKeysAndNotFound(t *testing.T) {
	key := "café/a %?#"
	var gotMethod, gotPath string
	message, err := json.Marshal(map[string]string{
		"key": key, "value": `{"card":true}`,
		"created_at": "2025-01-02T03:04:05Z", "updated_at": "2025-01-02T03:04:05Z",
	})
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod, gotPath = r.Method, r.URL.EscapedPath()
		if r.Method == http.MethodGet {
			_, _ = w.Write(message)
			return
		}
		_, _ = io.WriteString(w, " \t\r\n")
	}))
	defer server.Close()
	base, err := parseSyncboardBase(server.URL + "/prefix/")
	if err != nil {
		t.Fatal(err)
	}
	wantPath := "/prefix/api/sync/messages/" + url.PathEscape(key)
	get := callSyncboardHTTP(t.Context(), base, &pibridgepb.SyncboardRequest{
		Operation: pibridgepb.SyncboardOperation_SYNCBOARD_OPERATION_GET, Key: key,
	})
	if get.GetOutcome() != pibridgepb.SyncboardOutcome_SYNCBOARD_OUTCOME_HTTP_RESPONSE || string(get.GetBodyJson()) != string(message) {
		t.Fatalf("get result = %v", get)
	}
	if gotMethod != http.MethodGet || gotPath != wantPath {
		t.Fatalf("get route = %s %s, want %s %s", gotMethod, gotPath, http.MethodGet, wantPath)
	}
	deleted := callSyncboardHTTP(t.Context(), base, &pibridgepb.SyncboardRequest{
		Operation: pibridgepb.SyncboardOperation_SYNCBOARD_OPERATION_DELETE, Key: key,
	})
	if deleted.GetOutcome() != pibridgepb.SyncboardOutcome_SYNCBOARD_OUTCOME_HTTP_RESPONSE || deleted.GetHttpStatus() != http.StatusOK || len(deleted.GetBodyJson()) != 0 {
		t.Fatalf("delete result = %v", deleted)
	}
	if gotMethod != http.MethodDelete || gotPath != wantPath {
		t.Fatalf("delete route = %s %s, want %s %s", gotMethod, gotPath, http.MethodDelete, wantPath)
	}

	missing := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "Message not found", http.StatusNotFound)
	}))
	defer missing.Close()
	missingBase, err := parseSyncboardBase(missing.URL)
	if err != nil {
		t.Fatal(err)
	}
	for _, operation := range []pibridgepb.SyncboardOperation{
		pibridgepb.SyncboardOperation_SYNCBOARD_OPERATION_GET,
		pibridgepb.SyncboardOperation_SYNCBOARD_OPERATION_DELETE,
	} {
		result := callSyncboardHTTP(t.Context(), missingBase, &pibridgepb.SyncboardRequest{
			Operation: operation, Key: "absent",
		})
		if result.GetOutcome() != pibridgepb.SyncboardOutcome_SYNCBOARD_OUTCOME_HTTP_RESPONSE || result.GetHttpStatus() != http.StatusNotFound || result.GetReason() != "" || len(result.GetBodyJson()) != 0 {
			t.Errorf("operation %s missing result = %v", operation, result)
		}
	}
}

func TestPiSyncboardHTTPRefusesRedirectAndInvalidResponse(t *testing.T) {
	hitRedirect := false
	destination := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		hitRedirect = true
	}))
	defer destination.Close()
	redirect := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, destination.URL, http.StatusTemporaryRedirect)
	}))
	defer redirect.Close()
	base, err := parseSyncboardBase(redirect.URL)
	if err != nil {
		t.Fatal(err)
	}
	result := callSyncboardHTTP(t.Context(), base, &pibridgepb.SyncboardRequest{
		Operation: pibridgepb.SyncboardOperation_SYNCBOARD_OPERATION_LIST,
	})
	if result.GetOutcome() != pibridgepb.SyncboardOutcome_SYNCBOARD_OUTCOME_HTTP_RESPONSE || result.GetHttpStatus() != http.StatusTemporaryRedirect || result.GetReason() != pibridge.SyncboardReasonHTTPError {
		t.Fatalf("redirect result = %v", result)
	}
	if hitRedirect {
		t.Fatal("redirect target received a request")
	}

	invalid := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, `{"not":"a board list"}`)
	}))
	defer invalid.Close()
	base, _ = parseSyncboardBase(invalid.URL)
	result = callSyncboardHTTP(t.Context(), base, &pibridgepb.SyncboardRequest{
		Operation: pibridgepb.SyncboardOperation_SYNCBOARD_OPERATION_LIST,
	})
	if result.GetOutcome() != pibridgepb.SyncboardOutcome_SYNCBOARD_OUTCOME_UNKNOWN || result.GetReason() != pibridge.SyncboardReasonInvalidResponse {
		t.Fatalf("invalid body result = %v", result)
	}
}

func TestPiSyncboardHTTPRejectsMalformedSuccessAndRedactsErrors(t *testing.T) {
	cases := []struct {
		name   string
		status int
		body   string
	}{
		{name: "null value", status: 200, body: strings.Replace(syncboardTestMessage, `"value":"false"`, `"value":null`, 1)},
		{name: "null key", status: 200, body: strings.Replace(syncboardTestMessage, `"key":"card-a"`, `"key":null`, 1)},
		{name: "wrong key", status: 200, body: strings.Replace(syncboardTestMessage, "card-a", "another-key", 1)},
		{name: "invalid timestamp", status: 200, body: strings.ReplaceAll(syncboardTestMessage, "2025-01-02T03:04:05Z", "not-a-date")},
		{name: "truncated JSON", status: 200, body: syncboardTestMessage[:len(syncboardTestMessage)-1]},
		{name: "unauthorized", status: 401, body: "private coordinator details"},
		{name: "forbidden", status: 403, body: "private coordinator details"},
		{name: "rate limited", status: 429, body: "private coordinator details"},
		{name: "server error", status: 500, body: "private coordinator details"},
	}
	for _, item := range cases {
		t.Run(item.name, func(t *testing.T) {
			var mutations atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method == http.MethodPost {
					mutations.Add(1)
				}
				w.WriteHeader(item.status)
				_, _ = io.WriteString(w, item.body)
			}))
			defer server.Close()
			base, err := parseSyncboardBase(server.URL)
			if err != nil {
				t.Fatal(err)
			}
			result := callSyncboardHTTP(t.Context(), base, &pibridgepb.SyncboardRequest{
				Operation: pibridgepb.SyncboardOperation_SYNCBOARD_OPERATION_UPSERT,
				Key:       "card-a", ValueJson: []byte("false"),
			})
			if len(result.GetBodyJson()) != 0 || mutations.Load() != 1 {
				t.Fatalf("error leaked a body or retried a mutation: response=%v mutations=%d", result, mutations.Load())
			}
			if item.status == http.StatusOK {
				if result.GetOutcome() != pibridgepb.SyncboardOutcome_SYNCBOARD_OUTCOME_UNKNOWN || result.GetReason() != pibridge.SyncboardReasonInvalidResponse {
					t.Fatalf("malformed success = %v", result)
				}
			} else if result.GetOutcome() != pibridgepb.SyncboardOutcome_SYNCBOARD_OUTCOME_HTTP_RESPONSE || result.GetHttpStatus() != uint32(item.status) || result.GetReason() != pibridge.SyncboardReasonHTTPError {
				t.Fatalf("HTTP error = %v", result)
			}
		})
	}
}

func TestPiSyncboardHTTPAppliedMutationLostResponseIsUnknown(t *testing.T) {
	var mutations atomic.Int32
	applied := make(chan string, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		mutations.Add(1)
		applied <- string(body)
		w.WriteHeader(http.StatusOK)
		w.(http.Flusher).Flush()
		<-r.Context().Done()
	}))
	defer server.Close()
	base, err := parseSyncboardBase(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	result := callSyncboardHTTP(ctx, base, &pibridgepb.SyncboardRequest{
		Operation: pibridgepb.SyncboardOperation_SYNCBOARD_OPERATION_UPSERT,
		Key:       "card-a",
		ValueJson: []byte(`{"state":"applied"}`),
	})
	if result.GetOutcome() != pibridgepb.SyncboardOutcome_SYNCBOARD_OUTCOME_UNKNOWN || result.GetReason() != pibridge.SyncboardReasonTimeout {
		t.Fatalf("lost mutation response = %v", result)
	}
	select {
	case body := <-applied:
		if body != `{"key":"card-a","value":{"state":"applied"}}` {
			t.Fatalf("applied request body = %s", body)
		}
	case <-time.After(time.Second):
		t.Fatal("coordinator did not apply the mutation")
	}
	if mutations.Load() != 1 {
		t.Fatalf("mutation attempts = %d, want 1", mutations.Load())
	}
}

func TestPiSyncboardHTTPBoundsResponse(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, `[`+strings.Repeat(" ", pibridge.MaxSyncboardResponseBytes)+`]`)
	}))
	defer server.Close()
	base, err := parseSyncboardBase(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	result := callSyncboardHTTP(t.Context(), base, &pibridgepb.SyncboardRequest{
		Operation: pibridgepb.SyncboardOperation_SYNCBOARD_OPERATION_LIST,
	})
	if result.GetOutcome() != pibridgepb.SyncboardOutcome_SYNCBOARD_OUTCOME_UNKNOWN || result.GetReason() != pibridge.SyncboardReasonTooLarge {
		t.Fatalf("oversized result = %v", result)
	}
}

func TestPiSyncboardBaseRejectsArbitraryURLParts(t *testing.T) {
	for _, raw := range []string{
		"relative/path", "ftp://example.test", "http://user@example.test", "http://example.test/?x=1", "http://example.test/#fragment", "http:///missing-host",
	} {
		if _, err := parseSyncboardBase(raw); err == nil {
			t.Errorf("accepted invalid base %q", raw)
		}
	}
}
