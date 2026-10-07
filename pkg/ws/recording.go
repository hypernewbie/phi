package ws

import (
	"bytes"
	"encoding/binary"
	"fmt"
	"io"
	"os"
	"runtime"
	"sort"
)

// The replay ring is a cache. This append-only journal owns output and its
// geometry; chunk offsets permit bounded reads without rescanning old bytes.
type recordingChunk struct {
	seq    uint64
	offset int64
	length uint32
}
type coldRecording struct {
	file      *os.File
	path      string
	ephemeral bool
	offset    int64
	head      uint64
	chunks    []recordingChunk
	resizes   []ResizeMarker
	// Only ASCII text with CRLF line resets is eligible for a raw tail
	// shortcut. ANSI, UTF-8, tabs, and bare LF require prefix replay.
	plain    bool
	lastByte byte
}

func openRecording(path string) (*coldRecording, error) {
	var f *os.File
	var err error
	ephemeral := path == ""
	if ephemeral {
		f, err = os.CreateTemp("", "phi-recording-*")
	} else {
		f, err = os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0600)
	}
	if err != nil {
		return nil, err
	}
	if err := f.Chmod(0600); err != nil {
		f.Close()
		return nil, fmt.Errorf("secure recording permissions: %w", err)
	}
	r := &coldRecording{file: f, path: f.Name(), ephemeral: ephemeral, plain: true}
	info, err := f.Stat()
	if err != nil {
		f.Close()
		return nil, err
	}
	for r.offset < info.Size() {
		var hdr [5]byte
		if _, err = f.ReadAt(hdr[:], r.offset); err != nil {
			break
		}
		kind := hdr[0]
		n := binary.BigEndian.Uint32(hdr[1:])
		suffixStart := r.offset + 5
		if kind != 1 && kind != 2 {
			suffixStart = r.offset + 1
		}
		if (kind != 1 && kind != 2) || (kind == 2 && n != 4) || n > 64*1024*1024 || r.offset+5+int64(n) > info.Size() {
			if hasValidRecordSuffix(f, suffixStart, info.Size()) {
				f.Close()
				return nil, fmt.Errorf("corrupt recording record at offset %d before retained suffix", r.offset)
			}
			break
		}
		switch kind {
		case 1:
			if err := r.inspectPlain(r.offset+5, n); err != nil {
				f.Close()
				return nil, err
			}
			r.chunks = append(r.chunks, recordingChunk{r.head, r.offset + 5, n})
			r.head += uint64(n)
		case 2:
			var geometry [4]byte
			if _, err = f.ReadAt(geometry[:], r.offset+5); err != nil {
				f.Close()
				return nil, err
			}
			r.resizes = append(r.resizes, ResizeMarker{r.head, binary.BigEndian.Uint16(geometry[:2]), binary.BigEndian.Uint16(geometry[2:])})
		}
		r.offset += 5 + int64(n)
	}
	// Recover only a torn final append; never retain a fabricated byte frontier.
	if err = f.Truncate(r.offset); err != nil {
		f.Close()
		return nil, err
	}
	runtime.SetFinalizer(r, func(r *coldRecording) {
		r.file.Close()
		if r.ephemeral {
			os.Remove(r.path)
		}
	})
	return r, nil
}

// hasValidRecordSuffix distinguishes a torn final append from a damaged
// middle header with later committed records. The journal predates checksums,
// so a committed record chain followed by a torn final append also counts
// as a retained suffix. Ambiguous damage must fail closed, not delete data.
func hasValidRecordChain(file *os.File, start, end int64) bool {
	position := start
	records := 0
	for position < end {
		if position+5 > end {
			// The preceding records are complete even if the last header
			// was only partly written before shutdown.
			return records > 0
		}
		var header [5]byte
		if _, err := file.ReadAt(header[:], position); err != nil {
			return false
		}
		length := binary.BigEndian.Uint32(header[1:])
		if length > 64*1024*1024 ||
			(header[0] == 2 && length != 4) || (header[0] != 1 && header[0] != 2) {
			return false
		}
		if position+5+int64(length) > end {
			return records > 0 // complete suffix, then an incomplete payload
		}
		position += 5 + int64(length)
		records++
	}
	return records > 0 && position == end
}

func hasValidRecordSuffix(file *os.File, start, end int64) bool {
	const blockSize = 64 * 1024
	block := make([]byte, blockSize+4)
	for base := start; base+5 <= end; {
		length := min(int64(len(block)), end-base)
		n, err := file.ReadAt(block[:length], base)
		for i := 0; i+5 <= n; i++ {
			kind := block[i]
			if kind != 1 && kind != 2 {
				continue
			}
			declared := binary.BigEndian.Uint32(block[i+1 : i+5])
			candidate := base + int64(i)
			if declared > 64*1024*1024 || candidate+5+int64(declared) > end ||
				(kind == 2 && declared != 4) {
				continue
			}
			if hasValidRecordChain(file, candidate, end) {
				return true
			}
		}
		if err != nil || n <= 4 {
			break
		}
		base += int64(n - 4)
	}
	return false
}

func (r *coldRecording) notePlain(data []byte) {
	if !r.plain {
		return
	}
	for _, b := range data {
		if (b < 32 && b != '\r' && b != '\n') || b > 126 || (b == '\n' && r.lastByte != '\r') {
			r.plain = false
			return
		}
		r.lastByte = b
	}
}

func (r *coldRecording) inspectPlain(offset int64, length uint32) error {
	if !r.plain || length == 0 {
		return nil
	}
	block := make([]byte, min(length, 64*1024))
	for left := int64(length); left > 0 && r.plain; {
		n := min(int64(len(block)), left)
		if _, err := r.file.ReadAt(block[:n], offset); err != nil {
			return err
		}
		r.notePlain(block[:n])
		offset += n
		left -= n
	}
	return nil
}

// A line reset is a safe raw replay boundary only when the entire prefix is
// plain text and enough complete lines follow it to replace the live buffer.
// Otherwise no shortcut is certified; the client must replay the prefix.
func (r *coldRecording) replayStart() uint64 {
	const tailBytes = 2*1024*1024 - 128*1024
	const minimumLines = 10000 + 4096
	if !r.plain || r.head <= tailBytes {
		return 0
	}
	from := r.head - tailBytes
	data, resizes, err := r.read(from, r.head)
	if err != nil || bytes.Count(data, []byte("\r\n")) < minimumLines {
		return 0
	}
	for _, resize := range resizes {
		if resize.Rows > 4096 {
			return 0
		}
	}
	reset := bytes.Index(data, []byte("\r\n"))
	return from + uint64(reset) + 2
}

func (r *coldRecording) append(kind byte, data []byte) error {
	var hdr [5]byte
	hdr[0] = kind
	binary.BigEndian.PutUint32(hdr[1:], uint32(len(data)))
	if _, err := r.file.WriteAt(hdr[:], r.offset); err != nil {
		return err
	}
	if n, err := r.file.WriteAt(data, r.offset+5); err != nil {
		return err
	} else if n != len(data) {
		return io.ErrShortWrite
	}
	if kind == 1 {
		r.notePlain(data)
		r.chunks = append(r.chunks, recordingChunk{r.head, r.offset + 5, uint32(len(data))})
		r.head += uint64(len(data))
	} else {
		r.resizes = append(r.resizes, ResizeMarker{r.head, binary.BigEndian.Uint16(data[:2]), binary.BigEndian.Uint16(data[2:])})
	}
	r.offset += 5 + int64(len(data))
	return nil
}

func (r *coldRecording) read(from, end uint64) ([]byte, []ResizeMarker, error) {
	if end < from || end > r.head {
		return nil, nil, fmt.Errorf("invalid recording range")
	}
	data := make([]byte, int(end-from))
	i := sort.Search(len(r.chunks), func(i int) bool { c := r.chunks[i]; return c.seq+uint64(c.length) > from })
	for ; i < len(r.chunks); i++ {
		c := r.chunks[i]
		if c.seq >= end {
			break
		}
		start, stop := max(from, c.seq), min(end, c.seq+uint64(c.length))
		if _, err := r.file.ReadAt(data[start-from:stop-from], c.offset+int64(start-c.seq)); err != nil {
			return nil, nil, err
		}
	}
	var resizes []ResizeMarker
	at := sort.Search(len(r.resizes), func(i int) bool { return r.resizes[i].AtSeq >= from })
	// The geometry in force at the beginning matters even when set earlier.
	if at > 0 {
		resizes = append(resizes, r.resizes[at-1])
	}
	for ; at < len(r.resizes) && r.resizes[at].AtSeq <= end; at++ {
		resizes = append(resizes, r.resizes[at])
	}
	return data, resizes, nil
}
