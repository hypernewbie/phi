# Phi Apple clients

One shared core, two signed apps: `PhiMac` (macOS, AppKit) and `PhiOS`
(iOS, SwiftUI). Both link the same `PhiCore` package and the same Ghostty VT
engine build.

## Build

```sh
cd desktop/apple
cp Apps/Signing.xcconfig.example Apps/Signing.xcconfig   # set PHI_TEAM
xcodegen generate                                        # needs: brew install xcodegen
open PhiApple.xcodeproj
```

Or from the command line:

```sh
xcodebuild -scheme PhiMac   -destination 'generic/platform=macOS' build
xcodebuild -scheme PhiOS -destination 'generic/platform=iOS'   build   # device
xcodebuild -scheme PhiOS -destination 'generic/platform=iOS Simulator' build
```

`PhiApple.xcodeproj` is generated from `project.yml` and is not committed.
Run `xcodegen generate` after changing targets, sources, or settings.

## Signing

`Apps/Signing.xcconfig` (gitignored) holds `PHI_TEAM`. With a team set, Xcode
uses automatic signing for both apps. Without one, macOS still runs with
"Sign to Run Locally" and the iOS app builds for the simulator; device installs
need a real team.

The macOS app is sandboxed with the network-client entitlement. The iOS app
needs no entitlements; both declare an ATS exception because Phi servers are
reached over a tailnet on plain HTTP.

## Layout

| Path | Contents |
|---|---|
| `Package.swift` | `PhiCore`: `PhiWire` (protobuf), `PhiTerminal` (engine, wire client, journal, access auth), `PhiKit` (shared `PaneSession`, pane list), `PhiProbe` (evidence CLI) |
| `Vendor/ghostty-vt.xcframework` | Ghostty VT engine for macOS, iOS and the iOS simulator; rebuild with `Scripts/build-ghostty-vt.sh` (Zig 0.16.0) |
| `Apps/Mac` | AppKit window, grid view, key encoding |
| `Apps/iOS` | SwiftUI connect screen, pane list, terminal canvas, compose bar |
| `Apps/MacTests` | Grid render and key-encoding tests (needs the app target) |
| `Tests/PhiTerminalTests` | Engine interop, wire compatibility, journal, access auth |

`PaneSession` owns the socket, the durable input journal, the send ordering and
the status line. The app layers only draw and forward keys, so the ordering and
retry rules cannot drift between macOS and iOS.

## Command line

The macOS app reads `PHI_SERVER` and `PHI_PANE` when the flags are absent, so an
Xcode scheme can point it at a server. `PhiProbe` stays the headless evidence
tool:

```sh
swift build
.build/debug/PhiProbe --server http://hyperion:7070 --list-panes
.build/debug/PhiProbe --server http://hyperion:7070 --pane <id> --seconds 2
```

An access password is read from `PHI_ACCESS_PASSWORD` or from stdin; only the
derived verifier is stored, in the Keychain.

## Tests

```sh
swift test                                  # core, no server needed
xcodebuild -scheme PhiMac -destination 'generic/platform=macOS' test
```

The three `PHI_TEST_*` gated wire tests need a real, isolated server:

```sh
PHI_TEST_ORIGIN=http://127.0.0.1:17071 PHI_TEST_PANE=<id> swift test
```
