# Multi-step orchestration lives here; package.json keeps simple,
# platform-portable single commands only.

.PHONY: dev-web-full

# Full from-source desktop run: compile web-src -> web, build the
# optional pet package, build + vendor the Electron shell, launch it.
# Recipe lines abort on first failure (same semantics as &&).
dev-web-full:
	pnpm exec tsc -p tsconfig.build.json
	pnpm --filter @phi-desktop/pet run build
	pnpm --filter phi-desktop-electron run build
	pnpm --filter phi-desktop-electron run dev
