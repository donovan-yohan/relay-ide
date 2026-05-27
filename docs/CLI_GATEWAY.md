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
relay-ide v1 files write --session-id <session-id> --path <path> --mode <create|overwrite|append> --file <local-path|-> --json
relay-ide v1 supervisor sessions --json
relay-ide v1 supervisor snapshot --id <session-id-or-global-id> --json
relay-ide v1 supervisor send-text --id <session-id-or-global-id> --text <literal-text> --json
relay-ide v1 supervisor send-text --target-ids <session-id-1,session-id-2> --text <literal-text> --json
relay-ide v1 supervisor submit --id <session-id-or-global-id> --json
relay-ide v1 supervisor submit --target-ids <session-id-1,session-id-2> --json
relay-ide v1 events subscribe --topic <sessions|nodes|audit> --json
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

The current error taxonomy is declared in `RELAY_CLI_GATEWAY_CONTRACT.errorEnvelopeSchema`. It includes auth/connectivity errors, typed create/validation errors, file RPC errors (`NOT_FOUND`, `FORBIDDEN`, `NODE_OFFLINE`, `CONFIRMATION_REQUIRED`), control hand-back state errors (`CONTROL_STATE_STALE`, `INTERVENTION_ACK_REQUIRED`, `INTERVENTION_ACK_STALE`, `CONTROL_STATE_UNKNOWN`), and typed supervisor action errors. Multi-target supervisor action denials can also appear inside a successful action envelope as per-target `results[].error` entries; see [Supervisor typed actions and rmux mapping](#supervisor-typed-actions-and-rmux-mapping-704).

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

## Command taxonomy

Relay command metadata is defined in [`shared/relay-command-manifest.ts`](../shared/relay-command-manifest.ts) as a projection of this v1 gateway contract. That module adds product-facing fields on top of each stable gateway command: `id`/`name`, label, description/summary, supported surfaces, input/output schemas, capability hints, side-effect class, confirmation requirement, scope kinds, and the public handler projection.

Current command surfaces are intentionally separate:

| Surface | Meaning | Execution path |
| --- | --- | --- |
| UI-only Command Center actions | Browser affordances such as navigation, settings, local palette helpers, and workflow entry points that are not stable agent API. | Frontend action registry only; do not generate agent tools from these. |
| Stable CLI gateway commands | Versioned `relay-ide v1 ... --json` commands in `RELAY_CLI_GATEWAY_CONTRACT`. | Public CLI JSON gateway; this is the adapter-facing contract. |
| Agent-callable commands | Gateway commands safe to expose to Claude/Codex/Hermes/MCP/ACP-style adapters through generated schemas. | Generated from the shared command manifest and executed through `relay-ide v1 ... --json`, never private node-link/browser routes. |

The Command Center may search and describe stable gateway commands using the shared manifest before browser execution is wired. The manifest carries the stable command id, CLI projection, side-effect class, capability hints, confirmation/control requirements, scope kinds, and audit redaction expectations. Until a `handler.uiAction` or explicit UI execution bridge exists, these entries must stay disabled/degraded in the palette and point operators to the stable CLI argv. Do not mark every internal UI button as agent-callable, and do not add Claude/Codex/Hermes-specific schemas by hand; add or change the Relay-owned command definition first.

## Auth and hub access

Local discovery commands (`contract.*`, `nodes.manifest`) do not require a hub token.

Hub-backed commands (`nodes.list`, `sessions.*`, `files.*`, `handoffs.*`, `artifacts.*`, `supervisor.*`, and `events.*`) use the same local server token path as existing CLI session commands:

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
- routed node creation with the typed `environment` object (see [Typed environment IDs](#typed-environment-ids-626) below)
- `controlMode=agent-driven` only for routed node creation, where hub/node policy and hand-back state can be checked
- descriptor-only attach with `sessions attach --id ... --json`
- safe detach with `sessions detach --id ... --json`; this resolves the session and releases only the CLI gateway handle, leaving the underlying Relay session/process running

### Typed environment IDs (#626)

`sessions.create` accepts a typed `environment` object (epic #615) so agent tasks reference where work runs by **typed IDs**, not free-form host/path strings. The shape mirrors `EnvironmentOption` in `shared/environment-option.ts` and uses scoped IDs from `shared/identity.ts` plus the canonical `RepoIdentity` from `shared/repo-identity.ts`.

```json
{
  "environment": {
    "nodeId": "node-a",
    "repoIdentity": "github.com/donovan-yohan/relay-ide",
    "repoInstanceId": "node-a:%2FUsers%2Fme%2Fcode%2Frelay-ide",
    "benchId": "node-a:%2FUsers%2Fme%2Fcode%2Frelay-ide%2F.worktrees%2F626",
    "cwd": "/Users/me/code/relay-ide/.worktrees/626"
  },
  "type": "agent",
  "mode": "pty",
  "agent": "claude"
}
```

Fields:

- `nodeId` (required) — target Relay node id; sourced from `EnvironmentOption.node.nodeId`.
- `cwd` (required) — absolute cwd on the target node where the session starts.
- `repoIdentity` (optional, nullable) — canonical normalized repo identity (e.g. `github.com/owner/name`), produced by `shared/repo-identity.ts`. Never a free-form `{ host, path }` pair. May be `null` when the environment was built from a `RepoInstance` whose remotes did not produce a canonical identity (see `EnvironmentRepoInstanceSummary.repoIdentity` in `shared/environment-option.ts`), so adapters can round-trip the field without losing the "no identity resolved" signal; omit the field entirely otherwise.
- `repoInstanceId` (optional) — scoped `RepoInstanceId` from `createRepoInstanceId(nodeId, localPath)`.
- `benchId` (optional) — scoped `WorktreeInstanceId` from `createWorktreeInstanceId(nodeId, localPath)`. Requires `repoIdentity` or `repoInstanceId` (a Bench is anchored to a RepoInstance per `docs/WORKBENCH_BOUNDARY.md`).

Fail-closed examples specific to the typed shape:

- raw `{ host, path }` on `environment` returns `INVALID_ARGUMENT` with `details.field` under `environment.*` (free-form host/path is exactly what #626 forbids)
- missing `environment.nodeId` or `environment.cwd` returns `INVALID_ARGUMENT`
- `environment.benchId` without `repoIdentity` or `repoInstanceId` returns `INVALID_ARGUMENT`
- mixing `environment` with any legacy flat `nodeId` / `repoPath` / `worktreePath` / `cwd` returns `INVALID_ARGUMENT` — pick one shape per request
- local `/sessions` gateway creation rejects `environment` (typed `environment` always implies routed creation)

A schema fixture of the typed shape is committed at [`docs/cli-schema/sessions.create.environment.json`](cli-schema/sessions.create.environment.json) for adapter generators that consume the schema out-of-band.

#### Deprecation policy

Legacy flat fields `nodeId`, `repoPath`, `worktreePath`, and `cwd` on `sessions.create` remain accepted in **v1.x** so adapters shipped before #626 do not break. They are documented as deprecated and will be **removed in v2**. Adapters built today should emit the typed `environment` object. Mixing legacy flat fields with `environment` in the same call is rejected with `INVALID_ARGUMENT` to avoid ambiguous routing.

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

`relay-ide v1 sessions input --id <id> --data <text> --json` sends one UTF-8 chunk to the PTY attach path and then detaches the CLI handle. `--data-base64` is available for arbitrary bytes encoded as base64, and `--stdin` reads the chunk from standard input. Exactly one of `--data`, `--data-base64`, or `--stdin` is required; mixed or missing input sources fail with `INVALID_ARGUMENT` before Relay opens the temporary attach socket. For smoke tests and adapter handshakes, `--wait-for <text>` keeps the temporary attach open until the observed output contains the marker, then returns a single `sessions.input` envelope with `matched`, `output`, `bytesSent`, and `bytesReceived`.

Example:

```bash
relay-ide v1 sessions input --id remote-session-1 --data 'printf relay-ok\\n\n' --wait-for relay-ok --json
```

`stream` and `input` detach only their CLI/WebSocket handle. They do not kill the underlying Relay session or tmux process. Missing sessions, expired envelopes, rejected policy, offline nodes, and closed attach sockets surface as typed gateway error envelopes; adapter authors must not fall back to private `/hub/node-link` messages.

## Provider-native state commands

Provider-native session state adapters are intentionally internal in this slice. `shared/cli-gateway-contract.ts` does not expose stable v1 `providers.*` or `native-sessions.*` commands yet. External adapters must continue to treat missing provider-state verbs as unsupported rather than calling private REST routes or reading provider stores themselves.

When promoted to v1, the surface must preserve the same boundary as `AgentHarnessStateAdapter`: detection/list/import/read-state are read-only, snapshots are redacted and bounded, and open/resume returns copyable argv data without executing the provider CLI.

## Supervisor typed actions and rmux mapping (#704)

The stable supervisor surface is Relay-owned command API, not raw PTY, tmux, or rmux API. The implementation source of truth is `shared/cli-gateway-contract.ts`, with shared response types in `shared/supervisor-actions.ts` and server execution in `server/supervisor-actions.ts`.

Commands:

| Command | Purpose | Required capabilities |
| --- | --- | --- |
| `relay-ide v1 supervisor sessions --json` | Lists sessions and per-action eligibility. | `session:read`, `tab:intervention:read` |
| `relay-ide v1 supervisor snapshot --id <session-id-or-global-id> --json` | Reads one redacted supervisor snapshot. | `session:read`, `tab:intervention:read` |
| `relay-ide v1 supervisor send-text --id <session-id-or-global-id> --text <literal-text> --json` | Sends bounded literal text as a typed intervention. | `session:attach`, `tab:intervention:send-text` |
| `relay-ide v1 supervisor send-text --target-ids <id-1,id-2> --text <literal-text> --json` | Sends the same bounded literal text to multiple sessions and reports per-target results. | `session:attach`, `tab:intervention:send-text` |
| `relay-ide v1 supervisor submit --id <session-id-or-global-id> --json` | Sends Enter (`\n`) as a typed intervention. | `session:attach`, `tab:intervention:submit` |
| `relay-ide v1 supervisor submit --target-ids <id-1,id-2> --json` | Sends Enter to multiple sessions and reports per-target results. | `session:attach`, `tab:intervention:submit` |

Inputs:

- `supervisor.sessions` takes no input and returns `{ command: "supervisor.sessions", sessions, count }`. Each session includes `sessionId`, optional `globalSessionId`/`nodeId`, `mode`, `status`, optional `controlMode`/`controlFreshness`, and `actions.sendText` / `actions.submit` eligibility. Ineligible actions carry a `reasonCode` such as `SESSION_DISCONNECTED`, `SESSION_MODE_UNSUPPORTED`, `CONTROL_STATE_STALE`, or `CONTROL_STATE_UNKNOWN`.
- `supervisor.snapshot` requires `id`. Optional `--expected-control-mode <agent-driven|human-driven|co-driven>` and `--latest-seen-intervention-event-id <event-id>` are preflight guards. Stale or mismatched control state returns `CONTROL_STATE_STALE`; an unacknowledged newer intervention returns `INTERVENTION_ACK_REQUIRED`. The snapshot path is read-only: it never writes to the session, accepts prompts, or stores raw prompt/transcript/PTY/provider state.
- `supervisor.sendText` requires `text` plus exactly one target shape: `id` or `targetIds`. CLI flags are `--id`, positional `<id>`, or comma-separated `--target-ids`; `--input-json` / `--input-file` may provide the same object shape, including optional `actor` metadata. Text must be non-empty literal text, at most 1000 characters, with no CR/LF, ESC, DEL, or control characters except tab. Use `supervisor.submit` for Enter instead of embedding a newline.
- `supervisor.submit` requires `id` or `targetIds`, accepts optional `actor` metadata via JSON input, and writes exactly `\n`. It does not accept a text payload.

Successful action envelope shape:

```json
{
  "ok": true,
  "contract": "v1",
  "contractVersion": "1.0",
  "command": "supervisor.sendText",
  "data": {
    "command": "supervisor.sendText",
    "action": "sendText",
    "results": [
      {
        "sessionId": "sess-1",
        "globalSessionId": "local:sess-1",
        "nodeId": "local",
        "ok": true,
        "action": "sendText",
        "bytesWritten": 5,
        "interventionEventId": "evt-sess-1",
        "controlModeBefore": "agent-driven",
        "controlModeAfter": "co-driven"
      }
    ],
    "counts": { "requested": 1, "succeeded": 1, "denied": 0, "failed": 0, "skipped": 0 },
    "audit": {
      "action": "sendText",
      "targetSessionIds": ["sess-1"],
      "targetCount": 1,
      "timestamp": "2026-05-16T00:00:00.000Z",
      "content": {
        "rawContentAvailable": false,
        "hashSha256": "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
        "byteCount": 5,
        "charCount": 5,
        "lineCount": 1,
        "classes": ["literal-text"],
        "redacted": true
      },
      "rawContentStored": false,
      "partialFailure": false
    },
    "redaction": { "rawContentAvailable": false, "rawContentStored": false, "hashesOnly": true }
  }
}
```

Action failure semantics:

- CLI parse/auth/connectivity failures return a normal `ok: false` gateway envelope and the CLI exits nonzero. Examples: malformed `--input-json`, missing `RELAY_IDE_BROWSER_TOKEN`, unreachable hub, missing `--id`/`--target-ids`, or missing `--text` for `send-text`.
- Once the action request reaches the hub, target-level problems are reported in the successful action envelope under `data.results[].error` with aggregate `data.counts` and `data.audit.partialFailure`. This preserves multi-target partial success instead of failing the whole command on the first bad target.
- Per-target errors use typed `code`, `reasonCode`, `message`, `retryable`, and optional `details`. Current reason codes include `CAPABILITY_REQUIRED`, `SESSION_NOT_FOUND`, `SESSION_DISCONNECTED`, `CONTROL_STATE_STALE`, `CONTROL_STATE_UNKNOWN`, `SESSION_MODE_UNSUPPORTED`, `TEXT_REQUIRED`, `TEXT_TOO_LARGE`, `TEXT_MUST_BE_LITERAL`, and `UPSTREAM_WRITE_FAILED`.
- `counts.denied` is for capability denials (`FORBIDDEN`). Other per-target errors increment `counts.failed`. `counts.skipped` is reserved for future fan-out decisions.
- Audit stores actor summary, target session IDs/count, action type, timestamp, hashes/counts/classes for content, and the aggregate partial-failure flag. Raw supervisor text is not returned or stored by default.

This is deliberately distinct from raw PTY input and terminal substrates:

- `sessions input` remains the raw PTY input path for narrow smoke/debug use. It writes bytes through the temporary attach path, can wait for output markers, and is useful for adapter handshake tests, but it is not the blessed typed agent-to-agent command API.
- Existing browser/human PTY input remains a different event/API path from supervisor automation interventions.
- rmux/tmux panes may become backing substrates for Relay sessions, but adapters must not call rmux actions, rmux broadcast, tmux send-keys, or shell commands as stable Relay API. Add or extend a Relay-owned `relay-ide v1 supervisor ... --json` command first, then map that typed command to the substrate behind Relay capability, control-state, and hashes-only audit checks.

## Read-only file RPC commands

The `files.*` commands route through the existing scoped #505 File RPC surface:

```bash
relay-ide v1 files list --session-id remote-session-1 --path . --max-entries 100 --json
relay-ide v1 files stat --session-id remote-session-1 --path package.json --json
relay-ide v1 files read --session-id remote-session-1 --path package.json --max-bytes 32768 --max-lines 200 --json
relay-ide v1 files write --session-id remote-session-1 --path src/foo.ts --mode create --file ./src/foo.ts --json
relay-ide v1 files write --session-id remote-session-1 --path src/bar.ts --mode overwrite --file - --json  # read from stdin
```

The CLI first resolves the session through `sessions get` unless `--node-id` is supplied. It then calls:

```text
POST /hub/nodes/:nodeId/sessions/:sessionId/files/:operation
```

Only these operations are stable in v1:

- `files.list` maps to `fs.list` and requires `session:read` + `rpc:fs:list`.
- `files.stat` maps to `fs.stat` and requires `session:read` + `rpc:fs:read`.
- `files.read` maps to `fs.read` and requires `session:read` + `rpc:fs:read`.
- `files.write` maps to `fs.write` and requires `session:read` + `rpc:fs:write`. Capability is off by default; operators must grant `rpc:fs:write` per node. Uses atomic-rename on the node executor. Prod-tier nodes gate writes behind a confirmation challenge.

Caps are enforced by the existing File RPC layer and reflected in the contract:

- list: default 100 entries, max 500 entries
- read: default 32 KiB, max 64 KiB
- read line cap: optional, max 2000 lines
- write: max 1 MiB base64-decoded; enforced at CLI before HTTP

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

## First generated adapter smokes

The first #430 proof intentionally stops at one generated Claude-style tool/function bundle in `shared/cli-gateway-claude-tools.ts`. It reads `shared/cli-gateway-contract.ts` / `relay-ide v1 schema --json` shape and emits Anthropic-compatible tool definitions (`name`, `description`, `input_schema`) for only the hello-world path: `nodes.list`, `sessions.create`, `files.read`, and `sessions.detach`.

The Hermes-facing smoke in `shared/cli-gateway-hermes-tools.ts` uses the same contract manifest to emit Hermes tool descriptors (`name`, `description`, `parameters`), MCP descriptors (`name`, `description`, `inputSchema`), and OpenAI-style function descriptors (`type: "function"`, `function.parameters`). Its smoke path adds the now-stable PTY exchange commands: `nodes.list`, `sessions.create`, `files.read`, `sessions.stream`, `sessions.input`, and `sessions.detach`.

The Codex-facing smoke in `shared/cli-gateway-codex-tools.ts` derives the same command subset from the v1 manifest and emits Codex/OpenAI-compatible function descriptors in both common shapes: Chat Completions-style nested tools (`type: "function"`, `function.parameters`) and Responses-style flat function tools (`type: "function"`, `name`, `parameters`). Its fake hub/node example runs only public `relay-ide v1 ... --json` commands: `nodes.list`, scoped `sessions.create`, read-only `files.read`, bounded `sessions.stream`, `sessions.input`, and descriptor-only `sessions.detach`.

These smoke runners are deliberately thin: generated definitions select stable v1 CLI commands, Relay's existing CLI gateway does the hub/node/File RPC/PTY work, and `sessions.detach` remains descriptor-only so it does not kill the underlying session. Production Claude/Codex/Hermes packages, Codex runtime packaging, event subscriptions beyond PTY output, multi-session orchestration, File RPC write/delete/tail, arbitrary exec, stdin-backed adapter streaming, and private node-link shortcuts remain deferred.

## Events subscription

`relay-ide v1 events subscribe --topic <topic> --json` opens a long-lived authenticated NDJSON stream from the hub and emits one gateway envelope per event frame on stdout. Per ADR-017 and #596, this is intentionally narrow: read-only, capability-gated, no writes, no execs, no raw byte streams, no log tailing (that lives under #476).

Topics:

- `sessions` — session lifecycle (`session.started`, `session.ended`) and `tab.mode-changed` envelopes scoped to the current hub.
- `nodes` — `node.online`, `node.offline`, `node.revoked` envelopes from the hub node registry (#586/`hub-node-registry`).
- `audit` — redacted summaries of `tab.mode-changed` and `tab.intervention` envelopes (hash-chained at storage time per #470/#499). Raw intervention payloads, raw keylogs, and full terminal transcripts are never streamed through this gateway.

Each frame is a `events.subscribe` success envelope whose `data` carries:

```json
{
  "event": "open" | "event" | "closed",
  "topic": "sessions" | "nodes" | "audit",
  "sequence": 0,
  "occurredAt": "2026-05-19T00:00:00.000Z",
  "payload": { "type": "session.started", "sessionId": "..." }
}
```

The first envelope is always `event: "open"`. The final envelope is always `event: "closed"` with a `frames` count and a `reason`. Caps stay conservative:

- `--max-events N` detaches after N event frames (excluding `open`/`closed`).
- `--idle-timeout-ms N` detaches after N ms without an event frame.
- If stdout backpressure is observed, the CLI aborts the upstream stream and emits `closed` with `reason: "stdout backpressure"`.

Capability gating fails closed: `sessions` and `nodes` require `session:read`; `audit` additionally requires `tab:intervention:read`. Unknown topics surface as `INVALID_ARGUMENT` with `details.field: "topic"` before the CLI opens any hub request. Missing or denied capabilities surface as `FORBIDDEN` envelopes. The hub side enforces the same gate; the CLI side enforces the same allowlist. This is the only `events.*` verb in v1 — no `events.publish`, no `events.replay`, no event-bus write surface.

Smoke form:

```bash
relay-ide v1 events subscribe --topic sessions --max-events 1 --json
```

## Deferred work

Event subscription beyond `events.subscribe` (multi-topic fan-out, cursor/resume, replay), multi-session fan-out, File RPC write/delete/tail, destructive operations, and adapter packages are follow-up work. If a future adapter needs a missing primitive, extend this CLI contract first; do not bypass it with `/hub/node-link` or browser WebSocket protocol clients.
