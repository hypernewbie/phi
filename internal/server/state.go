// Package server owns Phi's HTTP application and its process-scoped runtime.
// New and Handler are inert; Run starts services and closes owned resources.
package server

import (
	"io/fs"
	"log/slog"
	"net/http"
	"sync"
	"sync/atomic"
	"time"

	"github.com/hypernewbie/phi/internal/access"
	"github.com/hypernewbie/phi/internal/attachments"
	"github.com/hypernewbie/phi/internal/config"
	"github.com/hypernewbie/phi/internal/gitapi"
	"github.com/hypernewbie/phi/internal/piapp"
	"github.com/hypernewbie/phi/internal/syncmesh"
	"github.com/hypernewbie/phi/pkg/bindaddr"
	"github.com/hypernewbie/phi/pkg/coders"
	"github.com/hypernewbie/phi/pkg/fleet"
	"github.com/hypernewbie/phi/pkg/fswatch"
	"github.com/hypernewbie/phi/pkg/obs"
	"github.com/hypernewbie/phi/pkg/prompt_history"
	"github.com/hypernewbie/phi/pkg/pty"
	"github.com/hypernewbie/phi/pkg/rpc"
	"github.com/hypernewbie/phi/pkg/system"
	"github.com/hypernewbie/phi/pkg/update"
	"github.com/hypernewbie/phi/pkg/ws"
)

// Options contains binary inputs, not process-global configuration. Paths and
// resource loaders are supplied by the entrypoint; the caller owns logging and
// observability initialization. OnListen runs after successful binds, before serving.
type Options struct {
	IP                                 string
	Port                               int
	Web                                string
	DiagnosticsDir                     string
	CWD                                string
	Config                             *config.Store
	Version, Commit, Date, BuildSource string
	Assets                             func() (fs.FS, map[string][]byte, error)
	PiRuntime                          func() ([]byte, error)
	PiVersion                          string
	OnListen                           func(config.Config, []bindaddr.Addr, int)
	// Exit is used only by the Windows restart handoff, after child spawn.
	Exit func(int)
}

// Server is one application. Handler fixtures can be independent, but Run is
// process-scoped and single-use: PTY/system services retain process lifetimes.
// Do not copy a Server or mutate its dependencies while serving requests.
type Server struct {
	options         Options
	runStarted      atomic.Bool
	handlerOnce     sync.Once
	handler         http.Handler
	mux             *http.ServeMux
	accessManager   *access.Manager
	attachmentStore *attachments.AttachmentStore
	attachmentAPI   *attachments.API
	bridge          *piapp.Bridge
	pty             *pty.Manager
	coders          *coders.Manager
	// Guards the ensureCoderManager fallback: two concurrent /api/coders
	// rows (one per switching desktop) must never race the lazy init.
	ensureCodersOnce                   sync.Once
	hub                                *ws.Hub
	pi                                 *piapp.API
	git                                *gitapi.API
	static                             http.Handler
	activeCWD                          string
	mdWatcher                          *fswatch.Watcher
	cpu                                *system.Sampler
	fleet                              *fleet.Poller
	port                               int
	rpc                                *rpc.Manager
	titles                             *PiTerminalTitleService
	version, commit, date, buildSource string
	startedAt                          int64
	shuttingDown                       atomic.Bool
	syncMesh                           *syncmesh.Server
	syncPushCancel                     func()
	diagnosticsProcessStartedAt        time.Time
	serverStartedAt                    time.Time
	cachedInstallMethod                string
	installMethodOnce                  sync.Once
	defaultOpenCodeIdleWatcher         *openCodeIdleWatcher
	openCodeIdleWatcherMu              sync.Mutex
	updateChecker                      *update.Checker
	updateApplier                      *update.Applier
	ocServiceCacheMu                   sync.Mutex
	ocServiceCacheRunning              bool
	ocServiceCacheTime                 time.Time
	ocServiceCacheValid                bool
	syncMu                             sync.RWMutex
	syncStore                          map[string]*SyncMessage
	testSyncPath                       string
	saveTimer                          *time.Timer
	saveMu                             sync.Mutex
	promptHistoryStoreMu               sync.Mutex
	promptHistoryStore                 *prompt_history.Store
	promptHistoryLoadErr               error
	testCustomBackendsDir              string
}

// New constructs an application without opening files, starting goroutines, or
// registering routes on the process mux. Config paths remain caller-controlled.
func New(options Options) *Server {
	now := time.Now()
	app := &Server{options: options,
		activeCWD: options.CWD, port: options.Port,
		version: options.Version, commit: options.Commit, date: options.Date, buildSource: options.BuildSource,
		startedAt: now.Unix(), serverStartedAt: now, diagnosticsProcessStartedAt: now,
		cpu: system.NewSampler(), fleet: fleet.NewPoller(), rpc: rpc.NewManager(),
		syncStore: make(map[string]*SyncMessage),
	}
	app.accessManager = access.NewManager(app.configStore, func() *ws.Hub { return app.hub })
	app.pi = piapp.NewAPI(func() *piapp.Bridge { return app.bridge }, func() *attachments.AttachmentStore { return app.attachmentStore }, func() *pty.Manager { return app.pty })
	app.git = gitapi.New(func() string { return app.activeCWD }, func() *pty.Manager { return app.pty }, func() []string { return app.workspaceRoots(app.loadConfig()) })
	app.git.StartReadLoop = func(inst *pty.PTYInstance) { ws.StartPTYReadLoop(inst, app.hub) }
	app.attachmentAPI = attachments.NewAPI(func() *pty.Manager { return app.pty })
	return app
}

// Handler returns the complete HTTP/WS boundary. Middleware order is part of
// the compatibility contract: observation, admission, then admitted timing.
func (app *Server) Handler() http.Handler {
	app.handlerOnce.Do(func() {
		app.mux = http.NewServeMux()
		app.registerRoutes(app.mux)
		app.handler = obs.WrapHTTP(app.accessManager.Middleware(obs.WrapTimingHTTP(app.mux)))
	})
	return app.handler
}

func (app *Server) bridgeOrNil() *piapp.Bridge { return app.bridge }
func (app *Server) configStore() *config.Store { return app.options.Config }

// closeResources also handles partial startup. Process-lifetime idle workers
// have no join API; Run is single-use and those workers end with the process.
func (app *Server) closeResources() {
	app.stopOpenCodeIdleWatcher()
	if app.mdWatcher != nil {
		app.mdWatcher.Close()
	}
	if app.titles != nil {
		app.titles.Close()
	}
	if app.pty != nil {
		app.pty.BeginDrain()
		app.pty.Shutdown(100 * time.Millisecond)
	}
	// Close journals before handing off access ownership to a new process.
	if app.hub != nil {
		if err := app.hub.Close(); err != nil {
			slog.Error("hub shutdown", "err", err)
		}
	}
	app.accessManager.BeginRestart()
	if app.syncPushCancel != nil {
		app.syncPushCancel()
		app.syncPushCancel = nil
	}
	if app.syncMesh != nil {
		app.syncMesh.Stop()
	}
	app.bridge.Stop()
	if app.fleet != nil {
		app.fleet.Start(nil)
	}
	if app.attachmentStore != nil {
		_ = app.attachmentStore.Close()
	}
}
