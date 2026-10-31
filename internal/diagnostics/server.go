//go:build profiling

package diagnostics

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"
)

const (
	readHeaderTimeout = 2 * time.Second
	readTimeout       = 5 * time.Second
	idleTimeout       = 5 * time.Second
	writeTimeout      = 5 * time.Second
	maxHeaderBytes    = 8192
	closeTimeout      = 5 * time.Second
)

type Server struct {
	dir       string
	url       string
	token     string
	startedAt time.Time
	commit    string
	readers   snapshotReaders

	httpServer *http.Server
	listener   net.Listener
	ctx        context.Context
	cancel     context.CancelFunc
	mux        *http.ServeMux

	snapshotSlot chan struct{}
	profileSlot  chan struct{}

	mu         sync.Mutex
	closed     bool
	handlers   sync.WaitGroup
	closeOnce  sync.Once
	closeError error

	ownershipStats func() any

	// Test seams. Production leaves these unset.
	onCPUStarted          func()
	onCPUStopped          func()
	maxProfileSize        int64
	profileDeliveryWindow time.Duration
}

type snapshotResponse struct {
	snapshot
	Ownership any `json:"ownership"`
}

// Start creates an authenticated diagnostics server on IPv4 loopback. It
// returns an error without affecting Phi; callers can log the error and keep
// the normal application server available.
func Start(parentDir string, startedAt time.Time, commit string) (*Server, error) {
	return start(parentDir, startedAt, commit, currentProcessReaders())
}

func start(parentDir string, startedAt time.Time, commit string, readers snapshotReaders) (*Server, error) {
	if runtime.GOOS == "windows" {
		return nil, errors.New("private diagnostics are unavailable on Windows")
	}
	if !filepath.IsAbs(parentDir) {
		return nil, errors.New("diagnostics directory must be an absolute path")
	}
	info, err := os.Stat(parentDir)
	if err != nil {
		return nil, fmt.Errorf("stat diagnostics parent: %w", err)
	}
	if !info.IsDir() {
		return nil, errors.New("diagnostics parent is not a directory")
	}
	if startedAt.IsZero() {
		startedAt = time.Now()
	}

	dir, err := os.MkdirTemp(parentDir, "phi-diag-")
	if err != nil {
		return nil, fmt.Errorf("create diagnostics session: %w", err)
	}
	if err := os.Chmod(dir, 0700); err != nil {
		_ = os.Remove(dir)
		return nil, fmt.Errorf("secure diagnostics session: %w", err)
	}
	cleanup := func(listener net.Listener) {
		if listener != nil {
			_ = listener.Close()
		}
		_ = os.Remove(filepath.Join(dir, "url"))
		_ = os.Remove(filepath.Join(dir, "client.curl"))
		_ = os.Remove(dir)
	}

	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		cleanup(nil)
		return nil, fmt.Errorf("bind diagnostics loopback listener: %w", err)
	}

	var randomToken [32]byte
	if _, err := rand.Read(randomToken[:]); err != nil {
		cleanup(listener)
		return nil, fmt.Errorf("generate diagnostics token: %w", err)
	}
	token := hex.EncodeToString(randomToken[:])
	debugURL := "http://" + listener.Addr().String()
	files := []struct {
		name    string
		content string
	}{
		{name: "url", content: debugURL + "\n"},
		{name: "client.curl", content: "header = \"Authorization: Bearer " + token + "\"\nnoproxy = \"*\"\n"},
	}
	for _, file := range files {
		if err := writePrivateFile(filepath.Join(dir, file.name), file.content); err != nil {
			cleanup(listener)
			return nil, fmt.Errorf("write diagnostics connection file: %w", err)
		}
	}

	ctx, cancel := context.WithCancel(context.Background())
	s := &Server{
		dir:                   dir,
		url:                   debugURL,
		token:                 token,
		startedAt:             startedAt,
		commit:                commit,
		readers:               readers,
		listener:              listener,
		ctx:                   ctx,
		cancel:                cancel,
		snapshotSlot:          make(chan struct{}, 1),
		profileSlot:           make(chan struct{}, 1),
		maxProfileSize:        64 << 20,
		profileDeliveryWindow: profileDeliveryTimeout,
	}
	s.mux = http.NewServeMux()
	s.mux.HandleFunc("/debug/phi", s.handleSnapshot)
	s.mux.HandleFunc("/debug/pprof/profile", s.handleCPUProfile)
	s.mux.HandleFunc("/debug/pprof/heap", s.handleHeapProfile)
	s.mux.HandleFunc("/debug/pprof/goroutine", s.handleGoroutineProfile)
	s.mux.HandleFunc("/debug/phi/timing", s.handleTiming)
	s.mux.HandleFunc("/debug/phi/timing/status", s.handleTimingStatus)
	s.httpServer = &http.Server{
		Handler:           s,
		ReadHeaderTimeout: readHeaderTimeout,
		ReadTimeout:       readTimeout,
		IdleTimeout:       idleTimeout,
		WriteTimeout:      writeTimeout,
		MaxHeaderBytes:    maxHeaderBytes,
	}
	go func() {
		if err := s.httpServer.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
			slog.Warn("private diagnostics server stopped", "err", err)
		}
	}()
	return s, nil
}

// SetOwnershipStats adds an optional best-effort owner snapshot to /debug/phi.
func (s *Server) SetOwnershipStats(collect func() any) {
	s.mu.Lock()
	s.ownershipStats = collect
	s.mu.Unlock()
}

func writePrivateFile(path, content string) error {
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return err
	}
	if err := file.Chmod(0600); err != nil {
		_ = file.Close()
		_ = os.Remove(path)
		return err
	}
	if _, err := io.WriteString(file, content); err != nil {
		_ = file.Close()
		_ = os.Remove(path)
		return err
	}
	if err := file.Close(); err != nil {
		_ = os.Remove(path)
		return err
	}
	return nil
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		http.Error(w, "diagnostics unavailable", http.StatusServiceUnavailable)
		return
	}
	s.handlers.Add(1)
	s.mu.Unlock()
	defer s.handlers.Done()

	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	if !s.authorized(r.Header.Get("Authorization")) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	s.mux.ServeHTTP(w, r)
}

func (s *Server) authorized(header string) bool {
	const prefix = "Bearer "
	if !strings.HasPrefix(header, prefix) {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(strings.TrimPrefix(header, prefix)), []byte(s.token)) == 1
}

func (s *Server) handleSnapshot(w http.ResponseWriter, r *http.Request) {
	select {
	case s.snapshotSlot <- struct{}{}:
		defer func() { <-s.snapshotSlot }()
	default:
		http.Error(w, "snapshot busy", http.StatusServiceUnavailable)
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
	defer cancel()
	result := collectSnapshot(ctx, s.startedAt, s.commit, s.readers)
	s.mu.Lock()
	collectOwnership := s.ownershipStats
	s.mu.Unlock()
	var ownership any
	if collectOwnership != nil {
		ownership = collectOwnership()
	}
	w.Header().Set("Content-Type", "application/json")
	if err := jsonEncode(w, snapshotResponse{snapshot: result, Ownership: ownership}); err != nil {
		slog.Debug("write private diagnostics snapshot", "err", err)
	}
}

// Close stops private diagnostics and removes only its known connection files.
// If an in-flight handler does not exit within the bound, its directory and
// profile files are retained rather than deleting data still in use.
func (s *Server) Close() error {
	s.closeOnce.Do(func() {
		s.mu.Lock()
		s.closed = true
		s.mu.Unlock()
		s.cancel()

		ctx, cancel := context.WithTimeout(context.Background(), closeTimeout)
		defer cancel()
		err := s.httpServer.Shutdown(ctx)
		if err != nil {
			_ = s.httpServer.Close()
		}

		done := make(chan struct{})
		go func() {
			s.handlers.Wait()
			close(done)
		}()
		select {
		case <-done:
			if err != nil {
				s.closeError = err
			}
			s.removeConnectionFiles()
			if removeErr := os.Remove(s.dir); removeErr != nil && !errors.Is(removeErr, os.ErrNotExist) {
				s.closeError = errors.Join(s.closeError, removeErr)
			}
		case <-ctx.Done():
			s.closeError = errors.Join(s.closeError, ctx.Err())
		}
	})
	return s.closeError
}

func (s *Server) removeConnectionFiles() {
	for _, name := range []string{"url", "client.curl"} {
		path := filepath.Join(s.dir, name)
		if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
			s.closeError = errors.Join(s.closeError, err)
		}
	}
}

func (s *Server) URL() string { return s.url }
func (s *Server) Dir() string { return s.dir }

func jsonEncode(w io.Writer, value any) error {
	return json.NewEncoder(w).Encode(value)
}
