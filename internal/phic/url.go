package phic

import (
	"fmt"
	"net/url"
	"strings"
)

// mustWebsocketURL turns an http(s) URL into ws(s). The Phi
// server speaks plain HTTP on the loopback interface; the
// client maps to ws without TLS.
func mustWebsocketURL(raw string) (string, error) {
	u, err := url.Parse(raw)
	if err != nil {
		return "", fmt.Errorf("phic: bad URL %q: %w", raw, err)
	}
	switch strings.ToLower(u.Scheme) {
	case "http", "ws":
		u.Scheme = "ws"
	case "https", "wss":
		u.Scheme = "wss"
	default:
		return "", fmt.Errorf("phic: unsupported URL scheme %q", u.Scheme)
	}
	return u.String(), nil
}
