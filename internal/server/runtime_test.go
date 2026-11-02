package server

import (
	"bufio"
	"bytes"
	"context"
	"fmt"
	"io"
	"io/fs"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"testing"
	"testing/fstest"
	"time"

	"github.com/hypernewbie/phi/internal/access"
	"github.com/hypernewbie/phi/internal/config"
	"github.com/hypernewbie/phi/pkg/bindaddr"
	"github.com/hypernewbie/phi/pkg/system"
)

// The runtime has process-lifetime workers. Run it in an owned child rather
// than leaking them into the test process. SIGTERM must wait for an active
// response, close listeners, and release auth ownership before Run returns.
func TestRunDrainsLiveRequest(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("SIGTERM fixture")
	}
	if root := os.Getenv("PHI_TEST_DRAIN_ROOT"); root != "" {
		runDrainChild(t, root)
		return
	}
	root := t.TempDir()
	for _, dir := range []string{"home", "tmp", "state"} {
		if err := os.MkdirAll(filepath.Join(root, dir), 0700); err != nil {
			t.Fatal(err)
		}
	}
	cmd := exec.Command(os.Args[0], "-test.run=^TestRunDrainsLiveRequest$", "-test.timeout=20s")
	cmd.Env = append(os.Environ(), "PHI_TEST_DRAIN_ROOT="+root,
		"HOME="+filepath.Join(root, "home"), "USERPROFILE="+filepath.Join(root, "home"),
		"TMPDIR="+filepath.Join(root, "tmp"), "TMP="+filepath.Join(root, "tmp"), "TEMP="+filepath.Join(root, "tmp"),
		"PHI_SHUTDOWN_DRAIN=1s", "PHI_SHUTDOWN_PTY_GRACE=100ms", "PHI_SHUTDOWN_GRACE=5s")
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	input, err := cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	exited := make(chan struct{})
	var waitErr error
	go func() { waitErr = cmd.Wait(); close(exited) }()
	t.Cleanup(func() {
		_ = input.Close()
		select {
		case <-exited:
		default:
			_ = cmd.Process.Kill()
			<-exited
		}
		if t.Failed() {
			t.Logf("child stderr:\n%s", stderr.String())
		}
	})
	lines := make(chan string, 16)
	go func() {
		scanner := bufio.NewScanner(stdout)
		for scanner.Scan() {
			lines <- scanner.Text()
		}
		close(lines)
	}()
	await := func(prefix string) string {
		t.Helper()
		timeout := time.After(10 * time.Second)
		for {
			select {
			case line, ok := <-lines:
				if !ok {
					t.Fatalf("child exited before %s", prefix)
				}
				if strings.HasPrefix(line, prefix) {
					return strings.TrimPrefix(line, prefix)
				}
			case <-timeout:
				t.Fatalf("child did not report %s", prefix)
			}
		}
	}
	url := await("READY ")
	client := &http.Client{Timeout: 10 * time.Second}
	responseDone := make(chan error, 1)
	go func() {
		response, err := client.Get(url + "/drain-hold")
		if err == nil {
			body, readErr := io.ReadAll(response.Body)
			_ = response.Body.Close()
			if readErr != nil {
				err = readErr
			} else if response.StatusCode != 200 || string(body) != "drained" {
				err = fmt.Errorf("held response: %d %q", response.StatusCode, body)
			}
		}
		responseDone <- err
	}()
	await("ENTERED")
	if err := cmd.Process.Signal(syscall.SIGTERM); err != nil {
		t.Fatal(err)
	}
	await("DRAINING")
	response, err := client.Get(url + "/readyz")
	if err != nil {
		t.Fatal(err)
	}
	_ = response.Body.Close()
	if response.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("readiness while draining = %d", response.StatusCode)
	}
	select {
	case <-exited:
		t.Fatal("runtime exited before releasing the held response")
	default:
	}
	if _, err := io.WriteString(input, "release\n"); err != nil {
		t.Fatal(err)
	}
	if err := <-responseDone; err != nil {
		t.Fatal(err)
	}
	select {
	case <-exited:
	case <-time.After(10 * time.Second):
		t.Fatal("runtime did not exit")
	}
	if waitErr != nil {
		t.Fatalf("child: %v\n%s", waitErr, stderr.String())
	}
	conn, err := net.DialTimeout("tcp", strings.TrimPrefix(url, "http://"), time.Second)
	if err == nil {
		_ = conn.Close()
		t.Fatal("listener remained open after Run returned")
	}
	store := config.NewStore(config.Paths{Primary: filepath.Join(root, "state", "config.toml")}, nil)
	manager := access.NewManager(func() *config.Store { return store }, nil)
	defer manager.Close()
	if err := manager.Configure(""); err != nil {
		t.Fatal(err)
	}
	if !manager.StateOwned() {
		t.Fatal("runtime retained auth ownership after exit")
	}
}

func runDrainChild(t *testing.T, root string) {
	t.Helper()
	state := filepath.Join(root, "state")
	system.SetPhiDataDir(state)
	app := New(Options{IP: "127.0.0.1", Port: 0, CWD: root,
		Config: config.NewStore(config.Paths{Primary: filepath.Join(state, "config.toml")}, nil),
		Assets: func() (fs.FS, map[string][]byte, error) {
			return fstest.MapFS{"index.html": {Data: []byte("fixture")}}, nil, nil
		},
		OnListen: func(_ config.Config, _ []bindaddr.Addr, port int) { fmt.Printf("READY http://127.0.0.1:%d\n", port) },
	})
	app.testCustomBackendsDir = filepath.Join(state, "backends")
	app.Handler()
	release := make(chan struct{})
	app.mux.HandleFunc("/drain-hold", func(w http.ResponseWriter, _ *http.Request) {
		fmt.Println("ENTERED")
		<-release
		_, _ = io.WriteString(w, "drained")
	})
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM)
	defer stop()
	go func() {
		<-ctx.Done()
		for !app.shuttingDown.Load() {
			time.Sleep(time.Millisecond)
		}
		fmt.Println("DRAINING")
		_, _ = bufio.NewReader(os.Stdin).ReadString('\n')
		close(release)
	}()
	if err := app.Run(ctx); err != nil {
		t.Fatal(err)
	}
	if err := app.Run(ctx); err == nil {
		t.Fatal("runtime admitted a second Run")
	}
}
