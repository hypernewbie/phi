package main

import (
	"log"
	"net/http"
	"os"
	"runtime"
	"time"

	"github.com/hypernewbie/phi/pkg/restart"
)

// handleRestart triggers an in-process restart. POST /api/restart.
//
// Behavior:
//   1. Broadcast 0x05 {"reason":"restart"} to all connected clients.
//   2. Flush pending state (tabs + sync board) atomically.
//   3. On Unix: syscall.Exec replaces the current process image with
//      the same binary. Same PID, same port (no rebind race).
//   4. On Windows: spawn detached child, exit. Child retry-binds
//      the port for up to 5s.
//
// Returns immediately with a JSON acknowledgement. Clients will see
// the WS close + the 0x05 frame and arm their reload pollers.
func handleRestart(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write([]byte(`{"status":"restarting"}`))

	if err := flushStateForRestart(); err != nil {
		log.Printf("[restart] flush failed: %v", err)
	}

	if wsHub != nil {
		wsHub.BroadcastShutdown("restart")
	}

	time.Sleep(150 * time.Millisecond)

	args := os.Args

	switch runtime.GOOS {
	case "windows":
		pid, err := restart.SpawnDetached(args, os.Environ())
		if err != nil {
			log.Printf("[restart] SpawnDetached failed: %v", err)
			http.Error(w, "spawn failed: "+err.Error(), http.StatusInternalServerError)
			return
		}
		log.Printf("[restart] spawned detached child pid=%d, exiting parent", pid)
		os.Exit(0)
	default:
		log.Printf("[restart] exec-replacing self: %v", args)
		if err := restart.ExecSelf(args, os.Environ()); err != nil {
			log.Printf("[restart] ExecSelf failed: %v", err)
			http.Error(w, "exec failed: "+err.Error(), http.StatusInternalServerError)
			return
		}
		// unreachable on success
	}
}

func flushStateForRestart() error {
	if ptyManager != nil {
		if err := ptyManager.FlushSaveState(); err != nil {
			return err
		}
	}
	return FlushSyncStore()
}