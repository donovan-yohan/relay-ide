# Spike: relay-ide CLI gateway JSON schema + versioning + agent plugin contract

> **Status:** Spike — design only, no runtime code
> **Scope:** Define the agent-facing CLI verb surface, JSON envelope, versioning policy, schema-generation pipeline, auth/scope rules, and streaming semantics that unblock the CLI gateway epic
> **Date:** 2026-05-12
> **Issue:** [#423](https://github.com/donovan-yohan/relay-ide/issues/423)
> **Unblocks:** [#429](https://github.com/donovan-yohan/relay-ide/issues/429) (CLI gateway epic), [#430](https://github.com/donovan-yohan/relay-ide/issues/430) (agent adapters)
> **Honors:** [ADR-015](../adrs/ADR-015-core-primitives-domain-agnostic.md) (domain-agnostic core), [ADR-016](../adrs/ADR-016-node-to-node-isolation.md) (no node-to-node addressing)

---

## tl;dr

**Recommendation: ship a versioned `relay-ide v1 <noun> <verb>` surface with a single JSON Schema source of truth.**

The CLI gateway becomes the **integration plane**: any agent that can shell out can drive the fleet without speaking `relay-node-link` envelopes. The shape locked in here is the contract that survives multiple core protocol revisions.

- **MVP verbs**: `v1 nodes list|manifest`, `v1 sessions list|create|attach|input|detach`, `v1 exec`, `v1 --list`. Eight verbs. Everything else is extension.
- **Envelope**: every `--json` invocation prints exactly one JSON object on stdout (`{ ok, data?, error? }`), except streaming verbs which print newline-delimited JSON (NDJSON) framed as `{ ok, event, data? }`. Errors reuse `RelayNodeError` from `shared/relay-node-protocol.ts`.
- **Versioning**: explicit `v1` prefix is canonical; bare `relay-ide nodes list` resolves to the latest stable major. New majors ship in parallel; previous major stays callable for one full major-version window before removal.
- **Schema source of truth**: Zod schemas in `shared/cli-schema/`, derived to JSON Schema (committed under `shared/cli-schema/generated/`) and consumed by TypeScript types, agent tool definitions (#430), and `--help` text. **No hand-written agent tool schemas anywhere.**
- **Repo verbs are out of the core MVP.** Per ADR-015, `repos list`, `worktree`, `dispatch` and other repo/IDE-flavored verbs ship as a feature-layer extension namespace once #425 separates them. The core CLI gateway must not bleed repo semantics.

---

## 1. Scope and non-goals

### In scope

- Verb taxonomy for the MVP CLI gateway (#429), with extension verbs flagged for future slices.
- Output envelope for `--json` consumers, with errors reusing the existing `RelayNodeError` taxonomy.
- Versioning policy and discovery mechanism (`v1 --list`).
- A single schema source of truth that produces TypeScript types, Claude tool-use definitions, Codex function schemas, and human `--help`.
- Auth/scope and how each verb interacts with the session intent model (#426) and the confirmation gate (#427).
- Streaming semantics for `sessions attach` and `fs tail`.
- Sample agent flows showing CLI → hub envelope mapping.
- Concrete follow-up implementation tickets for #429.

### Non-goals

- **Agent-specific adapters** themselves — those are #430. This spike defines the contract they consume.
- **Implementation of the verbs.** No runtime code. Verb names, flag shapes, and JSON shapes only.
- **Repo / workspace / dispatch verbs.** Per ADR-015 the core CLI surface stays domain-agnostic. These come as a feature-layer extension namespace later.
- **Multi-hub federation** verbs. Out of scope per #429.
- **GUI** for the CLI. Hub UI is the GUI.
- **Promoting existing `bin/relay-ide.ts` subcommands** (`hub`, `node`, `worktree`, `browser`, `pin`, `manifest`, `dev`, `update`, `install`, `uninstall`, `status`) into the versioned namespace. Those stay as operator-facing commands at the top level. The agent-facing surface lives strictly under `relay-ide v1 …`.

---

## 2. Verb taxonomy

The CLI gateway is a noun-then-verb surface, prefixed with the API major version. The split is:

| Layer                          | Namespace                 | Examples                                                               | Stability                                                             |
| ------------------------------ | ------------------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Operator commands (existing)   | bare `relay-ide …`        | `hub install`, `node connect`, `manifest`, `pin reset`, `worktree add` | Human-facing, not in this contract                                    |
| **Agent gateway (this spike)** | `relay-ide v1 …`          | `v1 nodes list`, `v1 sessions create`                                  | **JSON-Schema-versioned**                                             |
| Feature-layer extensions       | `relay-ide v1 ext.<ns> …` | `v1 ext.repos list`, `v1 ext.dispatch`                                 | Versioned alongside core, but lives outside `shared/cli-schema/core/` |

The reason for the `ext.<ns>` form: ADR-015 requires that repo/git/workspace verbs do not appear on the core surface. Placing them under `ext.repos` makes the boundary visible in tooling output (`v1 --list` returns `{ core: [...], extensions: { repos: [...] } }`) and lets the schema generator emit separate tool-definition bundles per agent so a strictly-core agent stays uncontaminated.

### 2.1 MVP verbs (in #429 acceptance)

All MVP verbs accept `--json` (machine output). Without `--json` they print a short human summary.

| #   | Verb                 | Args / flags                                                                                         | Output                                                                                                                                  | Tier gated?                                                                 |
| --- | -------------------- | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| 1   | `v1 nodes list`      | `[--hub <url>] [--status online\|stale\|offline\|revoked] [--json]`                                  | Array of `HubNodeSummary` (already defined in `shared/relay-node-protocol.ts`).                                                         | No                                                                          |
| 2   | `v1 nodes manifest`  | `--id <nodeId> [--hub <url>] [--json]`                                                               | One `NodeCapabilityManifestSummary` plus the node's `relayVersion`, `protocolVersion`, `wsl`, `serviceManager`.                         | No                                                                          |
| 3   | `v1 sessions list`   | `[--node <nodeId>] [--intent <intent>] [--status open\|closed] [--hub <url>] [--json]`               | Array of session descriptors `{id, nodeId, intent, scope, createdAt, expiresAt, status}`.                                               | No                                                                          |
| 4   | `v1 sessions create` | `--node <nodeId> --intent <intent> --scope <json-or-@file> [--ttl <seconds>] [--hub <url>] [--json]` | One session descriptor. Returns a `confirmationRequired: true, confirmationUrl: …` shape when #427 gates trip.                          | **Yes** (when intent is destructive on tier ≥ `dev`)                        |
| 5   | `v1 sessions attach` | `--id <sessionId> [--mode ndjson\|raw] [--hub <url>]`                                                | Streaming. See §7.                                                                                                                      | Inherited from `sessions create`                                            |
| 6   | `v1 sessions input`  | `--id <sessionId> --data <string-or-@file> [--hub <url>] [--json]`                                   | `{ok: true, bytesWritten: <n>}` or error.                                                                                               | Inherited                                                                   |
| 7   | `v1 sessions detach` | `--id <sessionId> [--revoke] [--hub <url>] [--json]`                                                 | `{ok: true, revoked: <bool>}` or error.                                                                                                 | No                                                                          |
| 8   | `v1 exec`            | `--node <nodeId> --cmd <argv-json> [--cwd <path>] [--timeout <s>] [--hub <url>] [--json]`            | Final shape: `{ ok, exitCode, stdout, stderr, durationMs }`. For long output prefer `sessions create --intent arbitrary-exec` + attach. | **Yes** (always; arbitrary exec is always destructive-ish in #427's policy) |
| 9   | `v1 --list`          | `[--json]`                                                                                           | Verb catalog. See §4.                                                                                                                   | No                                                                          |

**Why these 9 and not more in MVP.**

- They are the minimum set #429 needs to claim "any agent can drive the fleet": discover hosts, look at one host, open a session, talk to it, close it, plus one-shot exec for non-interactive cases.
- Every verb maps to a single hub envelope round trip or a single registry read — no new server work in the CLI layer.
- They exercise all four envelope shapes: synchronous JSON (`nodes list`), gated JSON (`sessions create`), streaming (`sessions attach`), one-way input (`sessions input`).

### 2.2 Extension verbs (post-MVP, still in #429 scope)

These ship after the MVP slice, reusing the same envelope and version policy. They are listed here so the schema generator can stub them.

| Verb          | Args / flags                                                                                                | Notes                                         |
| ------------- | ----------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| `v1 fs read`  | `--node <id> --path <path> [--offset <n>] [--length <n>] [--encoding utf-8\|base64] [--json]`               | Reuses #428 file RPC.                         |
| `v1 fs list`  | `--node <id> --path <dir> [--limit <n>] [--cursor <c>] [--json]`                                            | Paginated.                                    |
| `v1 fs stat`  | `--node <id> --path <path> [--json]`                                                                        |                                               |
| `v1 fs write` | `--node <id> --path <path> --mode create\|overwrite\|append [--data <string-or-@file> \| --stdin] [--json]` | **Tier gated**.                               |
| `v1 fs tail`  | `--node <id> --path <path> [--from-offset <n>] [--mode ndjson\|raw]`                                        | Streaming, same framing as `sessions attach`. |

### 2.3 Feature-layer extension verbs (not part of core MVP)

These are scoped here so the contract has a place for them, but they live behind the `ext.` prefix and ship after the #425 core/feature split.

| Verb                     | Why it is ext, not core                                                                                                                                                                                                                                            |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `v1 ext.repos list`      | Repo enumeration is a feature-layer concern per ADR-015. The core CLI must not include `repos list`.                                                                                                                                                               |
| `v1 ext.repos worktrees` | Worktree management is repo/IDE-flavored.                                                                                                                                                                                                                          |
| `v1 ext.dispatch`        | "Run this task on whichever node is best" is a feature-layer aggregator. ADR-016 requires that the hub authorizes each per-node leg independently with hub-level credentials; `ext.dispatch` is shorthand for hub-mediated fan-out, never node-to-node addressing. |
| `v1 ext.workspaces …`    | Pending #103.                                                                                                                                                                                                                                                      |

**Explicit non-inclusion in MVP.** The core CLI does not include `repos list`, `repos diff`, `workspaces …`, or `dispatch` until the feature layer is extracted (#425). The spike makes this binding so a future PR can't quietly add a repo verb to `shared/cli-schema/core/`.

### 2.4 Tier-gating summary

A verb is **tier gated** if executing it on a node whose `trustLevel` ≥ `dev` (per #427) requires the two-token confirmation gate. The gate is implemented in the hub, not the CLI; the CLI's job is to surface the confirmation challenge on stdout and re-issue the command with the supplied token.

Tier-gated verbs:

- `v1 sessions create` when `intent ∈ {arbitrary-exec, file-write, interactive-shell on tier prod}`.
- `v1 exec` always.
- `v1 fs write` always.
- `v1 ext.dispatch` always (delegates intent through to each underlying session creation, but the surface itself is treated as destructive).

Non-gated:

- All `nodes` verbs (read-only metadata).
- `sessions list/detach`, `sessions attach`/`input` (gate happens at create-time on the session).
- `fs read/list/stat/tail`.
- `v1 --list`.

---

## 3. Output envelope

### 3.1 Non-streaming verbs

Every non-streaming `--json` invocation prints **exactly one** JSON object on stdout, then exits.

```jsonc
// Success
{
  "ok": true,
  "apiVersion": "v1",
  "verb": "nodes.list",
  "requestId": "cli_01HZQ…",       // ULID. Echoed in hub audit log.
  "data": [ /* verb-specific */ ]
}

// Error — reuses RelayNodeError taxonomy verbatim.
{
  "ok": false,
  "apiVersion": "v1",
  "verb": "sessions.create",
  "requestId": "cli_01HZQ…",
  "error": {
    "code": "UNAUTHORIZED",        // RelayNodeErrorCode union
    "message": "Hub rejected credential.",
    "retryable": false,
    "details": { "reason": "credentialExpired" }
  }
}

// Tier-gated, waiting on confirmation (special success shape)
{
  "ok": true,
  "apiVersion": "v1",
  "verb": "sessions.create",
  "requestId": "cli_01HZQ…",
  "data": {
    "status": "confirmation-required",
    "challengeId": "cnf_01HZQ…",
    "channel": "hub-ui",            // per #427 spike
    "expiresAt": "2026-05-12T18:23:00Z"
  }
}
```

Rationale:

- `ok` boolean instead of mirroring HTTP status. Easier for shell consumers (`jq '.ok'`).
- `apiVersion` echoed so agents can verify they parsed what they think they parsed even if a bare `relay-ide` was rebound to a different major.
- `requestId` is generated client-side (ULID), forwarded as the envelope `requestId`, and emitted in the #427 audit log. Lets agents correlate a tool call with the hub audit row.
- Error codes are the existing `RelayNodeErrorCode` union from `shared/relay-node-protocol.ts`. Extending that union (e.g. `CONFIRMATION_REQUIRED`, `SESSION_REVOKED`, `SCOPE_DENIED`) is in scope for #429 implementation, not this spike.

### 3.2 Streaming verbs

`sessions attach` and `fs tail` stream NDJSON by default and raw bytes when `--mode raw`.

**`--mode ndjson` (default)** — newline-delimited JSON, one event per line:

```jsonc
{"ok":true,"event":"stream-open","streamId":"strm_01HZQ…","sessionId":"sess_…"}
{"ok":true,"event":"data","streamId":"strm_01HZQ…","chunk":"hello\r\n","encoding":"utf-8"}
{"ok":true,"event":"data","streamId":"strm_01HZQ…","chunk":"AAEC…","encoding":"base64"}
{"ok":true,"event":"resize","streamId":"strm_01HZQ…","cols":120,"rows":40}
{"ok":true,"event":"stream-close","streamId":"strm_01HZQ…","reason":"detached"}
{"ok":false,"event":"error","streamId":"strm_01HZQ…","error":{"code":"NODE_OFFLINE","message":"…","retryable":true}}
```

Rules:

- `chunk` is utf-8 when the data is valid utf-8, base64 otherwise. The `encoding` discriminator is required. Choosing per-chunk (not per-stream) lets us avoid an upfront probe.
- `error` events do not terminate the stream automatically. `stream-close` always terminates.
- The stream is guaranteed to start with exactly one `stream-open` event and end with exactly one `stream-close` event. Anything between is data/resize/error.

**`--mode raw`** — after a single-line `stream-open` JSON event on stdout, the rest of stdout is raw PTY bytes. Used by terminal pass-through use cases (`relay-ide v1 sessions attach --id X --mode raw | cat -v`). `--mode raw` cannot be combined with `--json` (mutually exclusive). Errors during raw mode are written to stderr as one final NDJSON line, then the process exits non-zero.

**Why both modes.** NDJSON is mandatory for agent adapters (Claude/Codex tool runners parse JSON streams). Raw is mandatory for human dogfooding and for plumbing relay into existing terminal tools. Both modes reuse the same hub envelope path; the CLI converts at the boundary.

### 3.3 Stdin

`sessions input --data <str>` is one-shot. For interactive use (`relay-ide v1 sessions attach`) stdin is consumed and forwarded as a continuous input stream while the attach is open. `--mode raw` reads stdin raw; `--mode ndjson` reads stdin as line-delimited JSON envelopes `{event: "data", chunk, encoding}`.

### 3.4 Exit codes

| Code | Meaning                                                                  |
| ---- | ------------------------------------------------------------------------ |
| 0    | Success. For streaming verbs: stream closed cleanly.                     |
| 1    | Generic CLI error (bad flags, schema validation failed before dispatch). |
| 2    | Hub error (envelope returned `error`, mapped from `RelayNodeError`).     |
| 3    | Stream closed due to remote error (NODE_OFFLINE, etc.).                  |
| 4    | Confirmation required and not supplied / expired.                        |
| 64   | Usage error (consistent with sysexits.h `EX_USAGE`).                     |

---

## 4. Versioning policy

### 4.1 Canonical vs implicit

- **Canonical form**: `relay-ide v1 nodes list …`. Agents and CI **must** use this.
- **Implicit form**: `relay-ide nodes list …` resolves to "the latest stable major". This is convenience-only and documented as such. Adapter generators (#430) never emit implicit-form commands.

### 4.2 Major versions

A new major (`v2`) ships when one of these changes:

- A verb's flag shape changes incompatibly (rename, type change, required flag added).
- An envelope field that consumers parse on becomes incompatible.
- An error code's semantics change.

The previous major remains callable for **one full major-version window** (i.e. `v1` is still callable during the entire `v2` lifetime, but is removed when `v3` ships). Implementation: each major is a separate command dispatcher that imports its own schema; deleting an old major is deleting one folder under `shared/cli-schema/v1/`.

### 4.3 Minor changes

Additive changes do not bump the major:

- Adding a new verb.
- Adding an optional flag.
- Adding a new optional envelope field.
- Adding a new error code (consumers parse the union with `default: throw`).

### 4.4 Discovery

`relay-ide v1 --list [--json]` is the discovery verb. Output shape:

```jsonc
{
  "ok": true,
  "apiVersion": "v1",
  "verb": "list",
  "data": {
    "binaryVersion": "3.19.0",
    "supportedApis": ["v1"],
    "core": [
      {
        "name": "nodes.list",
        "summary": "List paired nodes on this hub.",
        "flags": [
          /* normalized from JSON Schema */
        ],
        "streaming": false,
        "tierGated": false,
      },
      // …
    ],
    "extensions": {
      "repos": [
        /* … if loaded … */
      ],
    },
    "schemaUrl": "file:///…/shared/cli-schema/generated/v1.json",
  },
}
```

Adapters (#430) call `v1 --list --json` at install time, derive native tool definitions, and cache them. They re-run on `relay-ide` upgrade.

### 4.5 Deprecation horizon

When a verb is slated for removal in `vN+1`:

1. The verb keeps working in `vN`.
2. `v1 --list` adds `"deprecated": true, "removedIn": "v2", "replacement": "..."` on the verb entry.
3. The CLI prints a deprecation notice to **stderr** (never stdout — would corrupt JSON output) on first invocation per shell session.
4. `vN` continues to support the verb until `vN+2` ships.

This is the same "one full major-version window" rule applied at the verb granularity.

---

## 5. Schema generation

### 5.1 Source of truth: Zod

**Decision: Zod schemas in `shared/cli-schema/v1/`, with derived JSON Schema committed under `shared/cli-schema/generated/v1.json`.**

```
shared/cli-schema/
  index.ts                   # registry: { v1: V1Schema }
  v1/
    index.ts                 # exports the V1Schema bundle
    core/
      nodes.ts               # zod schemas for nodes.list, nodes.manifest
      sessions.ts            # sessions.list/create/attach/input/detach
      exec.ts
    envelope.ts              # shared success/error/streaming-event envelopes
    errors.ts                # re-export RelayNodeErrorCode + extends with CONFIRMATION_REQUIRED, SCOPE_DENIED, SESSION_REVOKED
    extensions/
      repos.ts               # post-#425; not loaded into core schema bundle
  generated/
    v1.json                  # JSON Schema 2020-12, committed
    v1.d.ts                  # TypeScript types, committed
    v1.help.md               # human-readable help text, committed
```

**Why Zod and not OpenAPI as source of truth:**

- The CLI is not an HTTP surface. OpenAPI's HTTP-method/path framing doesn't fit; we'd be co-opting half its primitives.
- Zod is already a transitive dep in the React frontend's TanStack Query layer (zod + zod-to-json-schema). No new top-level dependency in the runtime path of the CLI.
- Zod-to-JSON-Schema is well-tested and the output is mechanical.
- Runtime validation of CLI input is **free** when Zod is the source. The CLI parses flags, hands the parsed bag to the verb's Zod schema, and rejects on parse error before any hub envelope is sent.

**Why we commit the generated JSON Schema:**

- Agents and adapters consume the JSON file directly without running TypeScript. Adapter generators don't need to install the relay-ide source tree.
- Schema drift becomes a PR-visible diff. A reviewer sees the JSON Schema change in the same PR as the Zod change.
- The CI gate is: `npm run cli-schema:check` regenerates and `git diff --exit-code` — if the committed schema doesn't match the regenerated one, CI fails.

### 5.2 Four derivations from one source

| Consumer                           | How it derives from Zod                                                                                                                        |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| TypeScript types in CLI runtime    | `z.infer<typeof NodesListInput>` directly.                                                                                                     |
| `--help` text                      | `shared/cli-schema/v1/help.ts` walks the registry and emits markdown (commit under `generated/v1.help.md`).                                    |
| Claude tool-use definitions (#430) | `zodToJsonSchema` → Claude's `input_schema` shape. One tool per verb. Tool name is `relay_${verb.replace(".","_")}` (e.g. `relay_nodes_list`). |
| Codex function schemas (#430)      | Same JSON Schema, wrapped in Codex's `functions[]` envelope.                                                                                   |

### 5.3 The contract this enforces

- Adding a verb means: write one Zod schema file under `shared/cli-schema/v1/core/`, register it in `v1/index.ts`, run `npm run cli-schema:generate`, commit the regenerated `generated/v1.json`. Adapter tool definitions follow automatically.
- Removing a verb requires a deprecation cycle (§4.5).
- A reviewer who sees `shared/cli-schema/v1/core/*.ts` changed without `generated/v1.json` changed in the same PR knows the generator wasn't run.

---

## 6. Auth and scope

### 6.1 Where credentials come from

In priority order (highest wins):

1. `--hub <url>` + `--token <token>` flags. Used for ad-hoc invocations.
2. `RELAY_IDE_HUB` env var + `RELAY_IDE_HUB_TOKEN` env var.
3. `~/.config/relay-ide/cli-credential.json` (operator credential, distinct from `node-credential.json` which is node-side only). File mode `0600`.
4. Local-mode fallback: if no hub credential is found and a local hub server is running on `127.0.0.1:<port>` with a discoverable PIN session, the CLI reuses that session. This is the existing browser-tab pattern in `bin/relay-ide.ts` (uses `RELAY_IDE_BROWSER_TOKEN`).

The operator-credential file is created by `relay-ide hub login` (new operator command, scoped to #429 implementation, not this spike). The credential is **not** a node credential — per ADR-016, the CLI gateway authenticates as a hub-level peer, never as a node.

### 6.2 Local mode (no hub paired)

Some verbs work without any hub at all when relay-ide is running as a single-host process:

| Verb                              | Local mode behavior                                                               |
| --------------------------------- | --------------------------------------------------------------------------------- |
| `v1 nodes list`                   | Returns one entry for the local host's manifest.                                  |
| `v1 nodes manifest --id local`    | Returns the local `getNodeManifest()` output.                                     |
| `v1 sessions create`              | Creates a session against the local PTY pool, gated by intent.                    |
| `v1 sessions attach/input/detach` | Operates on the local session.                                                    |
| `v1 exec`                         | Local exec. Still tier-gated if the local node's `trustLevel` is `dev` or `prod`. |
| `v1 --list`                       | Always works.                                                                     |

Local-mode is detected by absence of `--hub`, `RELAY_IDE_HUB`, and `cli-credential.json` **and** presence of a local `relay-ide hub` process. Otherwise the CLI fails with a typed error (`UNAUTHORIZED` + `details.reason: "no-hub-credential"`).

### 6.3 Session-id flow

After `v1 sessions create` returns a session descriptor, every `sessions attach|input|detach` call carries `--id <sessionId>`. The hub validates the requester (CLI's hub credential) is the session's creator, and that the session's intent permits the operation. Per #426, the session's intent and scope are immutable for its lifetime.

### 6.4 Confirmation gate (#427) interaction

When the hub returns `data.status: "confirmation-required"`, the CLI:

1. Prints the challenge envelope (above) to stdout.
2. Exits 4.
3. The agent (or operator) completes the challenge out-of-band (hub UI by default; CLI may grow `relay-ide v1 confirm <challengeId> --token <t>` in #429 follow-ups).
4. The agent re-issues the original verb with `--confirmation-token <t>`.

The confirmation token is bound to the original request's `requestId` server-side, so the agent cannot replay a stale confirmation against a different verb.

### 6.5 ADR-016 enforcement

No CLI verb takes `--act-as-node <id>` or otherwise lets one node target a peer. `v1 ext.dispatch` is implemented as **hub-mediated fan-out**: each per-node leg is a separate authorized request from the hub's CLI peer identity. The CLI verb signature reflects this — `dispatch --task <task>` doesn't take a node id; the hub picks.

If a future PR proposes a verb whose schema includes both a `nodeId` and an `actAsNodeId`, `/adr:review` should reject it.

### 6.6 Redaction

Any CLI output that would otherwise embed a credential or pair token must be passed through `redactBootstrapSecrets` from `shared/bootstrap-diagnostics.ts`. This applies to:

- Error messages echoed from hub envelopes (the hub already redacts, but the CLI re-redacts as defense in depth).
- `v1 --list --json` output (none should contain secrets, but the redactor is run on the serialized output unconditionally).
- `stream-open` event metadata in `sessions attach` NDJSON.

The redactor's existing patterns cover pair tokens, secret tokens, node ids, and `Authorization: Bearer …` headers. New CLI-specific secret formats (e.g. confirmation tokens) need patterns added to the same redactor in the #427 implementation PR.

---

## 7. Streaming semantics

### 7.1 Backpressure

The CLI is a pass-through. The hub already enforces 256KB scrollback per session (existing rule from CLAUDE.md). For NDJSON output the CLI's stdout drain is the only backpressure signal:

- If `process.stdout.write()` returns `false`, the CLI calls `pause()` on the inbound envelope stream until `drain`.
- The hub's outbound buffer for the stream is bounded; the hub drops oldest PTY bytes (FIFO trim) when the consumer can't keep up, consistent with the existing scrollback policy. The dropped-bytes case surfaces as a `stream-event` with `event: "data-dropped", droppedBytes: N`.

For `--mode raw`, the inbound bytes are pumped directly to stdout. No buffering in the CLI layer.

### 7.2 Reconnect

If the underlying `/hub/node-link` reverse connection drops mid-stream, the hub emits one `error` event (`code: "NODE_OFFLINE", retryable: true`), then either:

- The hub reconnects within a short window and emits a `stream-resume` event with the lost-bytes count, then resumes data delivery (best-effort). Out of scope for the spike; #429 implementation decides whether to ship this in MVP.
- Or the hub closes the stream with `stream-close, reason: "node-disconnected"`. The agent decides whether to retry `sessions attach`.

Spike's recommendation: **start without resume**. Ship reconnect only after streaming is real and the gap is measured.

### 7.3 EOF and detach

- `sessions detach --id X` cleanly closes the underlying attach stream. The stream emits `stream-close, reason: "detached"` and the attach process exits 0.
- `sessions detach --id X --revoke` revokes the session itself per #426. Subsequent operations on `X` return `SESSION_REVOKED`.

---

## 8. Examples

### 8.1 Claude tool-use: list nodes, attach to one, run a command

```jsonc
// 1. Claude calls the tool defined for `relay_nodes_list`.
//    Adapter shells out:
$ relay-ide v1 nodes list --json
{"ok":true,"apiVersion":"v1","verb":"nodes.list","requestId":"cli_01HZQ1…",
 "data":[
   {"nodeId":"node_…","displayName":"laptop-a","status":"online", /* … HubNodeSummary … */ },
   {"nodeId":"node_…","displayName":"build-box","status":"online", /* … */ }
 ]}

// 2. Claude picks "build-box" and creates a read-only session.
$ relay-ide v1 sessions create \
    --node node_build_… \
    --intent read-only-inspect \
    --scope '{"paths":["/srv/app"]}' \
    --ttl 600 \
    --json
{"ok":true,"apiVersion":"v1","verb":"sessions.create","requestId":"cli_01HZQ2…",
 "data":{"id":"sess_01HZQ…","nodeId":"node_build_…","intent":"read-only-inspect",
         "scope":{"paths":["/srv/app"]},"expiresAt":"…","status":"open"}}

// 3. Claude calls `relay_fs_read` (extension verb, but already on the same envelope shape).
$ relay-ide v1 fs read --node node_build_… --path /srv/app/package.json --json
{"ok":true,"apiVersion":"v1","verb":"fs.read","requestId":"cli_01HZQ3…",
 "data":{"path":"/srv/app/package.json","encoding":"utf-8",
         "content":"{\n  \"name\": \"app\", ... }"}}

// 4. Claude detaches.
$ relay-ide v1 sessions detach --id sess_01HZQ… --revoke --json
{"ok":true,"apiVersion":"v1","verb":"sessions.detach","requestId":"cli_01HZQ4…",
 "data":{"ok":true,"revoked":true}}
```

How this maps to envelopes:

- Step 1 → CLI hits `GET /hub/nodes` (or equivalent registry route) with the operator credential. No `/hub/node-link` envelope.
- Step 2 → CLI hits `POST /hub/sessions` per #426. Hub creates registry row, returns descriptor.
- Step 3 → CLI hits `POST /hub/sessions/:id/fs-read` per #428 (or the eventual file-RPC route). Hub fans out one envelope on the existing `rpc` channel of `/hub/node-link` to `node_build_…`. Per ADR-016, the request is authorized as the operator/CLI peer, not as another node.
- Step 4 → CLI hits `DELETE /hub/sessions/:id`. Hub revokes and closes any open streams.

### 8.2 Codex function-call: open a shell, type, detach

```jsonc
// Codex selects `relay_sessions_create` with intent: interactive-shell.
$ relay-ide v1 sessions create \
    --node node_laptop_… \
    --intent interactive-shell \
    --scope '{"cwd":"/Users/me/code"}' \
    --json
// Hub: node_laptop_ is trustLevel "dev". Interactive-shell on dev is tier-gated.
{"ok":true,"apiVersion":"v1","verb":"sessions.create","requestId":"cli_01HZQ…",
 "data":{"status":"confirmation-required","challengeId":"cnf_01HZQ…",
         "channel":"hub-ui","expiresAt":"…"}}
// CLI exits 4. Codex surfaces to the operator. Operator approves in the hub UI.

// Codex retries with the confirmation token.
$ relay-ide v1 sessions create … --confirmation-token cnf_token_… --json
{"ok":true, "data": {"id":"sess_01HZR…", "intent":"interactive-shell", ...}}

// Codex attaches in NDJSON mode and pipes through a worker that emits ndjson back.
$ relay-ide v1 sessions attach --id sess_01HZR… --mode ndjson
{"ok":true,"event":"stream-open","streamId":"strm_…","sessionId":"sess_01HZR…"}
{"ok":true,"event":"data","streamId":"strm_…","chunk":"$ ","encoding":"utf-8"}
…
```

### 8.3 Script / CI: one-shot exec for a smoke test

```bash
#!/usr/bin/env bash
set -euo pipefail
RESULT=$(relay-ide v1 exec \
  --node "${RELAY_NODE_ID}" \
  --cmd '["node","--version"]' \
  --timeout 10 \
  --json)
echo "$RESULT" | jq -e '.ok == true and .data.exitCode == 0'
```

This is the smoke-test shape required by #429's acceptance criteria. Two-line agent integration.

---

## 9. Follow-up implementation tickets (for #429)

These are the tickets the spike unblocks. Each is a single PR's worth of work; titles and one-line scope only.

1. **#429a: scaffold `shared/cli-schema/v1/` Zod registry + `npm run cli-schema:generate`** — write the envelope, error, and one canary verb (`v1 --list`), wire the generator, commit `generated/v1.json` + `generated/v1.d.ts`.
2. **#429b: implement `v1 nodes list` and `v1 nodes manifest`** — read-only verbs, no tier gating, end-to-end through the existing registry. Smoke test against a fake hub.
3. **#429c: implement `v1 sessions list|create|attach|input|detach`** — depends on #426 session intent envelopes being in `main`. Confirmation-gate stub returns `confirmation-required` for `arbitrary-exec` on `dev`+.
4. **#429d: implement `v1 exec`** — wraps `sessions create --intent arbitrary-exec` + attach + final exit-code capture. Always tier-gated.
5. **#429e: NDJSON + raw stream framing for `sessions attach`** — including stdin pump, backpressure, `data-dropped` events, exit-code mapping.
6. **#429f: operator-credential flow (`relay-ide hub login` + `~/.config/relay-ide/cli-credential.json`)** — distinct from node credential; ADR-016 compliance test included.
7. **#429g: confirmation-gate wiring** — depends on #427. CLI surfaces challenge JSON, accepts `--confirmation-token`, exits 4 on missing.
8. **#429h: `--help` generator and human-mode output for every verb** — derived from `generated/v1.help.md` so `relay-ide v1 sessions create --help` is the same text humans see.
9. **#429i: CI gate `cli-schema:check`** — regenerate-and-diff. Fail PRs that touched `shared/cli-schema/v1/` without regenerating.
10. **#429j: smoke test `test/cli-gateway/end-to-end.test.ts`** — pair fake node, create read-only session, read a file, detach. The acceptance test #429 lists.
11. **#429k: `docs/CLI_GATEWAY.md`** — the operator/agent-author doc that #429's acceptance criteria require, with the verb catalog and link to the generated schema.
12. **#429-ext1: feature-layer namespace plumbing** — after #425. Wires `v1 ext.<ns>` dispatch, but ships no verbs. Repo/dispatch verbs land in subsequent tickets owned by the feature layer.

The first ten land before #430 (agent adapters) can start. #429k can ship in parallel with #429j.

---

## 10. Open questions (deferred to #429 implementation, not blocking)

- **Confirmation token UX.** Whether to add `relay-ide v1 confirm <challengeId>` as a CLI verb or keep approvals hub-UI-only in MVP. Spike defers to #427.
- **Stream resume across `/hub/node-link` reconnects.** Spike recommends starting without resume.
- **Pagination shape for `nodes list` and `fs list`.** Both are likely cursor-based (`cursor` + `limit`), but the cursor encoding is implementation-detail and not part of this spike.
- **`v1 --list` schema URL.** Whether to point at a `file://` path (local) or the relay-ide GitHub release asset (canonical). Implementation question; both work.
- **Telemetry.** Whether the CLI emits anonymous usage counts. Out of scope; covered by the existing session-analytics surface if anywhere.

None of these change the contract this spike locks in.
