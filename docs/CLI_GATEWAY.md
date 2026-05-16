# CLI Gateway JSON Contract

Relay exposes the adapter-facing gateway through an explicit major-version CLI surface:

```bash
relay-ide v1 --list --json
relay-ide v1 schema --json
relay-ide v1 nodes manifest --json
relay-ide v1 nodes list --json
relay-ide v1 sessions list --json
relay-ide v1 sessions get --id <session-id-or-global-id> --json
relay-ide v1 sessions create --input-json '{...}' --json
relay-ide v1 sessions attach --id <session-id-or-global-id> --json
relay-ide v1 sessions detach --id <session-id-or-global-id> --json
relay-ide v1 sessions stream --id <session-id-or-global-id> --mode ndjson --json
relay-ide v1 sessions input --id <session-id-or-global-id> --data 'echo ok\n' --wait-for ok --json
relay-ide v1 files list --session-id <session-id> --path <path> --json
relay-ide v1 files stat --session-id <session-id> --path <path> --json
relay-ide v1 files read --session-id <session-id> --path <path> --max-bytes 32768 --max-lines 2000 --json
```

This contract is for external brain-as-peer adapters (#430). It is intentionally separate from the internal `/hub/node-link` WebSocket protocol. Adapter packages must generate native tool/function definitions from `relay-ide v1 schema --json` or the committed source manifest in `shared/cli-gateway-contract.ts`; do not hand-code Hermes/Claude/Codex-specific schemas.

## Envelope

Every gateway command returns one JSON envelope on stdout. Human-readable CLI behavior outside `v1 ... --json` is unchanged.

Success:

```json
{
  "ok": true,
  "contract": "v1",
  "contractVersion": "1.0",
  "command": "sessions.list",
  "data": {}
}
```

Error:

```json
{
  "ok": false,
  "contract": "v1",
  "contractVersion": "1.0",
  "command": "files.read",
  "error": {
    "code": "NOT_FOUND",
    "message": "file was not found",
    "retryable": false,
    "details": { "upstreamCode": "NOT_FOUND", "reasonCode": "FILE_RPC_NOT_FOUND" }
  }
}
```

The current error taxonomy is declared in `RELAY_CLI_GATEWAY_CONTRACT.errorEnvelopeSchema`. It includes auth/connectivity errors, typed create/validation errors, file RPC errors (`NOT_FOUND`, `FORBIDDEN`, `NODE_OFFLINE`, `CONFIRMATION_REQUIRED`), and control hand-back state errors (`CONTROL_STATE_STALE`, `INTERVENTION_ACK_REQUIRED`, `INTERVENTION_ACK_STALE`, `CONTROL_STATE_UNKNOWN`).

## Discovery and schemas

`relay-ide v1 --list --json` returns command specs and the common error-envelope schema.

`relay-ide v1 schema --json` returns the complete contract manifest:

- `contract` / `contractVersion`
- node-link and security-policy versions used by this build
- command CLI argv shapes
- per-command input and output schemas
- capability hints for hub policy checks
- possible typed error codes

The schema is the source of truth for adapter generation. A command missing from this manifest is not stable adapter API, even if an internal REST/WebSocket route exists.

## Auth and hub access

Local discovery commands (`contract.*`, `nodes.manifest`) do not require a hub token.

Hub-backed commands (`nodes.list`, `sessions.*`, `files.*`) use the same local server token path as existing CLI session commands:

- `RELAY_IDE_BROWSER_TOKEN` supplies the bearer token.
- `--port` or `RELAY_IDE_PORT` selects the local hub port; otherwise Relay uses the default port.
- Gateway requests send capability hints via `x-relay-capabilities` so hub policy can fail closed.
- Gateway requests send `x-relay-cli-gateway: v1` so the hub can apply the adapter contract boundary.

Missing tokens and rejected hub responses are converted to the gateway error envelope. The CLI still exits nonzero for error envelopes.

## Session descriptors

`nodes list`, `sessions list`, `sessions get`, `sessions create`, `sessions attach`, and `sessions detach` return existing backend descriptors, wrapped in gateway envelopes. Session descriptors are expected to include the already-available identity and control fields where present:

- `id`, `globalSessionId`, `nodeId`
- `type`, `agent`, `mode`, `cwd`
- optional `repoPath` / `worktreePath` as context, not identity
- `sessionEnvelope` with #426 intent/scope/lifecycle/peer identity
- #470/#493 control summary fields such as `controlMode`, `activeActors`, `activeWorker`, `lastInterventionAt`, `lastInterventionBy`, `lastInterventionEventId`, `controlFreshness`, and `controlReason`

External brain/agent peer identity is reserved for hub-owned credential/session registry work. v1 currently documents the envelope field but only round-trips `local-user`, `relay-node`, and `unknown` peer identities; routed creates are represented as `relay-node` peers. Adapters must not add impersonation flags such as `--act-as-node` or `--brain`.

## Session create, attach, and detach

`sessions create` accepts either `--input-json`, `--input-file`, or typed flags. `nodeId` selects routed node creation through `/hub/nodes/:nodeId/sessions`; omitting it uses the current local `/sessions` path.

Supported now:

- local repo/worktree-backed session creation using `repoPath` and optional `worktreePath`
- routed node creation with `nodeId`, `cwd`, `type` (defaulting to `agent` when omitted), `mode`, `agent`, lifecycle fields, and optional non-agent `sessionEnvelope` where the existing backend supports them
- `controlMode=agent-driven` only for routed node creation, where hub/node policy and hand-back state can be checked
- descriptor-only attach with `sessions attach --id ... --json`
- safe detach with `sessions detach --id ... --json`; this resolves the session and releases only the CLI gateway handle, leaving the underlying Relay session/process running

`sessions attach` is intentionally descriptor-only in v1. It does not start a Claude/Codex/Hermes adapter runtime and it does not stream PTY data.

`sessions detach` intentionally does not call the session kill route. If the session is already gone, the command returns the normal typed `NOT_FOUND` envelope from `sessions.get`.

Fail-closed examples:

- local create without `repoPath` returns `INVALID_ARGUMENT`
- unknown `sessions create` input fields return `INVALID_ARGUMENT` before any backend forwarding
- local create with explicit `cwd` returns `UNSUPPORTED` because the local endpoint derives `cwd` from `repoPath`/`worktreePath`
- local scoped/lifecycle/peer fields (`sessionEnvelope`, `ttlSeconds`, `expiresAt`, `confirmationToken`) return `UNSUPPORTED` until implemented locally
- `sessionEnvelope.peerIdentity.kind: "agent"` returns `UNSUPPORTED` until hub-owned agent peer identity is implemented
- local `controlMode=agent-driven` returns `UNSUPPORTED` until local create has the same policy gate as routed creation
- malformed JSON returns `INVALID_JSON`
- unknown flags/commands return `INVALID_ARGUMENT`

The gateway must never silently downgrade unsupported scoped, privileged, or control-mode requests.

## Session stream and input

`relay-ide v1 sessions stream --id <id> --mode ndjson --json` opens the same authenticated PTY attach path as the browser tab and emits newline-delimited gateway envelopes. Each output chunk is a `sessions.stream` success envelope with `data.event: "data"`, UTF-8 `data.data`, `bytes`, and a monotonic `sequence`. When the CLI detaches or the PTY closes, it emits one final `data.event: "closed"` envelope with `closeCode`, `reason`, `frames`, `bytesReceived`, and `truncated`.

Useful smoke form:

```bash
relay-ide v1 sessions stream --id remote-session-1 --max-events 1 --json
```

Caps are contract-level and conservative:

- `--mode ndjson` is the only stable stream mode in v1.
- `--max-events N` detaches after N data frames.
- `--max-bytes N` detaches after at most N UTF-8 bytes; the last frame may be truncated and the final envelope reports `truncated: true`.
- `--idle-timeout-ms N` detaches after N ms without output.
- If stdout backpressure is observed, the CLI closes the stream instead of dropping frames; the final envelope reports `backpressureClosed: true`.

`relay-ide v1 sessions input --id <id> --data <text> --json` sends one UTF-8 chunk to the PTY attach path and then detaches the CLI handle. `--data-base64` is available for arbitrary bytes encoded as base64, and `--stdin` reads the chunk from standard input. For smoke tests and adapter handshakes, `--wait-for <text>` keeps the temporary attach open until the observed output contains the marker, then returns a single `sessions.input` envelope with `matched`, `output`, `bytesSent`, and `bytesReceived`.

Example:

```bash
relay-ide v1 sessions input --id remote-session-1 --data 'printf relay-ok\\n\n' --wait-for relay-ok --json
```

`stream` and `input` detach only their CLI/WebSocket handle. They do not kill the underlying Relay session or tmux process. Missing sessions, expired envelopes, rejected policy, offline nodes, and closed attach sockets surface as typed gateway error envelopes; adapter authors must not fall back to private `/hub/node-link` messages.

## Read-only file RPC commands

The `files.*` commands route through the existing scoped #505 File RPC surface:

```bash
relay-ide v1 files list --session-id remote-session-1 --path . --max-entries 100 --json
relay-ide v1 files stat --session-id remote-session-1 --path package.json --json
relay-ide v1 files read --session-id remote-session-1 --path package.json --max-bytes 32768 --max-lines 200 --json
```

The CLI first resolves the session through `sessions get` unless `--node-id` is supplied. It then calls:

```text
POST /hub/nodes/:nodeId/sessions/:sessionId/files/:operation
```

Only these operations are stable in v1:

- `files.list` maps to `fs.list` and requires `session:read` + `rpc:fs:list`.
- `files.stat` maps to `fs.stat` and requires `session:read` + `rpc:fs:read`.
- `files.read` maps to `fs.read` and requires `session:read` + `rpc:fs:read`.

Caps are enforced by the existing File RPC layer and reflected in the contract:

- list: default 100 entries, max 500 entries
- read: default 32 KiB, max 64 KiB
- read line cap: optional, max 2000 lines

List example:

```json
{
  "ok": true,
  "contract": "v1",
  "contractVersion": "1.0",
  "command": "files.list",
  "data": {
    "operation": "list",
    "root": "/repo",
    "cwd": "/repo",
    "path": "/repo",
    "entries": [
      {
        "path": "/repo/package.json",
        "name": "package.json",
        "type": "file",
        "size": 4133,
        "mtimeMs": 1760000000000,
        "mode": 33188
      }
    ],
    "truncated": false,
    "maxEntries": 100
  }
}
```

Read example:

```json
{
  "ok": true,
  "contract": "v1",
  "contractVersion": "1.0",
  "command": "files.read",
  "data": {
    "operation": "read",
    "root": "/repo",
    "cwd": "/repo",
    "path": "/repo/package.json",
    "encoding": "utf8",
    "content": "{\n  \"name\": \"relay-ide\"\n}\n",
    "bytesRead": 28,
    "truncatedBytes": false,
    "truncatedLines": false,
    "maxBytes": 32768,
    "maxLines": 200
  }
}
```

File commands remain read-only. They must surface unavailable node, missing path, denied capability, stale/expired session envelope, and confirmation-required states as typed error envelopes. They must not fall back to local filesystem reads when the scoped file RPC route rejects a request.

## Intervention and hand-back boundaries

`sessions interventions` is a bounded metadata read. The v1 contract explicitly marks raw payload and transcript export unavailable. Do not expose human intervention keylogs or full terminal transcripts through this gateway.

`sessions hand-back` requires the latest intervention event id observed by the caller before restoring agent-driven control. Stale, unknown, disconnected, or unacknowledged intervention state returns typed errors instead of resuming blindly.

## Deferred work

Event subscription beyond PTY output, multi-session fan-out, File RPC write/delete/tail, destructive operations, and adapter packages are follow-up work. If a future adapter needs a missing primitive, extend this CLI contract first; do not bypass it with `/hub/node-link` or browser WebSocket protocol clients.
