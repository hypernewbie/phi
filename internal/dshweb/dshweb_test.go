package dshweb

import (
	"net/http"
	"testing"
)

func TestParseOrigin(t *testing.T) {
	t.Parallel()
	good := map[string]Origin{
		"http://127.0.0.1:8080": {
			Scheme: "http", Hostname: "127.0.0.1", Port: 8080, Authority: "127.0.0.1:8080",
		},
		"http://127.0.0.1/": {
			Scheme: "http", Hostname: "127.0.0.1", Port: 80, Authority: "127.0.0.1",
		},
		"https://phi.example:8443": {
			Scheme: "https", Hostname: "phi.example", Port: 8443, Authority: "phi.example:8443",
		},
	}
	for raw, want := range good {
		got, err := ParseOrigin(raw)
		if err != nil {
			t.Errorf("ParseOrigin(%q) error: %v", raw, err)
			continue
		}
		if got != want {
			t.Errorf("ParseOrigin(%q) = %+v, want %+v", raw, got, want)
		}
	}

	bad := []string{
		"",
		"http://127.0.0.1:8080/ui",
		"http://127.0.0.1:8080?x=1",
		"http://127.0.0.1:8080#frag",
		"http://user:pass@127.0.0.1:8080",
		"ftp://127.0.0.1:21",
		"file:///etc/passwd",
		"http://",
		"http://127.0.0.1:0",
		"http://127.0.0.1:99999",
		"http://127.0.0.1:notaport",
	}
	for _, raw := range bad {
		if _, err := ParseOrigin(raw); err == nil {
			t.Errorf("ParseOrigin(%q) accepted, want rejection", raw)
		}
	}
}

func TestOriginMatchHost(t *testing.T) {
	t.Parallel()
	o, err := ParseOrigin("http://127.0.0.1:8080")
	if err != nil {
		t.Fatal(err)
	}
	if !o.MatchHost("127.0.0.1:8080") {
		t.Error("exact Host must match")
	}
	def, err := ParseOrigin("http://127.0.0.1")
	if err != nil {
		t.Fatal(err)
	}
	if !def.MatchHost("127.0.0.1") || !def.MatchHost("127.0.0.1:80") {
		t.Error("default-port Host forms must both match")
	}
	if o.MatchHost("127.0.0.1:9090") || o.MatchHost("evil.example:8080") || o.MatchHost("") {
		t.Error("foreign/empty Host must not match")
	}
	if o.MatchHost("127.0.0.1:8080.evil.example") {
		t.Error("suffix Host must not match")
	}
}

func TestOriginMatchOrigin(t *testing.T) {
	t.Parallel()
	o, err := ParseOrigin("http://127.0.0.1:8080")
	if err != nil {
		t.Fatal(err)
	}
	if !o.MatchOrigin("http://127.0.0.1:8080") {
		t.Error("exact origin must match")
	}
	for _, bad := range []string{"", "null", "http://127.0.0.1:9090", "https://127.0.0.1:8080", "http://evil.example:8080"} {
		if o.MatchOrigin(bad) {
			t.Errorf("MatchOrigin(%q) = true, want false", bad)
		}
	}
}

func TestCookieName(t *testing.T) {
	t.Parallel()
	// Independent vectors: openssl dgst -sha256 -binary, base64url, no pad.
	name, err := CookieName("http", "127.0.0.1:8080")
	if err != nil {
		t.Fatal(err)
	}
	if want := "dsh-auth-tnj6d93kQvawui-joPSvI431eQZmv7JBRAXy78AcksY"; name != want {
		t.Errorf("CookieName http = %q, want %q", name, want)
	}
	secure, err := CookieName("https", "phi.example:8443")
	if err != nil {
		t.Fatal(err)
	}
	if want := "dsh-auth-dF3qbFbSAPLg-ApxHMVO2sLBMLDXOcKQBwAPPUZ4400"; secure != want {
		t.Errorf("CookieName https = %q, want %q", secure, want)
	}
	upper, err := CookieName("http", "127.0.0.1:8080")
	if err != nil || upper != name {
		t.Error("cookie derivation must be stable")
	}
	bare, err := CookieName("http", "127.0.0.1")
	if err != nil {
		t.Fatal(err)
	}
	explicit, err := CookieName("http", "127.0.0.1:80")
	if err != nil {
		t.Fatal(err)
	}
	if bare != explicit {
		t.Error("default-port Host forms must derive the same cookie name")
	}
	if _, err := CookieName("ftp", "127.0.0.1"); err == nil {
		t.Error("non-HTTP cookie scheme must fail")
	}
}

func TestValidInstance(t *testing.T) {
	t.Parallel()
	if !ValidInstance("abcdefghijklmnopqrstuv") {
		t.Error("22-char base64url must be valid")
	}
	for _, bad := range []string{"", "status", "short", "abcdefghijklmnopqrstuvw", "abcdefghijklmnopqrstu!", "../escape-attempt.....x"} {
		if ValidInstance(bad) {
			t.Errorf("ValidInstance(%q) = true, want false", bad)
		}
	}
}

func TestSplitMount(t *testing.T) {
	t.Parallel()
	inst, rest, ok := SplitMount("/api/dsh/abcdefghijklmnopqrstuv/api/x")
	if !ok || inst != "abcdefghijklmnopqrstuv" || rest != "/api/x" {
		t.Errorf("SplitMount = %q %q %v", inst, rest, ok)
	}
	inst, rest, ok = SplitMount("/api/dsh/abcdefghijklmnopqrstuv/")
	if !ok || inst != "abcdefghijklmnopqrstuv" || rest != "/" {
		t.Errorf("SplitMount root = %q %q %v", inst, rest, ok)
	}
	inst, rest, ok = SplitMount("/api/dsh/abcdefghijklmnopqrstuv")
	if !ok || inst != "abcdefghijklmnopqrstuv" || rest != "" {
		t.Errorf("SplitMount bare = %q %q %v", inst, rest, ok)
	}
	if _, _, ok := SplitMount("/api/dsh/status"); !ok {
		t.Error("status path splits (handler treats it as unknown instance)")
	}
	if _, _, ok := SplitMount("/api/other"); ok {
		t.Error("non-DSH path must not split")
	}
}

func TestFilterUpstreamCookie(t *testing.T) {
	t.Parallel()
	req, _ := http.NewRequest(http.MethodGet, "http://x/", nil)
	req.AddCookie(&http.Cookie{Name: "phi_access_session", Value: "phi-secret"})
	req.AddCookie(&http.Cookie{Name: "dsh-auth-abc", Value: "dsh-value"})
	req.AddCookie(&http.Cookie{Name: "other", Value: "unrelated"})
	value, present, ok := FilterUpstreamCookie(req, "dsh-auth-abc")
	if !ok || !present || value != "dsh-value" {
		t.Errorf("FilterUpstreamCookie = %q %v %v", value, present, ok)
	}
	dup, _ := http.NewRequest(http.MethodGet, "http://x/", nil)
	dup.Header.Add("Cookie", "dsh-auth-abc=one")
	dup.Header.Add("Cookie", "dsh-auth-abc=two")
	if _, _, ok := FilterUpstreamCookie(dup, "dsh-auth-abc"); ok {
		t.Error("conflicting duplicate DSH cookies must fail")
	}
	same, _ := http.NewRequest(http.MethodGet, "http://x/", nil)
	same.Header.Add("Cookie", "dsh-auth-abc=one; dsh-auth-abc=one")
	if _, _, ok := FilterUpstreamCookie(same, "dsh-auth-abc"); !ok {
		t.Error("identical duplicate cookies must pass")
	}
	none, _ := http.NewRequest(http.MethodGet, "http://x/", nil)
	if _, present, ok := FilterUpstreamCookie(none, "dsh-auth-abc"); !ok || present {
		t.Error("absent cookie must report present=false with ok")
	}
}

func TestCheckCarrierRequest(t *testing.T) {
	t.Parallel()
	origin, err := ParseOrigin("http://127.0.0.1:8080")
	if err != nil {
		t.Fatal(err)
	}
	newReq := func(method, host, reqOrigin string) *http.Request {
		req, _ := http.NewRequest(method, "http://127.0.0.1:8080/api/dsh/i/", nil)
		req.Host = host
		if reqOrigin != "" {
			req.Header.Set("Origin", reqOrigin)
		}
		return req
	}
	cases := []struct {
		name string
		req  *http.Request
		want bool
	}{
		{"get absent origin", newReq(http.MethodGet, "127.0.0.1:8080", ""), true},
		{"get exact origin", newReq(http.MethodGet, "127.0.0.1:8080", "http://127.0.0.1:8080"), true},
		{"bad host", newReq(http.MethodGet, "evil.example:8080", ""), false},
		{"get foreign origin", newReq(http.MethodGet, "127.0.0.1:8080", "http://evil.example"), false},
		{"get null origin", newReq(http.MethodGet, "127.0.0.1:8080", "null"), false},
		{"post exact origin", newReq(http.MethodPost, "127.0.0.1:8080", "http://127.0.0.1:8080"), true},
		{"post missing origin", newReq(http.MethodPost, "127.0.0.1:8080", ""), false},
		{"post foreign origin", newReq(http.MethodPost, "127.0.0.1:8080", "http://evil.example"), false},
	}
	for _, tc := range cases {
		err := CheckCarrierRequest(tc.req, origin)
		if (err == nil) != tc.want {
			t.Errorf("%s: err=%v, want ok=%v", tc.name, err, tc.want)
		}
	}
	ws := newReq(http.MethodGet, "127.0.0.1:8080", "http://127.0.0.1:8080")
	ws.Header.Set("Upgrade", "websocket")
	ws.Header.Set("Connection", "Upgrade")
	if err := CheckCarrierRequest(ws, origin); err != nil {
		t.Errorf("upgrade with exact origin: %v", err)
	}
	wsNoOrigin := newReq(http.MethodGet, "127.0.0.1:8080", "")
	wsNoOrigin.Header.Set("Upgrade", "websocket")
	wsNoOrigin.Header.Set("Connection", "keep-alive, Upgrade")
	if err := CheckCarrierRequest(wsNoOrigin, origin); err == nil {
		t.Error("upgrade without origin must fail")
	}
	meta := newReq(http.MethodGet, "127.0.0.1:8080", "")
	meta.Header.Set("Sec-Fetch-Site", "cross-site")
	if err := CheckCarrierRequest(meta, origin); err == nil {
		t.Error("cross-site fetch metadata must fail")
	}
	tokenReq := newReq(http.MethodGet, "127.0.0.1:8080", "")
	tokenReq.URL.RawQuery = "token=abc"
	if err := CheckCarrierRequest(tokenReq, origin); err == nil {
		t.Error("token query must fail")
	}
}
