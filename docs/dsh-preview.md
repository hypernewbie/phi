# DeepSeek Harness online preview

Phi can carry the official DeepSeek Harness (DSH) Web UI in an application tab. Phi does not replace the DSH chat UI or create a terminal for this tab. The preview is off by default.

## Security limitation

**The framed DSH UI shares the browser's full Phi authority. It is not isolated from Phi.** DSH JavaScript can use authenticated Phi APIs to create terminals, run commands through those terminals, and read files. A compromised DSH package or an XSS vulnerability in DSH can therefore compromise the user's Phi session.

The DSH child also runs as the same OS user as Phi. Its separate home, working directory, and temporary directory are not an OS sandbox. DSH's own approval and permission defaults are unchanged. Those approvals do not restrict browser JavaScript that calls Phi APIs.

This risk was accepted for the bounded online preview on 2026-10-31 and deferred for later work. Revisit origin isolation before real deployment. A same-origin iframe sandbox does not provide the required separation. A separate origin needs compatible upstream DSH authentication and transport support; the reviewed DSH version does not provide that contract.

Only enable the preview with a trusted, reviewed DSH installation. Never treat Phi's access password as protection from the framed application itself.

## Startup configuration

The reviewed upstream version is `@deepseek-ai/dsh@0.2.1-rc.5`. Phi does not install or update it. These startup-only fields belong in Phi's configuration file:

```toml
dsh_preview_enabled = true
dsh_preview_command = "/absolute/path/to/dsh-wrapper"
dsh_preview_origin = "http://127.0.0.1:YOUR_PHI_PORT"
```

Use the exact browser-facing HTTP or HTTPS origin, including a non-default port. The carrier rejects other hosts and cross-origin requests. The command must be an absolute executable path. If a wrapper is needed, it must forward all arguments to DSH and use `exec` so Phi owns the child process:

```sh
#!/bin/sh
exec /absolute/path/to/node /absolute/path/to/dsh/lib/bin.js "$@"
```

Phi supplies `--profile web --host 127.0.0.1 --port 0 --no-open --trusted-host <authority>`. Do not add `--public-url`. The launch token stays in memory and is exchanged privately for a mount-scoped, HttpOnly cookie. Phi authentication is required independently on every carrier request.

The child receives a fixed executable search path, synthetic home and temporary paths, locale settings, and a telemetry opt-out. It does not inherit Phi's provider keys, proxies, or other environment variables. Durable DSH state is under `<phi-data-dir>/dsh-preview/`. Disabling or stopping the preview does not delete that state.

Restart Phi after changing these settings. Open the sessions launcher and select the **DeepSeek** orca icon beside the other agents. Its accessible name and tooltip identify it as an online preview. The opened tab also shows the preview notice. The preview is unavailable in the desktop shell.

## Networking and tab lifecycle

The outer tab opens immediately from local state. Phi caches the last status summary, but does not persist a mount URL or reopen an old mount while offline. Background status checks have a five-second bound. A failed refresh preserves an existing frame and any in-memory DSH work.

Switching tabs and soft-close/Undo keep the same frame. Final close unloads it without deleting a terminal. If the harness generation changes, Phi keeps the old frame and offers an explicit reload. Reload asks for confirmation because DSH drafts or unconfirmed work can be lost. Phi never retries or replays DSH sends.

## Not full integration acceptance

The verified first slice opens the official UI, creates a session, sends a synthetic message to a local mock provider, and displays its reply. It does not establish real-provider operation or spending approval.

The following remain unaccepted:

- Automatic entry into Phi's active workspace.
- Cached DSH workspace and session catalogs after an offline reload.
- A durable DSH send queue with explicit delivery state and no silent replay.
- An Electron low-memory carrier.

The unchanged upstream UI does not supply the required offline catalog and durable outbox contracts. Do not describe this online preview as satisfying those requirements. The separate, user-present Tailnet review also remains pending.

## Icon license

The orca icon is the unmodified `dist/favicon-dark.svg` from `@deepseek-ai/dsh-web-frontend@0.2.1-rc.5`. It is distributed under the [MIT license](../web/vendor/logos/deepseek.LICENSE).
