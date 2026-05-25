# ADR-018: Command-mediated handoff and supervisor contract

- **Status:** Accepted
- **Date:** 2026-05-25
- **Refs:** #718, #716, #717, #423, #426, #470, #493, #552, ADR-015, ADR-016, ADR-017
- **Supersedes:** none

## Context

Relay now exposes a versioned CLI gateway and shared command manifest. That creates a tempting but bad shortcut: map agent-to-agent handoff, supervision, fanout, or provider control to raw tmux/rmux/PTY bytes and hope the target harness interprets them correctly.

That shortcut breaks Relay's safety model. Terminal panes, rmux, ACP/MCP transports, and provider CLIs are substrate details. The Relay-owned command contract is the stable API because it carries scoped capability hints, control-mode state, redaction rules, audit summaries, and schema-generated adapter definitions.

## Decision

Handoff and supervisor operations are command-mediated. Stable adapter-facing operations must be declared in `shared/cli-gateway-contract.ts` and projected through `shared/relay-command-manifest.ts`. Adapters may execute those commands through CLI, hub HTTP, node RPC, ACP/MCP, rmux, tmux, or provider-native transports, but those substrates do not become source of truth.

The first stable supervisor slice is read-only: `supervisor.snapshot`. It returns bounded session identity, control-state, provider boundary, redacted intervention metadata, partial-failure metadata, and a redacted audit summary. It does not send text, submit prompts, accept provider permission prompts, or expose raw PTY/rmux execution as API.

Provider-native state remains read-only until explicitly promoted. The #717 `AgentHarnessStateAdapter` boundary may detect/list/read/import/resume-argv provider state, but it must not mutate provider stores or execute provider resume commands behind Relay's back.

## Command classification

| Command family | Side effect | Required capabilities | Confirmation/control requirement | Audit/redaction expectation |
| --- | --- | --- | --- | --- |
| `contract.*`, `nodes.manifest` | read | none | none | local schema/capability output only |
| `nodes.list`, `sessions.list`, `sessions.get`, `work-contexts.get`, `handoffs.status`, `handoffs.resume`, `artifacts.read` | read | `session:read` | no confirmation; scope checked by hub/session envelope | bounded descriptors/refs; raw logs, transcripts, provider auth, and secrets unavailable |
| `sessions.interventions` | read | `session:read`, `tab:intervention:read` | no write; intervention records are metadata only | redacted payload metadata and hashes only; no keylogs/transcripts |
| `supervisor.snapshot` | read | `session:read`, `tab:intervention:read` | refuses stale/mismatched `expectedControlMode`; returns `INTERVENTION_ACK_REQUIRED` when caller has not observed latest intervention | audit summary stores target ids, required/missing capabilities, hashes, partial-failure count; no raw prompts, PTY input, transcripts, or provider state |
| `sessions.attach`, `sessions.detach`, `sessions.renew`, `sessions.input`, `sessions.handBack`, `handoffs.cancel` | write/control | command-specific session/control bits from the manifest | hand-back requires latest intervention ack; raw input is not a typed supervisor action | summarize action and bytes/counts where applicable; never store raw prompt/transcript by default |
| `files.write` | write | `session:read`, `rpc:fs:write` | high-risk/prod nodes require confirmation challenge | path, mode, byte count, hashes, and decision only; no raw file payload in audit |
| `handoffs.create`, `handoffs.launch` | destructive/orchestrating | source read, destination write/create/exec capabilities as advertised by manifest and stored plan | confirmed grants required; launch retry uses stored plan/runtime target | artifact refs, run state, conflict summaries, and hashes only; no raw transcript/provider auth |
| `sessions.stream`, `events.subscribe` | stream | stream/topic-specific read bits | read-only stream; no event publish in v1 | bounded event/output frames; audit topic redacted only |

## Boundaries

- Raw PTY input is distinct from typed supervisor actions. `sessions.input` remains a narrow PTY smoke/debug primitive, not a blessed agent-to-agent API.
- Raw rmux/tmux command execution is not stable Relay API. If a new operation is needed, define a Relay command first and then adapt it to a substrate.
- Provider capability discovery/state import is read-only until a command explicitly advertises mutation semantics, capabilities, confirmation, and audit output.
- Redacted artifact/context exchange carries refs, hashes, sizes, timestamps, and summaries by default. Raw prompts, transcripts, secrets, provider auth, and provider store rows are not stored in audit by default.

## Consequences

This keeps Command Center search, generated adapter tools, CLI gateway behavior, and future ACP/MCP/rmux integrations aligned around one command registry. It also means write/send/submit/fanout work must be implemented as follow-up command slices with capability and control-mode enforcement instead of sneaking through terminal bytes.
