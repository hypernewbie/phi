package ws

import (
	"os"
	"testing"
)

// Package tests run the approved window scaled to one segment per window: a
// 1 MiB cap over 1 MiB segments spans two segments, exactly like the geometry
// the eviction tests were written for, on fixtures that stay small.
// TestRetentionApprovedWindow covers the shipped 32 MiB / 4 MiB bounds.
const (
	testRetentionCap     uint64 = 1 << 20
	testRetentionSegment uint64 = 1 << 20
)

func setRetentionBounds(capBytes, segNominal uint64) {
	retentionHistoryCap, retentionSegNominal = capBytes, segNominal
	retentionSegRawMax = retentionSegNominal + retentionSegSlack
	retentionSegsKept = int(retentionHistoryCap/retentionSegNominal) + 1
}

func TestMain(m *testing.M) {
	setRetentionBounds(testRetentionCap, testRetentionSegment)
	os.Exit(m.Run())
}
