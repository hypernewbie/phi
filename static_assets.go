package main

import (
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"io/fs"
	"log/slog"
	"mime"
	"net/http"
	"path"
	"strconv"
	"strings"
	"sync"

	"github.com/andybalholm/brotli"
)

// staticAsset holds startup-computed cache metadata for one embedded
// web/ file. Embedded assets never change while the process runs, so
// compressed variants are built once on first use and kept forever.
type staticAsset struct {
	hash  string // unquoted hex content hash; ETag variants derive from it
	ctype string // resolved once so compressed responses skip sniffing

	gzOnce sync.Once
	gz     []byte
	brOnce sync.Once
	br     []byte
}

var staticAssets map[string]*staticAsset

// compressibleStaticExts lists embedded extensions worth encoding.
// woff2 is internally brotli-compressed (gzip grows it) and images are
// already compressed; bell.wav is raw PCM and shrinks ~58-68%.
var compressibleStaticExts = map[string]bool{
	".css":  true,
	".html": true,
	".js":   true,
	".json": true,
	".md":   true,
	".svg":  true,
	".txt":  true,
	".wav":  true,
}

// initStaticAssets walks the embedded web/ tree and computes a strong
// ETag per file. Called once at startup, right after webRoot is set.
func initStaticAssets(root fs.FS) {
	staticAssets = make(map[string]*staticAsset)
	_ = fs.WalkDir(root, ".", func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return nil
		}
		data, rerr := fs.ReadFile(root, p)
		if rerr != nil {
			slog.Error("static asset unreadable; serving without cache headers", "path", p, "err", rerr)
			return nil
		}
		sum := sha256.Sum256(data)
		ctype := mime.TypeByExtension(path.Ext(p))
		if ctype == "" {
			ctype = http.DetectContentType(data)
		}
		staticAssets[p] = &staticAsset{
			hash:  hex.EncodeToString(sum[:8]),
			ctype: ctype,
		}
		return nil
	})
}

// staticPath maps a request URL path to its embedded file path.
// http.FileServer serves index.html for "/", so "/" must share its ETag.
func staticPath(urlPath string) string {
	p := strings.TrimPrefix(path.Clean(urlPath), "/")
	if p == "" || p == "." {
		return "index.html"
	}
	return p
}

func (a *staticAsset) etag(enc string) string {
	if enc == "" {
		return `"` + a.hash + `"`
	}
	return `"` + a.hash + "-" + enc + `"`
}

// compressed returns the cached encoded body for "gzip" or "br",
// building it on first use. Returns nil when encoding failed or did
// not shrink the asset — callers then fall back to identity.
func (a *staticAsset) compressed(root fs.FS, p, enc string) []byte {
	build := func(encode func(*bytes.Buffer, []byte) error) []byte {
		data, err := fs.ReadFile(root, p)
		if err != nil {
			return nil
		}
		var buf bytes.Buffer
		if err := encode(&buf, data); err != nil || buf.Len() >= len(data) {
			return nil
		}
		return buf.Bytes()
	}
	switch enc {
	case "gzip":
		a.gzOnce.Do(func() {
			a.gz = build(func(buf *bytes.Buffer, data []byte) error {
				zw, err := gzip.NewWriterLevel(buf, gzip.BestCompression)
				if err != nil {
					return err
				}
				if _, err := zw.Write(data); err != nil {
					return err
				}
				return zw.Close()
			})
		})
		return a.gz
	case "br":
		a.brOnce.Do(func() {
			a.br = build(func(buf *bytes.Buffer, data []byte) error {
				bw := brotli.NewWriterLevel(buf, brotli.BestCompression)
				if _, err := bw.Write(data); err != nil {
					return err
				}
				return bw.Close()
			})
		})
		return a.br
	}
	return nil
}

// negotiateStaticEncoding picks br over gzip from Accept-Encoding.
// q-values are deliberately ignored (a client sending gzip;q=0 is not
// worth the parser); unknown codings fall through to identity.
func negotiateStaticEncoding(acceptEncoding string) string {
	br, gz := false, false
	for _, part := range strings.Split(acceptEncoding, ",") {
		tok, _, _ := strings.Cut(strings.TrimSpace(part), ";")
		switch strings.ToLower(strings.TrimSpace(tok)) {
		case "br":
			br = true
		case "gzip":
			gz = true
		}
	}
	if br {
		return "br"
	}
	if gz {
		return "gzip"
	}
	return ""
}

// serveStatic serves embedded web assets with ETag revalidation and,
// when enabled, negotiated gzip/brotli compression. Non-GET/HEAD
// requests pass through untouched (a matching If-None-Match on other
// methods would yield 412, and FileServer serves bodies for POST too).
func serveStatic(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		http.FileServer(http.FS(webRoot)).ServeHTTP(w, r)
		return
	}
	p := staticPath(r.URL.Path)
	a, ok := staticAssets[p]
	if !ok {
		http.FileServer(http.FS(webRoot)).ServeHTTP(w, r)
		return
	}

	w.Header().Set("Cache-Control", "no-cache")

	enc := ""
	if compressibleStaticExts[path.Ext(p)] && loadConfig().CompressionEnabled {
		// The response for this path varies by Accept-Encoding even when
		// this particular request ends up with the identity encoding.
		w.Header().Set("Vary", "Accept-Encoding")
		// Byte ranges address the uncompressed body; serve them identity
		// via ServeContent, which handles Range/If-Range properly.
		if r.Header.Get("Range") == "" {
			enc = negotiateStaticEncoding(r.Header.Get("Accept-Encoding"))
		}
	}

	var body []byte
	if enc != "" {
		body = a.compressed(webRoot, p, enc)
	}
	if body == nil {
		// Identity: ServeContent handles Range, Content-Type, and 304s
		// against the pre-set quoted ETag.
		w.Header().Set("Etag", a.etag(""))
		http.FileServer(http.FS(webRoot)).ServeHTTP(w, r)
		return
	}

	etag := a.etag(enc)
	w.Header().Set("Etag", etag)
	if inm := r.Header.Get("If-None-Match"); inm != "" && (inm == "*" || strings.Contains(inm, etag)) {
		w.WriteHeader(http.StatusNotModified)
		return
	}
	w.Header().Set("Content-Type", a.ctype)
	w.Header().Set("Content-Encoding", enc)
	w.Header().Set("Content-Length", strconv.Itoa(len(body)))
	if r.Method == http.MethodHead {
		return
	}
	_, _ = w.Write(body)
}
