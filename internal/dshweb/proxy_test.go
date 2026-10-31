package dshweb

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
)

func TestRewriteSetCookies(t *testing.T) {
	t.Parallel()
	mount := "/api/dsh/abcdefghijklmnopqrstuv/"
	resp := &http.Response{Header: make(http.Header)}
	resp.Header.Add("Set-Cookie", "dsh-auth-abc=signed-value; Max-Age=2592000; Path=/; HttpOnly; SameSite=Strict")
	resp.Header.Add("Set-Cookie", "unrelated=x; Path=/")
	resp.Header.Add("Set-Cookie", "phi_access_session=phi; Path=/")
	rewriteSetCookies(resp, "dsh-auth-abc", mount, false)
	cookies := resp.Cookies()
	if len(cookies) != 1 || cookies[0].Name != "dsh-auth-abc" || cookies[0].Value != "signed-value" {
		t.Fatalf("cookies = %v", cookies)
	}
	if cookies[0].Path != mount || !cookies[0].HttpOnly || cookies[0].Secure {
		t.Errorf("cookie attrs = %+v", cookies[0])
	}
	if cookies[0].SameSite != http.SameSiteStrictMode {
		t.Errorf("SameSite = %v", cookies[0].SameSite)
	}
	secure := &http.Response{Header: make(http.Header)}
	secure.Header.Add("Set-Cookie", "dsh-auth-abc=v; Path=/; HttpOnly; SameSite=Strict")
	rewriteSetCookies(secure, "dsh-auth-abc", mount, true)
	if !secure.Cookies()[0].Secure {
		t.Error("configured HTTPS must set Secure")
	}
	// Domain is dropped, never forwarded.
	domain := &http.Response{Header: make(http.Header)}
	domain.Header.Add("Set-Cookie", "dsh-auth-abc=v; Domain=example.com; Path=/")
	rewriteSetCookies(domain, "dsh-auth-abc", mount, false)
	if got := domain.Cookies()[0].Domain; got != "" {
		t.Errorf("Domain = %q, want dropped", got)
	}
	duplicate := &http.Response{Header: make(http.Header)}
	duplicate.Header.Add("Set-Cookie", "dsh-auth-abc=first")
	duplicate.Header.Add("Set-Cookie", "dsh-auth-abc=second")
	if err := rewriteSetCookies(duplicate, "dsh-auth-abc", mount, false); err == nil {
		t.Error("conflicting upstream cookies accepted")
	}
}

func TestRewriteRedirect(t *testing.T) {
	t.Parallel()
	upstream, _ := url.Parse("http://127.0.0.1:54321")
	mount := "/api/dsh/abcdefghijklmnopqrstuv/"
	newResp := func(target string) *http.Response {
		req := httptest.NewRequest(http.MethodGet, "http://127.0.0.1:54321/", nil)
		return &http.Response{
			StatusCode: http.StatusSeeOther,
			Header:     http.Header{"Location": {target}},
			Request:    req,
		}
	}
	// Relative bootstrap redirect stays inside the mount.
	resp := newResp("./")
	if err := rewriteRedirect(resp, upstream, mount); err != nil {
		t.Fatalf("relative redirect: %v", err)
	}
	if got := resp.Header.Get("Location"); got != mount {
		t.Errorf("Location = %q, want %q", got, mount)
	}
	// Absolute upstream path rewrites into the mount.
	resp = newResp("http://127.0.0.1:54321/app/main?x=1")
	if err := rewriteRedirect(resp, upstream, mount); err != nil {
		t.Fatalf("absolute redirect: %v", err)
	}
	if got := resp.Header.Get("Location"); got != mount+"app/main?x=1" {
		t.Errorf("Location = %q", got)
	}
	// Encoded characters survive verbatim: no second escaping.
	resp = newResp("http://127.0.0.1:54321/app/a%20b?x=%2F")
	if err := rewriteRedirect(resp, upstream, mount); err != nil {
		t.Fatalf("encoded redirect: %v", err)
	}
	if got, want := resp.Header.Get("Location"), mount+"app/a%20b?x=%2F"; got != want {
		t.Errorf("Location = %q, want %q", got, want)
	}
	// Escapes fail closed.
	for _, target := range []string{
		"https://evil.example/",
		"//evil.example/x",
		"http://127.0.0.1:9999/",
		"/../escape",
		"/app%2f..%2fescape",
		"/app%5c..%5cescape",
		"/%252e%252e/escape",
		"http://127.0.0.1:54321/?token=abc",
		"http://127.0.0.1:54321/%2e%2e/x",
	} {
		resp := newResp(target)
		if err := rewriteRedirect(resp, upstream, mount); err == nil {
			t.Errorf("redirect %q accepted, want rejection", target)
		}
	}
}
