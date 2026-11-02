package server

import (
	"log"
	"net/http"
	"os"
	"runtime"
	"time"

	"github.com/hypernewbie/phi/internal/access"
	"github.com/hypernewbie/phi/pkg/restart"
)

// handleRestart triggers an in-process restart. POST /api/restart.
//
// Behavior:
//  1. Broadcast 0x05 {"reason":"restart"} to all connected clients.
//  2. Flush pending state (tabs + sync board) atomically.
//  3. Unix: syscall.Exec replaces the process image (same PID, no rebind race).
//  4. Windows: spawn detached child, exit. Child retry-binds via restart.BindWithRetry.
//
// Returns immediately with JSON ack. Clients see 0x05 and arm reload pollers.
func (app *Server) handleRestart(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write([]byte(`{"status":"restarting"}`))

	if err := app.flushStateForRestart(); err != nil {
		log.Printf("[restart] flush failed: %v", err)
	}

	if app.hub != nil {
		app.hub.BroadcastShutdown("restart")
	}

	time.Sleep(150 * time.Millisecond)

	args := os.Args

	switch runtime.GOOS {
	case "windows":
		if app.options.Exit == nil {
			log.Printf("[restart] process exit callback is unavailable")
			return
		}
		access.RestartOnWindows(app.accessManager, func() (int, error) {
			return restart.SpawnDetached(args, os.Environ())
		}, app.options.Exit)
	default:
		log.Printf("[restart] exec-replacing self: %v", args)
		access.RestartOnUnix(app.accessManager, func() error {
			return restart.ExecSelf(args, os.Environ())
		})
	}
}

func (app *Server) flushStateForRestart() error {
	if app.pty != nil {
		if err := app.pty.FlushSaveState(); err != nil {
			return err
		}
	}
	return app.flushSyncStore()
}
