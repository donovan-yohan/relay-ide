# Structured logs schema + `logs.tail` RPC envelope

Backend foundations from issue #597. CLI surface (`relay-ide hub logs --follow`, etc.) is
downstream in epic #476 and depends on this schema.

## JSON Lines log file

- **File:** `<logDir>/relay-ide.jsonl`
- **Companion plaintext:** `<logDir>/relay-ide.log` (back-compat; both streams are written in
  lock step by `server/logger.ts`)
- **Rotation:** 5MB cap per file; rotates to `.jsonl.old` (mirrors the plaintext stream).
- **Encoding:** UTF-8, one JSON object per line, `\n` line terminator, no trailing newline
  inside individual records.

Each line conforms to `StructuredLogEvent` from `shared/log-event.ts`:

| Field           | Type                          | Required | Notes                                                                  |
| --------------- | ----------------------------- | -------- | ---------------------------------------------------------------------- |
| `schemaVersion` | `1`                           | yes      | Bump on incompatible changes. Parser drops records with other values.  |
| `ts`            | `string` (ISO-8601 UTC)       | yes      | Wall-clock timestamp at write time.                                    |
| `level`         | `'trace' \| 'debug' \| 'info' \| 'warn' \| 'error'` | yes | Severity. `trace` is file-only (no console). |
| `subsystem`     | `string`                      | yes      | Stable tag (e.g. `node-link`, `pty-host`, `policy`).                   |
| `msg`           | `string`                      | yes      | Human-readable message. Already redacted before serialization.         |
| `ctx`           | `Record<string, unknown>`     | no       | Free-form structured context. Subsystem-defined keys.                  |

### Producer rules

- Producers MUST NOT serialize raw secrets into `msg` or `ctx`. The reader pipeline applies
  `redactText` / `redactJson` from `server/diagnostics-bundle.ts` before crossing the wire,
  but secrets at rest are still secrets — keep them out of the file.
- Loggers created via `createLogger(namespace)` use `namespace` as the `subsystem` tag.
- Malformed lines (corrupt tail-end writes, schema-version drift) are skipped by the reader
  and surfaced via `malformedCount` in the snapshot for diagnostics.

## `logs.tail` node-link RPC

Direction: hub → node, over `/hub/node-link`. The hub-side router gates on capability
`logs:read` (see `requiredCapabilitiesForRpcIntent('logs.tail')`).

### Request payload

```jsonc
{
  "lines": 100,              // optional, 0..2000, default 100
  "follow": false,           // optional, defaults to false
  "level": "warn",           // optional, minimum severity to include
  "subsystem": "policy",     // optional, exact match
  "sinceTs": "2026-05-19T12:00:00.000Z" // optional, ISO-8601; events with ts > sinceTs only
}
```

All filter fields are optional. Unknown fields are ignored. Malformed values return a typed
`INVALID_REQUEST` envelope.

### Response (single-shot)

`logs.tail.result` payload mirrors `NodeLogTailSnapshot`:

```jsonc
{
  "status": "ok" | "empty",
  "role": "node",
  "logDir": "<absolute path>",
  "files": ["<jsonl file>"],
  "output": "",              // populated only on legacy plaintext snapshots
  "message": "",
  "redacted": true,
  "events": [/* StructuredLogEvent */],
  "malformedCount": 0
}
```

- `events` is populated when the structured JSONL file is the source. `output` stays empty.
- `events` is omitted in legacy plaintext mode.

### Follow mode

When `follow: true`, the envelope MUST carry a `streamId`. The node responds with the
initial snapshot, then streams `logs.tail.chunk` envelopes as new lines append. The hub
sends `logs.tail.cancel` (same `streamId`) to stop.

### Errors

- `INVALID_REQUEST` — payload validation failed (line count out of range, bad level/sinceTs,
  follow without `streamId`).
- `NOT_FOUND` — no log file on disk yet.
- `UNAUTHORIZED` / `NODE_REVOKED` — capability gate rejected the request.

## Capability gate (#427 backbone)

- Bit: `logs:read` (added to `RELAY_CAPABILITY_BITS`).
- Default ACL: included in `LEGACY_DEFAULT_ALLOWED_CAPABILITIES` so existing operator
  workflows (`relay-ide hub logs`) keep working without a manual edit.
- Trust tier overlay (`prod`): `logs:read` is not in `HIGH_RISK_CAPABILITIES`, so it stays
  in the silent-allow set on prod nodes.
- Action mapping: `requiredCapabilitiesForRpcIntent('logs.tail')` returns `['logs:read']`.

## Redaction (mandatory)

Every event leaving the node passes through `redactText` (`msg`) and `redactJson` (`ctx`)
from `server/diagnostics-bundle.ts`. The same pipeline that powers diagnostic bundles is
reused so there is one place to maintain redaction rules:

- private key blocks, `Authorization:` headers, `Bearer …`
- GitHub tokens (`ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_`, `github_pat_`)
- URL credentials, cookie headers, secret-shaped assignments (`token=`, `pin=`, `password=`)

The snapshot's `redacted: true` flag indicates at least one rule fired during this read.
