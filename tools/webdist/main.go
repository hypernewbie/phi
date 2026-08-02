// Command webdist mirrors web/ into webdist/, minifying first-party
// js/css with esbuild, brotli-compressing every file that shrinks, and
// copying the rest raw. Release builds embed the mirror instead of
// web/ (-tags=embedassets, embed_release.go); dev builds never need it
// and always serve the readable sources. Output is deterministic for a
// given input tree and dependency set: lexical walk order, no
// timestamps, fixed quality, esbuild/brotli pinned via go.mod.
// Run from the repo root: go run ./tools/webdist
package main

import (
	"bytes"
	"fmt"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"strings"

	"github.com/andybalholm/brotli"
	"github.com/evanw/esbuild/pkg/api"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "webdist:", err)
		os.Exit(1)
	}
}

// minify returns the esbuild-minified form of first-party js/css and
// everything else unchanged. vendor/ ships upstream-minified files;
// re-minifying them buys nothing and risks churning foreign code.
func minify(p string, data []byte) ([]byte, error) {
	if strings.HasPrefix(p, "vendor/") {
		return data, nil
	}
	var loader api.Loader
	switch path.Ext(p) {
	case ".js":
		loader = api.LoaderJS
	case ".css":
		loader = api.LoaderCSS
	default:
		return data, nil
	}
	res := api.Transform(string(data), api.TransformOptions{
		Loader:            loader,
		MinifyWhitespace:  true,
		MinifyIdentifiers: true,
		MinifySyntax:      true,
		Charset:           api.CharsetUTF8,
	})
	if len(res.Errors) > 0 {
		return nil, fmt.Errorf("minify %s: %s", p, res.Errors[0].Text)
	}
	return res.Code, nil
}

func run() error {
	if err := os.RemoveAll("webdist"); err != nil {
		return err
	}
	src := os.DirFS("web")
	var files, minified, compressed int
	err := fs.WalkDir(src, ".", func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		data, err := fs.ReadFile(src, p)
		if err != nil {
			return err
		}
		if min, merr := minify(p, data); merr != nil {
			return merr
		} else if len(min) < len(data) {
			data = min
			minified++
		}
		out := filepath.Join("webdist", filepath.FromSlash(p))
		if err := os.MkdirAll(filepath.Dir(out), 0o755); err != nil {
			return err
		}
		var buf bytes.Buffer
		bw := brotli.NewWriterLevel(&buf, brotli.BestCompression)
		if _, err := bw.Write(data); err != nil {
			return err
		}
		if err := bw.Close(); err != nil {
			return err
		}
		files++
		if buf.Len() < len(data) {
			compressed++
			return os.WriteFile(out+".br", buf.Bytes(), 0o644)
		}
		return os.WriteFile(out, data, 0o644)
	})
	if err != nil {
		return err
	}
	fmt.Printf("webdist: %d files (%d minified, %d brotli)\n", files, minified, compressed)
	return nil
}
