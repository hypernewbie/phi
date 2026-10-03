# Codex CLI backend

Verified against the official `@openai/codex` npm package, Codex CLI 0.160.0,
and the sources listed below.

## Install and sign in

Install Codex on the computer that runs the Phi server:

```sh
npm install -g @openai/codex
codex --version
codex login
```

For a remote computer without a local browser, use `codex login --device-auth`.
Check authentication with `codex login status`. Phi does not collect Codex
credentials or run the login flow for you.

## Launch and resume

Phi starts `codex --no-alt-screen` in the selected project directory. This
keeps terminal scrollback. A saved conversation uses:

```sh
codex --no-alt-screen resume SESSION_UUID
```

Phi leaves Codex's sandbox, approval policy, model, and reasoning defaults
unchanged. It does not add bypass-approval flags or run `codex exec` instead
of the interactive CLI. Custom executable paths and environment overrides
use the existing `~/.phi/backends/codex.json` profile mechanism.

## Models and reasoning

The **Models** button and `/model` preset open Codex's native picker. Choose
a model, then its reasoning effort. Use `/status` to check the result.

In CLI 0.160.0, `/model` does **not** accept an inline model name. Phi does
not paste `/model MODEL`, guess picker positions, or send a timed selection
sequence. The native picker handles account availability and future catalog
changes.

The current official recommendations and bundled catalog include
`gpt-6.1-sol`, `gpt-6-astra`, and `gpt-6-luna`. Availability depends on the
account and workspace. Phi ships no hard-coded Codex model list. To select
a model at launch, use Codex's normal configuration or launch arguments:

```sh
codex --model gpt-6.1-sol
codex -c 'model_reasoning_effort="high"'
```

## Session history

Phi reads Codex's native `state_5.sqlite` thread index in read-only mode.
It respects `CODEX_HOME` and `CODEX_SQLITE_HOME`, including profile-local
environment overrides. It does not create, migrate, or modify Codex databases.
Archived conversations and child-agent records are not sidebar sessions.
Codex itself resumes both legacy rollouts and paginated thread history.
Phi does not advertise a transcript viewer for a format it cannot fully read.

## Sources

- [Official CLI installation](https://github.com/openai/codex/tree/rust-v0.160.0)
- [CLI reference](https://developers.openai.com/codex/cli/reference/)
- [CLI commands](https://developers.openai.com/codex/cli/slash-commands/)
- [Current models and reasoning](https://learn.chatgpt.com/docs/models)
- [Authentication](https://developers.openai.com/codex/auth/)
- [Inline-command argument support](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/tui/src/slash_command.rs)
- [Native database filenames](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/state/src/sqlite.rs)
- [Native thread-index schema](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/state/migrations/0001_threads.sql)
