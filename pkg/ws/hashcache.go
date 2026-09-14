package ws

import (
	"hash/fnv"
	"sort"
	"strconv"
	"strings"
)

// Hash-cache negotiation for recording bulk fetches.
//
// A reconnect storm on a bad link refetches the same delta repeatedly.
// Instead of resending it, the client declares the chunks it already
// holds (start:end:fnv1a64hex, from its bounded in-memory cache) and the
// server answers with the first uncovered run — or 204 when the client
// already has everything. Stateless per request: the declaration IS the
// per-client missing-set, so the server keeps no per-client memory.
// Malformed declarations never fail the request; they fall back to the
// full range. A hash mismatch means "not known": the bytes are resent,
// which is also the out-of-sync escape hatch (refresh declares nothing).

// MaxHaveChunks bounds declaration parsing; extras are ignored.
const MaxHaveChunks = 64

// HaveChunk is one client-declared cached chunk: absolute seqs plus the
// FNV-1a/64 of the raw bytes it holds for [Start, End).
type HaveChunk struct {
	Start uint64
	End   uint64
	Hash  uint64
}

// ChunkHash is the shared hash (Go side; the JS client implements the
// identical FNV-1a/64 over the same raw bytes — pinned by vectors in
// hashcache_test.go and test-js/hashCache.test.js).
func ChunkHash(data []byte) uint64 {
	h := fnv.New64a()
	_, _ = h.Write(data)
	return h.Sum64()
}

// ParseHave parses a have declaration "start:end:hexhash,...". Garbage
// in, garbage out: malformed entries are skipped, never errors.
func ParseHave(s string) []HaveChunk {
	if s == "" {
		return nil
	}
	var out []HaveChunk
	for _, part := range strings.Split(s, ",") {
		f := strings.Split(part, ":")
		if len(f) != 3 {
			continue
		}
		start, err1 := strconv.ParseUint(f[0], 10, 64)
		end, err2 := strconv.ParseUint(f[1], 10, 64)
		hash, err3 := strconv.ParseUint(f[2], 16, 64)
		if err1 != nil || err2 != nil || err3 != nil || end <= start {
			continue
		}
		out = append(out, HaveChunk{Start: start, End: end, Hash: hash})
		if len(out) >= MaxHaveChunks {
			break
		}
	}
	return out
}

// MissingRun subtracts verified client chunks from the span [from,
// through) the handler would otherwise return. data holds the server
// bytes for [base, base+len(data)) so declarations are verified, not
// trusted. It returns the first uncovered run [mfrom, mthrough) with
// mthrough <= through, or haveAll when the declaration covers the whole
// span. The cursor advances only over declarations that chain exactly
// from it with a matching hash; anything else (gap, overlap, overshoot
// past through, mismatch) stops the run and is resent — never skipped.
func MissingRun(from, through uint64, data []byte, base uint64, have []HaveChunk) (mfrom, mthrough uint64, haveAll bool) {
	if through <= from {
		return from, from, true
	}
	owned := make([]HaveChunk, 0, len(have))
	for _, h := range have {
		if h.End > from && h.Start < through {
			owned = append(owned, h)
		}
	}
	sort.Slice(owned, func(i, j int) bool {
		if owned[i].Start != owned[j].Start {
			return owned[i].Start < owned[j].Start
		}
		return owned[i].End < owned[j].End
	})
	cursor := from
	for _, h := range owned {
		if h.End <= cursor {
			continue
		}
		if h.Start != cursor || h.End > through {
			break
		}
		off := int(h.Start - base)
		n := int(h.End - h.Start)
		if off < 0 || n <= 0 || off+n > len(data) {
			break
		}
		if ChunkHash(data[off:off+n]) != h.Hash {
			break
		}
		cursor = h.End
	}
	if cursor >= through {
		return through, through, true
	}
	return cursor, through, false
}
