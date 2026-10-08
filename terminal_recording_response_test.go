package main

import (
	"bytes"
	"compress/gzip"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/hypernewbie/phi/pkg/ws"
)

func TestRecordingCompressionNegotiation(t *testing.T) {
	for _, tc := range []struct {
		header string
		want   bool
	}{
		{"", false}, {"identity", false}, {"br", false}, {"gzip", true}, {"br, gzip", true},
		{"gzip;q=0", false}, {"gzip;q=0.5", true}, {"GZIP; Q=1", true},
		{"*;q=1", true}, {"*;q=1,gzip;q=0", false}, {"gzip;q=bad", false},
		{"gzip;q=2", false}, {"gzip;q=NaN", false},
	} {
		if got := acceptsRecordingGzip(tc.header); got != tc.want {
			t.Errorf("%q: %v, want %v", tc.header, got, tc.want)
		}
	}
}

func TestRecordingResponseCompressionIsExactAndTinySpansStayRaw(t *testing.T) {
	for _, data := range [][]byte{[]byte("one glyph 你🙂"), bytes.Repeat([]byte("\x1b[38;2;40;50;60m你🙂\x1b[0m\r\n"), 4096)} {
		for _, accept := range []string{"", "gzip", "gzip;q=0"} {
			t.Run(fmt.Sprintf("%d/%s", len(data), accept), func(t *testing.T) {
				header := []byte(`{"epoch":7,"start":0,"end":` + fmt.Sprint(len(data)) + `,"resizes":[[0,80,24]]}`)
				req := httptest.NewRequest(http.MethodGet, "/recording", nil)
				req.Header.Set("Accept-Encoding", accept)
				w := httptest.NewRecorder()
				writeRecordingResponse(w, req, header, data)
				body := w.Body.Bytes()
				compressed := len(data) >= recordingCompressionMinimum && accept == "gzip"
				if (w.Header().Get("Content-Encoding") == "gzip") != compressed {
					t.Fatal("wrong transport encoding")
				}
				if compressed {
					zr, err := gzip.NewReader(bytes.NewReader(body))
					if err != nil {
						t.Fatal(err)
					}
					body, err = io.ReadAll(zr)
					if err != nil {
						t.Fatal(err)
					}
					if err := zr.Close(); err != nil {
						t.Fatal(err)
					}
				}
				n := binary.BigEndian.Uint32(body[:4])
				if !bytes.Equal(body[4:4+n], header) || !bytes.Equal(body[4+n:], data) {
					t.Fatal("encoding changed source bytes or metadata")
				}
				if w.Header().Get("Vary") != "Accept-Encoding" || w.Header().Get("Cache-Control") != "no-store" {
					t.Fatal("unsafe caching headers")
				}
			})
		}
	}
}

func TestRecordingEndpointDefaultHTTPTransportInflatesWithoutChangingFrontiers(t *testing.T) {
	setupHotHub(t)
	data := bytes.Repeat([]byte("\x1b[31mLINE 你🙂\x1b[0m\r\n"), 1024)
	if err := wsHub.Ingest("compressed", data); err != nil {
		t.Fatal(err)
	}
	wsHub.RecordResize("compressed", 100, 30)
	srv := httptest.NewServer(http.HandlerFunc(handleFallback))
	defer srv.Close()
	// Same Go automatic gzip support used by phic; no custom decompressor.
	resp, err := srv.Client().Get(srv.URL + fmt.Sprintf("/api/terminals/compressed/recording?from=0&through=%d", len(data)))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	if !resp.Uncompressed {
		t.Fatal("HTTP transport did not negotiate native decompression")
	}
	n := binary.BigEndian.Uint32(body[:4])
	var header ws.RecordingHeaderJSON
	if err := json.Unmarshal(body[4:4+n], &header); err != nil {
		t.Fatal(err)
	}
	if header.Start != 0 || header.End != uint64(len(data)) || !bytes.Equal(body[4+n:], data) {
		t.Fatal("decompression corrupted source interval")
	}
	if len(header.Resizes) != 1 || header.Resizes[0] != [3]uint64{uint64(len(data)), 100, 30} {
		t.Fatal("geometry metadata changed")
	}
}

func BenchmarkRecordingTransport(b *testing.B) {
	data := bytes.Repeat([]byte("\x1b[38;2;120;80;200mPHONE LINE xxxxxxxxxxxxxxxxxxxxxxxxxxxx\x1b[0m\r\n"), 10000)
	for _, encoding := range []string{"identity", "gzip"} {
		b.Run(encoding, func(b *testing.B) {
			req := httptest.NewRequest(http.MethodGet, "/recording", nil)
			req.Header.Set("Accept-Encoding", encoding)
			header := []byte(fmt.Sprintf(`{"epoch":7,"start":0,"end":%d}`, len(data)))
			b.ReportAllocs()
			b.SetBytes(int64(len(data)))
			var size int
			for b.Loop() {
				w := httptest.NewRecorder()
				writeRecordingResponse(w, req, header, data)
				size = w.Body.Len()
			}
			b.ReportMetric(float64(size), "wire-B/op")
		})
	}
}
