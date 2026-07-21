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
//  1. Broadcast 0x05 {"reason":"restart"} to all connected clients.
//  2. Flush pending state (tabs + sync board) atomically.
//  3. Unix: syscall.Exec replaces the process image (same PID, no rebind race).
//  4. Windows: spawn detached child, exit. Child retry-binds via restart.BindWithRetry.
//
// Returns immediately with JSON ack. Clients see 0x05 and arm reload pollers.
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
			return
		}
		log.Printf("[restart] spawned detached child pid=%d, exiting parent", pid)
		os.Exit(0)
	default:
		log.Printf("[restart] exec-replacing self: %v", args)
		if err := restart.ExecSelf(args, os.Environ()); err != nil {
			log.Printf("[restart] ExecSelf failed: %v", err)
		}
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
