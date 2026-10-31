package diagnostics

import (
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"runtime"
	"runtime/pprof"
	"strconv"
	"sync"
	"time"
)

const (
	defaultCPUProfileSeconds = 30
	maxCPUProfileSeconds     = 120
	profileDeliveryTimeout   = 10 * time.Second
	profileFilePrefix        = "phi-profile-"
)

var errProfileTooLarge = errors.New("diagnostics profile exceeds 64 MiB limit")

func (s *Server) handleCPUProfile(w http.ResponseWriter, r *http.Request) {
	seconds, err := parseCPUProfileQuery(r.URL.RawQuery)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if !s.acquireProfile(w) {
		return
	}
	defer func() {
		s.releaseProfile()
		if s.onCPUStopped != nil {
			s.onCPUStopped()
		}
	}()

	file, err := s.newProfileFile()
	if err != nil {
		http.Error(w, "profile unavailable", http.StatusServiceUnavailable)
		return
	}
	defer removeProfileFile(file)
	limited := newLimitingWriter(file, s.maxProfileSize)

	if err := setWriteDeadline(w, time.Now().Add(time.Duration(seconds+5)*time.Second)); err != nil {
		http.Error(w, "profile transport unavailable", http.StatusServiceUnavailable)
		return
	}
	if err := pprof.StartCPUProfile(limited); err != nil {
		_ = setWriteDeadline(w, time.Now().Add(writeTimeout))
		http.Error(w, "CPU profiler is already active", http.StatusConflict)
		return
	}
	if s.onCPUStarted != nil {
		s.onCPUStarted()
	}

	timer := time.NewTimer(time.Duration(seconds) * time.Second)
	captureComplete := false
	var captureErr error
	select {
	case <-timer.C:
		captureComplete = true
	case <-r.Context().Done():
	case <-s.ctx.Done():
	case <-limited.failed:
		captureErr = limited.Err()
	}
	if !timer.Stop() {
		select {
		case <-timer.C:
		default:
		}
	}
	pprof.StopCPUProfile()
	if !captureComplete {
		if captureErr != nil {
			http.Error(w, "profile capture failed", http.StatusServiceUnavailable)
		} else if s.ctx.Err() != nil && r.Context().Err() == nil {
			http.Error(w, "profile capture canceled", http.StatusServiceUnavailable)
		}
		return
	}

	if err := limited.Err(); err != nil {
		slogProfileError(err)
		http.Error(w, "profile capture failed", http.StatusServiceUnavailable)
		return
	}
	if err := file.Sync(); err != nil {
		http.Error(w, "profile capture failed", http.StatusServiceUnavailable)
		return
	}
	if err := s.deliverProfile(w, file); err != nil {
		return
	}
}

func (s *Server) handleHeapProfile(w http.ResponseWriter, r *http.Request) {
	forceGC, err := parseHeapProfileQuery(r.URL.RawQuery)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if !s.acquireProfile(w) {
		return
	}
	defer s.releaseProfile()
	if err := setWriteDeadline(w, time.Now().Add(30*time.Second)); err != nil {
		http.Error(w, "profile transport unavailable", http.StatusServiceUnavailable)
		return
	}
	file, err := s.newProfileFile()
	if err != nil {
		http.Error(w, "profile unavailable", http.StatusServiceUnavailable)
		return
	}
	defer removeProfileFile(file)
	limited := newLimitingWriter(file, s.maxProfileSize)
	if forceGC {
		runtime.GC()
	}
	if err := pprof.WriteHeapProfile(limited); err != nil || limited.Err() != nil {
		http.Error(w, "profile capture failed", http.StatusServiceUnavailable)
		return
	}
	if err := file.Sync(); err != nil {
		http.Error(w, "profile capture failed", http.StatusServiceUnavailable)
		return
	}
	if err := s.deliverProfile(w, file); err != nil {
		return
	}
}

func (s *Server) handleGoroutineProfile(w http.ResponseWriter, r *http.Request) {
	if err := parseEmptyProfileQuery(r.URL.RawQuery); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if !s.acquireProfile(w) {
		return
	}
	defer s.releaseProfile()
	if err := setWriteDeadline(w, time.Now().Add(30*time.Second)); err != nil {
		http.Error(w, "profile transport unavailable", http.StatusServiceUnavailable)
		return
	}
	file, err := s.newProfileFile()
	if err != nil {
		http.Error(w, "profile unavailable", http.StatusServiceUnavailable)
		return
	}
	defer removeProfileFile(file)
	limited := newLimitingWriter(file, s.maxProfileSize)
	profile := pprof.Lookup("goroutine")
	if profile == nil {
		http.Error(w, "goroutine profile unavailable", http.StatusServiceUnavailable)
		return
	}
	if err := profile.WriteTo(limited, 0); err != nil || limited.Err() != nil {
		http.Error(w, "profile capture failed", http.StatusServiceUnavailable)
		return
	}
	if err := file.Sync(); err != nil {
		http.Error(w, "profile capture failed", http.StatusServiceUnavailable)
		return
	}
	if err := s.deliverProfile(w, file); err != nil {
		return
	}
}

func parseCPUProfileQuery(raw string) (int, error) {
	values, err := url.ParseQuery(raw)
	if err != nil {
		return 0, errors.New("invalid profile query")
	}
	for key := range values {
		if key != "seconds" {
			return 0, errors.New("unsupported profile query")
		}
	}
	seconds := defaultCPUProfileSeconds
	if value, ok := values["seconds"]; ok {
		if len(value) != 1 || value[0] == "" {
			return 0, errors.New("seconds must appear once")
		}
		parsed, err := strconv.Atoi(value[0])
		if err != nil || parsed < 1 || parsed > maxCPUProfileSeconds {
			return 0, errors.New("seconds must be between 1 and 120")
		}
		seconds = parsed
	}
	return seconds, nil
}

func parseHeapProfileQuery(raw string) (bool, error) {
	values, err := url.ParseQuery(raw)
	if err != nil {
		return false, errors.New("invalid profile query")
	}
	for key := range values {
		if key != "gc" {
			return false, errors.New("unsupported profile query")
		}
	}
	if value, ok := values["gc"]; ok {
		if len(value) != 1 || (value[0] != "0" && value[0] != "1") {
			return false, errors.New("gc must be 0 or 1 and appear once")
		}
		return value[0] == "1", nil
	}
	return false, nil
}

func parseEmptyProfileQuery(raw string) error {
	if raw != "" {
		return errors.New("profile query is not supported")
	}
	return nil
}

func (s *Server) acquireProfile(w http.ResponseWriter) bool {
	select {
	case s.profileSlot <- struct{}{}:
		return true
	default:
		http.Error(w, "profile busy", http.StatusConflict)
		return false
	}
}

func (s *Server) releaseProfile() { <-s.profileSlot }

func (s *Server) newProfileFile() (*os.File, error) {
	file, err := os.CreateTemp(s.dir, profileFilePrefix+"*.tmp")
	if err != nil {
		return nil, err
	}
	if err := file.Chmod(0600); err != nil {
		_ = file.Close()
		_ = os.Remove(file.Name())
		return nil, err
	}
	return file, nil
}

func removeProfileFile(file *os.File) {
	path := file.Name()
	_ = file.Close()
	_ = os.Remove(path)
}

func (s *Server) deliverProfile(w http.ResponseWriter, file *os.File) error {
	if err := setWriteDeadline(w, time.Now().Add(s.profileDeliveryWindow)); err != nil {
		http.Error(w, "profile transport unavailable", http.StatusServiceUnavailable)
		return err
	}
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		http.Error(w, "profile read failed", http.StatusServiceUnavailable)
		return err
	}
	info, err := file.Stat()
	if err != nil {
		http.Error(w, "profile read failed", http.StatusServiceUnavailable)
		return err
	}
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Length", strconv.FormatInt(info.Size(), 10))
	w.WriteHeader(http.StatusOK)
	if _, err := io.Copy(w, io.LimitReader(file, info.Size())); err != nil {
		slogProfileError(err)
		return err
	}
	return nil
}

func setWriteDeadline(w http.ResponseWriter, deadline time.Time) error {
	return http.NewResponseController(w).SetWriteDeadline(deadline)
}

type limitingWriter struct {
	mu        sync.Mutex
	writer    io.Writer
	remaining int64
	err       error
	failed    chan struct{}
}

func newLimitingWriter(writer io.Writer, limit int64) *limitingWriter {
	return &limitingWriter{writer: writer, remaining: limit, failed: make(chan struct{})}
}

func (w *limitingWriter) Write(data []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.err != nil {
		return 0, w.err
	}
	if int64(len(data)) > w.remaining {
		w.failLocked(errProfileTooLarge)
		return 0, w.err
	}
	n, err := w.writer.Write(data)
	w.remaining -= int64(n)
	if err != nil {
		w.failLocked(err)
	} else if n != len(data) {
		w.failLocked(io.ErrShortWrite)
	}
	return n, w.err
}

func (w *limitingWriter) Err() error {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.err
}

func (w *limitingWriter) failLocked(err error) {
	if w.err != nil {
		return
	}
	w.err = err
	close(w.failed)
}

func slogProfileError(err error) {
	if err != nil {
		slog.Debug("write private diagnostics profile", "err", err)
	}
}
