package main

import (
	"log"
	"log/slog"
	"os"
	"strings"
)

// parseLevel maps a level name (case-insensitive) to a slog.Level.
// Unknown/empty values fall back to Info — the same default phi has always
// had, just now leveled instead of freeform.
func parseLevel(s string) slog.Level {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "debug":
		return slog.LevelDebug
	case "warn", "warning":
		return slog.LevelWarn
	case "error":
		return slog.LevelError
	default:
		return slog.LevelInfo
	}
}

// resolveLevel applies the documented precedence: --log-level flag, then
// PHI_LOG env var, then "info".
func resolveLevel(flagVal string) slog.Level {
	if flagVal == "" {
		flagVal = os.Getenv("PHI_LOG")
	}
	return parseLevel(flagVal)
}

// initLogging builds the process-wide slog handler (text by default, JSON
// if PHI_LOG_FORMAT=json), installs it via slog.SetDefault, and bridges the
// stdlib "log" package through it so the ~47 existing log.Printf("[tag] ...")
// call sites keep working unchanged — no mechanical rewrite required.
func initLogging(level string) *slog.Logger {
	opts := &slog.HandlerOptions{Level: resolveLevel(level)}

	var handler slog.Handler
	if os.Getenv("PHI_LOG_FORMAT") == "json" {
		handler = slog.NewJSONHandler(os.Stderr, opts)
	} else {
		handler = slog.NewTextHandler(os.Stderr, opts)
	}

	logger := slog.New(handler)
	slog.SetDefault(logger)

	// Bridge: stdlib log.Printf/log.Print/log.Fatal* lines flow through the
	// same slog handler at Info level, carrying their own "[tag]" prefix as
	// the message text. log.SetFlags(0) drops the stdlib timestamp/prefix so
	// slog's own time/level fields aren't duplicated.
	log.SetFlags(0)
	log.SetOutput(slogBridgeWriter{})

	return logger
}

// slogBridgeWriter forwards stdlib log output into slog.Default() at Info
// level, one record per Write call (the stdlib logger always calls Write
// once per formatted line).
type slogBridgeWriter struct{}

func (slogBridgeWriter) Write(p []byte) (int, error) {
	slog.Default().Info(strings.TrimRight(string(p), "\n"))
	return len(p), nil
}
