# Phi Quota Snapshot v1

The quota overlay (`#phi-quota-btn` → `web-src/quota.ts`) renders a **generic**
JSON snapshot. Phi does not know or care which providers you use: your
aggregator script declares labels, amounts, direction, and reset times, and
Phi pretty-prints them.

You never need to read anyone else's aggregator. Implement this document,
point the overlay at your URL (saved in `localStorage` under
`phi_quota_url`), and it renders.

Machine-readable version: `docs/quota-schema.json`.
Runnable template (stdlib only): `examples/quota-aggregator.example.py`.

## Endpoint

- `GET` your URL → `200` with `Content-Type: application/json`.
- Browsers enforce CORS: send `Access-Control-Allow-Origin: *` (or your Phi
  origin) when the aggregator is cross-origin.
- v1 defines no auth. Run the aggregator on loopback or your tailnet and
  treat the URL as bearer-equivalent.

## Snapshot

```json
{
  "version": 1,
  "updated_at": "2026-09-13T07:13:07Z",
  "sections": [
    {
      "id": "opencode-go-nomad",
      "title": "opencode · nomad",
      "rows": [
        {
          "label": "Weekly",
          "remaining_percent": 72,
          "resets_at": "2026-09-14T00:00:00Z"
        },
        {
          "label": "Session",
          "used": 0.24,
          "total": 12.0,
          "unit": "USD",
          "resets_at": 1789293600
        },
        { "label": "Notice", "text": "rate limited until reset" }
      ]
    }
  ]
}
```

- `version`: must be `1`.
- `updated_at`: optional ISO-8601 string, display only.
- `sections`: array of any length. `title` is shown verbatim; `id` should be
  unique and is only used as a fallback title (snake/kebab parts title-cased,
  so `opencode_go_nomad` renders as `Opencode Go Nomad` even with no `title`).
- Unknown top-level or section fields are ignored.

## Rows

Every row needs a string `label`, plus exactly one value shape. If several
are present the precedence is
`remaining_percent` → `used_percent` → `used`+`total` → `text`.

| Shape | Meaning |
|---|---|
| `{ label, remaining_percent: 0–100, resets_at?, note? }` | Percent left. The bar shows it directly. |
| `{ label, used_percent: 0–100, resets_at?, note? }` | Percent consumed. The bar shows `100 − used`. Direction is explicit in the field name — the client never guesses. |
| `{ label, used: n, total: m, unit?, resets_at?, note? }` | Absolute amounts in `unit`. The bar shows the remaining fraction `(1 − used/total)`. Currency-like units (`USD`, `$`, `EUR`, `€`, `GBP`, `£`, `CNY`, `¥`, `JPY`) render as `$n`; anything else renders as `"<n> <unit>"`. |
| `{ label, text, note? }` | Verbatim line, no bar. Escape hatch for anything numeric shapes can't say. |

Optional on any row:

- `resets_at`: ISO-8601 string, epoch **seconds**, or epoch **millis**.
  Rendered as `resets <local date>`; missing or unparseable means no reset
  fragment is shown.
- `note`: free text appended after the amounts.
- `low_below`: `0–100` threshold that turns the bar red; default `10`.

## Client guarantees

- Unknown fields are ignored. Bad rows (no label, no usable value) are
  skipped and the rest of the section still renders.
- An empty snapshot renders `No usable quota sections in the response.`;
  a non-object response renders `Empty response from the quota source.`
- Nothing a snapshot contains can throw or inject markup: percents are
  clamped to `0–100`, all strings are HTML-escaped.
- No provider names exist in the client. A new backend is a new section —
  zero Phi changes.

## Legacy (deprecated)

Pre-v1 aggregators returned a provider-keyed dict (`quota`, `deepseek`,
`glm`, `openrouter`, `codex`, `agy`, `opencode_go`). Phi still renders those
through a deprecated per-provider shim so old URLs keep working, but new
aggregators MUST emit v1. The shim will be removed in a later release.
