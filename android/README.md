# Phi for Android (thin shell)

Native shell around the existing Phi web UI in a WebView — the same
architecture as the desktop Electron client. The APK owns server profiles
and view retention; the web client owns everything the user sees. No UI
code is rewritten here.

## What works

- **Drawer**: obsidian glass panel (blur while open, API 31+), chevron
  edge handle, Phi header, per-server rows, offline retry.
- **Server identity**: Greek-letter badges (Α, Β, Γ…) in deterministic
  cached colors; display names from the server-reported
  `/api/config` hostname (pretty-host fallback); accent follows the web
  theme live via the `__phiDesktop` bridge.
- **Profiles**: add (URL-validated like the desktop controller),
  tap-to-switch with one retained WebView per origin, long-press to
  rename/remove. Active profile + names + zoom persist in app prefs.
- **Power**: low-power ONLY — every page seeds `phi_low_power='1'` after
  load, same key/class/CSS as desktop low-power mode.
- **Zoom**: in-drawer −/%/+ (tap % resets), persisted, applied to all
  retained views; pinch-zoom enabled in-page.
- **Sessions**: screen stays on while the app is foreground; rotation and
  process death reload the active server fresh.
- **Assets**: web files ship in the APK (same desktop `vendor-web.mjs`
  sidecar, re-run every build); only `/api` and live sockets hit the
  network. Offline servers get a native retry screen, not a WebView error.

## Prerequisites (Linux build host, no sudo)

- JDK 17, Android SDK (`~/Android/Sdk` or `ANDROID_HOME`), `node` on PATH.
- Either `ANDROID_HOME` in the environment or a gitignored
  `android/local.properties` with `sdk.dir=/home/<you>/Android/Sdk`.

## Build

```sh
./android/gradlew -p android :app:assembleDebug
# -> android/app/build/outputs/apk/debug/app-debug.apk
```

CI builds the same APK on every push (`.github/workflows/test.yml`,
`test-android` job). `./gradlew :app:lintDebug` runs Android lint.

## Layout

```text
android/
  settings.gradle.kts / build.gradle.kts / gradle.properties
  gradlew* gradle/       # committed wrapper (pins Gradle 9.9.1)
  gen-icons.py           # one-off: launcher icons from desktop brand glyph
  app/
    build.gradle.kts     # AGP pin, vendorWeb + syncWebAssets tasks
    src/main/
      AndroidManifest.xml
      java/dev/phi/android/
        MainActivity.kt  # drawer, retained WebViews, zoom, retry overlay
        ServerStore.kt   # profiles, names, accents, zoom (prefs)
        PhiBridge.kt     # window.__phiDesktop contract
        BadgeDrawable.kt # Greek-letter server badge
      res/values/        # obsidian colors, server palette, Theme.Phi+splash
      res/layout/ res/drawable/ res/mipmap-*/
```

## Privacy notes (why this is safe to commit)

- No server URLs, IPs, hostnames, or credentials anywhere in this tree —
  servers are user-entered at runtime and stored in app-private prefs.
- `local.properties` (machine-specific SDK path) is gitignored, as are all
  build outputs and APKs.
