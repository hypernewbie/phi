# Experimental SwiftTerm client for Phi

`PhiSwiftTermSpike` opens one existing Phi pane in a native macOS window.
The Phi server owns the shell and PTY. This client does not start a local shell.

SwiftTerm 1.99.1 supplies the AppKit view and keyboard input.
The shared `PhiKit` / `PhiTerminal` core supplies transport, recovery, and the input journal.
Ghostty VT remains the sole terminal-query authority. Both engines process output in this experiment.
This does not establish standalone SwiftTerm protocol compatibility or production readiness.

## Requirements

- macOS 14 or newer, with a graphical session.
- Xcode with Swift 6.2 or newer. Local verification used Xcode 27.1 and Swift 6.4 on Apple Silicon.
- Network access for the pinned Swift packages on the first build.
- An existing Phi pane on a server without an access password.

The preview has no password prompt and requires `--no-keychain`.
Use a separate test server. Do not disable the password on a shared server.
Use HTTPS or a trusted private network. Plain HTTP does not encrypt terminal traffic.

## Build

From the repository root:

```sh
cd desktop/apple
swift build -c release --product PhiSwiftTermSpike --disable-automatic-resolution
```

The repository includes the pinned Ghostty VT xcframework. A normal build needs no Zig installation or Xcode project generation.
The xcframework contains macOS, iOS, and iOS-simulator slices. This preview does not include an iOS app.

## Open a pane

1. Get an existing pane ID from your Phi server's `GET /api/terminals` response.
2. Replace the server origin and pane ID in this example.
3. Run the commands from `desktop/apple`.

```sh
SERVER='http://your-phi-server:7070'
PANE='replace-with-pane-id'
STATE="$HOME/Library/Application Support/PhiSwiftTermPreview/test-server"
BIN="$(swift build -c release --show-bin-path --disable-automatic-resolution)"
umask 077
mkdir -p "$STATE"
"$BIN/PhiSwiftTermSpike" \
  --server "$SERVER" \
  --pane "$PANE" \
  --state-dir "$STATE" \
  --no-keychain
```

The server value must be an HTTP(S) origin without credentials, a query, or a path prefix.
The state directory must already exist, belong to your user, and have an absolute path.
Use a separate state directory for each server. Use only one client per pane/state directory.
Keep the directory between launches so the client can recover input that never reached the server.
Do not share it with an older binary: older journal writers do not honor the exclusive lease.

The status line reports connection state, queued input, and unconfirmed input.
Only definitely unsent input is eligible for automatic retry. Unconfirmed input is not silently resent.
Window resizing offers the new dimensions to the server. It can resize the pane for other attached clients.
Closing the window disconnects this client; it does not request pane deletion.

**CAUTION:** The state directory contains raw input, including terminal passwords.
Payload files are private but not encrypted. Do not commit or share this directory.

## Tests

From `desktop/apple`:

```sh
swift test --disable-automatic-resolution
```

The package suite needs Go with CGO for the independent adapter oracle.
Some live, capture, and password checks skip without their explicit fixture settings.
A passing default suite does not mean that those checks ran.

The eight `LiveTerminalSpikeTests` require a fresh isolated server and an owned workspace.
The fixture accepts loopback port 17071 or 17070 and checks the listener PID before requests.
Do not point these tests at an existing server or user pane.

```sh
PHI_SPIKE_LIVE=1 \
PHI_TEST_ORIGIN=http://127.0.0.1:17071 \
PHI_TEST_WORKSPACE=/absolute/path/to/isolated-workspace \
PHI_TEST_SERVER_PID=replace-with-owned-server-pid \
swift test --disable-automatic-resolution --filter LiveTerminalSpikeTests
```

The fixture creates and deletes its own panes. The native capture test needs an AppKit display.
The full physical-keyboard, IME, accessibility, and window-close matrix remains incomplete.
iOS integration, sustained-output performance, and extreme-geometry budgets remain unverified.
GPU-in-flight shutdown retry behavior has a simulated regression, not a hardware-backed acceptance result.
A stalled view remains retained after the five-second shutdown deadline until process exit.

## Debug snapshots

A Debug build accepts `SIGINFO` and writes a PNG and JSON under its explicit state directory.
Snapshots contain visible terminal text and must remain private. They are not atomic pixel/frontier receipts.
The request temporarily permits rendering for a hidden view; it also works while the console is locked.
Release builds omit this feature and its signal handler.

## Sources and notices

| Path | Purpose |
|---|---|
| `Sources/PhiSwiftTermSpike` | Native window, SwiftTerm adapter, and notices |
| `Sources/PhiKit` | Shared pane session and input ordering |
| `Sources/PhiTerminal` | Ghostty adapter, wire recovery, auth, and journal |
| `Sources/PhiWire` | Committed Swift protobuf output |
| `Sources/PhiProbe` | Existing headless evidence tool, not the preview UI |
| `Tests`, `TestSupport/oracle` | Package regressions and Go adapter oracle |
| `Scripts/build-ghostty-vt.sh` | Optional reproduction of the pinned xcframework |
| `Scripts/generate-protobuf.sh` | Optional protobuf maintenance command |

The two additive `internal/termemu` snapshot changes expose invisible, overline, and underline-color metadata for oracle parity.
They do not change the server's HTTP APIs or WebSocket protocol.

SwiftTerm and Ghostty MIT notices are in
[`Sources/PhiSwiftTermSpike/THIRD_PARTY_NOTICES.txt`](Sources/PhiSwiftTermSpike/THIRD_PARTY_NOTICES.txt).
The preview copies that notice into its SwiftPM resource bundle.
Keep that bundle beside the executable when you move the build products.
