# Multi-step orchestration lives here; package.json keeps simple,
# platform-portable single commands only.

.PHONY: dev-web-full

run-server:
	pnpm exec tsc -p tsconfig.build.json
	go run . -ip 127.0.0.1

# Full from-source desktop run: compile web-src -> web, build the
# optional pet package, build + vendor the Electron shell, launch it.
# Recipe lines abort on first failure (same semantics as &&).
run-desktop:
	pnpm exec tsc -p tsconfig.build.json
	pnpm --filter @phi-desktop/pet run build
	pnpm --filter phi-desktop-electron run build
	pnpm --filter phi-desktop-electron run dev
