// Package server serves Phi's HTTP API and static assets. The process wiring
// lives in main; this package owns the handler implementations and the shared
// state they read.
package server

import (
	"net/http"
	"sync/atomic"
	"time"

	"github.com/hypernewbie/phi/internal/access"
	"github.com/hypernewbie/phi/internal/attachments"
	"github.com/hypernewbie/phi/internal/config"
	"github.com/hypernewbie/phi/internal/gitapi"
	"github.com/hypernewbie/phi/internal/piapp"
	"github.com/hypernewbie/phi/pkg/coders"
	"github.com/hypernewbie/phi/pkg/fleet"
	"github.com/hypernewbie/phi/pkg/fswatch"
	"github.com/hypernewbie/phi/pkg/pty"
	"github.com/hypernewbie/phi/pkg/rpc"
	"github.com/hypernewbie/phi/pkg/system"
	"github.com/hypernewbie/phi/pkg/ws"
)

// Shared process state. main installs each value before serving; handlers
// treat a nil manager as "that feature is unavailable".
var (
	PTY         *pty.Manager
	Coders      *coders.Manager
	Hub         *ws.Hub
	Pi          *piapp.API
	Git         *gitapi.API
	ConfigStore func() *config.Store
	Static      http.Handler
	ActiveCWD   string
	MDWatcher   *fswatch.Watcher
	CPU         = system.NewSampler()
	Fleet       = fleet.NewPoller()
	Port        = 7070
	AttachRoot  func() *attachments.AttachmentStore
	Access      func() *access.Manager
	// BridgeOf returns the Pi bridge owner; nil when integration is off.
	BridgeOf func() *piapp.Bridge
	// RPC backs the control WebSocket.
	RPC *rpc.Manager
	// Titles is the Pi title service; nil when title sync is off.
	Titles *PiTerminalTitleService
)

// Build identity, stamped by the linker in main.
var (
	Version     = "dev"
	Commit      = "none"
	Date        = "unknown"
	BuildSource = "source"
)

// StartedAt is the unix-second timestamp of server startup. /api/version
// returns it so the front-end can detect a restart.
var StartedAt = time.Now().Unix()

// ShuttingDown flips true once the drain starts, so /readyz reports 503.
var ShuttingDown atomic.Bool

// bridgeOrNil resolves the installed bridge, if any.
func bridgeOrNil() *piapp.Bridge {
	if BridgeOf == nil {
		return nil
	}
	return BridgeOf()
}

// configStore resolves the installed config store.
func configStore() *config.Store {
	if ConfigStore == nil {
		return nil
	}
	return ConfigStore()
}
