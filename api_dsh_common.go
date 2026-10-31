package main

import (
	"net/http"
	"net/url"
	"strings"
)

// dshStatusResponse is the launcher payload. Enabled is a real boolean;
// the frontend rejects any other shape. Both build variants share it so the
// JSON contract cannot drift when the preview is compiled out.
type dshStatusResponse struct {
	Enabled bool   `json:"enabled"`
	State   string `json:"state"`
	Mount   string `json:"mount,omitempty"`
	Reason  string `json:"reason,omitempty"`
}

// dshPathGuard runs before mux dispatch and rejects encoded traversal,
// encoded separators, and launch-token queries on DSH paths. It reads the
// raw escaped path so cleaning never hides an attack.
func dshPathGuard(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		escaped := r.URL.EscapedPath()
		if r.URL.Path == "/api/dsh" || strings.HasPrefix(r.URL.Path, "/api/dsh/") || escaped == "/api/dsh" || strings.HasPrefix(escaped, "/api/dsh/") {
			w.Header().Set("Cache-Control", "no-store")
			lower := strings.ToLower(escaped)
			if strings.Contains(lower, "%2e") || strings.Contains(lower, "%2f") ||
				strings.Contains(lower, "%5c") || strings.Contains(lower, "%25") || strings.Contains(escaped, "\\") {
				http.Error(w, "invalid dsh path", http.StatusBadRequest)
				return
			}
			if strings.Contains(escaped, "/./") || strings.Contains(escaped, "/../") ||
				strings.HasSuffix(escaped, "/.") || strings.HasSuffix(escaped, "/..") {
				http.Error(w, "invalid dsh path", http.StatusBadRequest)
				return
			}
			query, err := url.ParseQuery(r.URL.RawQuery)
			if err != nil {
				http.Error(w, "invalid dsh query", http.StatusBadRequest)
				return
			}
			if query.Has("token") {
				http.Error(w, "token query not allowed", http.StatusBadRequest)
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}
