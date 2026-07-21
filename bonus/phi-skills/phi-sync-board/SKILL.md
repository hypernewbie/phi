---
name: phi-sync-board
description: Read, write, and delete key/value messages on a Phi Sync Board coordinator, used to pass state/messages between machines or agents on the same tailnet/LAN. Use when the user asks to "sync", "post to the board", "check the coordinator", "read/write a sync key", or mentions the Phi server / sync board. If PHI_COORDINATOR is unset, ask the user for the address and offer to set it up before running any commands.
allowed-tools: Bash, Read
---

# Phi Sync Board

Stateless key/value REST API exposed by a Phi server, used as a shared
coordination board between machines/agents on the same tailnet or LAN.
Every write is an upsert (no need to check existence first).

## Setup: the PHI_COORDINATOR env var

All commands below use `$PHI_COORDINATOR`. If it isn't set when this skill
fires, **stop and ask the user before running any command**. The right
opening is roughly:

> I don't see a Phi coordinator address in your environment. Do you have a
> phi server running somewhere? If yes — what's its address? If no — start
> one with `phi` on the machine you want to use, and I'll grab the URL
> from the welcome banner or `~/.phi/config.json` for you.

Then once you have the address, offer to set it for this session and
persist it. Three options, in order of helpfulness:

1. **Set it for this session** (simplest, gone after the shell exits):

       export PHI_COORDINATOR="http://<address>:<port>"

2. **Read it from an existing phi install on this machine** — if a phi has
   been run here before, the address is already saved. Run this and use
   the result as $PHI_COORDINATOR:

       jq -r '.sync_coordinator // empty' ~/.phi/config.json

3. **Persist it across sessions** by adding the export line to the user's
   shell rc (`~/.bashrc`, `~/.zshrc`, or PowerShell `$PROFILE`).

If the user gives you an address, echo it back so they can confirm before
you set anything: "Setting PHI_COORDINATOR=http://192.168.1.42:7070 — OK?"

## Sanity check

Once the var is set, hit the list endpoint before the first real command
to confirm reachability. If it fails with "connection refused" the address
is wrong (or phi isn't running). If it fails with "could not resolve
host" the address is malformed.

    curl -sS "$PHI_COORDINATOR/api/sync/messages" && echo

A `[]` response (and exit 0) means you're good.

## API

| Action | Command |
|---|---|
| List all keys | `curl -s "$PHI_COORDINATOR/api/sync/messages"` |
| Get one key | `curl -s "$PHI_COORDINATOR/api/sync/messages/<key>"` |
| Create/update key | `curl -s -X POST "$PHI_COORDINATOR/api/sync/messages" -H "Content-Type: application/json" -d '{"key":"<key>","value":"<value>"}'` |
| Delete key | `curl -s -X DELETE "$PHI_COORDINATOR/api/sync/messages/<key>"` |

## Response shape

Each entry is a JSON object:

```json
{"key":"some_key","value":"some_value","created_at":"2026-07-07T05:41:33.721438439Z","updated_at":"2026-07-07T05:41:33.721438439Z"}
```

- `GET /api/sync/messages` → JSON array of entries (`[]` when empty).
- `GET /api/sync/messages/<key>` → single entry object.
- `POST /api/sync/messages` → upsert, returns the resulting entry.
- `DELETE /api/sync/messages/<key>` → 200 on success, whether or not the key existed.

`value` is stored as a plain string — if you need structured data, JSON-encode
it into the string yourself (e.g. `-d '{"key":"foo","value":"{\"status\":\"done\"}"}'`)
and decode with `jq -r '.value' | jq .` on read.

## Notes

- The coordinator address is whatever your phi server binds to. On a default
  install phi binds to loopback + LAN (RFC 1918) + Tailscale CGNAT
  (100.64/10); pick whichever address is reachable from the machine running
  `claude` (often a Tailscale IP for cross-machine sync).
- All writes are upserts: POST with an existing key overwrites its value and
  bumps `updated_at`.
- `DELETE` on a nonexistent key is not an error.
- No auth on this API — treat the board as trusted-network-only, don't put
  secrets in it.

## Finding the address (full reference)

If the user asks "where do I find my coordinator address?" or you need it
yourself, two stable sources:

1. **Welcome banner** when phi starts — looks like
   `Coordinator:  http://100.70.164.85:7070`. The example uses a Tailscale
   IP; yours will differ.
2. **`~/.phi/config.json`** — the `sync_coordinator` field, read with:

       jq -r '.sync_coordinator // empty' ~/.phi/config.json

If phi is running on the same machine as `claude`, `http://127.0.0.1:<port>`
(default port 7070) usually works without further setup.
