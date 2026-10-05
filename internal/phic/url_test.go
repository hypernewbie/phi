package phic

import "testing"

// TestMustWebsocketURL covers the http/https -> ws/wss map
// used by the relay's dialer.
func TestMustWebsocketURL(t *testing.T) {
	cases := []struct{ in, want string }{
		{"http://127.0.0.1:7070", "ws://127.0.0.1:7070"},
		{"https://example.com", "wss://example.com"},
		{"ws://example.com", "ws://example.com"},
		{"wss://example.com", "wss://example.com"},
	}
	for _, c := range cases {
		got, err := mustWebsocketURL(c.in)
		if err != nil {
			t.Fatalf("mustWebsocketURL(%q): %v", c.in, err)
		}
		if got != c.want {
			t.Fatalf("mustWebsocketURL(%q) = %q, want %q", c.in, got, c.want)
		}
	}
	if _, err := mustWebsocketURL("ftp://example.com"); err == nil {
		t.Fatalf("expected error for ftp scheme")
	}
}
