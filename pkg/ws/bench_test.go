package ws

import (
	"context"
	"io"
	"log/slog"
	"testing"
)

// BenchmarkFrameDebugGuard_AtInfoLevel (L8): the WS hot-path debug guard —
// slog.Default().Enabled(ctx, slog.LevelDebug) checked before any attr
// construction — must cost ~nothing at the default Info level. This is
// exactly the pattern ReadPump/WritePump/StartPTYReadLoop use before their
// "frame" trace line, so a regression here (e.g. someone building the
// Debug args unconditionally) would show up as new allocs/op.
func BenchmarkFrameDebugGuard_AtInfoLevel(b *testing.B) {
	old := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(io.Discard, &slog.HandlerOptions{Level: slog.LevelInfo})))
	defer slog.SetDefault(old)

	logger := componentLogger().With("pane", "bench-pane")
	ctx := context.Background()
	payload := make([]byte, 4096)

	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		if slog.Default().Enabled(ctx, slog.LevelDebug) {
			logger.Debug("frame", "dir", "client->pty", "bytes", len(payload))
		}
	}
}
