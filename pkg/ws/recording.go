package ws

import (
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
	r := &coldRecording{file: f, path: f.Name(), ephemeral: ephemeral}
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
		n := binary.BigEndian.Uint32(hdr[1:])
		if n > 64*1024*1024 || r.offset+5+int64(n) > info.Size() {
			if hasValidRecordSuffix(f, r.offset+5, info.Size()) {
				f.Close()
				return nil, fmt.Errorf("corrupt recording record at offset %d before retained suffix", r.offset)
			}
			break
		}
		switch hdr[0] {
		case 1:
			r.chunks = append(r.chunks, recordingChunk{r.head, r.offset + 5, n})
			r.head += uint64(n)
		case 2:
			if n != 4 {
				f.Close()
				return nil, fmt.Errorf("invalid resize record")
			}
			var geometry [4]byte
			if _, err = f.ReadAt(geometry[:], r.offset+5); err != nil {
				f.Close()
				return nil, err
			}
			r.resizes = append(r.resizes, ResizeMarker{r.head, binary.BigEndian.Uint16(geometry[:2]), binary.BigEndian.Uint16(geometry[2:])})
		default:
			f.Close()
			return nil, fmt.Errorf("invalid recording entry")
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
// so recovery accepts a suffix only when a complete chain of framed records
// reaches EOF; otherwise it truncates only the incomplete tail.
func hasValidRecordChain(file *os.File, start, end int64) bool {
	position := start
	records := 0
	for position < end {
		if position+5 > end {
			return false
		}
		var header [5]byte
		if _, err := file.ReadAt(header[:], position); err != nil {
			return false
		}
		length := binary.BigEndian.Uint32(header[1:])
		if length > 64*1024*1024 || position+5+int64(length) > end ||
			(header[0] == 2 && length != 4) || (header[0] != 1 && header[0] != 2) {
			return false
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
