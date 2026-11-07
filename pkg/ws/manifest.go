package ws

import (
	"bytes"
	"encoding/binary"
	"fmt"
	"hash/crc32"
	"io"
	"os"
	"strconv"
	"strings"
)

// The retention manifest codec. The bounded retention group that wrote
// these manifests is retired; the raw journal (the live on-disk history)
// kept the format, and the disk sweep still recognizes leftover group
// segment files so it can delete them. This file owns the shared codec
// and nothing else.

const retentionManifestMax = 64 << 10

var retentionManifestMagic = []byte("PHIRV2")

const retentionManifestVersion = 1

const retentionFlagClosed = 1 << 0

// Upper bounds a manifest may carry. Segment sizes only gate decode, not
// any write path: no code writes segments anymore.
const (
	retentionSegRawMax   uint64 = (4 << 20) + (32 << 10)
	retentionRszMaxCount        = 4096
	retentionCkptMax            = 2 << 20
	retentionSegsKept           = 9
)

type retentionSegDesc struct {
	gen          uint64
	start        uint64
	rawLen       uint64
	startOrdinal uint64
	rszCount     uint32
	ckptLen      uint32
}

type retentionManifest struct {
	head         uint64
	segs         []retentionSegDesc
	plain        bool
	lastByte     byte
	flags        uint32
	closedAtNs   int64
	lastUpdateNs int64
}

func encodeRetentionManifest(m retentionManifest) []byte {
	var buf bytes.Buffer
	buf.Write(retentionManifestMagic)
	var tmp [8]byte
	binary.LittleEndian.PutUint16(tmp[:2], retentionManifestVersion)
	buf.Write(tmp[:2])
	binary.LittleEndian.PutUint64(tmp[:], m.head)
	buf.Write(tmp[:])
	binary.LittleEndian.PutUint32(tmp[:4], uint32(len(m.segs)))
	buf.Write(tmp[:4])
	for _, s := range m.segs {
		binary.LittleEndian.PutUint64(tmp[:], s.gen)
		buf.Write(tmp[:])
		binary.LittleEndian.PutUint64(tmp[:], s.start)
		buf.Write(tmp[:])
		binary.LittleEndian.PutUint64(tmp[:], s.rawLen)
		buf.Write(tmp[:])
		binary.LittleEndian.PutUint64(tmp[:], s.startOrdinal)
		buf.Write(tmp[:])
		binary.LittleEndian.PutUint32(tmp[:4], s.rszCount)
		buf.Write(tmp[:4])
		binary.LittleEndian.PutUint32(tmp[:4], s.ckptLen)
		buf.Write(tmp[:4])
	}
	if m.plain {
		buf.WriteByte(1)
	} else {
		buf.WriteByte(0)
	}
	buf.WriteByte(m.lastByte)
	binary.LittleEndian.PutUint32(tmp[:4], m.flags)
	buf.Write(tmp[:4])
	binary.LittleEndian.PutUint64(tmp[:], uint64(m.closedAtNs))
	buf.Write(tmp[:])
	binary.LittleEndian.PutUint64(tmp[:], uint64(m.lastUpdateNs))
	buf.Write(tmp[:])
	out := buf.Bytes()
	var crc [4]byte
	binary.LittleEndian.PutUint32(crc[:], crc32.ChecksumIEEE(out))
	return append(out, crc[:]...)
}

// readRetentionManifest reads a manifest through a bounded regular-file
// reader so a corrupt oversized entry cannot exhaust server memory
// before the size check runs. Non-regular entries (symlinks, fifos,
// directories) reject without blocking on or following them.
func readRetentionManifest(path string) ([]byte, error) {
	fi, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if !fi.Mode().IsRegular() {
		return nil, fmt.Errorf("retention manifest is not a regular file")
	}
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	if ofi, err := f.Stat(); err != nil || !ofi.Mode().IsRegular() {
		return nil, fmt.Errorf("retention manifest is not a regular file")
	}
	data, err := io.ReadAll(io.LimitReader(f, int64(retentionManifestMax)+1))
	if err != nil {
		return nil, err
	}
	if len(data) > retentionManifestMax {
		return nil, fmt.Errorf("retention manifest exceeds size bound")
	}
	return data, nil
}

func decodeRetentionManifest(data []byte) (retentionManifest, error) {
	var m retentionManifest
	if len(data) > retentionManifestMax {
		return m, fmt.Errorf("retention manifest exceeds size bound")
	}
	if len(data) < 50 || !bytes.Equal(data[:6], retentionManifestMagic) {
		return m, fmt.Errorf("invalid retention manifest")
	}
	body, crc := data[:len(data)-4], data[len(data)-4:]
	if crc32.ChecksumIEEE(body) != binary.LittleEndian.Uint32(crc) {
		return m, fmt.Errorf("retention manifest checksum mismatch")
	}
	if binary.LittleEndian.Uint16(body[6:8]) != retentionManifestVersion {
		return m, fmt.Errorf("unsupported retention manifest version")
	}
	m.head = binary.LittleEndian.Uint64(body[8:16])
	count := int(binary.LittleEndian.Uint32(body[16:20]))
	if count < 1 || count > retentionSegsKept {
		return m, fmt.Errorf("invalid retention segment count %d", count)
	}
	if len(body) != 42+40*count {
		return m, fmt.Errorf("retention manifest length mismatch")
	}
	at := 20
	for range count {
		var s retentionSegDesc
		s.gen = binary.LittleEndian.Uint64(body[at:])
		s.start = binary.LittleEndian.Uint64(body[at+8:])
		s.rawLen = binary.LittleEndian.Uint64(body[at+16:])
		s.startOrdinal = binary.LittleEndian.Uint64(body[at+24:])
		s.rszCount = binary.LittleEndian.Uint32(body[at+32:])
		s.ckptLen = binary.LittleEndian.Uint32(body[at+36:])
		at += 40
		if s.gen == 0 || s.start > m.head || s.rawLen > retentionSegRawMax ||
			s.startOrdinal == 0 || s.rszCount > retentionRszMaxCount || s.ckptLen > retentionCkptMax {
			return m, fmt.Errorf("retention manifest segment out of bounds")
		}
		if n := len(m.segs); n > 0 {
			prev := m.segs[n-1]
			if s.gen <= prev.gen || s.start < prev.start ||
				s.startOrdinal != prev.startOrdinal+uint64(prev.rszCount) {
				return m, fmt.Errorf("retention manifest segments out of order")
			}
		}
		m.segs = append(m.segs, s)
	}
	last := m.segs[len(m.segs)-1]
	if last.start+last.rawLen != m.head {
		return m, fmt.Errorf("retention manifest head mismatch")
	}
	switch body[at] {
	case 0:
		m.plain = false
	case 1:
		m.plain = true
	default:
		return m, fmt.Errorf("invalid retention plain flag")
	}
	m.lastByte = body[at+1]
	m.flags = binary.LittleEndian.Uint32(body[at+2:])
	m.closedAtNs = int64(binary.LittleEndian.Uint64(body[at+6:]))
	m.lastUpdateNs = int64(binary.LittleEndian.Uint64(body[at+14:]))
	return m, nil
}

// rejectNonRegular refuses to mutate through a namespace entry that is
// missing-OK but must never be a symlink, directory, fifo, or device.
// Same-uid TOCTOU between this check and use is out of scope: a local
// writer racing the server can write the files directly.
func rejectNonRegular(path string) error {
	fi, err := os.Lstat(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	if !fi.Mode().IsRegular() {
		return fmt.Errorf("retention entry is not a regular file: %s", path)
	}
	return nil
}

func parseRetentionSegFile(name string) (uint64, bool) {
	var suffix string
	switch {
	case strings.HasSuffix(name, ".raw"):
		suffix = ".raw"
	case strings.HasSuffix(name, ".rsz"):
		suffix = ".rsz"
	case strings.HasSuffix(name, ".ckpt"):
		suffix = ".ckpt"
	default:
		return 0, false
	}
	// "s" + 16 hex + suffix; validate the full shape before slicing
	// so short names like ".raw" reject instead of panicking.
	if len(name) != 1+16+len(suffix) || name[0] != 's' {
		return 0, false
	}
	hexPart := name[1 : 1+16]
	gen, err := strconv.ParseUint(hexPart, 16, 64)
	if err != nil {
		return 0, false
	}
	return gen, true
}
