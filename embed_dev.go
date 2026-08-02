//go:build !embedassets

package main

import (
	"embed"
	"io/fs"
)

//go:embed all:web
var webFS embed.FS

// newWebRoot returns the raw embedded web/ tree. Release builds
// (-tags=embedassets) swap in the precompressed webdist/ mirror; see
// embed_release.go. go run . must always work from a fresh checkout,
// so the default build embeds the source tree directly.
func newWebRoot() (fs.FS, error) {
	return fs.Sub(webFS, "web")
}
