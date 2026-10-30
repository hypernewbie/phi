package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"
)

func mobileRequest(t *testing.T, fence bool, body string, want int) mobileAppearanceState {
	t.Helper()
	w := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodPost, "/api/config/mobile-appearance", strings.NewReader(body))
	r.Header.Set("Content-Type", "application/json; charset=utf-8")
	serveMobileAppearance(w, r, fence, writeConfigLocked)
	if w.Code != want {
		t.Fatalf("status=%d want=%d body=%s", w.Code, want, w.Body.String())
	}
	var state mobileAppearanceState
	if want == 200 || want == 409 {
		if err := json.Unmarshal(w.Body.Bytes(), &state); err != nil {
			t.Fatal(err)
		}
		var fields map[string]json.RawMessage
		if err := json.Unmarshal(w.Body.Bytes(), &fields); err != nil || len(fields) != 5 {
			t.Fatalf("incomplete response: %s", w.Body.String())
		}
	}
	return state
}

func TestMobileAppearancePersistenceAndReset(t *testing.T) {
	path := withTempConfig(t)
	legacy := loadConfig()
	legacy.UIFontFamily, legacy.TerminalFontFamily = "Desktop UI", "Desktop terminal"
	legacy.UIFontSize, legacy.TerminalFontSize = 16, 18
	saveConfig(legacy)
	state := mobileRequest(t, false, `{"revision":0,"fields":{"ui_font_size":21}}`, 200)
	if state.Revision != 1 || state.UIFontSize == nil || *state.UIFontSize != 21 || state.UIFontFamily != nil {
		t.Fatalf("unexpected state: %+v", state)
	}
	state = mobileRequest(t, false, `{"revision":1,"fields":{"ui_font_family":"","terminal_font_family":"Mobile terminal","terminal_font_size":20}}`, 200)
	legacy.UseHiddenTerminal = true
	saveConfig(legacy)
	cfg := loadConfig()
	if cfg.MobileAppearanceRevision != 2 || *cfg.MobileUIFontSize != 21 || *cfg.MobileUIFontFamily != "" || *cfg.MobileTerminalFontFamily != "Mobile terminal" || *cfg.MobileTerminalFontSize != 20 || !cfg.UseHiddenTerminal {
		t.Fatalf("stale save lost owned data: %+v", mobileAppearanceFromConfig(cfg))
	}
	state = mobileRequest(t, false, `{"revision":2,"fields":{"ui_font_family":null}}`, 200)
	if state.UIFontFamily != nil || *state.UIFontSize != 21 || *state.TerminalFontSize != 20 {
		t.Fatalf("partial reset lost fields: %+v", state)
	}
	mobileRequest(t, false, `{"revision":3,"fields":{"ui_font_family":null,"ui_font_size":null,"terminal_font_family":null,"terminal_font_size":null}}`, 200)
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var disk Config
	if err := json.Unmarshal(raw, &disk); err != nil {
		t.Fatal(err)
	}
	if disk.MobileAppearanceRevision != 4 || disk.MobileUIFontSize != nil || disk.MobileTerminalFontFamily != nil || disk.UIFontFamily != "Desktop UI" || disk.TerminalFontFamily != "Desktop terminal" || disk.UIFontSize != 16 || disk.TerminalFontSize != 18 {
		t.Fatalf("reset crossed profile boundary: %+v", disk)
	}
}

func TestMobileAppearanceConcurrentDesktopAndAtomicBatch(t *testing.T) {
	path := withTempConfig(t)
	var wg sync.WaitGroup
	for _, request := range []struct {
		body    string
		handler http.HandlerFunc
	}{
		{`{"revision":0,"fields":{"ui_font_size":21,"terminal_font_size":22,"ui_font_family":"Mobile UI","terminal_font_family":"Mobile terminal"}}`, handleMobileAppearance},
		{`{"ui_font_size":19,"terminal_font_size":20,"ui_font_family":"Desktop UI","terminal_font_family":"Desktop terminal"}`, handleAppearanceUpdate},
	} {
		wg.Add(1)
		go func() {
			defer wg.Done()
			w := httptest.NewRecorder()
			r := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(request.body))
			r.Header.Set("Content-Type", "application/json")
			request.handler(w, r)
			if w.Code != 200 {
				t.Errorf("concurrent write status=%d body=%s", w.Code, w.Body.String())
			}
		}()
	}
	wg.Wait()
	cfg := loadConfig()
	if cfg.UIFontSize != 19 || cfg.TerminalFontSize != 20 || cfg.UIFontFamily != "Desktop UI" || cfg.TerminalFontFamily != "Desktop terminal" || cfg.MobileAppearanceRevision != 1 || *cfg.MobileUIFontSize != 21 || *cfg.MobileTerminalFontSize != 22 || *cfg.MobileUIFontFamily != "Mobile UI" || *cfg.MobileTerminalFontFamily != "Mobile terminal" {
		t.Fatalf("concurrent profiles lost values: %+v", cfg)
	}
	before, _ := os.ReadFile(path)
	mobileRequest(t, false, `{"revision":1,"fields":{"ui_font_family":null,"terminal_font_size":7}}`, 400)
	after, _ := os.ReadFile(path)
	if !bytes.Equal(before, after) {
		t.Fatal("invalid batch partly reset a valid field")
	}
}

func TestMobileAppearanceRejectsWithoutMutation(t *testing.T) {
	path := withTempConfig(t)
	mobileRequest(t, false, `{"revision":0,"fields":{"ui_font_size":21}}`, 200)
	before, _ := os.ReadFile(path)
	cases := []struct {
		body        string
		status      int
		fence       bool
		contentType string
	}{
		{`null`, 400, false, ""}, {`[]`, 400, false, ""}, {`{`, 400, false, ""},
		{`{} {}`, 400, false, ""}, {`{}`, 400, false, ""},
		{`{"revision":1,"fields":{}}`, 400, false, ""},
		{`{"revision":1,"fields":null}`, 400, false, ""},
		{`{"revision":1,"fields":[]}`, 400, false, ""},
		{`{"revision":null,"fields":{"ui_font_size":20}}`, 400, false, ""},
		{`{"revision":"1","fields":{"ui_font_size":20}}`, 400, false, ""},
		{`{"revision":1.5,"fields":{"ui_font_size":20}}`, 400, false, ""},
		{`{"revision":-1,"fields":{"ui_font_size":20}}`, 400, false, ""},
		{`{"revision":9007199254740992,"fields":{"ui_font_size":20}}`, 400, false, ""},
		{`{"revision":1,"extra":true,"fields":{"ui_font_size":20}}`, 400, false, ""},
		{`{"revision":1,"fields":{"other":20}}`, 400, false, ""},
		{`{"revision":1,"fields":{"ui_font_size":0}}`, 400, false, ""},
		{`{"revision":1,"fields":{"ui_font_size":9}}`, 400, false, ""},
		{`{"revision":1,"fields":{"ui_font_size":25}}`, 400, false, ""},
		{`{"revision":1,"fields":{"terminal_font_size":7}}`, 400, false, ""},
		{`{"revision":1,"fields":{"terminal_font_size":33}}`, 400, false, ""},
		{`{"revision":1,"fields":{"ui_font_size":17.2}}`, 400, false, ""},
		{`{"revision":1,"fields":{"ui_font_size":"20"}}`, 400, false, ""},
		{`{"revision":1,"fields":{"ui_font_family":true}}`, 400, false, ""},
		{`{"revision":1,"fields":{"ui_font_family":"` + string([]byte{0xff}) + `"}}`, 400, false, ""},
		{`{"revision":1,"fields":{"ui_font_family":"bad\nfont"}}`, 400, false, ""},
		{`{"revision":1,"fields":{"ui_font_family":"` + strings.Repeat("a", 513) + `"}}`, 400, false, ""},
		{`{"revision":1,"fields":{"ui_font_size":20}}` + strings.Repeat(" ", 4096), 413, false, ""},
		{`{"revision":0,"fields":{"ui_font_size":20}}`, 409, false, ""},
		{`{"revision":1}`, 400, true, ""}, {`null`, 400, true, ""},
		{`{} {}`, 400, true, ""}, {strings.Repeat(" ", 4097), 413, true, ""},
		{`{}`, 415, true, "text/plain"},
		{`{}`, 415, true, "missing"},
		{`{"revision":1,"fields":{"ui_font_family":"` + strings.Repeat("界", 171) + `"}}`, 400, false, ""},
	}
	for i, tc := range cases {
		t.Run(fmt.Sprint(i), func(t *testing.T) {
			w := httptest.NewRecorder()
			r := httptest.NewRequest(http.MethodPost, "/api/config/mobile-appearance", strings.NewReader(tc.body))
			ct := tc.contentType
			if ct == "" {
				ct = "application/json"
			}
			if ct != "missing" {
				r.Header.Set("Content-Type", ct)
			}
			serveMobileAppearance(w, r, tc.fence, writeConfigLocked)
			if w.Code != tc.status {
				t.Fatalf("status=%d want=%d body=%s", w.Code, tc.status, w.Body.String())
			}
			after, _ := os.ReadFile(path)
			if !bytes.Equal(before, after) {
				t.Fatal("rejection mutated disk")
			}
		})
	}
}

func TestMobileAppearanceFenceAndConcurrency(t *testing.T) {
	withTempConfig(t)
	var wg sync.WaitGroup
	codes := make(chan int, 2)
	for _, size := range []int{17, 21} {
		wg.Add(1)
		go func(size int) {
			defer wg.Done()
			w := httptest.NewRecorder()
			r := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(fmt.Sprintf(`{"revision":0,"fields":{"ui_font_size":%d}}`, size)))
			r.Header.Set("Content-Type", "application/json")
			handleMobileAppearance(w, r)
			codes <- w.Code
		}(size)
	}
	wg.Wait()
	close(codes)
	counts := map[int]int{}
	for code := range codes {
		counts[code]++
	}
	if counts[200] != 1 || counts[409] != 1 {
		t.Fatalf("concurrent statuses: %v", counts)
	}
	state := mobileRequest(t, true, `{}`, 200)
	if state.Revision != 2 {
		t.Fatalf("fence revision=%d", state.Revision)
	}
	mobileRequest(t, false, `{"revision":0,"fields":{"ui_font_size":24}}`, 409)
	// A fence before a delayed revision-2 save rejects it. Fencing after a
	// committed revision-3 save retains that save's values.
	mobileRequest(t, true, `{}`, 200)
	mobileRequest(t, false, `{"revision":2,"fields":{"ui_font_size":24}}`, 409)
	mobileRequest(t, false, `{"revision":3,"fields":{"ui_font_size":24}}`, 200)
	state = mobileRequest(t, true, `{}`, 200)
	if state.Revision != 5 || *state.UIFontSize != 24 {
		t.Fatal("fence undid a committed save")
	}
}

func TestMobileAppearanceReadWriteErrorsAndRevisionLimit(t *testing.T) {
	path := withTempConfig(t)
	mobileRequest(t, false, `{"revision":0,"fields":{"ui_font_size":10,"terminal_font_size":8}}`, 200)
	before, _ := os.ReadFile(path)
	w := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(`{"revision":1,"fields":{"ui_font_size":24}}`))
	r.Header.Set("Content-Type", "application/json")
	serveMobileAppearance(w, r, false, func(Config) error { return errors.New("injected failure") })
	after, _ := os.ReadFile(path)
	if w.Code != 500 || !bytes.Equal(before, after) {
		t.Fatalf("failed write status=%d mutated=%t", w.Code, !bytes.Equal(before, after))
	}
	configMu.Lock()
	cfg, err := readConfigLocked()
	if err == nil {
		cfg.MobileAppearanceRevision = maxMobileAppearanceRevision
		err = writeConfigLocked(cfg)
	}
	configMu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	mobileRequest(t, false, `{"revision":9007199254740991,"fields":{"ui_font_size":24}}`, 500)
	mobileRequest(t, true, `{}`, 500)
	if err := os.WriteFile(path, []byte("not JSON"), 0600); err != nil {
		t.Fatal(err)
	}
	w = httptest.NewRecorder()
	handleMobileAppearance(w, httptest.NewRequest(http.MethodGet, "/", nil))
	if w.Code != 500 {
		t.Fatalf("malformed config GET=%d", w.Code)
	}
	mobileRequest(t, false, `{"revision":0,"fields":{"ui_font_size":24}}`, 500)
	if raw, _ := os.ReadFile(path); string(raw) != "not JSON" {
		t.Fatal("destroyed malformed config")
	}
}

func TestMobileAppearanceMethodsAndAuthorization(t *testing.T) {
	withTempConfig(t)
	auth := useTestAccessAuth(t)
	for _, fence := range []bool{false, true} {
		w := httptest.NewRecorder()
		serveMobileAppearance(w, httptest.NewRequest(http.MethodDelete, "/", nil), fence, writeConfigLocked)
		if w.Code != 405 {
			t.Fatalf("DELETE=%d", w.Code)
		}
	}
	w := httptest.NewRecorder()
	handleMobileAppearance(w, httptest.NewRequest(http.MethodGet, "/", nil))
	if w.Code != 200 || w.Header().Get("Cache-Control") != "no-store" || !strings.Contains(w.Body.String(), `"ui_font_size":null`) {
		t.Fatalf("GET=%d %s", w.Code, w.Body.String())
	}
	if err := auth.configure(testAccessHash()); err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/api/config/mobile-appearance", handleMobileAppearance)
	mux.HandleFunc("/api/config/mobile-appearance/fence", handleMobileAppearanceFence)
	protected := accessAuthMiddleware(mux)
	for _, path := range []string{"/api/config/mobile-appearance", "/api/config/mobile-appearance/fence"} {
		for _, method := range []string{http.MethodGet, http.MethodPost} {
			w := httptest.NewRecorder()
			protected.ServeHTTP(w, httptest.NewRequest(method, path, strings.NewReader(`{}`)))
			if w.Code != 401 {
				t.Fatalf("unauthorized %s %s=%d", method, path, w.Code)
			}
		}
	}
	auth.mu.Lock()
	token, err := auth.newSessionLocked(time.Now())
	auth.mu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		method, path, body string
		status             int
	}{
		{http.MethodGet, "/api/config/mobile-appearance", "", 200},
		{http.MethodPost, "/api/config/mobile-appearance", `{"revision":0,"fields":{"ui_font_size":24,"terminal_font_size":32}}`, 200},
		{http.MethodPost, "/api/config/mobile-appearance/fence", `{}`, 200},
		{http.MethodGet, "/api/config/mobile-appearance/fence", "", 405},
	} {
		w := httptest.NewRecorder()
		r := httptest.NewRequest(tc.method, tc.path, strings.NewReader(tc.body))
		r.Header.Set("Content-Type", "application/json")
		r.AddCookie(&http.Cookie{Name: accessSessionCookie, Value: token})
		protected.ServeHTTP(w, r)
		if w.Code != tc.status {
			t.Fatalf("authorized %s %s=%d", tc.method, tc.path, w.Code)
		}
	}
}
