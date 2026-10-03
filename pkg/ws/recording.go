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
