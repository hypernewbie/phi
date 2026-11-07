package ws

import (
	"bytes"
	"encoding/binary"
	"hash/crc32"
	"math"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestEventCursor(t *testing.T) {
	t.Run("WebClientAttachHeadPrefix", func(t *testing.T) {
		got := EncodeEventCursor(1, 0, 0)
		const want = "v1.1.0.0"
		if got != want {
			t.Fatalf("EncodeEventCursor(1, 0, 0) = %q, want %q", got, want)
		}
	})

	t.Run("RoundTrip", func(t *testing.T) {
		cases := []struct {
			name    string
			epoch   uint64
			pos     uint64
			ordinal uint64
		}{
			{"ZeroValues", 0, 0, 0},
			{"TypicalValuesLow", 1, 1024, 5},
			{"TypicalValuesHigh", 42, 5000000, 999},
			{"MaxUint64Epoch", math.MaxUint64, 0, 0},
			{"MaxUint64Pos", 0, math.MaxUint64, 0},
			{"MaxUint64Ordinal", 0, 0, math.MaxUint64},
			{"MaxUint64All", math.MaxUint64, math.MaxUint64, math.MaxUint64},
		}

		for _, tc := range cases {
			t.Run(tc.name, func(t *testing.T) {
				encoded := EncodeEventCursor(tc.epoch, tc.pos, tc.ordinal)
				epoch, pos, ordinal, err := ParseEventCursor(encoded)
				if err != nil {
					t.Fatalf("unexpected parse error for %q: %v", encoded, err)
				}
				if epoch != tc.epoch || pos != tc.pos || ordinal != tc.ordinal {
					t.Fatalf("mismatched round-trip for (%d, %d, %d): got (%d, %d, %d)",
						tc.epoch, tc.pos, tc.ordinal, epoch, pos, ordinal)
				}
			})
		}
	})

	t.Run("ParseRejections", func(t *testing.T) {
		longCursor := "v1.0.0." + strings.Repeat("9", 128)
		cases := []struct {
			name  string
			input string
		}{
			{"EmptyString", ""},
			{"OversizedCursor", longCursor},
			{"WrongVersionMissingV", "1.1.0.0"},
			{"WrongVersionV2", "v2.1.0.0"},
			{"WrongVersionV0", "v0.1.0.0"},
			{"WrongPartCountTooFewTwo", "v1.1"},
			{"WrongPartCountTooFewThree", "v1.1.0"},
			{"WrongPartCountTooManyFive", "v1.1.0.0.0"},
			{"NonNumericEpoch", "v1.abc.0.0"},
			{"NonNumericPos", "v1.0.xyz.0"},
			{"NonNumericOrdinal", "v1.0.0.foo"},
			{"EmptyNumericPart", "v1..0.0"},
			{"NegativeEpoch", "v1.-1.0.0"},
			{"NegativePos", "v1.0.-5.0"},
			{"NegativeOrdinal", "v1.0.0.-10"},
			{"OverflowEpoch", "v1.18446744073709551616.0.0"},
			{"OverflowPos", "v1.0.18446744073709551616.0"},
			{"OverflowOrdinal", "v1.0.0.18446744073709551616"},
		}

		for _, tc := range cases {
			t.Run(tc.name, func(t *testing.T) {
				_, _, _, err := ParseEventCursor(tc.input)
				if err == nil {
					t.Fatalf("expected error parsing %q, but got nil", tc.input)
				}
			})
		}
	})
}

func TestSyncDir(t *testing.T) {
	t.Run("ValidDirectory", func(t *testing.T) {
		dir := t.TempDir()
		if err := syncDir(dir); err != nil {
			t.Fatalf("syncDir on valid directory failed: %v", err)
		}
	})

	t.Run("NonExistentPath", func(t *testing.T) {
		missingPath := filepath.Join(t.TempDir(), "missing-directory")
		if err := syncDir(missingPath); err == nil {
			t.Fatalf("syncDir on non-existent path succeeded unexpectedly")
		}
	})
}

func assertManifestEqual(t *testing.T, want, got retentionManifest) {
	t.Helper()
	if got.head != want.head || got.plain != want.plain || got.lastByte != want.lastByte ||
		got.flags != want.flags || got.closedAtNs != want.closedAtNs || got.lastUpdateNs != want.lastUpdateNs {
		t.Fatalf("manifest header mismatch:\nwant %+v\ngot  %+v", want, got)
	}
	if len(got.segs) != len(want.segs) {
		t.Fatalf("manifest segment count mismatch: want %d, got %d", len(want.segs), len(got.segs))
	}
	for i := range want.segs {
		if got.segs[i] != want.segs[i] {
			t.Fatalf("manifest segment[%d] mismatch:\nwant %+v\ngot  %+v", i, want.segs[i], got.segs[i])
		}
	}
}

func manifestWithCRC(body []byte) []byte {
	crc := crc32.ChecksumIEEE(body)
	var crcBytes [4]byte
	binary.LittleEndian.PutUint32(crcBytes[:], crc)
	return append(append([]byte(nil), body...), crcBytes[:]...)
}

func TestRetentionManifest(t *testing.T) {
	t.Run("RoundTripSingleSegment", func(t *testing.T) {
		cases := []struct {
			name     string
			manifest retentionManifest
		}{
			{
				name: "StandardSingleSegment",
				manifest: retentionManifest{
					head: 1024,
					segs: []retentionSegDesc{
						{
							gen:          1,
							start:        0,
							rawLen:       1024,
							startOrdinal: 1,
							rszCount:     10,
							ckptLen:      128,
						},
					},
					plain:        false,
					lastByte:     '\n',
					flags:        retentionFlagClosed,
					closedAtNs:   1700000000000,
					lastUpdateNs: 1700000005000,
				},
			},
			{
				name: "PlainTrueWithZeroFlags",
				manifest: retentionManifest{
					head: 2048,
					segs: []retentionSegDesc{
						{
							gen:          10,
							start:        1000,
							rawLen:       1048,
							startOrdinal: 5,
							rszCount:     0,
							ckptLen:      0,
						},
					},
					plain:        true,
					lastByte:     'x',
					flags:        0,
					closedAtNs:   0,
					lastUpdateNs: 42,
				},
			},
		}

		for _, tc := range cases {
			t.Run(tc.name, func(t *testing.T) {
				encoded := encodeRetentionManifest(tc.manifest)
				decoded, err := decodeRetentionManifest(encoded)
				if err != nil {
					t.Fatalf("unexpected decode error: %v", err)
				}
				assertManifestEqual(t, tc.manifest, decoded)
			})
		}
	})

	t.Run("RoundTripMultiSegment", func(t *testing.T) {
		segs := make([]retentionSegDesc, retentionSegsKept)
		var currentStart uint64
		var currentOrdinal uint64 = 1
		const segLen uint64 = 512
		const rszPerSeg uint32 = 4

		for i := 0; i < retentionSegsKept; i++ {
			segs[i] = retentionSegDesc{
				gen:          uint64(i + 1),
				start:        currentStart,
				rawLen:       segLen,
				startOrdinal: currentOrdinal,
				rszCount:     rszPerSeg,
				ckptLen:      256,
			}
			currentStart += segLen
			currentOrdinal += uint64(rszPerSeg)
		}

		manifest := retentionManifest{
			head:         currentStart,
			segs:         segs,
			plain:        true,
			lastByte:     '\r',
			flags:        retentionFlagClosed,
			closedAtNs:   1234567890,
			lastUpdateNs: 9876543210,
		}

		encoded := encodeRetentionManifest(manifest)
		decoded, err := decodeRetentionManifest(encoded)
		if err != nil {
			t.Fatalf("unexpected decode error on multi-segment manifest: %v", err)
		}
		assertManifestEqual(t, manifest, decoded)
	})

	t.Run("DecodeRejections", func(t *testing.T) {
		validSingleSeg := retentionManifest{
			head: 500,
			segs: []retentionSegDesc{
				{
					gen:          1,
					start:        100,
					rawLen:       400,
					startOrdinal: 1,
					rszCount:     3,
					ckptLen:      64,
				},
			},
			plain:        false,
			lastByte:     'A',
			flags:        1,
			closedAtNs:   1000,
			lastUpdateNs: 2000,
		}
		validEncoded := encodeRetentionManifest(validSingleSeg)
		validBody := validEncoded[:len(validEncoded)-4]

		t.Run("OversizedData", func(t *testing.T) {
			oversized := make([]byte, retentionManifestMax+1)
			_, err := decodeRetentionManifest(oversized)
			if err == nil || !strings.Contains(err.Error(), "exceeds size bound") {
				t.Fatalf("expected size bound error, got %v", err)
			}
		})

		t.Run("ShortDataEmpty", func(t *testing.T) {
			_, err := decodeRetentionManifest(nil)
			if err == nil || !strings.Contains(err.Error(), "invalid retention manifest") {
				t.Fatalf("expected invalid retention manifest error, got %v", err)
			}
		})

		t.Run("ShortDataUnder50Bytes", func(t *testing.T) {
			short := make([]byte, 49)
			copy(short, retentionManifestMagic)
			_, err := decodeRetentionManifest(short)
			if err == nil || !strings.Contains(err.Error(), "invalid retention manifest") {
				t.Fatalf("expected invalid retention manifest error, got %v", err)
			}
		})

		t.Run("BadMagic", func(t *testing.T) {
			corrupt := append([]byte(nil), validEncoded...)
			copy(corrupt[:6], []byte("BADMAG"))
			_, err := decodeRetentionManifest(corrupt)
			if err == nil || !strings.Contains(err.Error(), "invalid retention manifest") {
				t.Fatalf("expected invalid retention manifest error, got %v", err)
			}
		})

		t.Run("CRCMismatch", func(t *testing.T) {
			corrupt := append([]byte(nil), validEncoded...)
			corrupt[len(corrupt)-1] ^= 0xff
			_, err := decodeRetentionManifest(corrupt)
			if err == nil || !strings.Contains(err.Error(), "checksum mismatch") {
				t.Fatalf("expected checksum mismatch error, got %v", err)
			}
		})

		t.Run("UnsupportedVersionZero", func(t *testing.T) {
			body := append([]byte(nil), validBody...)
			binary.LittleEndian.PutUint16(body[6:8], 0)
			_, err := decodeRetentionManifest(manifestWithCRC(body))
			if err == nil || !strings.Contains(err.Error(), "unsupported retention manifest version") {
				t.Fatalf("expected unsupported version error, got %v", err)
			}
		})

		t.Run("UnsupportedVersionTwo", func(t *testing.T) {
			body := append([]byte(nil), validBody...)
			binary.LittleEndian.PutUint16(body[6:8], 2)
			_, err := decodeRetentionManifest(manifestWithCRC(body))
			if err == nil || !strings.Contains(err.Error(), "unsupported retention manifest version") {
				t.Fatalf("expected unsupported version error, got %v", err)
			}
		})

		t.Run("SegmentCountZero", func(t *testing.T) {
			body := append([]byte(nil), validBody...)
			binary.LittleEndian.PutUint32(body[16:20], 0)
			_, err := decodeRetentionManifest(manifestWithCRC(body))
			if err == nil || !strings.Contains(err.Error(), "invalid retention segment count 0") {
				t.Fatalf("expected invalid segment count error, got %v", err)
			}
		})

		t.Run("SegmentCountOverLimit", func(t *testing.T) {
			body := append([]byte(nil), validBody...)
			binary.LittleEndian.PutUint32(body[16:20], retentionSegsKept+1)
			_, err := decodeRetentionManifest(manifestWithCRC(body))
			if err == nil || !strings.Contains(err.Error(), "invalid retention segment count 10") {
				t.Fatalf("expected invalid segment count error, got %v", err)
			}
		})

		t.Run("BodyLengthMismatchTooShort", func(t *testing.T) {
			body := append([]byte(nil), validBody[:len(validBody)-1]...)
			_, err := decodeRetentionManifest(manifestWithCRC(body))
			if err == nil || !strings.Contains(err.Error(), "retention manifest length mismatch") {
				t.Fatalf("expected length mismatch error, got %v", err)
			}
		})

		t.Run("BodyLengthMismatchTooLong", func(t *testing.T) {
			body := append([]byte(nil), validBody...)
			body = append(body, 0)
			_, err := decodeRetentionManifest(manifestWithCRC(body))
			if err == nil || !strings.Contains(err.Error(), "retention manifest length mismatch") {
				t.Fatalf("expected length mismatch error, got %v", err)
			}
		})

		t.Run("SegmentOutOfBoundsGenZero", func(t *testing.T) {
			body := append([]byte(nil), validBody...)
			binary.LittleEndian.PutUint64(body[20:28], 0)
			_, err := decodeRetentionManifest(manifestWithCRC(body))
			if err == nil || !strings.Contains(err.Error(), "retention manifest segment out of bounds") {
				t.Fatalf("expected segment out of bounds error, got %v", err)
			}
		})

		t.Run("SegmentOutOfBoundsStartAboveHead", func(t *testing.T) {
			body := append([]byte(nil), validBody...)
			binary.LittleEndian.PutUint64(body[28:36], validSingleSeg.head+1)
			_, err := decodeRetentionManifest(manifestWithCRC(body))
			if err == nil || !strings.Contains(err.Error(), "retention manifest segment out of bounds") {
				t.Fatalf("expected segment out of bounds error, got %v", err)
			}
		})

		t.Run("SegmentOutOfBoundsRawLenTooLarge", func(t *testing.T) {
			body := append([]byte(nil), validBody...)
			binary.LittleEndian.PutUint64(body[36:44], retentionSegRawMax+1)
			_, err := decodeRetentionManifest(manifestWithCRC(body))
			if err == nil || !strings.Contains(err.Error(), "retention manifest segment out of bounds") {
				t.Fatalf("expected segment out of bounds error, got %v", err)
			}
		})

		t.Run("SegmentOutOfBoundsStartOrdinalZero", func(t *testing.T) {
			body := append([]byte(nil), validBody...)
			binary.LittleEndian.PutUint64(body[44:52], 0)
			_, err := decodeRetentionManifest(manifestWithCRC(body))
			if err == nil || !strings.Contains(err.Error(), "retention manifest segment out of bounds") {
				t.Fatalf("expected segment out of bounds error, got %v", err)
			}
		})

		t.Run("SegmentOutOfBoundsRszCountTooHigh", func(t *testing.T) {
			body := append([]byte(nil), validBody...)
			binary.LittleEndian.PutUint32(body[52:56], retentionRszMaxCount+1)
			_, err := decodeRetentionManifest(manifestWithCRC(body))
			if err == nil || !strings.Contains(err.Error(), "retention manifest segment out of bounds") {
				t.Fatalf("expected segment out of bounds error, got %v", err)
			}
		})

		t.Run("SegmentOutOfBoundsCkptLenTooHigh", func(t *testing.T) {
			body := append([]byte(nil), validBody...)
			binary.LittleEndian.PutUint32(body[56:60], retentionCkptMax+1)
			_, err := decodeRetentionManifest(manifestWithCRC(body))
			if err == nil || !strings.Contains(err.Error(), "retention manifest segment out of bounds") {
				t.Fatalf("expected segment out of bounds error, got %v", err)
			}
		})

		// Multi-segment fixtures for ordering checks.
		validTwoSeg := retentionManifest{
			head: 600,
			segs: []retentionSegDesc{
				{
					gen:          1,
					start:        100,
					rawLen:       200,
					startOrdinal: 1,
					rszCount:     3,
					ckptLen:      32,
				},
				{
					gen:          2,
					start:        300,
					rawLen:       300,
					startOrdinal: 4, // 1 + 3
					rszCount:     2,
					ckptLen:      32,
				},
			},
			plain:        false,
			lastByte:     '\n',
			flags:        0,
			closedAtNs:   0,
			lastUpdateNs: 0,
		}
		validTwoSegEncoded := encodeRetentionManifest(validTwoSeg)
		validTwoSegBody := validTwoSegEncoded[:len(validTwoSegEncoded)-4]

		t.Run("SegmentsOutOfOrderGenDecreasedOrEqual", func(t *testing.T) {
			body := append([]byte(nil), validTwoSegBody...)
			// Seg 2 starts at offset 20 + 40 = 60. Set gen to equal seg 1 gen (1).
			binary.LittleEndian.PutUint64(body[60:68], 1)
			_, err := decodeRetentionManifest(manifestWithCRC(body))
			if err == nil || !strings.Contains(err.Error(), "retention manifest segments out of order") {
				t.Fatalf("expected out of order error, got %v", err)
			}
		})

		t.Run("SegmentsOutOfOrderStartRegressed", func(t *testing.T) {
			body := append([]byte(nil), validTwoSegBody...)
			// Seg 2 start offset at 60 + 8 = 68. Set start to 50 (< seg 1 start of 100).
			binary.LittleEndian.PutUint64(body[68:76], 50)
			_, err := decodeRetentionManifest(manifestWithCRC(body))
			if err == nil || !strings.Contains(err.Error(), "retention manifest segments out of order") {
				t.Fatalf("expected out of order error, got %v", err)
			}
		})

		t.Run("SegmentsOutOfOrderOrdinalMismatch", func(t *testing.T) {
			body := append([]byte(nil), validTwoSegBody...)
			// Seg 2 startOrdinal offset at 60 + 24 = 84. Set ordinal to 5 instead of 4.
			binary.LittleEndian.PutUint64(body[84:92], 5)
			_, err := decodeRetentionManifest(manifestWithCRC(body))
			if err == nil || !strings.Contains(err.Error(), "retention manifest segments out of order") {
				t.Fatalf("expected out of order error, got %v", err)
			}
		})

		t.Run("HeadMismatch", func(t *testing.T) {
			body := append([]byte(nil), validBody...)
			// Head is at offset 8:16. Mismatch head so last.start + last.rawLen != head.
			binary.LittleEndian.PutUint64(body[8:16], validSingleSeg.head+1)
			_, err := decodeRetentionManifest(manifestWithCRC(body))
			if err == nil || !strings.Contains(err.Error(), "retention manifest head mismatch") {
				t.Fatalf("expected head mismatch error, got %v", err)
			}
		})

		t.Run("InvalidPlainFlag", func(t *testing.T) {
			body := append([]byte(nil), validBody...)
			// Plain flag is at offset 20 + 40*1 = 60.
			body[60] = 2
			_, err := decodeRetentionManifest(manifestWithCRC(body))
			if err == nil || !strings.Contains(err.Error(), "invalid retention plain flag") {
				t.Fatalf("expected invalid plain flag error, got %v", err)
			}
		})
	})

	t.Run("ReadRetentionManifest", func(t *testing.T) {
		tempDir := t.TempDir()

		t.Run("ValidFile", func(t *testing.T) {
			manifest := retentionManifest{
				head: 100,
				segs: []retentionSegDesc{
					{
						gen:          1,
						start:        0,
						rawLen:       100,
						startOrdinal: 1,
						rszCount:     1,
						ckptLen:      16,
					},
				},
				plain:        false,
				lastByte:     'Z',
				flags:        0,
				closedAtNs:   10,
				lastUpdateNs: 20,
			}
			encoded := encodeRetentionManifest(manifest)
			filePath := filepath.Join(tempDir, "valid_manifest")
			if err := os.WriteFile(filePath, encoded, 0o600); err != nil {
				t.Fatalf("failed to write test manifest: %v", err)
			}

			readData, err := readRetentionManifest(filePath)
			if err != nil {
				t.Fatalf("readRetentionManifest failed: %v", err)
			}
			if !bytes.Equal(readData, encoded) {
				t.Fatalf("read data does not match written manifest")
			}
		})

		t.Run("OversizedFile", func(t *testing.T) {
			oversizedPath := filepath.Join(tempDir, "oversized_manifest")
			oversizedData := make([]byte, retentionManifestMax+1)
			if err := os.WriteFile(oversizedPath, oversizedData, 0o600); err != nil {
				t.Fatalf("failed to write oversized manifest: %v", err)
			}

			_, err := readRetentionManifest(oversizedPath)
			if err == nil || !strings.Contains(err.Error(), "exceeds size bound") {
				t.Fatalf("expected size bound error reading oversized manifest, got %v", err)
			}
		})

		t.Run("DirectoryNonRegular", func(t *testing.T) {
			subDir := filepath.Join(tempDir, "sub-directory")
			if err := os.Mkdir(subDir, 0o700); err != nil {
				t.Fatalf("failed to create sub-directory: %v", err)
			}

			_, err := readRetentionManifest(subDir)
			if err == nil || !strings.Contains(err.Error(), "not a regular file") {
				t.Fatalf("expected non-regular error reading directory, got %v", err)
			}
		})
	})
}

func TestRejectNonRegular(t *testing.T) {
	tempDir := t.TempDir()

	t.Run("NonExistentPath", func(t *testing.T) {
		missingPath := filepath.Join(tempDir, "non_existent_file")
		if err := rejectNonRegular(missingPath); err != nil {
			t.Fatalf("expected nil for non-existent path, got %v", err)
		}
	})

	t.Run("RegularFile", func(t *testing.T) {
		regPath := filepath.Join(tempDir, "regular_file.txt")
		if err := os.WriteFile(regPath, []byte("payload"), 0o600); err != nil {
			t.Fatalf("failed to write regular file: %v", err)
		}
		if err := rejectNonRegular(regPath); err != nil {
			t.Fatalf("expected nil for regular file, got %v", err)
		}
	})

	t.Run("Directory", func(t *testing.T) {
		dirPath := filepath.Join(tempDir, "dir_entry")
		if err := os.Mkdir(dirPath, 0o700); err != nil {
			t.Fatalf("failed to create directory: %v", err)
		}
		err := rejectNonRegular(dirPath)
		if err == nil || !strings.Contains(err.Error(), "not a regular file") {
			t.Fatalf("expected non-regular error for directory, got %v", err)
		}
	})
}

func TestParseRetentionSegFile(t *testing.T) {
	t.Run("ValidNames", func(t *testing.T) {
		cases := []struct {
			name    string
			wantGen uint64
		}{
			{"s0000000000000001.raw", 1},
			{"s0000000000000001.rsz", 1},
			{"s0000000000000001.ckpt", 1},
			{"s0000000000000000.raw", 0},
			{"s000000000000002a.raw", 42},
			{"s000000000000002A.rsz", 42},
			{"sffffffffffffffff.ckpt", math.MaxUint64},
			{"s0123456789abcdef.raw", 0x0123456789abcdef},
		}

		for _, tc := range cases {
			gen, ok := parseRetentionSegFile(tc.name)
			if !ok {
				t.Fatalf("expected %q to parse successfully", tc.name)
			}
			if gen != tc.wantGen {
				t.Fatalf("parseRetentionSegFile(%q) = %d, want %d", tc.name, gen, tc.wantGen)
			}
		}
	})

	t.Run("InvalidNames", func(t *testing.T) {
		invalidCases := []string{
			"",
			".raw",
			".rsz",
			".ckpt",
			"s.raw",
			"s000000000000001.raw",            // 15 hex digits
			"s00000000000000001.raw",           // 17 hex digits
			"x0000000000000001.raw",           // wrong prefix
			"s000000000000000g.raw",           // invalid hex character
			"s0000000000000001.txt",           // wrong suffix
			"s0000000000000001.raw.tmp",       // trailing extension
			"s0000000000000001",               // missing suffix
			"s-00000000000001.raw",            // dash character
			"s 00000000000001.raw",            // space character
		}

		for _, name := range invalidCases {
			gen, ok := parseRetentionSegFile(name)
			if ok {
				t.Fatalf("expected %q to fail parsing, but got gen %d", name, gen)
			}
		}
	})
}
