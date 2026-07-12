package ws

import (
	"sync"
)

type RingBuffer struct {
	mu      sync.Mutex
	buf     []byte
	size    int
	write   int
	wrapped bool
}

func NewRingBuffer(size int) *RingBuffer {
	if size <= 0 {
		return nil
	}
	return &RingBuffer{
		buf:  make([]byte, size),
		size: size,
	}
}

func (r *RingBuffer) Write(p []byte) {
	if r == nil || r.size == 0 {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()

	n := len(p)
	if n >= r.size {
		copy(r.buf, p[n-r.size:])
		r.write = 0
		r.wrapped = true
		return
	}

	space := r.size - r.write
	if n <= space {
		copy(r.buf[r.write:], p)
		r.write += n
		if r.write == r.size {
			r.write = 0
			r.wrapped = true
		}
	} else {
		copy(r.buf[r.write:], p[:space])
		copy(r.buf[0:], p[space:])
		r.write = n - space
		r.wrapped = true
	}
}

func (r *RingBuffer) Snapshot() []byte {
	if r == nil || r.size == 0 {
		return nil
	}
	r.mu.Lock()
	defer r.mu.Unlock()

	if !r.wrapped {
		res := make([]byte, r.write)
		copy(res, r.buf[:r.write])
		return res
	}

	res := make([]byte, r.size)
	copy(res[0:], r.buf[r.write:])
	copy(res[r.size-r.write:], r.buf[:r.write])
	return res
}

// Stats returns (used bytes, capacity) for the ring. When wrapped,
// used == cap. Used by /api/diag.
func (r *RingBuffer) Stats() (int, int) {
	if r == nil {
		return 0, 0
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.wrapped {
		return r.size, r.size
	}
	return r.write, r.size
}
