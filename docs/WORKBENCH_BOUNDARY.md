# Relay workbench boundary

Relay is a federated workbench and control plane for agentic development across online devices. It connects existing tools, sessions, tasks, repos, worktrees, artifacts, and operators into one shared work surface.

Relay is not the runtime, task tracker, source host, or memory system of record. Native agent CLIs, Hermes Agent, GitHub, Kanban, shells, tmux, and node-local filesystems keep owning their domains. Relay's job is shared identity, routing, context handoff, bounded inspection/control, and audit trails.

Status: this document is the product/docs contract for #552/#553. It defines vocabulary and acceptance boundaries for follow-up schema, API, UI, mobile, and dogfood work; it does not claim those follow-up implementations have landed.

## Product thesis

Relay should answer:

> What work is happening across my devices, who or what is doing it, where is it running, what task/repo/worktree/session does it belong to, and what can I safely inspect or control from this device?

The product promise is not "run every agent inside Relay." The promise is: start or observe work anywhere, attach from any device, hand control between assistant/terminal/pair sessions, and keep a bounded audit trail without forcing the operator to reconstruct state from terminals, chats, issue comments, PRs, and logs.

Mobile is a first-class control surface: status, latest bounded output, artifacts, approvals, small input, attach, hand-back, pause/kill/retry where policy allows, and stale/offline state. It is not a full phone IDE.

## Hard boundaries and non-goals

Relay must not:

- replace Hermes Agent, Hermes dashboard, hermes-workspace, GitHub, Kanban, tmux, or native Claude/Codex/OpenCode/Hermes CLIs;
- scrape, sync, or become a source of truth for raw Hermes profile SQLite DBs, memory stores, provider auth, env, or unbounded transcript/log history;
- clone GitHub Issues, Kanban, or any future task system as owned storage; those remain external `TaskRef`s linked into `WorkContext`;
- turn mobile into a worse phone IDE; mobile v1 is status/control/artifact/approval oriented, not bulk editing, broad file navigation, or high-risk write workflows;
- treat a node capability probe as permission. A node manifest says "can"; hub policy and `CapabilityGrant` say "may";
- require repo/worktree identity for every surface. Repo/worktree is the golden path, but remote/free/non-git Tabs still need valid `Node`, `cwd`, `kind`, `Session`, and `WorkContext` representation;
- bundle the broad #444 IA migration, #428 write-capable File RPC, raw transcript export, or universal task database into the #552 workbench spine.

## Canonical nouns

These nouns are the shared language for #552 follow-up work. Future shared schemas should use these names or explicitly map to them.

| Noun               | Definition                                                                                                                                                   | Boundary                                                                                                                           |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| `Node`             | An online/stale/offline execution device exposing local Relay capabilities.                                                                                  | A node is a paired execution host, not a trust grant. Capabilities still require hub policy.                                       |
| `Actor`            | A human or agent runtime participating in work.                                                                                                              | Actor identity describes who/what acted; it does not imply ownership of the node or task system.                                   |
| `WorkContext`      | The durable envelope tying task refs, repo/project refs, worktree/cwd/session refs, actors, artifacts, and audit refs together.                              | This is Relay's context spine, not a transcript dump or task database clone.                                                       |
| `Session`          | A node-owned terminal, agent, web-chat, or process session that can be attached to or summarized.                                                            | Sessions are execution/process handles; a browser Tab may render or attach to one.                                                 |
| `TaskRef`          | An external task source reference such as a GitHub issue, Kanban row, PR, or future task system item.                                                        | Relay links to task systems; it does not own their canonical state.                                                                |
| `RepoInstance`     | A repo checkout on a specific node, identified by node-scoped path plus repo identity where available.                                                       | Git-specific Instance compatibility shape; paths are not global IDs.                                                               |
| `WorktreeInstance` | A git worktree on a specific node, identified by node-scoped worktree path plus related repo metadata where available.                                       | Git-specific Bench compatibility shape; free/non-git cwd must still be representable without it.                                   |
| `Artifact`         | A bounded external or Relay-produced evidence handle: PR, log, screenshot, diagnostic bundle, summary, recording, test report, etc.                          | Prefer refs, hashes, sizes, and summaries over raw secret-bearing payloads.                                                        |
| `AuditEvent`       | An append-only event describing important work/context/control/security transitions.                                                                         | Audit rows record compact identifiers, decisions, hashes, and redaction metadata; they are not raw terminal or transcript storage. |
| `CapabilityGrant`  | A scoped permission allowing an Actor or client to inspect, control, read, write, execute, approve, retry, pause, kill, or attach within a defined boundary. | Grants are separate from node manifests and should be visible enough for operators to understand blast radius.                     |

## Compatibility with the six-layer vocabulary

The #444 information architecture remains: **View -> Workspace -> Project -> Instance -> Bench -> Tab**. The workbench nouns do not rename that tree; they give the federated work/control spine a precise vocabulary.

| Six-layer term | Workbench mapping                                                                                                                                                       |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| View           | A browser/mobile lens over WorkContexts, Nodes, Projects, Sessions, Artifacts, or things needing the operator.                                                          |
| Workspace      | User grouping/config/pins. It may organize Projects and WorkContexts, but it is not a repo path.                                                                        |
| Project        | The "what" being worked on. A git repo identity is the common Project kind; agent/playbook/node-target Projects may exist later.                                        |
| Instance       | Where a Project is realized. `RepoInstance` is the git-specific compatibility shape.                                                                                    |
| Bench          | The active cwd/environment arrangement inside an Instance. `WorktreeInstance` is the git worktree compatibility shape.                                                  |
| Tab            | The leaf surface: terminal, agent chat, file, diff, preview, or other attach/render surface. It carries `nodeId`, `cwd`, `kind`, and optional repo/worktree decoration. |

Rules of thumb:

- Use repo/worktree nouns only for git-specific affordances and destructive git operations.
- Use `WorkContext` when the user-facing question is "what work is this part of?"
- Use `Session`/`Tab` when the user-facing question is "what process or surface am I attached to?"
- Use `CapabilityGrant` when the user-facing question is "what is this device/client/actor allowed to do?"

## Canonical user journeys as acceptance criteria

These journeys are acceptance criteria for future workbench/mobile/dogfood implementation. They are not claims about current shipped behavior.

### 1. Phone status/control

As the operator away from the desk, I open Relay on my phone and see active work grouped by `WorkContext`: task, repo/project if any, node, active actor, session/tab, latest bounded status/output, blockers/approvals, and artifacts.

Acceptance criteria:

- phone view prioritizes "what needs me" before raw terminal rendering;
- raw PTY attach remains available but is not the primary mobile surface;
- I can approve/deny a pending prompt, send a short text input, pause/kill/retry where policy allows, and open a PR/log/screenshot/diagnostic artifact;
- destructive controls require an explicit `CapabilityGrant` and visible `AuditEvent`;
- offline/stale nodes preserve last-known context, show freshness, and disable live controls.

### 2. Tablet/laptop attach

As the operator on a tablet or secondary laptop, I can attach to an existing tab/session without losing the work context.

Acceptance criteria:

- attach is a handle on an existing Relay `Session`, not a hidden new agent runtime;
- the UI shows node, cwd, kind, active actors/control mode, task refs, artifacts, and hand-back state;
- I can switch from summary/control view into terminal attach when I need deeper interaction;
- hand-back requires acknowledgement of latest human intervention where applicable;
- free/non-git tabs do not inherit stale local repo badges or actions.

### 3. Desktop/devbox handoff

As the operator at a devbox, I can start work from assistant/messaging, have Relay create or associate a `WorkContext`, spawn or attach a Claude/Codex/Hermes pair session in the right node/cwd/worktree, then return control to the assistant with enough context to resume without archaeology.

Acceptance criteria:

- native agent CLIs remain the runtime;
- Relay records identity, routing, control, artifact, and audit metadata;
- assistant resume consumes bounded summaries, artifact refs, and audit refs, not raw transcript dumps by default;
- node/cwd/worktree/session identity is explicit enough that Relay does not route resume work to the wrong local checkout.

## V1 dogfood acceptance loop

A v1 Relay-develops-Relay dogfood is acceptable only when this loop works end-to-end:

1. Assistant/messaging starts or claims a Relay development task and creates or links a `WorkContext` with at least task ref, repo/project ref, intended node/cwd/worktree/bench if known, initiating actor, and requested agent/runtime.
2. Relay shows that `WorkContext` on desktop and mobile with correct node/session/control state.
3. The operator opens Relay and starts or attaches a Claude/Codex/Hermes pair session under that same `WorkContext`.
4. During the pair session, Relay records bounded events: session start/resume/end, actor/control mode changes, approval/intervention summaries, tool/activity summaries, artifacts, and policy/audit decisions.
5. The operator can inspect latest bounded output/artifacts from phone, send small scoped input or approval, and pause/kill/retry only when capability policy allows.
6. If the node drops offline, Relay preserves stale read state, shows last-seen timestamps, disables live controls, and does not silently route to the wrong repo/session.
7. The assistant can resume from Relay `WorkContext` after the pair session with a compact summary, artifact refs, and audit refs sufficient to continue or close the task.
8. Dogfood uses isolated Relay config/ports and has an operator recovery path for stuck sessions, bad node links, broken plugin events, and audit/diagnostics collection.

## Hermes Agent integration boundary

Relay needs a Hermes Agent plugin or integration layer that emits Relay-useful metadata without making Relay scrape raw Hermes profile state.

Minimum useful event envelope for future schema work:

- event id, schema version, timestamp, source, profile, and stable run/session ids where available;
- actor identity: human/agent, profile name, runtime (`hermes`, `claude`, `codex`, `opencode`, etc.), and model/provider when non-sensitive;
- `workContextId` if known, plus task refs such as GitHub issue/PR, Kanban task id, branch/worktree intent;
- node/cwd/repo/worktree/bench context with node-scoped paths only;
- session lifecycle: started/resumed/ended/blocked/completed/crashed/timed_out;
- parent/child session links when Hermes spawns Claude/Codex/Hermes or delegates work;
- turn/tool summaries: tool name/category, status, compact result/error summary, duration, and artifact refs, without raw secret-bearing inputs by default;
- control/intervention events: approval requested/approved/denied, clarify/block, hand-back acknowledgement, pause/kill/retry;
- artifacts: PR URL, issue comment URL, diff/log/diagnostic bundle refs, screenshots, QA evidence refs;
- redaction/privacy metadata: payload class, raw payload availability false by default, hash/size where needed, retention class.

Non-goals for this integration:

- no raw Hermes DB sync;
- no Hermes memory provider role;
- no Hermes dashboard clone;
- no raw env/provider auth/secrets/unbounded logs;
- no implicit transcript export into mobile or audit views.

## Follow-up evidence matrix

| Requirement          | Evidence expected before dependent work claims completion                                                      |
| -------------------- | -------------------------------------------------------------------------------------------------------------- |
| Product boundary     | Current docs state Relay is a workbench/control plane and list the hard non-goals above.                       |
| Canonical nouns      | Shared/server/frontend contracts use or explicitly map to the canonical nouns in this document.                |
| WorkContext schema   | Shared schema includes task refs, actors, node/session, optional repo/bench links, artifacts, and audit refs.  |
| Hermes metadata      | Fixture events cover task lifecycle, tool summary, child session, artifact, and redaction metadata.            |
| Federated visibility | Two-node scenario shows online/stale/offline nodes and node-owned sessions without path-only identity.         |
| Mobile control       | Phone viewport test covers latest status, artifact open, approval/small input, and disabled stale controls.    |
| Pair handoff         | Dogfood trace covers assistant/messaging -> Relay context -> pair session -> assistant resume.                 |
| Privacy/audit        | Tests prove default Relay event/audit rows do not contain raw env, tokens, transcript bytes, or provider auth. |
| Recovery             | Dogfood config is isolated and diagnostics exist for stuck node/session/plugin cases.                          |

## Sources

- GitHub issue #552 body and product/planner comments.
- GitHub issue #553 acceptance criteria.
- `docs/ARCHITECTURE.md` for hub/node, six-layer vocabulary, current/deferred implementation state.
- `docs/federated-relay.md` for node/session routing, stale/offline states, and control/audit boundaries.
- `docs/CLI_GATEWAY.md` for adapter-facing session descriptors and gateway boundaries.
- `docs/SECURITY_POLICY.md` for capability grant and audit separation.
- `DESIGN.md` for mobile-friendly terminal-native product framing and tab-context expectations.
