# Phi for Android (prototype shell)

Thin native shell around the existing Phi web UI in a WebView — the same
architecture as the desktop Electron client. The APK owns server profiles
and view retention; the web client owns everything the user sees. No UI
code is rewritten here.

Status: prototype. Backend switching, retained WebViews, and in-APK web
assets work. Not yet built: status-bar theming, `__phiDesktop` bridge,
notifications.

## Prerequisites (Linux build host, all user-local, no sudo)

- JDK 17 (`openjdk-17-jdk-headless` or a tarball under `~/opt`)
- Android SDK command-line tools under `~/Android/Sdk`
  (`cmdline-tools/latest`, plus `platform-tools`, one `platforms;android-37*`
  and matching `build-tools` via `sdkmanager`)
- Gradle via the committed wrapper (`./gradlew`) (the pinned AGP/Kotlin versions are in the build files)
- `node` on `PATH` (vendoring re-runs the desktop script)
- Either `ANDROID_HOME=~/Android/Sdk` in the environment or a gitignored
  `android/local.properties` containing `sdk.dir=/home/<you>/Android/Sdk`

## Build

```sh
./gradlew :app:assembleDebug
# -> android/app/build/outputs/apk/debug/app-debug.apk
```

`preBuild` runs the `vendorWeb` task first: it re-executes
`desktop/electron/scripts/vendor-web.mjs` — the same and only sidecar the
desktop build uses — and syncs its verbatim `web/` copy
(`desktop/electron/embedded/`) into the APK's assets. The WebView serves
same-origin static assets from those bytes and lets `/api` + live sockets
through to the server, so the UI loads from disk while all backend traffic
stays live. Rebuilding after any `web/` change re-vendors automatically.

## Layout

```text
android/
  settings.gradle.kts / build.gradle.kts / gradle.properties
  app/
    build.gradle.kts      # AGP pin, vendorWeb + syncWebAssets tasks
    src/main/
      AndroidManifest.xml # cleartext allowed (user-entered LAN hosts can't
                          # be pre-declared; scope down if this ships)
      java/dev/phi/android/
        MainActivity.kt   # DrawerLayout + NavigationView drawer, one
                          # retained WebView per server, add/rename/remove
        ServerStore.kt    # profiles + URL validation (same rules as the
                          # desktop controller: http/https, root path only)
      res/values/themes.xml
      res/layout/drawer_header.xml
```

## Privacy notes (why this is safe to commit)

- No server URLs, IPs, hostnames, or credentials anywhere in this tree —
  servers are user-entered at runtime and stored in app-private prefs.
- `local.properties` (machine-specific SDK path) is gitignored, as are all
  build outputs and APKs.
