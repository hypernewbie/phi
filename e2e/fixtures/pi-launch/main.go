// Command pi-launch is a stub Pi/Psi binary for e2e/pi-launch-config.spec.ts.
//
// Phi copies it to `pi` and `psi` names on an isolated PATH, so a spec can
// prove which agent actually ran without a real coding CLI. It records how it
// was launched, prints a ready line so the pane's output probe succeeds, and
// stays alive so the tab remains a live process.
package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"time"
)

// recordedEnv is the fixed set of synthetic variables this fixture reports.
// The child inherits everything Phi passes, so never dump the whole
// environment: it would leak unrelated values into evidence.
var recordedEnv = []string{"PHI_E2E_AGENT_MARK", "PHI_E2E_SECOND_MARK"}

func main() {
	dir := os.Getenv("PHI_E2E_PI_LAUNCH_DIR")
	if dir == "" {
		fmt.Fprintln(os.Stderr, "PHI_E2E_PI_LAUNCH_DIR is required")
		os.Exit(2)
	}
	executable, err := os.Executable()
	if err != nil {
		executable = os.Args[0]
	}
	cwd, _ := os.Getwd()
	env := make(map[string]string, len(recordedEnv))
	for _, key := range recordedEnv {
		if value, ok := os.LookupEnv(key); ok {
			env[key] = value
		}
	}
	payload, err := json.Marshal(map[string]any{
		"pid":        os.Getpid(),
		"executable": executable,
		"argv":       os.Args,
		"cwd":        cwd,
		"env":        env,
	})
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(3)
	}
	// One record per child process: overlapping launches must not overwrite
	// each other's evidence.
	path := filepath.Join(dir, "child-"+strconv.Itoa(os.Getpid())+".json")
	if err := os.WriteFile(path, payload, 0o600); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(4)
	}
	fmt.Println("ready")
	for {
		time.Sleep(time.Second)
	}
}
