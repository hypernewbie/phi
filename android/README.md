# Phi for Android (thin shell)

Native shell around the existing Phi web UI in a WebView — the same
architecture as the desktop Electron client. The APK owns server profiles
and view retention; the web client owns everything the user sees. No UI
code is rewritten here, and **no design is invented here**: every color,
glyph and form comes from the repo's own sources.

## Design provenance

| Shell surface | Source of truth |
| --- | --- |
| Palette (`values/colors.xml`) | `web/style.css` tokens via `desktop/electron/src/rail.css :root` |
| Drawer field | radial obsidian gradient (`#16161c → #08080a`), web body background |
| Server chips | `.rail-item` material: 40dp elevated tile, 1px hairline, 6dp radius |
| Greek glyphs | `renderer.ts`: FNV-1a over the canonical hostname, 47-letter pool (both cases + ς), **Φ/φ excluded**; collisions case-swap, then numeral marks. Golden-value unit tests generated from the TS algorithm |
| Active state | observed accent at 15% glow fill + accent stroke; neutral material until a server reports its color (`no-accent` mode) |
| Offline | `.offline`: dimmed tile, muted glyph — health is diegetic |
| Attention | `.attention` lozenge in the server's accent on background title activity |
| Brand row | `Φ` in JetBrains Mono at the live accent + lowercase `phi` (web `index.html`) |
| Empty state | `Φ / Phi / "Terminal Multiplexer for AI Coding Agents"` (`.empty-state`) |
| Add-server form | `picker.html` verbatim: `:7070` autofill, whitespace bulk paste, per-server errors, indigo `#4f46e5` Add |
| Launcher icons | `desktop/electron/assets/icon.png` verbatim (gen-icon.mjs brand raster) over solid `--bg` |
| Fonts | the same vendored woff2 subsets the page serves (Inter greek/latin, JetBrains Mono), decompressed to static TTFs |

## What works

- Drawer with rail-parity chips, live accent sync (`__phiDesktop.reportThemeColor`),
  offline tiles, attention lozenges; edge handle carries the active glyph.
- Add server (picker parity), rename/remove (themed sheet), launcher
  long-press shortcuts with chip icons.
- One retained WebView per origin; web assets ship in the APK from the
  desktop `vendor-web.mjs` sidecar (re-vendored every build); only `/api`
  and live sockets hit the network.
- Low power ONLY: `phi_low_power='1'` seeded per origin after load.
- Zoom (−/%/+ persisted), keep-awake, offline retry overlay, splash.

## Build

```sh
./android/gradlew -p android :app:assembleDebug     # APK
./android/gradlew -p android :app:testDebugUnitTest # glyph + parser parity tests
./android/gradlew -p android :app:lintDebug         # Android lint (zero errors)
```

CI builds the APK on every push (`test-android` job). JDK 17, an Android
SDK (`ANDROID_HOME` or gitignored `local.properties`), and `node` for
vendoring are the only host requirements.

## Layout

```text
android/
  gen-icons.py           # favicon-formula launcher icons
  app/src/main/java/dev/phi/android/
    MainActivity.kt      # drawer, retained views, picker, sheets
    GreekGlyph.kt        # renderer.ts glyph engine (tested)
    ServerInput.kt       # picker.html parseUrls (tested)
    ServerStore.kt       # profiles, names, accents, zoom
    PhiBridge.kt         # window.__phiDesktop contract
  app/src/main/res/      # tokens, rail drawables, layout, mipmaps
  app/src/test/          # golden parity tests
  app/src/main/assets/fonts/  # vendored Inter/JBM static instances
```

## Privacy

No server URLs, IPs, hostnames, or credentials anywhere in this tree —
servers are user-entered at runtime, stored in app-private prefs.
`local.properties`, build outputs and APKs are gitignored.
