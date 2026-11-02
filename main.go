package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"log/slog"
	"net"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"

	"github.com/hypernewbie/phi/internal/access"
	"github.com/hypernewbie/phi/internal/config"
	"github.com/hypernewbie/phi/internal/server"
	"github.com/hypernewbie/phi/pkg/bindaddr"
	"github.com/hypernewbie/phi/pkg/obs"
	"github.com/hypernewbie/phi/pkg/system"
	"github.com/hypernewbie/phi/pkg/update"
)

var (
	Version     = "dev"
	Commit      = "none"
	Date        = "unknown"
	BuildSource = "source"
)

func rollbackPreviousBinary() (string, error) {
	release, err := access.AcquireRollbackGuard(config.NewStore(config.Paths{}, nil))
	if err != nil {
		return "", err
	}
	defer release()
	return update.Rollback()
}

func main() {
	enableVirtualTerminalProcessing()
	portFlag := flag.Int("port", 7070, "Port to run Go web server on")
	diagnosticsDirFlag := flag.String("diagnostics-dir", "", "Enable private loopback diagnostics and write connection files under this absolute directory. Only takes effect in a binary built with -tags=profiling.")
	ipFlag := flag.String("ip", "lan", `IP to bind. "lan" (default) binds loopback + every LAN (RFC 1918) + Tailscale (100.64/10) interface on the host. Use 0.0.0.0 to expose on every interface (public internet reachable), or an explicit IP to bind just one address.`)
	webFlag := flag.String("web", "", "Directory to serve web assets from instead of embedded assets")
	dataDirFlag := flag.String("data-dir", "", "Absolute directory for Phi state (default ~/.phi); does not change HOME or assistant settings")
	versionFlag := flag.Bool("version", false, "Print version and exit")
	rollbackFlag := flag.Bool("rollback", false, "Roll back to the previously installed binary (undoes the last self-update) and exit")
	logLevelFlag := flag.String("log-level", "", "Log level: debug|info|warn|error (default: info, or PHI_LOG env var)")
	// Registered unconditionally (not behind //go:build otel) so a default
	// build parses identical args — it just never has anywhere to send the
	// endpoint. obs.Init's body is the only tag-split part (plan §B).
	otelEndpointFlag := flag.String("otel-endpoint", "", "OTLP/gRPC collector endpoint for OpenTelemetry export (host:port). Only takes effect in a binary built with -tags=otel. Falls back to PHI_OTEL_ENDPOINT.")
	flag.Parse()

	if *diagnosticsDirFlag != "" && !filepath.IsAbs(*diagnosticsDirFlag) {
		fmt.Fprintln(os.Stderr, "--diagnostics-dir must be an absolute path")
		os.Exit(2)
	}

	if *dataDirFlag != "" {
		if !filepath.IsAbs(*dataDirFlag) {
			fmt.Fprintln(os.Stderr, "--data-dir must be an absolute path")
			os.Exit(2)
		}
		system.SetPhiDataDir(filepath.Clean(*dataDirFlag))
	}

	initLogging(*logLevelFlag)

	otelEndpoint := *otelEndpointFlag
	if otelEndpoint == "" {
		otelEndpoint = os.Getenv("PHI_OTEL_ENDPOINT")
	}
	obsShutdown, obsErr := obs.Init(context.Background(), otelEndpoint)
	if obsErr != nil {
		log.Printf("[main] obs.Init: %v", obsErr)
	}

	if *versionFlag {
		fmt.Printf("Phi %s (commit: %s, built: %s, source: %s)\n", Version, Commit, Date, BuildSource)
		os.Exit(0)
	}

	if *rollbackFlag {
		restored, err := rollbackPreviousBinary()
		if err != nil {
			fmt.Fprintf(os.Stderr, "Rollback failed: %v\n", err)
			os.Exit(1)
		}
		fmt.Printf("Rolled back to previous binary: %s\nRestart phi normally to run it.\n", restored)
		os.Exit(0)
	}

	cwd, err := os.Getwd()
	if err != nil {
		slog.Error("failed to resolve current working directory", "err", err)
		os.Exit(1)
	}
	app := server.New(server.Options{
		IP: *ipFlag, Port: *portFlag, Web: *webFlag, DiagnosticsDir: *diagnosticsDirFlag,
		CWD: cwd, Config: config.NewStore(config.Paths{}, nil),
		Version: Version, Commit: Commit, Date: Date, BuildSource: BuildSource,
		Assets: newWebRoot, PiRuntime: piPhiRuntime, PiVersion: strings.TrimSpace(piPhiVersionAsset), Exit: os.Exit,
		OnListen: func(cfg config.Config, addrs []bindaddr.Addr, port int) { printWelcomeBanner(cfg, addrs, port, cwd) },
	})
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	err = app.Run(ctx)
	if shutdownErr := obsShutdown(context.Background()); shutdownErr != nil {
		slog.Error("obs shutdown", "err", shutdownErr)
	}
	if err != nil {
		slog.Error("serve failed", "err", err)
		os.Exit(1)
	}
}

// bannerColors is the RGB tuple per theme name used by the welcome banner.
// MUST stay in sync with web/theme.js ACCENT_COLORS keys — drift silently
// falls back to purple in printWelcomeBanner. The test
// TestBannerColorsCoversAllAccentColors enforces this.
//
// NOTE: When adding a new theme color, you must update:
//  1. web/app.js: Add properties in ACCENT_COLORS
//  2. web/index.html: Add <option> in #accent-color-select
//  3. main.go: Add entry in bannerColors below
//  4. bonus/: Add matching theme profiles to bonus/vim_themes/,
//     bonus/pi_themes/, bonus/opencode_themes/, and bonus/btop_themes/
var bannerColors = map[string][]int{
	"purple":  {124, 106, 247},
	"blue":    {56, 189, 248},
	"green":   {16, 185, 129},
	"amber":   {251, 191, 36},
	"red":     {248, 113, 113},
	"pink":    {236, 72, 153},
	"teal":    {20, 184, 166},
	"indigo":  {99, 102, 241},
	"orange":  {249, 115, 22},
	"cyan":    {6, 182, 212},
	"rose":    {244, 63, 94},
	"lime":    {132, 204, 22},
	"white":   {255, 255, 255},
	"gold":    {212, 175, 55},
	"canary":  {255, 238, 16},
	"copper":  {211, 84, 0},
	"mint":    {46, 213, 115},
	"violet":  {167, 139, 250},
	"emerald": {5, 150, 105},
	"neon":    {26, 121, 255},
	"coral":   {224, 122, 95},
	"fuchsia": {217, 70, 239},
	"arc":     {41, 82, 255},
	"ember":   {255, 69, 0},
	"fog":     {148, 163, 184},
	"ash":     {168, 162, 158},
	"dusk":    {184, 169, 201},
	"pine":    {132, 165, 157},
	"fern":    {156, 175, 136},
}

func printWelcomeBanner(cfg config.Config, addrs []bindaddr.Addr, port int, cwd string) {
	rgb, ok := bannerColors[strings.ToLower(cfg.ThemeColor)]
	if !ok {
		rgb = bannerColors["purple"]
	}

	colorEsc := fmt.Sprintf("\x1b[38;2;%d;%d;%dm", rgb[0], rgb[1], rgb[2])
	resetEsc := "\x1b[0m"
	boldEsc := "\x1b[1m"
	dimEsc := "\x1b[2m"

	fmt.Printf("\n")
	fmt.Printf("%s    ____  __     _%s\n", colorEsc, resetEsc)
	fmt.Printf("%s   / __ \\/ /_   (_)%s\n", colorEsc, resetEsc)
	fmt.Printf("%s  / /_/ / /__ \\  /%s\n", colorEsc, resetEsc)
	fmt.Printf("%s / ____/ / / // /%s\n", colorEsc, resetEsc)
	fmt.Printf("%s/_/   /_/ /_//_/%s   %sControl Center for AI Coding%s\n\n", colorEsc, resetEsc, boldEsc, resetEsc)

	host := server.ReportedHostname(cfg)
	coordinatorAddr := &net.TCPAddr{Port: port}
	if len(addrs) > 0 {
		coordinatorAddr.IP = addrs[0].IP
	}

	fmt.Printf("%s── Status Dump ──────────────────────────────────────────%s\n", dimEsc, resetEsc)
	fmt.Printf("  %sCWD:%s          %s\n", colorEsc, resetEsc, cwd)
	fmt.Printf("  %sWorkspaces:%s   %d active\n", colorEsc, resetEsc, len(cfg.Workspaces))
	fmt.Printf("  %sHostname:%s     %s\n", colorEsc, resetEsc, strings.ToUpper(host))
	fmt.Printf("  %sCoordinator:%s  %s\n", colorEsc, resetEsc, cfg.SyncCoordinatorURL(coordinatorAddr))
	fmt.Printf("  %sPort:%s         %d\n", colorEsc, resetEsc, port)
	fmt.Printf("  %sTheme:%s        %s\n", colorEsc, resetEsc, cfg.ThemeColor)
	fmt.Printf("%s────────────────────────────────────────────────────────%s\n\n", dimEsc, resetEsc)

	// Bind summary. In lan-detect mode this prints one labelled line
	// per successfully bound interface (loopback, each LAN IP, each
	// Tailnet IP). In explicit --ip mode it prints one line. Called
	// AFTER binds so the banner only advertises URLs we actually serve.
	firstLoopback := true
	for _, a := range addrs {
		url := fmt.Sprintf("http://%s:%d", a.IP.String(), port)
		switch {
		case a.IP.Equal(net.IPv4zero):
			// Explicit 0.0.0.0 bind — flag the public exposure so the
			// user isn't surprised when their firewall ignores it.
			fmt.Printf("  %sServer running on:%s %s%s%s %s(all interfaces, public reachable)%s\n",
				boldEsc, resetEsc, boldEsc, url, resetEsc, dimEsc, resetEsc)
			fmt.Printf("    %slocal:           http://localhost:%d%s\n", dimEsc, port, resetEsc)
		case a.Kind == bindaddr.Loopback:
			if firstLoopback {
				fmt.Printf("  %sServer running on:%s %s%s%s\n", boldEsc, resetEsc, boldEsc, url, resetEsc)
				fmt.Printf("    %slocal%s\n", dimEsc, resetEsc)
				firstLoopback = false
			} else {
				fmt.Printf("    %s%-8s%s %s%s%s\n", dimEsc, a.Kind.String()+":", resetEsc, boldEsc, url, resetEsc)
			}
		default:
			fmt.Printf("    %s%-8s%s %s%s%s\n", dimEsc, a.Kind.String()+":", resetEsc, boldEsc, url, resetEsc)
		}
	}
	fmt.Printf("\n")
}
