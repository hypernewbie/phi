package main

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"os"
	"os/exec"
	"runtime"
	"sync"
	"time"
)

type RunCommandRequest struct {
	Command   string   `json:"command"`
	Worktrees []string `json:"worktrees,omitempty"`
	Cwd       string   `json:"cwd,omitempty"`
}

type CommandResult struct {
	Worktree   string `json:"worktree"`
	Success    bool   `json:"success"`
	ExitCode   int    `json:"exit_code"`
	Output     string `json:"output"`
	DurationMs int64  `json:"duration_ms"`
	Error      string `json:"error,omitempty"`
}

type RunCommandResponse struct {
	Results []CommandResult `json:"results"`
}

func handleRunCommand(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req RunCommandRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	if req.Command == "" {
		http.Error(w, "Missing command", http.StatusBadRequest)
		return
	}

	worktrees := req.Worktrees
	if len(worktrees) == 0 {
		if req.Cwd != "" {
			worktrees = []string{req.Cwd}
		} else {
			worktrees = []string{activeCWD}
		}
	}

	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Minute)
	defer cancel()

	results := make([]CommandResult, len(worktrees))
	var wg sync.WaitGroup
	sem := make(chan struct{}, 8) // max 8 parallel workers

	for i, wt := range worktrees {
		wg.Add(1)
		go func(idx int, targetDir string) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()

			start := time.Now()
			res := CommandResult{
				Worktree: targetDir,
			}

			// Validate working directory
			if targetDir != "" {
				info, err := os.Stat(targetDir)
				if err != nil || !info.IsDir() {
					res.Success = false
					res.ExitCode = 1
					res.Error = "directory does not exist"
					res.DurationMs = time.Since(start).Milliseconds()
					results[idx] = res
					return
				}
			}

			var shellCmd string
			var args []string

			if runtime.GOOS == "windows" {
				shellCmd = getPreferredPowerShell()
				args = []string{"-NoProfile", "-NonInteractive", "-Command", req.Command}
			} else {
				shellCmd = os.Getenv("SHELL")
				if shellCmd == "" {
					shellCmd = "/bin/sh"
				}
				args = []string{"-c", req.Command}
			}

			cmd := exec.CommandContext(ctx, shellCmd, args...)
			if targetDir != "" {
				cmd.Dir = targetDir
			}

			var outBuf bytes.Buffer
			cmd.Stdout = &outBuf
			cmd.Stderr = &outBuf

			err := cmd.Run()
			duration := time.Since(start).Milliseconds()
			res.DurationMs = duration
			res.Output = outBuf.String()

			if err != nil {
				res.Success = false
				if exitErr, ok := err.(*exec.ExitError); ok {
					res.ExitCode = exitErr.ExitCode()
				} else {
					res.ExitCode = 1
				}
				res.Error = err.Error()
			} else {
				res.Success = true
				res.ExitCode = 0
			}

			results[idx] = res
		}(i, wt)
	}

	wg.Wait()

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(RunCommandResponse{Results: results})
}
