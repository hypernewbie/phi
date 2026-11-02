# Multi-step orchestration lives here; package.json keeps simple,
# platform-portable single commands only.

# Chromium DevTools port for profile-desktop.
# Override with: make profile-desktop PHI_DEBUG_PORT=9333
PHI_DEBUG_PORT ?= 9222

# Node inspector port for profile-desktop: the Electron main process, so a
# heap snapshot can name what the shell itself retains. Override likewise.
PHI_INSPECT_PORT ?= 9229

# Matches every Electron process launched from this checkout (main + helpers).
ELECTRON_PATTERN = $(CURDIR)/node_modules/.pnpm/electron

.PHONY: dev-server dev-server-profile dev-desktop profile-desktop

dev-server:
	pnpm exec tsc -p tsconfig.build.json
	go run . --web=./web -ip 127.0.0.1

# Profiling server: the `profiling` build tag adds exact per-pane terminal
# resident bytes plus /debug/phi snapshots and /debug/pprof/{heap,goroutine,
# profile}, all on a private loopback listener authenticated by the token
# file under --diagnostics-dir. Never expose the diagnostics dir.
PROFILE_DIAG_DIR ?= $(CURDIR)/.phi-profile
dev-server-profile:
	pnpm exec tsc -p tsconfig.build.json
	mkdir -p $(PROFILE_DIAG_DIR)
	go run -tags=profiling . --web=./web -ip 127.0.0.1 \
		--diagnostics-dir=$(PROFILE_DIAG_DIR)

# Full from-source desktop run: compile web-src -> web, build the
# optional pet package, build + vendor the Electron shell, launch it.
# Recipe lines abort on first failure (same semantics as &&).
dev-desktop:
	pnpm exec tsc -p tsconfig.build.json
	pnpm --filter @phi-desktop/pet run build
	pnpm --filter phi-desktop-electron run build
	pnpm --filter phi-desktop-electron run dev

# Same as dev-desktop, but both sides listen for a debugger:
#   curl -s localhost:9222/json/list   # renderers (CDP)
#   curl -s localhost:9229/json/list   # main process (Node inspector)
# Restarts first: a second launch only hands its args to the running copy
# through the single-instance gate, so the port would never bind. The stop
# is scoped to this checkout, so other Electron apps are untouched.
profile-desktop:
	-@pkill -f "$(ELECTRON_PATTERN)" 2>/dev/null
	-@pkill -f "$(CURDIR)/desktop/electron/node_modules/.bin/../electron/cli.js" 2>/dev/null
	@for i in $$(seq 25); do pgrep -f "$(ELECTRON_PATTERN)" >/dev/null || break; sleep 0.2; done
	@if pgrep -f "$(ELECTRON_PATTERN)" >/dev/null; then \
		echo "profile-desktop: a phi desktop from this checkout is still running;" >&2; \
		echo "a second launch would only hand off its args and quit." >&2; \
		exit 1; \
	fi
	pnpm exec tsc -p tsconfig.build.json
	pnpm --filter @phi-desktop/pet run build
	pnpm --filter phi-desktop-electron run build
	pnpm --filter phi-desktop-electron exec electron . \
		--inspect=$(PHI_INSPECT_PORT) --remote-debugging-port=$(PHI_DEBUG_PORT)
