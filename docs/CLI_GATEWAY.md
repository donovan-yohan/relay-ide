# CLI Gateway JSON Contract

Relay exposes the adapter-facing gateway through an explicit major-version CLI surface:

```bash
relay-ide v1 --list --json
relay-ide v1 schema --json
relay-ide v1 nodes manifest --json
relay-ide v1 nodes list --json
relay-ide v1 repos add --input-json '{...}' --json
relay-ide v1 workspaces launch --input-json '{...}' --json
relay-ide v1 worktrees create --input-json '{...}' --json
relay-ide v1 worktrees status --input-json '{...}' --json
relay-ide v1 worktrees delete --input-json '{...}' --json
relay-ide v1 worktrees archive --input-json '{...}' --json
relay-ide v1 sessions list --json
relay-ide v1 sessions get --id <session-id-or-global-id> --json
relay-ide v1 sessions create --input-json '{...}' --json
relay-ide v1 tickets start-work --input-json '{...}' --json
relay-ide v1 branches open-session --input-json '{...}' --json
relay-ide v1 sessions renew --id <session-id> --ttl-seconds <seconds> --json
relay-ide v1 sessions attach --id <session-id-or-global-id> --json
relay-ide v1 sessions detach --id <session-id-or-global-id> --json
relay-ide v1 sessions kill --id <session-id-or-global-id> [--confirmation-token <token>] --json
relay-ide v1 sessions rename --id <session-id-or-global-id> --display-name 'new name' --json
relay-ide v1 sessions stream --id <session-id-or-global-id> --mode ndjson --json
relay-ide v1 sessions wait --id <session-id-or-global-id> --output-text 'ready' --timeout-ms 30000 --json
relay-ide v1 sessions screen --id <session-id-or-global-id> [--scrollback --max-lines 200] --json
relay-ide v1 sessions input --id <session-id-or-global-id> --data 'echo ok\n' --wait-for ok --json
relay-ide v1 sessions interventions --id <session-id> --json
relay-ide v1 sessions hand-back --id <session-id> --latest-seen-intervention-event-id <event-id> --json
relay-ide v1 files list --session-id <session-id> --path <path> --json
relay-ide v1 files stat --session-id <session-id> --path <path> --json
relay-ide v1 files read --session-id <session-id> --path <path> --max-bytes 32768 --max-lines 2000 --json
relay-ide v1 files write --session-id <session-id> --path <path> --mode <create|overwrite|append> --file <local-path|-> --json
relay-ide v1 work-contexts get --id <work-context-id> --json
relay-ide v1 work-contexts resume --id <work-context-id> --json
relay-ide v1 work-context-messages append --input-json '<json>' --json
relay-ide v1 work-context-messages append --template relay.qa.handoff --work-context-id <work-context-id> --summary 'qa handoff' --payload-json '{"body":{...}}' --json
relay-ide v1 work-context-messages templates list [--repo-path <path>] [--work-context-id <work-context-id>] --json
relay-ide v1 work-context-messages templates show --template <id-or-stem> [--repo-path <path>] --json
relay-ide v1 work-context-messages templates render --template <id-or-stem> --template-data-json '{...}' --json
relay-ide v1 work-context-messages list --work-context-id <work-context-id> [--thread-id <message-id>] [--payload-schema <schema-id>] --json
relay-ide v1 work-context-messages show --id <message-id> --json
relay-ide v1 work-context-messages query --input-json '{"workContextId":"...","refKind":"task.github","refValue":"949"}' --json
relay-ide v1 context create --input-json '{...}' --json
relay-ide v1 context get --id <context-packet-id> --json
relay-ide v1 context list [--work-context-id <work-context-id>] --json
relay-ide v1 context pin --id <context-packet-id> --work-context-id <work-context-id> --json
relay-ide v1 context unpin --id <context-packet-id> --work-context-id <work-context-id> --json
relay-ide v1 work-context-artifacts publish --work-context-id <work-context-id> --artifact-file <pipeline-handoff.json> --json
relay-ide v1 work-context-artifacts list --work-context-id <work-context-id> --json
relay-ide v1 work-context-artifacts show --id <artifact-id> [--current-head-sha <sha>] --json
relay-ide v1 work-context-artifacts pin --id <artifact-id> --work-context-id <work-context-id> --json
relay-ide v1 work-context-artifacts unpin --id <artifact-id> --work-context-id <work-context-id> --json
relay-ide v1 work-context-artifacts export --id <artifact-id> [--output <path>] --json
relay-ide v1 work-context-artifacts doctor --json
relay-ide v1 handoff-artifacts attach --work-context-id <work-context-id> --artifact-file <pipeline-handoff-artifact.json> --json
relay-ide v1 handoff-artifacts list --work-context-id <work-context-id> [--stage <implementation|qa|review|release>] [--current-head-sha <sha>] --json
relay-ide v1 handoff-artifacts show --id <artifact-id> [--current-head-sha <sha>] [--public] --json
relay-ide v1 handoff-artifacts copy --id <artifact-id> [--output <path>] --json
relay-ide v1 inbox send --input-json '{...}' --json
relay-ide v1 inbox list --target-session-id <global-session-id> --json
relay-ide v1 inbox get --id <inbox-message-id> --json
relay-ide v1 inbox ack --id <inbox-message-id> --json
relay-ide v1 inbox resolve --id <inbox-message-id> --json
relay-ide v1 inbox ignore --id <inbox-message-id> --json
relay-ide v1 roster list [--repo <repo-name-or-path>] [--work-context-id <work-context-id>] [--provider <agent-kind>] [--role <implementer|reviewer|orchestrator|context|collaborator>] [--node-id <node-id>] [--needs-attention] [--include-terminals] [--limit <n>] --json
relay-ide v1 cockpit list [--limit <n>] --json
relay-ide v1 cockpit get --work-context-id <work-context-id> --json
relay-ide cockpit [--limit <n>] [--json]
relay-ide cockpit get <work-context-id> [--json]
relay-ide cockpit --work-context-id <work-context-id> [--json]
relay-ide v1 roster register --input-json '{"role":"implementer","useCase":"...","sessionId":"...","statusText":"...","capabilityHints":["..."],"ttlSeconds":120}' --json
relay-ide v1 roster update-self --input-json '{"sessionId":"...","statusText":"...","needsAttention":true}' --json
relay-ide v1 automation-runs register --input-json '{"name":"...","kind":"watchdog","owner":{"orchestrator":"hermes"},"targets":[{"sessionId":"..."}],"workContextId":"...","ttlSeconds":300}' --json
relay-ide v1 automation-runs observe --id <automation-run-id> --input-json '{"summary":"..."}' --json
relay-ide v1 automation-runs retire --id <automation-run-id> [--reason '<why>'] [--retired-by '<who>'] --json
relay-ide v1 automation-runs list [--work-context-id <id>] [--repo-path <path>] [--status <active|stale|cleanup-needed|retired>] [--kind <watchdog|cron|automation|oversight|manual>] [--orchestrator <name>] [--include-retired] [--limit <n>] --json
relay-ide v1 automation-runs get --id <automation-run-id> --json
relay-ide v1 pr-overseer register --input-json '{"name":"...","owner":{"orchestrator":"ebi"},"pr":{"ownerRepo":"donovan-yohan/relay-ide","number":1234},"issue":{"number":960},"session":{"sessionId":"..."},"workContextId":"...","expectedHeadSha":"<sha>","ttlSeconds":600}' --json
relay-ide v1 pr-overseer observe --id <pr-overseer-id> --input-json '{"summary":"...","expectedHeadSha":"<sha>"}' --json
relay-ide v1 pr-overseer retire --id <pr-overseer-id> [--reason '<why>'] [--retired-by '<who>'] --json
relay-ide v1 pr-overseer list [--work-context-id <id>] [--repo-path <path>] [--owner-repo <owner/repo>] [--status <pending|observing|blocked|ready|merged|closed|stale|retired>] [--orchestrator <name>] [--include-retired] [--limit <n>] --json
relay-ide v1 pr-overseer get --id <pr-overseer-id> [--current-head-sha <sha>] --json
relay-ide v1 workspace-surfaces list [--root-id <id>] [--workspace-id <id>] [--repo-path <path>] --json
relay-ide v1 workspace-surfaces publish --input-json '{"kind":"preview","label":"agent preview","url":"http://localhost:4173"}' --json
relay-ide v1 workspace-topics list [--workspace-id <id>] [--include-archived] --json
relay-ide v1 workspace-topics get --id <topic:id> --json
relay-ide v1 workspace-topics create --input-json '{"workspaceId":"...","title":"...","linkedRefs":{"workspaceSurfaceIds":["..."]}}' --json
relay-ide v1 workspace-topics update --id <topic:id> --input-json '{...}' --json
relay-ide v1 workspace-topics archive --id <topic:id> --json
relay-ide v1 handoffs plan --input-json '{...}' --json
relay-ide v1 handoffs create --input-json '{...}' --json
relay-ide v1 handoffs status --run-id <run-id> --json
relay-ide v1 handoffs cancel --run-id <run-id> --json
relay-ide v1 handoffs resume --run-id <run-id> --json
relay-ide v1 handoffs launch --run-id <run-id> --json
relay-ide v1 artifacts read --ref <artifact-ref> --json
relay-ide v1 supervisor sessions --json
relay-ide v1 supervisor snapshot --id <session-id-or-global-id> --json
relay-ide v1 supervisor send-text --id <session-id-or-global-id> --text <literal-text> --json
relay-ide v1 supervisor send-text --target-ids <session-id-1,session-id-2> --text <literal-text> --json
relay-ide v1 supervisor send-key --id <session-id-or-global-id> --key <escape|tab|arrow-up|arrow-down|arrow-left|arrow-right|ctrl-c|ctrl-d|home|end|page-up|page-down> --json
relay-ide v1 supervisor send-key --target-ids <session-id-1,session-id-2> --key <escape|tab|arrow-up|arrow-down|arrow-left|arrow-right|ctrl-c|ctrl-d|home|end|page-up|page-down> --json
relay-ide v1 supervisor submit --id <session-id-or-global-id> --json
relay-ide v1 supervisor submit --id <session-id-or-global-id> --text 'multi-line prompt' [--clear-input] [--paste] [--dry-run] --json
relay-ide v1 supervisor submit --target-ids <session-id-1,session-id-2> --json
relay-ide v1 events subscribe --topic <sessions|nodes|audit|context|inbox|attention|work-context-artifacts|handoff-artifacts|workflow-runs|automation-runs|pr-overseer> [--work-context-id <id>] [--session-id <id>] [--global-session-id <id>] [--repo-path <path>] [--cursor <cursor>] [--max-events <n>] --json
relay-ide v1 settings get --json
relay-ide v1 settings update --input-json '{"key":"defaultYolo","value":true,"confirmRiskyWrite":true}' --json
relay-ide v1 webhooks status --json
relay-ide v1 webhooks ping --json
```

This contract is for external brain-as-peer adapters (#430). It is intentionally separate from the internal `/hub/node-link` WebSocket protocol. Adapter packages must generate native tool/function definitions from `relay-ide v1 schema --json` or the committed source manifest in `shared/cli-gateway-contract.ts`; do not hand-code Hermes/Claude/Codex-specific schemas. `inbox list --target-session-id` expects the scoped session key form (`local:<session-id>` for local sessions or `<nodeId>:<session-id>` for routed sessions); passing a raw session id (without the node prefix) returns an empty list.

Boo/adapter rule: `relay-ide v1 ... --json` is Relay's scriptable session substrate. External agents should compose sessions, files, WorkContexts, artifacts, events, inbox, and supervisor actions through this contract. They must not speak private `/hub/node-link`, scrape browser WebSockets, read provider databases, shell out to tmux/rmux directly, or infer durable state from raw transcripts when a Relay-owned command exists or needs to be added.

Terminal backend note (#973): v1 keeps the `terminalBackend` field for create/workflow compatibility, but `relay-pty` is the only accepted value. `tmux-compat` and old tmux-shaped fields are rejected/ignored as unsupported legacy state; they are not a request to restore tmux-backed processes.

## Active-agent roster + evented steering (#952/#953)

Relay exposes agent collaboration as generic, Relay-owned primitives — not a Hermes-specific endpoint and not raw PTY/tmux byte injection. Two surfaces work together so agents and operators steer running work without polling loops:

- **Evented delivery (#945).** `events subscribe --topic inbox` streams `inbox.sent` / `inbox.state-changed` (with `previousState`) metadata frames as messages move through `queued → delivered → acknowledged → resolved|ignored`. Sibling topics cover `context`, `work-context-artifacts`, `handoff-artifacts`, and `workflow-runs`. Every frame is metadata-only (ids, refs, state transition, actor/source summary, cursor) — never raw bodies, prompts, transcripts, tokens, or env — and is filterable by `--work-context-id` / `--session-id` / `--global-session-id` with `--cursor` replay. This is the push surface for "tell this agent something now" and "know when an agent needs attention"; do not build timer-poll loops as the product answer.
- **Evented attention/session-state (#963, child of #952).** `events subscribe --topic attention` streams `attention.state-changed` metadata frames whenever a local agent session's backend display state transitions (`idle | running | permission | error | initializing`). Each frame's payload carries the derived collaboration signal — `backendState`, `previousBackendState`, `agentState`, `needsAttention`, `reasons[]` (`permission-prompt | waiting-for-input | error | pending-inbox`), `pendingInboxCount`, optional `permissionType`, plus identity hints (`sessionId`, `globalSessionId`, `provider`, `role`, `repoName`, `branchName`, `worktreePath`). `needsAttention`/`reasons` use the same `deriveRosterAttention` heuristic as `roster.list`, so a given frame's derived signal matches what `roster.list` would report at that instant. The topic fires **on backend-state transitions only**: it is the right surface for permission/error/idle/waiting transitions. It is NOT a complete inbox-backlog feed — a message arriving for an otherwise-idle agent does not change backend state, so it surfaces on `--topic inbox` (and is reflected in the next attention frame's `pendingInboxCount` whenever a transition next fires), not as its own attention frame. Subscribe to both `attention` and `inbox` to cover "agent changed state" and "agent has mail". Terminals are excluded; session create/end stays on the `sessions` topic. This is the Relay-owned replacement for cron jobs and screen/replay watchdog loops that scrape a PTY to ask "is this agent waiting on me yet?" — subscribe once and react to the transition instead. Capability-gated on `session:read`.
- **Discovery (`roster.list`).** A read-only, **derived, redaction-safe** projection of the live session read model so an agent can answer "who else is working in this repo / WorkContext, and who needs me?" before sending a message. The derived projection is the trusted base; explicit self-declared presence (below) is merged on top without ever overriding identity/control fields. Capability-gated on `session:read`. When called with `--work-context-id`, a scoped actor credential must also carry that WorkContext (fail-closed); without it the command behaves like `sessions.list` (broad `session:read` read scope).
- **Terminal cockpit (`cockpit.list` / `cockpit.get` / `relay-ide cockpit`, #934 slices).** A read-first terminal surface for operators on SSH/devboxes. It composes Active Work through the CLI gateway and orders WorkContexts with the same attention copy as the Active Work UI: approval/input first, then offline/revoked/stale last-known contexts, then errors/running/live. Each list row carries why attention is needed, node freshness, session durability, actor/control mode, TaskRefs, artifact counts/latest refs, and explicit action availability before attach. Offline/stale/revoked nodes keep the last-known WorkContext/session context but live controls are disabled with typed reasons; destructive controls are outside this MVP. The selected-item detail path (`cockpit get --work-context-id`) adds exact follow-up command hints for bounded status/evidence (`work-contexts get/resume`, `context list`, artifact list/show/export/read, inbox/interventions) and attach discovery when the session is live/fresh. Capability hints: `session:read` + `context:read`.
- **Explicit presence (`roster.register` / `roster.updateSelf`, #964).** The first roster **write**: an agent self-declares its own collaboration metadata so non-Relay-launched agents and richer role/use-case/status surface for discovery. Capability-gated on `context:write` (writes, never `session:read`). `register` create-or-replaces the calling agent's presence record; `update-self` patches an existing record and refreshes its heartbeat (fail-closed `NOT_FOUND` if none lives, `FORBIDDEN` if it belongs to another actor). See the safe-field allowlist, expiry/heartbeat, and merge rules below.

### Explicit presence safe-field allowlist + expiry (#964)

`roster.register` / `roster.updateSelf` accept ONLY this allowlisted, sanitized field set — the input schema is `additionalProperties: false` and the store re-sanitizes (defense in depth), so a secret-shaped key (`token`, `secret`, `env`, `transcript`, `prompt`, `payload`, …) is **rejected** (`INVALID_ARGUMENT`), unknown non-secret keys are dropped, and text fields are control-char-stripped + length-bounded:

- **Soft collaboration fields:** `role` (one of the `roster.list` role enum; rejected otherwise), `displayName`, `useCase` (free-text role/use-case hint), `statusText` (coarse status), `needsAttention` (additive attention hint), `capabilityHints[]` (normalized tokens).
- **Scope / addressing (self-claimed, used only to JOIN the derived roster — never trusted for security):** `sessionId`, `globalSessionId`, `workContextId`, `repoPath`, `nodeId`, `provider`.
- **Lifecycle:** `ttlSeconds` (heartbeat TTL, clamped to 10–3600, default 120). The store stamps `expiresAt = now + ttl`; `roster.list` filters stale records at read time and writes sweep expired rows, so explicit presence never lives forever. Re-`register` or `update-self` before expiry to stay live.

`registeredBy` is the **authenticated actor id** (audit attribution); a body `createdBy` is only a fallback when no actor is resolved. Presence is non-authoritative discovery metadata, never an authorization input.

**Merge precedence (`roster.list`).** Derived session fields always win for identity/control/security (`sessionId`, `globalSessionId`, `nodeId`, `provider`, `controlMode`, `status`, `agentState`, `activeActors`). Self-declaration only overlays the soft subset (`role`, `displayName`, capability-hint union, additive attention) and attaches a `selfDeclared` block; such entries are tagged `origin: "merged"`. A live presence record with no matching session is surfaced as an `origin: "self-declared"` entry (e.g. an external/non-Relay agent). `needsAttention` is additive: a self-declared hint can RAISE attention (adding the `self-declared` reason) but never clears a derived reason.

### Cursor / resume / gap / backpressure (metadata topics)

`inbox`, `attention`, `context`, `work-context-artifacts`, `handoff-artifacts`, `workflow-runs`, `automation-runs`, and `pr-overseer` share one in-memory metadata bus, so they share the same resume contract:

- **Cursor.** Every live and replayed event frame carries an opaque `cursor`. Persist the last-seen cursor; on reconnect pass it as `--cursor <cursor>`. Replayed frames are tagged `replay: true`.
- **Resume.** With a known cursor, the hub replays only the buffered frames _after_ it, then continues live. Scope filters (`--session-id`, `--global-session-id`, `--work-context-id`, `--repo-path`) apply to replayed frames too.
- **Gap / drop.** The replay buffer is bounded (default 1000 frames/topic, oldest trimmed FIFO). If your cursor has already aged out, the hub emits an extra `open` frame with `replayDropped: true` before replaying everything it still holds. Treat `replayDropped` as "you may have missed frames between your cursor and the oldest retained one" — re-sync via `roster.list` / `inbox list` if you need exact state.
- **Backpressure.** If a subscriber stops reading and the socket buffer fills, the hub drops that subscriber and closes the stream rather than growing memory unbounded; the CLI emits a `closed` frame (`closeCode 1013`, `reason: "stdout backpressure"` on the CLI side). Reconnect with your last cursor to resume.
- **Scope.** `--repo-path` is an exact checkout-path match and is only meaningful for the `attention` topic (other topics do not carry `repoPath`, so they never match it). Worktree-level granularity is available via `--session-id` (each worktree session has a distinct id). Cross-node attention aggregation and durable (cross-restart) replay are documented residuals — this slice is local-node / in-memory.

This is local-node, in-memory only: the buffer does not survive a hub restart and does not aggregate remote-node sessions. Durable + cross-node attention/inbox streaming is the next slice.

`roster.list` fields (per entry): `sessionId`, `globalSessionId`, `nodeId`, `provider` (agent kind), `sessionType` (`agent`|`terminal`), `role`, `displayName`, `repoPath`/`repoName`/`worktreePath`/`branchName`/`cwd`, `workContextId`, `controlMode`, `status`, `agentState`, `attention` (`{ needsAttention, reasons[], pendingInboxCount }`, where `reasons` may include `self-declared` from an explicit presence hint), `capabilities[]` (framework flags), `activeActors[]` (kind/id/displayName), `lastActivity`, `createdAt`. When explicit presence (#964) is folded in, an entry also carries `origin` (`derived` | `merged` | `self-declared`; omitted means `derived`) and `selfDeclared` (`{ presenceId, registeredBy?, role?, displayName?, useCase?, statusText?, needsAttention?, capabilityHints?, updatedAt, expiresAt }`). The envelope adds `generatedAt`, `count`, and `nodeId`.

`role` is a lightweight collaboration **hint** (default map: `claude → implementer`, `codex → reviewer`, `hermes`/`ebi → orchestrator`, else `collaborator`), not an authorization boundary and not a hard-coded architecture — Relay projects one collaboration vocabulary across providers. `attention.needsAttention` is derived (`agentState ∈ {permission-prompt, waiting-for-input, error}` or a non-empty pending inbox backlog); the roster never mutates inbox state (it reads with delivery suppressed). Terminals are excluded unless `--include-terminals`. Cross-node aggregation of remote sessions into the roster is a documented follow-up; this slice projects locally-owned sessions (already WorkContext-decorated).

## Workflow run topology (#1016/#1129)

`workflow-runs.*` stores bounded WorkContext-scoped workflow projections and, as of the
visible orchestration work, can also carry Relay-owned planner/worker topology. This
keeps provider-runtime projections compatible while giving Relay enough structure to
render and steer visible agent teams.

A Relay orchestration run sets `runKind: "relay-orchestration"` and usually
`providerRuntime: "relay-orchestration"`. Its optional `orchestration` block is
metadata-only:

```json
{
  "planner": {
    "role": "planner",
    "sessionId": "planner-session-id",
    "globalSessionId": "local:planner-session-id",
    "provider": "hermes",
    "nodeId": "local",
    "cwd": "/repo/relay-ide",
    "repoPath": "/repo/relay-ide",
    "worktreePath": "/repo/relay-ide/.worktrees/...",
    "state": "running",
    "attention": {
      "needsAttention": false,
      "pendingInboxCount": 0
    }
  },
  "children": [
    {
      "role": "implementer",
      "sessionId": "claude-session-id",
      "provider": "claude",
      "state": "running"
    },
    {
      "role": "reviewer",
      "sessionId": "codex-session-id",
      "provider": "codex",
      "state": "waiting",
      "attention": {
        "needsAttention": true,
        "reasons": ["pending-inbox"],
        "pendingInboxCount": 1
      }
    }
  ]
}
```

Rules:

- `planner` and each `children[]` entry must include `role` plus `sessionId` or
  `globalSessionId`.
- Roles are collaboration hints, not authorization boundaries.
- Session links may include provider/node/cwd/repo/worktree/state/attention hints,
  but raw transcripts, prompts, provider private state, env, tokens, and message
  bodies remain forbidden.
- Event summaries include planner ids, participant ids, child ids/count, artifact refs,
  inbox refs, handoff refs, and task refs so the UI can refresh without transcript
  scraping.
- The v0 contract is local-run topology only. Launching child sessions is tracked by
  #1130; the WorkContext cockpit is tracked by #158.

## Automation / watchdog run registry (#959)

`automation-runs.*` is a Relay-visible registry of operator crons, watchdogs, and automations that drive Relay sessions. It exists so a watcher that keeps firing at a session id that no longer exists is **obvious and retirable** instead of silent: the run's target session ids, owner/orchestrator, linked issue/PR, last observation, and cleanup state all live in Relay, and Relay itself probes whether the target sessions are still alive. This is intentionally distinct from `workflow-runs.*` (the provider-runtime workflow-VM projection); it does not replace Hermes cron and is not a Kanban board.

A run record carries: `id` (Relay-owned), `name`, `kind` (`watchdog|cron|automation|oversight|manual`), optional external `runId` (e.g. a Hermes cron id), `owner.orchestrator`, optional `repoPath`/`workContextId`, `targets[]` (session ids), `links` (`taskRefs`, `prUrls`, `issueUrls`), `heartbeat` (TTL + `expiresAt`), optional hard `expiresAt`, `lastObservation`, `cleanup`, `createdAt`/`updatedAt`/`version`, and a `redaction` block. `status` and `staleReasons` are **derived at read time**, never written directly.

Derived `status`:

- `active` — targets resolve alive and the heartbeat is fresh.
- `cleanup-needed` — a target session is `gone` (404 / killed) or `ended` (done), or a hard `expiresAt` has passed. This is the #959 incident; `staleReasons` names the cause (`target-session-gone`, `target-session-ended`, `hard-expiry`).
- `stale` — the heartbeat lapsed (`heartbeat-expired`): the watcher stopped checking in. This is the **no-silent-infinite-watchdog** guard — a watchdog can never stay green forever without re-observing.
- `retired` — terminal; set by `automation-runs.retire`.

How operator crons/watchdogs should register and retire themselves:

1. **Register once at start.** `automation-runs register` with the target session ids, a short `ttlSeconds` heartbeat, the owning orchestrator, and any linked issue/PR. Pass a stable `id` to make re-registration idempotent (create-or-replace, revives a retired run). Capability: `context:write`.
2. **Heartbeat each tick.** Call `automation-runs observe --id <id>` on every watcher iteration. Each observe refreshes the TTL and re-probes target liveness; skip it and the run goes `stale` so an abandoned watchdog is visible. Capability: `context:write`.
3. **Retire when done.** When the PR merges / the task closes / the watcher should stop, call `automation-runs retire --id <id> --reason '<why>'`. Retire is idempotent: a second retire is a no-op that preserves the original retire metadata and version. Capability: `context:write`.
4. **Find cleanup work.** `automation-runs list --status cleanup-needed` (or `--status stale`) is the read surface that makes dead targets and quiet watchdogs obvious; `get`/`list` always reflect live target liveness. Capabilities: `context:read`.

Reads are side-effect free — `get`/`list` overlay a fresh liveness probe and derive status without bumping `version`. Target liveness is resolved against the **local** session registry in this slice; remote-node targets resolve `unknown` (cross-node target liveness is a documented follow-up). Like `workflow-runs`, run lifecycle frames publish on the metadata event bus under `events subscribe --topic automation-runs` (`automation-run.registered` / `.observed` / `.status-changed` / `.retired`), metadata-only and redaction-safe (no raw payloads, transcripts, or secrets; secret-shaped register/observe fields are rejected with `AUTOMATION_RUN_VALIDATION_FAILED`).

Dynamic Workflows-compatible finalizers can register Relay-owned cleanup with `registerRelayAutomationRunFinalizers(...)` from `server/automation-run-finalizers.ts`. The action is `relay.automation_run.retire`; the automation-run id can be supplied as `resource.handle.automationRunId`, `resource.handle.automation_run_id`, `resource.handle.id`, `finalizer.args.automationRunId`, or `finalizer.args.automation_run_id`. The handler calls the same store-level retire primitive as `automation-runs retire`. It is idempotent for already-retired or absent records, can optionally enforce `ownerOrchestrator`, and returns bounded evidence without raw transcripts, prompts, env, or token material. This is the safe Relay-side adapter boundary for release-ops closeout today: it retires the automation/watchdog record and makes cleanup state auditable. Actual artifact-preserving termination of Relay child agent sessions is broader #1019 work and must remain a Relay-owned session/process primitive, not a Dynamic Workflows core concern.

## PR / check / review overseer (#960, refs #956)

`pr-overseer.*` links a Relay-driven implementation session to the GitHub PR it is shipping and turns the manual "poll the PR, read the checks/reviews, decide what's blocking, steer the agent, hand off for release" loop into a Relay-owned product surface. The overnight #956 run only worked because Ebi did that polling by hand; this primitive is the Relay-owned replacement. It is **observe + evidence only**: it never merges, approves, or mutates the PR — the actual QA/review/merge decision stays with the authorized tester/release agent (Codex or other). It is intentionally distinct from `handoff-artifacts.*` (durable stage evidence an agent authors) and `automation-runs.*` (the watcher driving it); a watchdog cron can register an `automation-run` whose linked PR is overseen by a `pr-overseer`.

A record carries: `id` (Relay-owned), `name`, `owner.orchestrator`, optional `repoPath`/`workContextId`, optional `session` (the implementation session being steered), optional `issue` (the issue being shipped), required `pr` (`{ ownerRepo, number, url? }`), optional `expectedHeadSha` (the head the session believes it pushed), `links`, `heartbeat` (TTL + `expiresAt`), `lastObservation` (the last **successful** GitHub snapshot), `lastFetch` (the most recent fetch attempt, success or failure), `cleanup`, timestamps/`version`, and a `redaction` block. `status`, `blockers`, `requiredNextAction`, `handoff`, and `staleHeadRisk` are **derived at read time**, never written directly.

`observe` is the only command that hits GitHub: it reads the PR's checks/reviews/mergeability/issue-closeout through the operator's existing `gh` CLI (no PATs plumbed through Relay), stores a bounded exact-head snapshot, refreshes the heartbeat, and returns the full derived view. `get`/`list` are **GitHub-free** — they replay the last stored evidence plus read-time staleness, so reads never hit rate limits. The observer never throws: a missing/unauthenticated `gh` or a deleted PR degrades to a failed-fetch snapshot (`lastFetch.ok: false`) that keeps the last good evidence rather than destroying it.

Derived `status` (precedence `retired > pending > merged > closed > blocked > stale > observing > ready`):

- `pending` — registered, never successfully observed.
- `observing` — open PR with only **soft** blockers (checks still running, draft, mergeability still computing, review not yet requested). In progress; not yet handoff-ready.
- `blocked` — open PR with a **hard** blocker: `checks-failed`, `review-changes-requested`, `unresolved-review-threads`, `merge-conflict`, `stale-head` (the evidence head diverged from the session's `expectedHeadSha` or a caller-asserted `currentHeadSha`), or `issue-closeout-mismatch` (the PR does not reference the linked issue as auto-closing).
- `ready` — open PR, zero blockers, exact-head evidence current and fresh. The **only** state where a handoff is safe.
- `merged` / `closed` — terminal PR states (a merged PR still surfaces `issue-closeout-mismatch` so the operator verifies the issue actually closed).
- `stale` — the heartbeat lapsed **or** the last fetch failed: the evidence could not be confirmed current, so the run is never reported `ready` until a successful re-observe. This is the **no-silent-stale-evidence** guard.
- `retired` — terminal; set by `pr-overseer.retire`.

`requiredNextAction` (`{ action, actor, summary, blockers[] }`) is the structured steering directive: e.g. `fix-checks`/`address-review`/`resync-head` → `actor: implementer`; `await-checks`/`await-mergeability` → `actor: none` (wait); `hand-off-to-release-train` → `actor: release-train`; `re-observe`/`observe-first` → `actor: operator`. `handoff` (`{ ready, exactHeadEvidenceCurrent, evidenceHeadSha, evidenceAgeSeconds, blockedBy[], recommendedActor }`) is the **safe-handoff gate**: a tester/release agent must treat `ready: false` as "do not QA/review/merge yet". To make the exact-head check explicit, a release agent passes `pr-overseer get --id <id> --current-head-sha <the-head-it-is-about-to-merge>`; a mismatch against the stored evidence forces `blocked` + `stale-head` so evidence for the wrong head can never read as `ready`. Bot comments (CodeRabbit/Gemini/etc.) are summarized as informational evidence (counts + bot logins only, never bodies) and **never gate** readiness, so the overseer does not depend on any bot being present.

How a release train uses it:

1. **Register at PR open.** The implementer (or its orchestrator) calls `pr-overseer register` with the `pr`, the `issue` being shipped, the `session` id, the `workContextId`, and optionally the `expectedHeadSha` it just pushed. Capability: `context:write`.
2. **Observe each tick.** `pr-overseer observe --id <id>` refreshes the GitHub snapshot + heartbeat and returns the derived blockers + next action. An orchestrator reads `requiredNextAction` to steer the implementation session (e.g. via `supervisor submit`). Capability: `context:write`.
3. **Hand off only when `handoff.ready` and exact-head-current.** A tester/release agent calls `pr-overseer get --id <id> --current-head-sha <head>`; it proceeds to QA/review/merge **only** if `handoff.ready === true` for that exact head. The primitive itself never merges. Capabilities: `context:read`.
4. **Retire when done.** On merge/abandon, `pr-overseer retire --id <id> --reason '<why>'` (idempotent). Capability: `context:write`.

Run lifecycle frames publish on the metadata event bus under `events subscribe --topic pr-overseer` (`pr-overseer.registered` / `.observed` / `.status-changed` / `.retired`), metadata-only and redaction-safe (ids/refs/derived state only — no PR bodies, transcripts, or secrets; secret-shaped register/observe fields are rejected with `PR_OVERSEER_VALIDATION_FAILED`). Reads resolve against the **local** store; cross-node aggregation is a documented follow-up.

### Release-train roles (#956)

The same record is consumed by every framework — Relay hard-codes no Claude-only behavior. The roles below are collaboration **hints** (matching the `roster.list` default map), not authorization boundaries:

- **Ebi / Hermes (orchestrator).** Owns the loop: registers the overseer, runs `observe` on a cadence (often as a registered `automation-run` watchdog), reads `requiredNextAction`, and steers the right session — without hand-rolled GitHub polling or cookie scripts.
- **Claude (implementer).** The Relay-launched session shipping the PR. Acts on `actor: implementer` next actions (`fix-checks`, `address-review`, `resync-head`, `fix-issue-closeout`) and pushes; the next `observe` re-checks exact-head evidence.
- **Codex / tester / release agent (release-train).** Consumes `handoff.ready` + `--current-head-sha` as the safe gate to QA/review and merge through its own authorized path. It never relies on the overseer to merge, and it refuses to act on stale, failed, or unknown evidence (`handoff.ready: false`).

## Envelope

Most gateway commands return one JSON envelope on stdout. Streaming commands such as `sessions.stream` and `events.subscribe` emit newline-delimited gateway envelopes and document their own final/closed envelope behavior. Human-readable CLI behavior outside `v1 ... --json` is unchanged.

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
    "details": {
      "upstreamCode": "NOT_FOUND",
      "reasonCode": "FILE_RPC_NOT_FOUND"
    }
  }
}
```

The current error taxonomy is declared in `RELAY_CLI_GATEWAY_CONTRACT.errorEnvelopeSchema`. It includes auth/connectivity errors, typed create/validation errors, file RPC errors (`NOT_FOUND`, `FORBIDDEN`, `NODE_OFFLINE`, `CONFIRMATION_REQUIRED`), control hand-back state errors (`CONTROL_STATE_STALE`, `INTERVENTION_ACK_REQUIRED`, `INTERVENTION_ACK_STALE`, `CONTROL_STATE_UNKNOWN`), and typed supervisor action errors. Multi-target supervisor action denials can also appear inside a successful action envelope as per-target `results[].error` entries; see [Supervisor typed actions and rmux mapping](#supervisor-typed-actions-and-rmux-mapping-704). `CONFIRMATION_REQUIRED` means the agent must pause for a human/operator approval of the exact operation described by the returned challenge; it is not a prompt to ask for a broader grant.

## Discovery and schemas

`relay-ide v1 --list --json` returns command specs and the common error-envelope schema.

`relay-ide v1 schema --json` returns the complete contract manifest:

- `contract` / `contractVersion`
- node-link and security-policy versions used by this build
- command CLI argv shapes
- per-command input and output schemas
- capability hints for hub policy checks
- possible typed error codes

The schema is the source of truth for adapter generation. A command missing from this manifest is not stable adapter API, even if an internal REST/WebSocket route exists. WorkContext-pinning commands are exposed here as `context.pin`, `context.unpin`, and `context.list --work-context-id`; agents should discover and call those gateway verbs instead of private HTTP routes.

WorkContext message operations are stable adapter API under `work-context-messages.append`, `list`, `show`, `query`, and `templates.*`. `append --input-json` accepts one JSON object containing `workContextId`, `kind`, `summary`, and optional `sender`, `audience`, `refs`, `payloadSchema`, `payload`, and `visibility` fields. `append --payload-json` is the complete message `payload` object; template authors normally put template data under `payload.body`. `templates render --template-data-json` is only a dry-run render input and maps directly to the template body data. `append --template <id-or-stem>` may omit `kind`: Relay discovers `.relay/messages/*.json` in the selected repo (`--repo-path`, `--cwd`, or the WorkContext repo/worktree), applies the template's `kind`, `payloadSchema`, `mediaType`, and `encoding`, and then appends the normal message envelope. Scoped actor tokens with WorkContext scope must select templates by `--work-context-id`; caller-selected `--repo-path`/`--cwd` is rejected for those credentials. Templates are JSON-only, repo-contained regular files; Relay never shells out, imports code, follows directory escapes, resolves remote `$ref`s, or lets a template override envelope fields such as ids, sender, refs, timestamps, or WorkContext id. Messages are append-only WorkContext-scoped envelopes: Relay owns ids, timestamps, threading, sender/audience, refs/provenance indexes, bounded persistence, auth, and redacted event emission; agents/repos own the `kind`, `payloadSchema`, and `payload` body. Unknown payload schemas are preserved as opaque JSON and returned unchanged after the envelope-level redaction pass removes dangerous/private-looking keys such as tokens, credentials, raw transcripts, and prototype-pollution keys. Query commands require a bounded scope (`workContextId`, `threadId`, `parentMessageId`, or `refKind`+`refValue`) and scoped actor tokens are checked against the resolved WorkContext.

WorkContext artifact operations are also part of the stable manifest: `work-context-artifacts.publish`, `list`, `show`, `pin`, `unpin`, `export`, and `doctor`. These commands expose PipelineHandoffArtifact storage through the hub without giving adapters private database paths or raw transcript access. `publish` accepts the artifact object through `--input-json`, `--input-file`, or `--artifact-file`; `list` is bounded and metadata-only; `show` validates payload integrity; `export` returns only the sanitized public-summary form and never raw payload bytes — artifacts without a public summary (i.e., private artifacts) return `403 FORBIDDEN` with reason code `WORK_CONTEXT_ARTIFACT_UNSAFE_PUBLIC_COPY`; `doctor` reports bounded store health/manifest metadata. Stale-head checks use `currentHeadSha` / `--current-head-sha` and return typed gateway errors rather than silently accepting evidence for the wrong PR head. Artifact writes (`publish`, `pin`, and `unpin`) require the dedicated `artifact:write` capability, including when a scoped actor token is used, so context-packet writers do not implicitly gain artifact publication authority.

### Pipeline handoff artifacts (#883/#884)

`handoff-artifacts.*` is the stable adapter-facing affordance for the #883 `PipelineHandoffArtifact` schema. It uses the same WorkContext artifact store as `work-context-artifacts.*`, but exposes pipeline-specific names and route checks so implementation, QA, review, and release agents can exchange exact-head handoff layers without private database paths or raw transcript access.

| Command                    | CLI shape                                                                                                              | Hub API path                               | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `handoff-artifacts.attach` | `relay-ide v1 handoff-artifacts attach --work-context-id <id> --artifact-file <pipeline-handoff-artifact.json> --json` | `POST /pipeline-handoff-artifacts`         | Requires `artifact:write`. Accepts the same validated artifact body as `work-context-artifacts.publish` through `--input-json`, `--input-file`, or `--artifact-file`. Optional metadata flags include `--project-id`, `--task-ref-kind/--task-ref-id`, `--stage`, `--visibility`, `--kind`, `--title`, `--summary`, `--current-head-sha`, `--supersedes-artifact-id`, and `--pin`. `--supersedes-artifact-id` is append-only: new layers may append stages, but must not mutate previous stages or change the covered head. |
| `handoff-artifacts.list`   | `relay-ide v1 handoff-artifacts list --work-context-id <id> --json` or `--task-ref-kind <kind> --task-ref-id <id>`     | `GET /pipeline-handoff-artifacts`          | Requires `context:read`. Returns bounded metadata only. Optional filters: `--project-id`, `--stage <implementation\|qa\|review\|release>`, `--limit`, `--include-superseded`, and `--current-head-sha`.                                                                                                                                                                                                                                                                                                                     |
| `handoff-artifacts.show`   | `relay-ide v1 handoff-artifacts show --id <artifact-id> [--current-head-sha <sha>] [--public] --json`                  | `GET /pipeline-handoff-artifacts/:id`      | Requires `context:read`. Without `--public`, returns the stored artifact envelope with payload integrity validation. With `--public`, returns only the sanitized public summary and fails closed if no safe public copy exists.                                                                                                                                                                                                                                                                                             |
| `handoff-artifacts.copy`   | `relay-ide v1 handoff-artifacts copy --id <artifact-id> [--output <path>] --json`                                      | `GET /pipeline-handoff-artifacts/:id/copy` | Requires `context:read`. Returns the bounded public-safe summary and can also write that JSON result to `--output`. Raw payload export is intentionally unsupported.                                                                                                                                                                                                                                                                                                                                                        |

Stale-head handling is explicit. `attach --current-head-sha <sha>` rejects mismatched artifact heads with `SESSION_CONFLICT` and `reasonCode: WORK_CONTEXT_ARTIFACT_STALE_HEAD`; `list --current-head-sha <sha>` and `show --current-head-sha <sha>` include `staleness` metadata (`stale`, `artifactHeadSha`, `currentHeadSha`) instead of silently accepting evidence for the wrong PR head. `handoff-artifacts.list`, `show`, and `copy` work with `--actor-token` / `RELAY_IDE_ACTOR_TOKEN` and `context:read`; `handoff-artifacts.attach` works with a scoped actor token only when that credential carries `artifact:write` for the target WorkContext.

Relay gate workers should use this surface as the standard live publication pattern: implementation attaches the initial `implementation` layer, QA appends `qa` with `--supersedes-artifact-id`, review appends `review`, and release appends `release`. Every layer must carry the exact PR URL/number, the exact covered `headSha`, and `staleIf.headShaChanges: true`; public copies must be generated through `handoff-artifacts.copy` or the shared public renderer so local paths, private task IDs, secrets/env, raw logs/transcripts, and dispatcher internals stay out of PR/issue comments. See [`pipeline-handoff-artifact-template.md`](pipeline-handoff-artifact-template.md) for the stage-by-stage worker pattern and live attach+append fixture.

## Command taxonomy

Relay command metadata is defined in [`shared/relay-command-manifest.ts`](../shared/relay-command-manifest.ts) as a projection of this v1 gateway contract. That module adds product-facing fields on top of each stable gateway command: `id`/`name`, label, description/summary, supported surfaces, input/output schemas, capability hints, side-effect class, confirmation requirement, scope kinds, and the public handler projection.

Current command surfaces are intentionally separate:

| Surface                        | Meaning                                                                                                                           | Execution path                                                                                                                     |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| UI-only Command Center actions | Browser affordances such as navigation, settings, local palette helpers, and workflow entry points that are not stable agent API. | Frontend action registry only; do not generate agent tools from these.                                                             |
| Stable CLI gateway commands    | Versioned `relay-ide v1 ... --json` commands in `RELAY_CLI_GATEWAY_CONTRACT`.                                                     | Public CLI JSON gateway; this is the adapter-facing contract.                                                                      |
| Agent-callable commands        | Gateway commands safe to expose to Claude/Codex/Hermes/MCP/ACP-style adapters through generated schemas.                          | Generated from the shared command manifest and executed through `relay-ide v1 ... --json`, never private node-link/browser routes. |

The Command Center may search and describe stable gateway commands using the shared manifest before browser execution is wired. The manifest carries the stable command id, CLI projection, side-effect class, capability hints, confirmation/control requirements, scope kinds, and audit redaction expectations. Until a `handler.uiAction` or explicit UI execution bridge exists, these entries must stay disabled/degraded in the palette and point operators to the stable CLI argv. Do not mark every internal UI button as agent-callable, and do not add Claude/Codex/Hermes-specific schemas by hand; add or change the Relay-owned command definition first.

Command Center resolver fixtures and explain/help copy are part of this contract, not a private prompt registry. Resolver-capable commands must preserve descriptor parity across `shared/cli-gateway-contract.ts`, `shared/relay-command-manifest.ts`, `shared/action-descriptor.ts`, Command Center action metadata, and the docs-backed explain corpus. Drift tests should fail when a resolver-capable command lacks side-effect class, confirmation/control policy, surfaces, schema, scope, availability/disabled reason, explain coverage, or an explicit UI-only/private opt-out rationale. Explain answers may cite docs/descriptor snippets and related command ids/action ids; they must not invent unlisted flows, raw shell execution, provider-agent launches, or write/destructive execution paths.

### Web UI action parity rule (#849/#860)

Relay's web UI is one client over this action contract. The agent-facing source of truth is the stable v1 gateway contract and shared manifest, not React handler names, Command Center labels, or private browser REST calls. UI-only helpers such as tab switching, dashboard sorting/filtering, dialog openers, clipboard helpers, terminal viewport scrolling, and external-link navigation must stay classified as UI-only until a follow-up issue defines a real agent/operator use case and adds a stable Relay-owned command descriptor.

The #857 inventory is kept in [`docs/refactor/857-action-parity-inventory.md`](refactor/857-action-parity-inventory.md), and the #860 follow-up map is kept in [`docs/refactor/860-action-contract-follow-up-map.md`](refactor/860-action-contract-follow-up-map.md). Remaining major web-only groups are tracked as explicit issues instead of TODO comments: session lifecycle (#869), workspace/worktree lifecycle (#870), ticket/PR branch workflows (#871), UI bridges to existing gateway commands (#872), and settings/integration mutations (#873).

## Auth and hub access

Local discovery commands (`contract.*`, `nodes.manifest`) do not require a hub token.

Hub-backed commands (`nodes.list`, `sessions.*`, `files.*`, `work-contexts.*`, `context.*`, `work-context-artifacts.*`, `handoff-artifacts.*`, `workflow-runs.*`, `automation-runs.*`, `inbox.*`, `handoffs.*`, `artifacts.*`, `supervisor.*`, `events.*`, `settings.*`, and `webhooks.*`) are in the CLI/agent lane, which is distinct from node credentials and the browser-only UI lane. #802 defines the scoped actor credential registry; #805 wires the first CLI gateway scoped credential lane.

### Scoped actor credential MVP (#805)

The scoped actor credential slice supports the read-only hub-backed set plus the closed write allowlist below. Write credentials must be issued for audience `relay:cli-gateway:v1`, include only the requested command's capability bit, and match the requested WorkContext/session/global-session/repo/task scope. The lane remains separate from browser cookies, node credentials, pair tokens, and `relay-ohg-v1...` handshake grants.

| CLI command                                                              | Stable command id               | Required capability | Notes                                                                                                                                            |
| ------------------------------------------------------------------------ | ------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `relay-ide v1 nodes list --json`                                         | `nodes.list`                    | `session:read`      | Reads summarized hub/node inventory.                                                                                                             |
| `relay-ide v1 sessions list --json`                                      | `sessions.list`                 | `session:read`      | Reads session descriptors and control summaries.                                                                                                 |
| `relay-ide v1 roster list --json`                                        | `roster.list`                   | `session:read`      | Reads the redacted active-agent roster; validates WorkContext scope when `--work-context-id` is present.                                         |
| `relay-ide v1 cockpit get --work-context-id <id> --json`                 | `cockpit.get`                   | `session:read`      | Reads one Active Work cockpit item and safe follow-up command hints; requires `context:read` and does not execute live controls.                 |
| `relay-ide v1 sessions get --id <id> --json`                             | `sessions.get`                  | `session:read`      | Validates the credential against the requested session/global session id when scoped that narrowly.                                              |
| `relay-ide v1 sessions screen --id <id> --json`                          | `sessions.screen`               | `session:read`      | Returns a bounded relay-pty/libghostty rendered screen snapshot; tmux-compat and remote-unavailable sessions fail closed with typed errors.      |
| `relay-ide v1 work-contexts get --id <id> --json`                        | `work-contexts.get`             | `session:read`      | Validates work-context scope when the credential is scoped to a work context.                                                                    |
| `relay-ide v1 work-context-artifacts list --work-context-id <id> --json` | `work-context-artifacts.list`   | `session:read`      | Reads bounded artifact metadata; requires `context:read` capability hint and enforces exact WorkContext scope when present.                      |
| `relay-ide v1 work-context-artifacts show --id <id> --json`              | `work-context-artifacts.show`   | `session:read`      | Reads one artifact envelope after metadata-derived WorkContext scope authorization; validates stored payload integrity; requires `context:read`. |
| `relay-ide v1 work-context-artifacts export --id <id> --json`            | `work-context-artifacts.export` | `session:read`      | Exports only the sanitized public-summary copy after metadata-derived WorkContext scope authorization; requires `context:read`.                  |
| `relay-ide v1 work-context-artifacts doctor --json`                      | `work-context-artifacts.doctor` | `session:read`      | Reads bounded artifact store diagnostics; requires `context:read`.                                                                               |

Write allowlist:

| CLI command                                                                           | Stable command id                                                                                | Required capability | Notes                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `relay-ide v1 context create ... --actor-token <token>`                               | `context.create`                                                                                 | `context:write`     | Creates a context packet when the body target scope matches.                                                                                                                                                                                                                                                              |
| `relay-ide v1 context pin/unpin ... --actor-token <token>`                            | `context.pin` / `context.unpin`                                                                  | `context:write`     | Pins or unpins a context packet for an authorized target.                                                                                                                                                                                                                                                                 |
| `relay-ide v1 inbox send ... --actor-token <token>`                                   | `inbox.send`                                                                                     | `inbox:write`       | Sends an inbox message only for the matched target session/global session/work-context/repo/task scope.                                                                                                                                                                                                                   |
| `relay-ide v1 inbox ack/resolve/ignore ... --actor-token <token>`                     | `inbox.ack` / `inbox.resolve` / `inbox.ignore`                                                   | `inbox:write`       | Applies state transitions; message/work-context scope is checked before mutation.                                                                                                                                                                                                                                         |
| `relay-ide v1 roster register/update-self --input-json '{...}' --actor-token <token>` | `roster.register` / `roster.updateSelf`                                                          | `context:write`     | Self-declared presence overlay (#964). Allowlisted safe fields only; unknown/secret-shaped keys rejected; heartbeat-expiring (TTL); `update-self` is owner-scoped and fails closed `NOT_FOUND`/`FORBIDDEN`.                                                                                                               |
| `relay-ide v1 automation-runs register/observe/retire ... --actor-token <token>`      | `automation-runs.register` / `automation-runs.observe` / `automation-runs.retire`                | `context:write`     | Watchdog/cron run registry (#959). Secret-shaped fields rejected; WorkContext scope checked when the run carries one; retire is idempotent. Reads (`automation-runs.list`/`automation-runs.get`) require `context:read`.                                                                                                  |
| `relay-ide v1 pr-overseer register/observe/retire ... --actor-token <token>`          | `pr-overseer.register` / `pr-overseer.observe` / `pr-overseer.retire`                            | `context:write`     | PR/check/review overseer (#960). Secret-shaped fields rejected; `workContextId` immutable across re-register and scope checked when the record carries one; `observe` fetches GitHub via the operator's `gh` and never merges; retire is idempotent. Reads (`pr-overseer.list`/`pr-overseer.get`) require `context:read`. |
| `relay-ide v1 work-context-artifacts publish/pin/unpin ... --actor-token <token>`     | `work-context-artifacts.publish` / `work-context-artifacts.pin` / `work-context-artifacts.unpin` | `artifact:write`    | Writes artifact-store entries only for matched WorkContext/repo/task metadata; artifact id routes re-check stored metadata before mutation.                                                                                                                                                                               |
| `relay-ide v1 handoff-artifacts attach ... --actor-token <token>`                     | `handoff-artifacts.attach`                                                                       | `artifact:write`    | Uses the same artifact-store write lane as `work-context-artifacts.publish`.                                                                                                                                                                                                                                              |
| `relay-ide v1 handoff-artifacts list --work-context-id <id> --json`                   | `handoff-artifacts.list`                                                                         | `session:read`      | Reads bounded PipelineHandoffArtifact metadata; requires `context:read` and enforces exact WorkContext scope when present.                                                                                                                                                                                                |
| `relay-ide v1 handoff-artifacts show --id <id> --json`                                | `handoff-artifacts.show`                                                                         | `session:read`      | Reads one PipelineHandoffArtifact envelope or safe public copy after metadata-derived WorkContext scope authorization; requires `context:read`.                                                                                                                                                                           |
| `relay-ide v1 handoff-artifacts copy --id <id> --json`                                | `handoff-artifacts.copy`                                                                         | `session:read`      | Copies only the sanitized public-summary form after metadata-derived WorkContext scope authorization; raw payload export is unsupported and requires `context:read`.                                                                                                                                                      |

Pass the credential with `--actor-token` or `RELAY_IDE_ACTOR_TOKEN`; `--actor-token` wins when both are present. `--correlation-id` or `RELAY_IDE_CORRELATION_ID` may be supplied for audit correlation. The CLI sends actor credentials as bearer auth with `x-relay-cli-gateway: v1`, `x-relay-cli-actor-token: v1`, `x-relay-cli-command`, and capability hints in `x-relay-capabilities`.

For artifact list commands, WorkContext-scoped actor credentials are checked against the requested `--work-context-id` (or `workContextId`/`work-context-id` query parameter). For artifact id reads/copies/exports, the gateway first loads artifact metadata, checks the stored `workContextId` against the actor credential `scope.workContextIds`, and only then reads or returns artifact payload/public-summary content. A mismatched scoped credential fails closed with `CLI_ACTOR_WRONG_WORK_CONTEXT_SCOPE`.

Examples:

```bash
relay-ide v1 nodes list --actor-token "$RELAY_IDE_ACTOR_TOKEN" --json
RELAY_IDE_ACTOR_TOKEN="$token" relay-ide v1 sessions list --json
relay-ide v1 sessions get --id <session-id-or-global-id> --actor-token "$token" --correlation-id cli-smoke-1 --json
relay-ide v1 work-contexts get --id <work-context-id> --actor-token "$token" --json
relay-ide v1 work-context-artifacts list --work-context-id <work-context-id> --actor-token "$token" --json
relay-ide v1 work-context-artifacts show --id <artifact-id> --actor-token "$token" --json
relay-ide v1 work-context-artifacts export --id <artifact-id> --actor-token "$token" --json
relay-ide v1 work-context-artifacts doctor --actor-token "$token" --json
relay-ide v1 handoff-artifacts list --work-context-id <work-context-id> --actor-token "$token" --json
relay-ide v1 handoff-artifacts show --id <artifact-id> --current-head-sha <sha> --actor-token "$token" --json
relay-ide v1 handoff-artifacts copy --id <artifact-id> --output ./handoff-public.json --actor-token "$token" --json
```

Local discovery commands (`relay-ide v1 --list --json`, `relay-ide v1 schema --json`, and `relay-ide v1 nodes manifest --json`) remain unauthenticated. Browser-session bearer compatibility remains for legacy local/dev gateway invocations through `RELAY_IDE_BROWSER_TOKEN`; that path is separate from the actor-token lane and must not be described as a scoped actor credential. When an invocation presents `--actor-token` or `RELAY_IDE_ACTOR_TOKEN`, the actor-token lane does not fall back to browser cookies/PIN state or node credentials. `--port` or `RELAY_IDE_PORT` selects the local hub port; otherwise Relay uses the default port.

### Mint, use, revoke, and rotate

The current MVP exposes credential lifecycle through hub operator endpoints, not through stable `relay-ide v1` adapter commands. Browser-authenticated operators may mint/list/revoke with the existing hub operator auth path after PIN/browser-session login. #815 also allows an approved one-time operator handshake grant for the same lifecycle without browser-cookie fallback. Grant-backed lifecycle calls must carry a handshake `grantHandle`, exact audience `relay:cli-gateway:v1`, actor type/id, explicit `session:read` capability bits, at least one concrete scope dimension, TTL or expiry, and a correlation id.

Mint a short-lived CLI actor token with browser operator auth:

```bash
curl -sS -X POST http://127.0.0.1:3456/cli-gateway/actor-credentials \
  -H 'Content-Type: application/json' \
  -b 'token=<operator-browser-session-cookie>' \
  -d '{
    "actor": { "type": "cli", "id": "relay-cli" },
    "issuer": { "id": "operator" },
    "ttlMs": 300000,
    "scope": { "taskRefs": ["relay:cli-gateway:v1:read"] },
    "correlationId": "cli-actor-mint-1"
  }'
```

Mint the same token family with an approved handshake grant:

```bash
curl -sS -X POST http://127.0.0.1:3456/cli-gateway/actor-credentials \
  -H 'Content-Type: application/json' \
  -d '{
    "grantHandle": "<approved-one-time-handshake-grant>",
    "audience": "relay:cli-gateway:v1",
    "actor": { "type": "cli", "id": "relay-cli" },
    "capabilities": ["session:read"],
    "ttlMs": 300000,
    "scope": { "sessionIds": ["<session-id>"] },
    "correlationId": "cli-actor-grant-mint-1"
  }'
```

The response includes `token` once and a public `credential` record. Store the token in the calling process or a secret manager; do not paste it into issues, logs, screenshots, or test snapshots. Use the returned `credential.id` for list/revoke/audit references. Public records include the issuer/grant id and redacted metadata only; raw grant handles and bearer material are never returned.

List public credential records with browser auth or a fresh grant handle:

```bash
curl -sS http://127.0.0.1:3456/cli-gateway/actor-credentials \
  -b 'token=<operator-browser-session-cookie>'

curl -sS -X POST http://127.0.0.1:3456/cli-gateway/actor-credentials/list \
  -H 'Content-Type: application/json' \
  -d '{"grantHandle":"<approved-one-time-handshake-grant>","audience":"relay:cli-gateway:v1","actor":{"type":"cli","id":"relay-cli"},"capabilities":["session:read"],"scope":{"sessionIds":["<session-id>"]},"correlationId":"cli-actor-grant-list-1"}'
```

Revoke by credential id with browser auth or a fresh grant handle:

```bash
curl -sS -X DELETE http://127.0.0.1:3456/cli-gateway/actor-credentials/<credential-id> \
  -H 'Content-Type: application/json' \
  -b 'token=<operator-browser-session-cookie>' \
  -d '{"revokedBy":"operator","reason":"rotation","correlationId":"cli-actor-revoke-1"}'

curl -sS -X POST http://127.0.0.1:3456/cli-gateway/actor-credentials/<credential-id>/revoke \
  -H 'Content-Type: application/json' \
  -d '{"grantHandle":"<approved-one-time-handshake-grant>","audience":"relay:cli-gateway:v1","actor":{"type":"cli","id":"relay-cli"},"scope":{"sessionIds":["<session-id>"]},"correlationId":"cli-actor-grant-revoke-1"}'
```

Rotation is mint-new-then-revoke-old in this slice. The grant-backed rotate endpoint performs that ordering in one request with a fresh grant handle and returns `{ token, credential, revoked }`; browser-authenticated operators can do the same manually by issuing a replacement credential, updating the automation to use the new token, then revoking the old credential id. Revocation is in-process and applies to future validations by id/jti; expiry is checked on every validation.

```bash
curl -sS -X POST http://127.0.0.1:3456/cli-gateway/actor-credentials/<credential-id>/rotate \
  -H 'Content-Type: application/json' \
  -d '{"grantHandle":"<approved-one-time-handshake-grant>","audience":"relay:cli-gateway:v1","actor":{"type":"cli","id":"relay-cli"},"ttlMs":300000,"scope":{"sessionIds":["<session-id>"]},"correlationId":"cli-actor-grant-rotate-1"}'
```

Grant-backed requests are denied before minting when the handle is revoked, expired, replayed, from a different credential lane, scoped to another actor/session/task, asks for another audience, omits scope/TTL, or requests wildcard/unknown/non-allowlisted capabilities. Denial copy must mention stable reason codes, credential/grant ids, and correlation ids only; redact bearer tokens, grant handles, cookies, node credentials, approval secrets, and raw secret-looking reason strings.

### Lane separation

| Lane                         | Credential source                                                                                                  | Valid surfaces                                                                                                                        | Must not satisfy                                                                                                                                  | Audit/redaction promise                                                                                                                                                    |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Browser cookie / PIN session | Existing browser login/PIN session cookie.                                                                         | Browser UI, operator endpoints such as mint/list/revoke above, and legacy CLI gateway compatibility paths that have not migrated yet. | The scoped actor-token lane, `/hub/node-link`, heartbeat, node pairing/reconnect.                                                                 | Browser cookie/token material is redacted; use safe session/operator metadata only.                                                                                        |
| Node credential              | Node credential material issued through node pairing/lifecycle.                                                    | Node heartbeat and `/hub/node-link`.                                                                                                  | Browser UI auth, CLI actor token, “act as human/agent” auth.                                                                                      | Use node id and credential id/hash; never log raw node token material.                                                                                                     |
| Scoped actor token           | Explicit `--actor-token` / `RELAY_IDE_ACTOR_TOKEN` issued by the scoped actor registry for `relay:cli-gateway:v1`. | The read allowlist above plus the closed write allowlist for `context:write`, `inbox:write`, and `artifact:write`.                    | Browser routes, node link/heartbeat, control/session input/settings/webhook/file/repo mutation, or any command outside the implemented allowlist. | Use actor id/type, issuer, credential id/jti, requested/granted capability bits, requested scope hash/ids, and correlation id; redact raw `relay-sac-v1...` bearer values. |

### Failure examples

Missing or rejected actor credentials use the normal gateway envelope shape (`ok: false`, `contract: "v1"`, command id, stable `error.code`, `retryable: false`) and the CLI exits nonzero. Current server-side lane failures include `lane: "denied"`, `acceptedLanes: ["scoped-actor-credential"]`, and `audience: "relay:cli-gateway:v1"` without token material.

Stable reason codes in this slice include:

| Case                                                    | HTTP / envelope code            | Reason code                                                                                                                                 |
| ------------------------------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Missing bearer on an actor-marked MVP request           | `UNAUTHORIZED`                  | `CLI_ACTOR_CREDENTIAL_MISSING`                                                                                                              |
| Browser cookie/PIN supplied to the actor lane           | `UNAUTHORIZED`                  | `CLI_ACTOR_BROWSER_COOKIE_REJECTED`                                                                                                         |
| Node credential supplied to the actor lane              | `UNAUTHORIZED`                  | `CLI_ACTOR_NODE_CREDENTIAL_REJECTED`                                                                                                        |
| Actor token used on a command outside the MVP allowlist | `UNAUTHORIZED`                  | `CLI_ACTOR_ROUTE_UNSUPPORTED`                                                                                                               |
| Unsupported bearer type                                 | `UNAUTHORIZED`                  | `CLI_ACTOR_CREDENTIAL_UNSUPPORTED_TYPE`                                                                                                     |
| Malformed/unknown token material                        | `UNAUTHORIZED`                  | `CLI_ACTOR_MALFORMED_CREDENTIAL`                                                                                                            |
| Wrong/unknown audience                                  | `FORBIDDEN` or issue-time `400` | `CLI_ACTOR_WRONG_AUDIENCE` / `CLI_ACTOR_UNKNOWN_AUDIENCE`                                                                                   |
| Expired or revoked credential                           | `UNAUTHORIZED`                  | `CLI_ACTOR_EXPIRED` / `CLI_ACTOR_REVOKED`                                                                                                   |
| Missing or wrong scope                                  | `FORBIDDEN`                     | `CLI_ACTOR_MISSING_SCOPE`, `CLI_ACTOR_WRONG_SESSION_SCOPE`, `CLI_ACTOR_WRONG_GLOBAL_SESSION_SCOPE`, or `CLI_ACTOR_WRONG_WORK_CONTEXT_SCOPE` |
| Unknown or insufficient capability                      | `FORBIDDEN`                     | `CLI_ACTOR_UNKNOWN_CAPABILITY` / `CLI_ACTOR_INSUFFICIENT_CAPABILITY`                                                                        |

Messages and details must not echo `relay-sac-v1...` tokens, bearer headers, browser cookies, node credential material, secret hashes, or raw secret-looking scope/params. Use credential ids, jtis, correlation ids, hashes, and redacted summaries when reporting gateway auth failures or migration evidence.

### Explicit non-goals for the first actor-token PR

This slice does not migrate every v1 command and does not migrate adapter packages broadly. The actor-token lane does not cover `sessions.create`, `sessions.attach`, `sessions.detach`, `sessions.stream`, `sessions.input`, `files.*`, `context.*`, `inbox.*`, `handoffs.*`, `artifacts.*`, `supervisor.*`, `events.subscribe`, write/control/session-input/event-stream surfaces, browser auth replacement, node proof-of-possession, node credential lifecycle, approval UX, MFA/passkeys, enterprise RBAC, or public multi-tenant hosting.

This boundary is part of the #797/#798/#802 split: #427 provided the trust-tier/capability/audit/confirmation backbone, #798 inventories routes and clarifies browser-session vs actor/node credentials, and #802 provides the scoped actor credential lifecycle primitive. Follow-up work may replace local browser-token compatibility with scoped actor credentials, but adapters should treat that as a credential migration, not a reason to reuse node credentials, browser UI cookies, or browser-only private routes.

## Settings and webhook gateway contracts (#873)

`settings.*` and `webhooks.*` expose a narrow operational slice for CLI/agent adapters. They are not a raw config API, and they are browser-operator-session-only for now.

| Command                                                    | Current auth boundary    | Side effect | Contract                                                                                                                                                                |
| ---------------------------------------------------------- | ------------------------ | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `relay-ide v1 settings get --json`                         | Browser operator session | read        | Returns only `defaultAgent`, `defaultContinue`, `defaultYolo`, `defaultNotifications`, `claudeFullscreen`, `renamerTool`, and `updateChannel`, plus redaction metadata. |
| `relay-ide v1 settings update --input-json '{...}' --json` | Browser operator session | write       | Updates one allowlisted key. Unknown keys, wrong value types, command/path-shaped `defaultAgent`, and unconfirmed risky transitions fail closed.                        |
| `relay-ide v1 webhooks status --json`                      | Browser operator session | read        | Returns bounded webhook relay status, repo webhook states, Smee connection status, and redaction metadata.                                                              |
| `relay-ide v1 webhooks ping --json`                        | Browser operator session | write/probe | Runs a safe configuration ping/status probe without delivering secrets or raw webhook URLs.                                                                             |

Settings update accepts either `--input-json` / `--input-file` with `{ "key", "value", "confirmRiskyWrite"? }` or typed flags (`--key`, `--value` / `--value-json`, optional `--confirm-risky-write`). `defaultYolo: true` and `updateChannel` changes require `confirmRiskyWrite: true`; otherwise the hub returns `CONFIRMATION_REQUIRED` with a bounded challenge that names only the key and requested value. The shared security policy still defines settings/webhook capability bits as future grant names, but they are not trusted for these routes yet.

All responses include redaction metadata. The gateway must never return raw config, bearer/browser/node tokens, GitHub tokens, webhook secrets, Smee URLs, connection strings, or secret-looking values. `webhooks.status` and `webhooks.ping` intentionally expose booleans/status strings instead of `github.webhookSecret` or `github.smeeUrl`.

These routes are mounted under `/cli-gateway`, but they are wired through the browser operator-session middleware rather than the scoped actor-token lane. Caller-supplied `x-relay-capabilities` is ignored and must not be treated as an authorization boundary; the v1 contract intentionally publishes empty `capabilityHints` for `settings.*` and `webhooks.*`. Scoped actor/bearer settings and webhook grants remain future credential-lifecycle work.

## Session descriptors

`nodes list`, `sessions list`, `sessions get`, `sessions create`, `sessions attach`, `sessions detach`, `sessions kill`, and `sessions rename` return existing backend descriptors or lifecycle summaries, wrapped in gateway envelopes. Session descriptors are expected to include the already-available identity and control fields where present:

- `id`, `globalSessionId`, `nodeId`
- `type`, `agent`, `mode`, `cwd`
- optional `repoPath` / `worktreePath` as context, not identity
- `sessionEnvelope` with #426 intent/scope/lifecycle/peer identity
- #470/#493 control summary fields such as `controlMode`, `activeActors`, `activeWorker`, `lastInterventionAt`, `lastInterventionBy`, `lastInterventionEventId`, `controlFreshness`, and `controlReason`

External brain/agent peer identity is reserved for hub-owned credential/session registry work. v1 currently documents the envelope field but only round-trips `local-user`, `relay-node`, and `unknown` peer identities; routed creates are represented as `relay-node` peers. Adapters must not add impersonation flags such as `--act-as-node` or `--brain`.

## Session create, attach, and detach

`sessions create` accepts either `--input-json`, `--input-file`, or typed flags. `nodeId` selects routed node creation through `/hub/nodes/:nodeId/sessions`; omitting it uses the current local `/sessions` path.

Web launch parity (#859): the converted browser launch actions use the same stable command id, descriptor, and envelope as this CLI command. `sessionCreateActionDescriptor()` is generated from `relayCommandDefinition('sessions.create')`; `session.new-agent`, `session.new-terminal`, `session.start-on-repo`, and `session.start-work-in-env` attach that descriptor in the action registry. Their input is the `sessions.create` schema / `CreateSessionBody`, success is `RelayCliGatewayEnvelope<SessionSummary>`, and errors use the normal gateway error envelope. `sessionCreateActionAvailability()` carries the shared availability state for missing workspace/cwd/selected environment, offline node, and unsupported capability reasons. Do not document unconverted browser actions as `sessions.create` parity just because they eventually start a session after private branch/worktree/ticket semantics.

Supported now:

- local repo/worktree-backed session creation using `repoPath` and optional `worktreePath`
- routed node creation with `nodeId`, `cwd`, `type` (defaulting to `agent` when omitted), `mode`, `agent`, lifecycle fields, and optional non-agent `sessionEnvelope` where the existing backend supports them
- routed node creation with the typed `environment` object (see [Typed environment IDs](#typed-environment-ids-626) below)
- optional `terminalBackend`, with `relay-pty` as the only accepted value; `tmux-compat` fails closed as an unsupported legacy backend
- `controlMode=agent-driven` only for routed node creation, where hub/node policy and hand-back state can be checked
- descriptor-only attach with `sessions attach --id ... --json`
- safe detach with `sessions detach --id ... --json`; this resolves the session and releases only the CLI gateway handle, leaving the underlying Relay session/process running

## Ticket and branch workflow session commands

`tickets start-work` and `branches open-session` are stable v1 workflow commands for adapters that want a single backend contract for “resolve this ticket or branch into a worktree and open a Relay session.” They intentionally sit above raw `sessions create`: the CLI resolves the local git branch/worktree policy first, then creates a normal `/sessions` backend session with `repoPath`, `worktreePath`, `branchName`, session options, and optional initial prompt/control handoff metadata. The local `/sessions` path derives `cwd` from the resolved repo/worktree and workflow delegation does not send an explicit `cwd` field.

Supported now:

- local repo execution only (`repo.nodeId` may be omitted or `local`); remote node workflow routing returns `UNSUPPORTED` until node-side git/worktree capability routing exists
- `branch.name`, or `pr.head`, or `pr.number` (via `gh pr view`) as the branch target
- worktree policy `reuse-existing` (default), `create-if-missing`, or `reject-if-missing`
- optional `worktree.worktreePath` for an explicit existing or newly-created worktree path
- optional dirty/conflict overrides with `worktree.allowDirty` and `worktree.allowConflicted`
- `session` options forwarded through the existing session-create validator (`type`, `mode`, `agent`, `terminalBackend`, dimensions, continuation policy, `workContextId`, `controlMode`)
- `prompt.mode="initial-prompt"` to deliver prompt text through the stable `sessions.create.initialPrompt` path; raw PTY prompt injection is deliberately not a gateway contract

Minimal examples:

```json
{
  "ticket": {
    "source": "github",
    "id": "871",
    "url": "https://github.com/donovan-yohan/relay-ide/issues/871"
  },
  "repo": { "repoPath": "/Users/me/code/relay-ide" },
  "branch": {
    "name": "issue-871-backend-start-work-branch-contract",
    "base": "origin/nightly"
  },
  "worktree": { "mode": "create-if-missing" },
  "session": { "type": "agent", "agent": "claude" },
  "prompt": { "mode": "initial-prompt", "prompt": "Work issue #871." }
}
```

```json
{
  "repo": { "repoPath": "/Users/me/code/relay-ide" },
  "pr": { "number": 123 },
  "worktree": { "mode": "reuse-existing" },
  "session": { "type": "terminal", "terminalBackend": "relay-pty" }
}
```

Fail-closed behavior:

- workflow commands require `RELAY_IDE_BROWSER_TOKEN` before git/worktree mutation; `--actor-token` is read-only in this slice
- missing `ticket` on `tickets.startWork`, missing `repo.repoPath`, or missing branch/PR identity returns `INVALID_ARGUMENT`
- missing worktree under `reuse-existing` / `reject-if-missing` returns `NOT_FOUND`
- unknown branch without a provided base under `create-if-missing` returns `NOT_FOUND`
- dirty or conflicted worktrees return `SESSION_CONFLICT` unless explicitly allowed
- explicit unsupported prompt handoff with `requireTypedDelivery=true` returns `UNSUPPORTED`

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

`relay-ide v1 sessions kill --id <id> [--confirmation-token <token>] --json` resolves local and routed session IDs before calling the Relay-owned lifecycle route. Local sessions use `DELETE /sessions/:id`; routed sessions use `DELETE /hub/nodes/:nodeId/sessions/:sessionId`, which forwards `sessions.kill` over node-link RPC and removes the hub's scoped session envelope only after the node acknowledges. The command requires `session:control:kill`, is marked destructive in the manifest, forwards retry tokens as `x-confirmation-token`, and remains subject to the existing high-risk confirmation policy.

`relay-ide v1 sessions rename --id <id> --display-name <name> --json` uses `PATCH /sessions/:id` locally and `PATCH /hub/nodes/:nodeId/sessions/:sessionId` remotely. Remote renames forward `sessions.rename` over node-link RPC and require `session:control:rename`; they fail closed on stale envelopes, offline nodes, and policy denial.

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

## Exact-operation confirmation challenges (#807)

High-risk routed operations can return a normal error envelope with `error.code: "CONFIRMATION_REQUIRED"` and `error.details.challenge`. The challenge is the pause point: the agent or adapter must stop before executing the operation, show the human/operator enough safe metadata to decide, and wait for an approved token. Do not auto-approve from the same actor/session, and do not treat approval as a reusable capability grant.

The challenge is bound to the original requester, node, session/work context, intent/action/target, capability bits, scope hash, canonical params hash, TTL, and approval target. For File RPC writes, the canonical params include action, path, mode, expected hash, decoded byte count, and SHA-256 of the bytes; raw file bytes and confirmation tokens are not safe to log. For exec-style operations, command and cwd may be shown to the approving human but should not be pasted into durable logs if they contain secret-looking values.

The currently implemented retry shape is:

1. The original command returns `CONFIRMATION_REQUIRED` with a `challengeId`, status, reason code, expiry, required/challenge bits, and contract metadata.
2. A distinct authenticated human/operator approves or denies through the existing hub confirmation surface (`POST /hub/confirmations/:challengeId/approve`). This MVP does not ship passkey/WebAuthn/TOTP, multi-approver policy, or a broad approval center.
3. The original requester fetches its one-time token with `POST /hub/confirmations/:challengeId/requester-token`.
4. The requester retries the same CLI operation with `--confirmation-token <token>` or `confirmationToken` in the request body.

Denial, expiry, requester mismatch, context drift, parameter drift, same-session/self-approval, wrong approval target, audit-write failure, and token reuse fail closed. After any of those outcomes, retrying begins with a new command attempt and a fresh challenge. Reusing the old token or changing parameters under the approved token must be reported as a failed redemption, not retried silently.

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

`relay-ide v1 sessions wait --id <id> --output-text <text> --timeout-ms 30000 --json` is the first-class bounded wait primitive for raw PTY output. It opens the same temporary authenticated attach socket as `stream`, watches UTF-8 bytes until the raw output contains `<text>`, then detaches only the CLI/WebSocket handle. Success returns one normal JSON envelope with `data.model: "raw-output"`, `data.status: "matched"`, `predicate: { kind: "output-text", value: <text> }`, `elapsedMs`, `bytesObserved`, `truncated`, `timeoutMs`, `maxBytes`, and session/node metadata.

Idle waits use the same raw-output model but wait for quiet instead of a substring:

```bash
relay-ide v1 sessions wait --id remote-session-1 --idle-ms 1000 --timeout-ms 30000 --json
```

Exactly one predicate is allowed: `--output-text <text>`, `--idle-ms <ms>`, or `--screen-text <text>`. The current MVP intentionally does not implement rendered-screen matching; `--screen-text` fails with `UNSUPPORTED` and `details.reasonCode: "RENDERED_SCREEN_UNSUPPORTED"` so adapters do not silently confuse raw stream bytes with visible terminal screen state. Mixed or missing predicates fail with `INVALID_ARGUMENT` before the CLI attaches. Timeouts, closed attach streams, and max-byte caps fail with nonzero gateway envelopes (`WAIT_TIMEOUT`, `SESSION_STREAM_CLOSED`, `WAIT_MAX_BYTES_EXCEEDED` in `details.reasonCode`) instead of falling back to sleep/poll loops. `--timeout-ms` and `--max-bytes` are bounded; the default wait timeout is 30 seconds and the default observation cap is 65536 bytes.

`relay-ide v1 sessions input --id <id> --data <text> --json` sends one UTF-8 chunk to the PTY attach path and then detaches the CLI handle. `--data-base64` is available for arbitrary bytes encoded as base64, and `--stdin` reads the chunk from standard input. Exactly one of `--data`, `--data-base64`, or `--stdin` is required; mixed or missing input sources fail with `INVALID_ARGUMENT` before Relay opens the temporary attach socket. For smoke tests and adapter handshakes, `--wait-for <text>` keeps the temporary attach open until the observed raw output contains the marker, then returns a single `sessions.input` envelope with `matched`, `output`, `bytesSent`, and `bytesReceived`. Use `--timeout-ms <n>` and `--max-bytes <n>` to bound the wait.

`sessions.input --wait-for` is a raw PTY-output substring wait. It is not a rendered-screen wait and must not be treated as proof of visible viewport/cursor/title state. A future Boo-style screen wait must be added as a separate stable gateway command/schema before adapters depend on terminal-model semantics.

To steer an interactive agent/TUI — type a prompt and submit it — prefer the typed [`supervisor submit`](#supervisor-typed-actions-and-rmux-mapping-704) primitive over raw `sessions.input` scripts. `supervisor submit --text ...` hides newline/carriage-return weirdness (it appends the submit carriage return itself, so you never send a second `\r`), handles paste-ish/long bodies, optionally clears the current input, and returns structured submission evidence. Raw `sessions.input` is for narrow smoke/debug and emergency fallback.

Example:

```bash
relay-ide v1 sessions input --id remote-session-1 --data 'printf relay-ok\\n\n' --wait-for relay-ok --json
```

`stream`, `wait`, and `input` detach only their CLI/WebSocket handle. They do not kill the underlying Relay session or selected terminal-backend process. Missing sessions, expired envelopes, rejected policy, offline nodes, and closed attach sockets surface as typed gateway error envelopes; adapter authors must not fall back to private `/hub/node-link` messages.

## Provider-native state commands

Provider-native session state adapters are intentionally internal in this slice. `shared/cli-gateway-contract.ts` does not expose stable v1 `providers.*` or `native-sessions.*` commands yet. External adapters must continue to treat missing provider-state verbs as unsupported rather than calling private REST routes or reading provider stores themselves.

When promoted to v1, the surface must preserve the same boundary as `AgentHarnessStateAdapter`: detection/list/import/read-state are read-only, snapshots are redacted and bounded, and open/resume returns copyable argv data without executing the provider CLI.

## Supervisor typed actions and rmux mapping (#704)

The stable supervisor surface is Relay-owned command API, not raw PTY, tmux, or rmux API. The implementation source of truth is `shared/cli-gateway-contract.ts`, with shared response types in `shared/supervisor-actions.ts` and server execution in `server/supervisor-actions.ts`.

Commands:

| Command                                                                                                 | Purpose                                                                                                                                                                    | Required capabilities                                                                                     |
| ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `relay-ide v1 supervisor sessions --json`                                                               | Lists sessions and per-action eligibility.                                                                                                                                 | `session:read`, `tab:intervention:read`                                                                   |
| `relay-ide v1 supervisor snapshot --id <session-id-or-global-id> --json`                                | Reads one redacted supervisor snapshot.                                                                                                                                    | `session:read`, `tab:intervention:read`                                                                   |
| `relay-ide v1 supervisor send-text --id <session-id-or-global-id> --text <literal-text> --json`         | Sends bounded literal text as a typed intervention.                                                                                                                        | `session:attach`, `tab:intervention:send-text`                                                            |
| `relay-ide v1 supervisor send-text --target-ids <id-1,id-2> --text <literal-text> --json`               | Sends the same bounded literal text to multiple sessions and reports per-target results.                                                                                   | `session:attach`, `tab:intervention:send-text`                                                            |
| `relay-ide v1 supervisor send-key --id <session-id-or-global-id> --key <key-name> --json`               | Sends one canonical closed-enum key as a typed intervention.                                                                                                               | `session:attach`, `tab:intervention:send-key`                                                             |
| `relay-ide v1 supervisor send-key --target-ids <id-1,id-2> --key <key-name> --json`                     | Sends the same canonical key to multiple sessions and reports per-target results.                                                                                          | `session:attach`, `tab:intervention:send-key`                                                             |
| `relay-ide v1 supervisor submit --id <session-id-or-global-id> --json`                                  | Submits Enter (carriage return) as a typed intervention.                                                                                                                   | `session:attach`, `tab:intervention:submit`                                                               |
| `relay-ide v1 supervisor submit --id <id> --text <prompt> [--clear-input] [--paste] [--dry-run] --json` | Typed submit primitive: optionally clears the input, types a (multi-line) body, then submits with an owned carriage return; returns structured submission evidence (#958). | `session:attach`, `tab:intervention:submit`, `tab:intervention:send-text` (only when `--text` is present) |
| `relay-ide v1 supervisor submit --target-ids <id-1,id-2> --json`                                        | Submits to multiple sessions and reports per-target results.                                                                                                               | `session:attach`, `tab:intervention:submit`                                                               |

Inputs:

- `supervisor.sessions` takes no input and returns `{ command: "supervisor.sessions", sessions, count }`. Each session includes `sessionId`, optional `globalSessionId`/`nodeId`, `mode`, `status`, optional `controlMode`/`controlFreshness`, and `actions.sendText` / `actions.sendKey` / `actions.submit` eligibility. Ineligible actions carry a `reasonCode` such as `SESSION_DISCONNECTED`, `SESSION_MODE_UNSUPPORTED`, `CONTROL_STATE_STALE`, or `CONTROL_STATE_UNKNOWN`.
- `supervisor.snapshot` requires `id`. Optional `--expected-control-mode <agent-driven|human-driven|co-driven>` and `--latest-seen-intervention-event-id <event-id>` are preflight guards. Stale or mismatched control state returns `CONTROL_STATE_STALE`; an unacknowledged newer intervention returns `INTERVENTION_ACK_REQUIRED`. The snapshot path is read-only: it never writes to the session, accepts prompts, or stores raw prompt/transcript/PTY/provider state.
- `supervisor.sendText` requires `text` plus exactly one target shape: `id` or `targetIds`. CLI flags are `--id`, positional `<id>`, or comma-separated `--target-ids`; `--input-json` / `--input-file` may provide the same object shape, including optional `actor` metadata. Text must be non-empty literal text, at most 1000 characters, with no CR/LF, ESC, DEL, or control characters except tab. Use `supervisor.submit` for Enter instead of embedding a newline.
- `supervisor.sendKey` requires `key` plus exactly one target shape: `id` or `targetIds`. CLI flags are `--id`, positional `<id>`, comma-separated `--target-ids`, and `--key`; `--input-json` / `--input-file` may provide the same object shape, including optional `actor` metadata. Keys are a closed enum only: `escape`, `tab`, `arrow-up`, `arrow-down`, `arrow-left`, `arrow-right`, `ctrl-c`, `ctrl-d`, `home`, `end`, `page-up`, and `page-down`. Aliases, function keys, raw escape/control strings, newlines, and arbitrary byte payloads are rejected; Relay maps the canonical name to substrate bytes behind the capability/control/audit boundary.
- `supervisor.submit` is the typed submit primitive for agent/TUI steering (#958). It requires `id` or `targetIds` and accepts optional `actor` metadata. It owns the submission: it always ends with a single carriage return (Enter, `\r`) — the carriage return the browser Enter key sends — so callers never need to send a second raw `\r`. (The pre-#958 behavior wrote a bare line feed `\n`, which is exactly what left text sitting unsubmitted in carriage-return-driven TUIs.) Optional fields:
  - `text` (CLI `--text`, also accepted via `--input-json`): a message body to type before submitting. Unlike `send-text`, it may contain newlines (multi-line prompts) and tabs, up to 100,000 characters; embedded `\r\n` / lone `\r` are normalized to `\n` and trailing newlines are stripped before the owned carriage return is appended. ESC/DEL and other control bytes are still rejected (`TEXT_MUST_BE_LITERAL`) so this stays a typed text primitive, not a raw byte-injection API. Supplying `text` additionally requires the `tab:intervention:send-text` capability.
  - `clearInput` (CLI `--clear-input`): clears the current input buffer first (best-effort Ctrl-U), so a partially-typed prompt is replaced rather than appended to.
  - `paste` (CLI `--paste`): wraps the body in DEC 2004 bracketed-paste markers so long/multi-line content is inserted as one paste; recommended for paste-ish bodies.
  - `dryRun` (CLI `--dry-run`): previews the planned submission — eligibility, ordered `steps`, and `charsAccepted`/`plannedBytes` — without writing to the PTY or emitting an audit intervention.
  - Each `data.results[]` entry carries submission evidence: `charsAccepted`, `bytesAccepted`, `submitPerformed`, `submitKey` (`enter`), `clearInputPerformed`, `pasteBracketed`, `steps` (`clear-input` → `type-text` → `submit`), `bytesWritten` / `plannedBytes`, and a best-effort `postSubmit` observation (`{ available, agentState, idle }`) derived from the session snapshot when the backend exposes a classified state.

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
    "counts": {
      "requested": 1,
      "succeeded": 1,
      "denied": 0,
      "failed": 0,
      "skipped": 0
    },
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
    "redaction": {
      "rawContentAvailable": false,
      "rawContentStored": false,
      "hashesOnly": true
    }
  }
}
```

Action failure semantics:

- CLI parse/auth/connectivity failures return a normal `ok: false` gateway envelope and the CLI exits nonzero. Examples: malformed `--input-json`, missing `RELAY_IDE_BROWSER_TOKEN`, unreachable hub, missing `--id`/`--target-ids`, or missing `--text` for `send-text`.
- Once the action request reaches the hub, target-level problems are reported in the successful action envelope under `data.results[].error` with aggregate `data.counts` and `data.audit.partialFailure`. This preserves multi-target partial success instead of failing the whole command on the first bad target.
- Per-target errors use typed `code`, `reasonCode`, `message`, `retryable`, and optional `details`. Current reason codes include `CAPABILITY_REQUIRED`, `SESSION_NOT_FOUND`, `SESSION_DISCONNECTED`, `CONTROL_STATE_STALE`, `CONTROL_STATE_UNKNOWN`, `SESSION_MODE_UNSUPPORTED`, `TEXT_REQUIRED`, `TEXT_TOO_LARGE`, `TEXT_MUST_BE_LITERAL`, `KEY_REQUIRED`, `KEY_INVALID`, and `UPSTREAM_WRITE_FAILED`.
- `counts.denied` is for capability denials (`FORBIDDEN`). Other per-target errors increment `counts.failed`. `counts.skipped` is reserved for future fan-out decisions.
- Audit stores actor summary, target session IDs/count, action type, optional canonical send-key name, timestamp, hashes/counts/classes for content, and the aggregate partial-failure flag. Raw supervisor text or mapped terminal bytes are not returned or stored by default.

This is deliberately distinct from raw PTY input and terminal substrates:

- `sessions input` (and the underlying `POST /sessions/:id/input`) remains the raw PTY input path for narrow smoke/debug use. It writes bytes through the temporary attach path, can wait for output markers, and is useful for adapter handshake tests, but it is **not** the blessed typed agent-to-agent command API. To steer a running agent/TUI — type a prompt and have it submit — use `supervisor submit --text ...` (#958), which owns the carriage return and returns structured submission evidence; the old raw-input pattern of "POST text with a newline, then POST a second `\r` to make it submit" is an emergency fallback only.
- Existing browser/human PTY input remains a different event/API path from supervisor automation interventions.
- Historical rmux/tmux prototypes may appear in design notes, but adapters must not call rmux actions, rmux broadcast, tmux send-keys, or shell commands as stable Relay API. Add or extend a Relay-owned `relay-ide v1 supervisor ... --json` command first, then map that typed command to the supported substrate behind Relay capability, control-state, and hashes-only audit checks.

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

Only these file operations are stable in v1:

- `files.list` maps to `fs.list` and requires `session:read` + `rpc:fs:list`.
- `files.stat` maps to `fs.stat` and requires `session:read` + `rpc:fs:read`.
- `files.read` maps to `fs.read` and requires `session:read` + `rpc:fs:read`.
- `files.write` maps to `fs.write` and requires `session:read` + `rpc:fs:write`. Capability is off by default; operators must grant `rpc:fs:write` per node. Uses atomic-rename on the node executor. Prod-tier nodes gate writes behind a confirmation challenge.

### Browser editor parity and the two write paths (#1004)

The web file editor and these CLI commands operate on the **same files through two intentionally distinct, scoped abstractions** — there is no third write path:

- **Browser editor** (`CodeMirrorFileEditor`) reads via `GET /workspaces/file-content` and writes via `PUT /workspaces/file-content`, a workspace-scoped HTTP route with mtime/SHA optimistic concurrency, atomic write, and a size cap. This is what the save button, `Cmd/Ctrl+S`, and the stale-disk conflict bar drive.
- **CLI / agents** use `files.read` / `files.write`, the session-scoped File RPC above. `files.write` stays capability-gated (`rpc:fs:write`, off by default) and confirmation-gated on prod-tier nodes.

To keep the two discoverable from the UI, every file surface renders a shared `FileActionMenu` whose copy affordances emit the contract-derived command for the open file — e.g. `relay-ide v1 files read --session-id <session-id> --path <abs-path> --json` (editable surfaces also offer the `files write … --mode overwrite --file -` form). The command strings are rendered from this contract's own `cli` template (`commandSpec('files.read' | 'files.write')`), so the in-product affordance cannot drift from the shipped flags. `<session-id>` falls back to a literal placeholder when no scoped session is bound to the surface (e.g. the read-only evidence preview). The browser write path and the read/write contract shapes are covered by `test/file-write-api.test.ts`, `test/cli-gateway-contract.test.ts`, and `test/editor-affordances.test.ts`; a live scoped-session round-trip remains a manual smoke (`relay-ide v1 files read --session-id <id> --path <path> --json`).

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

File commands must surface unavailable node, missing path, denied capability, stale/expired session envelope, and confirmation-required states as typed error envelopes. They must not fall back to local filesystem reads or writes when the scoped file RPC route rejects a request.

## Intervention and hand-back boundaries

`sessions interventions` is a bounded metadata read. The v1 contract explicitly marks raw payload and transcript export unavailable. Do not expose human intervention keylogs or full terminal transcripts through this gateway.

`sessions hand-back` requires the latest intervention event id observed by the caller before restoring agent-driven control. Stale, unknown, disconnected, or unacknowledged intervention state returns typed errors instead of resuming blindly.

## First generated adapter smokes

The first #430 proof intentionally stops at one generated Claude-style tool/function bundle in `shared/cli-gateway-claude-tools.ts`. It reads `shared/cli-gateway-contract.ts` / `relay-ide v1 schema --json` shape and emits Anthropic-compatible tool definitions (`name`, `description`, `input_schema`) for only the hello-world path: `nodes.list`, `sessions.create`, `files.read`, and `sessions.detach`.

The Hermes-facing smoke in `shared/cli-gateway-hermes-tools.ts` uses the same contract manifest to emit Hermes tool descriptors (`name`, `description`, `parameters`), MCP descriptors (`name`, `description`, `inputSchema`), and OpenAI-style function descriptors (`type: "function"`, `function.parameters`). Its smoke path adds the now-stable PTY exchange commands: `nodes.list`, `sessions.create`, `files.read`, `sessions.stream`, `sessions.wait`, `sessions.input`, and `sessions.detach`.

The Codex-facing smoke in `shared/cli-gateway-codex-tools.ts` derives the same command subset from the v1 manifest and emits Codex/OpenAI-compatible function descriptors in both common shapes: Chat Completions-style nested tools (`type: "function"`, `function.parameters`) and Responses-style flat function tools (`type: "function"`, `name`, `parameters`). Its fake hub/node example runs only public `relay-ide v1 ... --json` commands: `nodes.list`, scoped `sessions.create`, read-only `files.read`, bounded `sessions.stream`, bounded `sessions.wait`, `sessions.input`, and descriptor-only `sessions.detach`.

These smoke runners are deliberately thin: generated definitions select stable v1 CLI commands, Relay's existing CLI gateway does the hub/node/File RPC/PTY work, and `sessions.detach` remains descriptor-only so it does not kill the underlying session. Production Claude/Codex/Hermes packages, Codex runtime packaging, event subscriptions beyond PTY output, multi-session orchestration, File RPC write/delete/tail, arbitrary exec, stdin-backed adapter streaming, and private node-link shortcuts remain deferred.

## Events subscription

`relay-ide v1 events subscribe --topic <topic> --json` opens a long-lived authenticated NDJSON stream from the hub and emits one gateway envelope per event frame on stdout. Per ADR-017 and #596, this is intentionally narrow: read-only, capability-gated, no writes, no execs, no raw byte streams, no log tailing (that lives under #476).

Topics:

- `sessions` — session lifecycle (`session.started`, `session.ended`) and `tab.mode-changed` envelopes scoped to the current hub.
- `nodes` — `node.online`, `node.offline`, `node.revoked` envelopes from the hub node registry (#586/`hub-node-registry`).
- `audit` — redacted summaries of `tab.mode-changed` and `tab.intervention` envelopes (hash-chained at storage time per #470/#499). Raw intervention payloads, raw keylogs, and full terminal transcripts are never streamed through this gateway.
- `context` — metadata for context packet create/pin/unpin activity, scoped by WorkContext/session/global session where available.
- `inbox` — metadata for `inbox.sent` and `inbox.state-changed` frames, including state transitions and redacted target/source summaries.
- `attention` — metadata for local agent session backend-state transitions (`attention.state-changed`), including derived `needsAttention`/`reasons[]` and repo/session scope hints.
- `work-context-artifacts` — metadata for WorkContext artifact publication/pin/export lifecycle events; never raw payload bytes.
- `handoff-artifacts` — metadata for pipeline handoff artifact attach/list-visible lifecycle events, using the same safe artifact store envelope.
- `workflow-runs` — metadata for workflow run publication/update events and bounded run state changes.

Each frame is a `events.subscribe` success envelope whose `data` carries:

```json
{
  "event": "open" | "event" | "closed",
  "topic": "sessions" | "nodes" | "audit" | "context" | "inbox" | "attention" | "work-context-artifacts" | "handoff-artifacts" | "workflow-runs",
  "sequence": 0,
  "occurredAt": "2026-05-19T00:00:00.000Z",
  "payload": { "type": "session.started", "sessionId": "..." }
}
```

The first envelope is always `event: "open"`. The final envelope is always `event: "closed"` with a `frames` count and a `reason`. Caps stay conservative:

- `--max-events N` detaches after N event frames (excluding `open`/`closed`).
- `--idle-timeout-ms N` detaches after N ms without an event frame.
- If stdout backpressure is observed, the CLI aborts the upstream stream and emits `closed` with `reason: "stdout backpressure"`.

Capability gating fails closed: `sessions`, `nodes`, and `attention` require `session:read`; `context`, `work-context-artifacts`, `handoff-artifacts`, and `workflow-runs` require `context:read`; `inbox` requires `inbox:read`; `audit` additionally requires `tab:intervention:read`. Unknown topics surface as `INVALID_ARGUMENT` with `details.field: "topic"` before the CLI opens any hub request. Missing or denied capabilities surface as `FORBIDDEN` envelopes. The hub side enforces the same gate; the CLI side enforces the same allowlist. This is the only `events.*` verb in v1 — no `events.publish`, no `events.replay`, no event-bus write surface.

Smoke form:

```bash
relay-ide v1 events subscribe --topic sessions --max-events 1 --json
```

## Deferred work

Event subscription beyond `events.subscribe` (multi-topic fan-out, durable cross-restart replay, cross-node aggregation), multi-session fan-out, File RPC delete/tail, arbitrary exec/destructive operations, stronger approval authentication, and adapter packages are follow-up work. If a future adapter needs a missing primitive, extend this CLI contract first; do not bypass it with `/hub/node-link` or browser WebSocket protocol clients.
