package ws

import (
	"fmt"
	"testing"
)

// Shared hash vectors: the JS client implements the identical FNV-1a/64
// (test-js/hashCache.test.js asserts the same values). If either side
// changes hash, both suites fail together.
func TestChunkHashVectors(t *testing.T) {
	cases := map[string]uint64{
		"":       0xcbf29ce484222325,
		"foobar": 0x85944171f73967e8,
		"a":      0xaf63dc4c8601ec8c,
	}
	for in, want := range cases {
		if got := ChunkHash([]byte(in)); got != want {
			t.Fatalf("ChunkHash(%q) = %x, want %x", in, got, want)
		}
	}
}

func TestParseHave(t *testing.T) {
	got := ParseHave(fmt.Sprintf("0:10:%x,10:20:%x", ChunkHash([]byte("0123456789")), ChunkHash([]byte("abcdefghij"))))
	if len(got) != 2 || got[0].Start != 0 || got[0].End != 10 || got[1].Start != 10 || got[1].End != 20 {
		t.Fatalf("bad parse: %+v", got)
	}
	// Garbage never errors: malformed entries are skipped.
	bad := ParseHave(",,,0:10,10:5:zz,7:9:12:14,x:y:z,3:9:NOTHEX")
	if len(bad) != 0 {
		t.Fatalf("expected empty, got %+v", bad)
	}
	if ParseHave("") != nil {
		t.Fatal("empty declaration must parse to nil")
	}
}

func TestMissingRun(t *testing.T) {
	data := []byte("0123456789abcdefghij") // base 0
	h0 := ChunkHash(data[0:10])
	h1 := ChunkHash(data[10:20])
	decl := func(s, e uint64, h uint64) HaveChunk { return HaveChunk{Start: s, End: e, Hash: h} }

	// No declaration: full span uncovered.
	if mfrom, mto, all := MissingRun(0, 20, data, 0, nil); mfrom != 0 || mto != 20 || all {
		t.Fatalf("no-decl: got [%d,%d) all=%v", mfrom, mto, all)
	}
	// Full coverage, chained: everything known.
	if _, _, all := MissingRun(0, 20, data, 0, []HaveChunk{decl(0, 10, h0), decl(10, 20, h1)}); !all {
		t.Fatal("full coverage must report haveAll")
	}
	// Prefix known: first uncovered run starts after it.
	if mfrom, mto, all := MissingRun(0, 20, data, 0, []HaveChunk{decl(0, 10, h0)}); mfrom != 10 || mto != 20 || all {
		t.Fatalf("prefix: got [%d,%d) all=%v", mfrom, mto, all)
	}
	// Middle known but prefix missing: prefix is resent, never skipped.
	if mfrom, _, all := MissingRun(0, 20, data, 0, []HaveChunk{decl(10, 20, h1)}); mfrom != 0 || all {
		t.Fatalf("middle-only: got from=%d all=%v", mfrom, all)
	}
	// Hash mismatch: treated as unknown, resent from the cursor.
	if mfrom, _, all := MissingRun(0, 20, data, 0, []HaveChunk{decl(0, 10, h1)}); mfrom != 0 || all {
		t.Fatalf("mismatch: got from=%d all=%v", mfrom, all)
	}
	// Overshoot past through: unverifiable, resent.
	if mfrom, _, all := MissingRun(0, 10, data, 0, []HaveChunk{decl(0, 20, ChunkHash(data))}); mfrom != 0 || all {
		t.Fatalf("overshoot: got from=%d all=%v", mfrom, all)
	}
	// Unordered declarations still chain after sorting.
	if _, _, all := MissingRun(0, 20, data, 0, []HaveChunk{decl(10, 20, h1), decl(0, 10, h0)}); !all {
		t.Fatal("unordered full coverage must report haveAll")
	}
	// Degenerate span.
	if _, _, all := MissingRun(5, 5, data, 0, nil); !all {
		t.Fatal("empty span must report haveAll")
	}
}
