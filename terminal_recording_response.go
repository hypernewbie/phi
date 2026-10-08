package main

import (
	"compress/gzip"
	"encoding/binary"
	"io"
	"net/http"
	"strconv"
	"strings"
	"sync"
)

// HTTP content encoding changes only transport bytes. Both fetch and Go's
// default HTTP transport inflate natively before decoding this envelope.
// Tiny spans stay raw; no JS decoder, hash negotiation, or new wire format.
const recordingCompressionMinimum = 1024

var recordingGzipWriters = sync.Pool{New: func() any {
	writer, err := gzip.NewWriterLevel(io.Discard, gzip.BestSpeed)
	if err != nil {
		panic(err)
	} // Constant, supported compression level.
	return writer
}}

func acceptsRecordingGzip(header string) bool {
	wildcard := false
	for _, part := range strings.Split(header, ",") {
		fields := strings.Split(part, ";")
		coding := strings.ToLower(strings.TrimSpace(fields[0]))
		if coding != "gzip" && coding != "*" {
			continue
		}
		q := 1.0
		for _, parameter := range fields[1:] {
			key, value, ok := strings.Cut(strings.TrimSpace(parameter), "=")
			if ok && strings.EqualFold(key, "q") {
				n, err := strconv.ParseFloat(value, 64)
				if err != nil || !(n >= 0 && n <= 1) {
					q = 0
				} else {
					q = n
				}
			}
		}
		if coding == "gzip" {
			return q > 0
		}
		wildcard = q > 0
	}
	return wildcard
}

func writeRecordingResponse(w http.ResponseWriter, r *http.Request, header, data []byte) {
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Add("Vary", "Accept-Encoding")
	var output io.Writer = w
	if len(data) >= recordingCompressionMinimum && acceptsRecordingGzip(r.Header.Get("Accept-Encoding")) {
		writer := recordingGzipWriters.Get().(*gzip.Writer)
		writer.Reset(w)
		defer func() {
			_ = writer.Close()
			writer.Reset(io.Discard) // Do not retain a response/client in the pool.
			recordingGzipWriters.Put(writer)
		}()
		w.Header().Set("Content-Encoding", "gzip")
		output = writer
	}
	var length [4]byte
	binary.BigEndian.PutUint32(length[:], uint32(len(header)))
	if _, err := output.Write(length[:]); err != nil {
		return
	}
	if _, err := output.Write(header); err != nil {
		return
	}
	_, _ = output.Write(data)
}
