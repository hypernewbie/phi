//go:build embedassets

package main

import (
	"bytes"
	"embed"
	"io"
	"io/fs"
	"strings"
	"testing/fstest"

	"github.com/andybalholm/brotli"
)

// Release builds embed the precompressed webdist/ mirror produced by
// tools/webdist. Building with -tags=embedassets and no webdist/ fails
// at compile time — stale or missing assets can never ship silently.
//
//go:embed all:webdist
var distFS embed.FS

// newWebRoot decompresses the mirror once at startup (~10 ms) into an
// in-memory tree and keeps each .br payload so serveStatic hands br
// clients the build-time bytes verbatim — the runtime brotli encoder
// never runs in release builds. fstest.MapFS opened files are seekable
// (asserted in the tagged tests), which http.ServeContent needs for
// Range requests against the identity bytes.
func newWebRoot() (fs.FS, error) {
	sub, err := fs.Sub(distFS, "webdist")
	if err != nil {
		return nil, err
	}
	m := fstest.MapFS{}
	preBrotli = map[string][]byte{}
	err = fs.WalkDir(sub, ".", func(p string, d fs.DirEntry, werr error) error {
		if werr != nil || d.IsDir() {
			return werr
		}
		data, rerr := fs.ReadFile(sub, p)
		if rerr != nil {
			return rerr
		}
		if logical, ok := strings.CutSuffix(p, ".br"); ok {
			identity, derr := io.ReadAll(brotli.NewReader(bytes.NewReader(data)))
			if derr != nil {
				return derr
			}
			m[logical] = &fstest.MapFile{Data: identity}
			preBrotli[logical] = data
			return nil
		}
		m[p] = &fstest.MapFile{Data: data}
		return nil
	})
	return m, err
}
