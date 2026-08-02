// Command webdist mirrors web/ into webdist/, brotli-compressing every
// file that shrinks and copying the rest raw. Release builds embed the
// mirror instead of web/ (-tags=embedassets, embed_release.go); dev
// builds never need it. Output is deterministic for a given input tree
// and brotli version: lexical walk order, no timestamps, fixed quality.
// Run from the repo root: go run ./tools/webdist
package main

import (
	"bytes"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"

	"github.com/andybalholm/brotli"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "webdist:", err)
		os.Exit(1)
	}
}

func run() error {
	if err := os.RemoveAll("webdist"); err != nil {
		return err
	}
	src := os.DirFS("web")
	var files, compressed int
	err := fs.WalkDir(src, ".", func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		data, err := fs.ReadFile(src, p)
		if err != nil {
			return err
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
	fmt.Printf("webdist: %d files (%d brotli)\n", files, compressed)
	return nil
}
