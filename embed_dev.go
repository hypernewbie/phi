//go:build !embedassets

package main

import (
	"embed"
	"io/fs"
)

//go:embed all:web
var webFS embed.FS

// newWebRoot returns the raw embedded web/ tree plus any build-time
// brotli payloads. Release builds (-tags=embedassets) swap in the
// precompressed webdist/ mirror; see embed_release.go. go run . must
// always work from a fresh checkout, so the default build embeds the
// source tree directly and compresses lazily.
func newWebRoot() (fs.FS, map[string][]byte, error) {
	sub, err := fs.Sub(webFS, "web")
	if err != nil {
		return nil, nil, err
	}
	return sub, nil, nil
}
