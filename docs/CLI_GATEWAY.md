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
  "command": "sessions.create",
  "error": {
    "code": "UNSUPPORTED",
    "message": "local /sessions creation derives cwd from repoPath/worktreePath; explicit cwd requires routed node creation",
    "retryable": false,
    "details": { "field": "cwd" }
  }
}
```

The current error taxonomy is declared in `RELAY_CLI_GATEWAY_CONTRACT.errorEnvelopeSchema`. It includes auth/connectivity errors, typed create/validation errors, and control hand-back state errors (`CONTROL_STATE_STALE`, `INTERVENTION_ACK_REQUIRED`, `INTERVENTION_ACK_STALE`, `CONTROL_STATE_UNKNOWN`).

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

Hub-backed commands (`nodes.list`, `sessions.*`) use the same local server token path as existing CLI session commands:

- `RELAY_IDE_BROWSER_TOKEN` supplies the bearer token.
- `--port` or `RELAY_IDE_PORT` selects the local hub port; otherwise Relay uses the default port.
- Gateway requests send capability hints via `x-relay-capabilities` so hub policy can fail closed.

Missing tokens and rejected hub responses are converted to the gateway error envelope. The CLI still exits nonzero for error envelopes.

## Session descriptors

`nodes list`, `sessions list`, `sessions get`, and `sessions create` return the existing backend descriptors, wrapped in gateway envelopes. Session descriptors are expected to include the already-available identity and control fields where present:

- `id`, `globalSessionId`, `nodeId`
- `type`, `agent`, `mode`, `cwd`
- optional `repoPath` / `worktreePath` as context, not identity
- `sessionEnvelope` with #426 intent/scope/lifecycle/peer identity
- #470/#493 control summary fields such as `controlMode`, `activeActors`, `activeWorker`, `lastInterventionAt`, `lastInterventionBy`, `lastInterventionEventId`, `controlFreshness`, and `controlReason`

External brain/agent peer identity is reserved for hub-owned credential/session registry work. v1 currently documents the envelope field but only round-trips `local-user`, `relay-node`, and `unknown` peer identities; routed creates are represented as `relay-node` peers. Adapters must not add impersonation flags such as `--act-as-node` or `--brain`.

## Session create support and fail-closed behavior

`sessions create` accepts either `--input-json`, `--input-file`, or typed flags. `nodeId` selects routed node creation through `/hub/nodes/:nodeId/sessions`; omitting it uses the current local `/sessions` path.

Supported now:

- local repo/worktree-backed session creation using `repoPath` and optional `worktreePath`
- routed node creation with `nodeId`, `cwd`, `type` (defaulting to `agent` when omitted), `mode`, `agent`, lifecycle fields, and optional non-agent `sessionEnvelope` where the existing backend supports them
- `controlMode=agent-driven` only for routed node creation, where hub/node policy and hand-back state can be checked

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

## Intervention and hand-back boundaries

`sessions interventions` is a bounded metadata read. The v1 contract explicitly marks raw payload and transcript export unavailable. Do not expose human intervention keylogs or full terminal transcripts through this gateway.

`sessions hand-back` requires the latest intervention event id observed by the caller before restoring agent-driven control. Stale, unknown, disconnected, or unacknowledged intervention state returns typed errors instead of resuming blindly.

## Deferred work

Event subscription, attach/input/detach streaming, File RPC expansion, destructive operations, and adapter packages are follow-up work. If a future adapter needs a missing primitive, extend this CLI contract first; do not bypass it with `/hub/node-link` or browser WebSocket protocol clients.
