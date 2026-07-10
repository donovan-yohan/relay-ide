# Substrate Refit — audit synthesis and plan

_Source: 27-agent audit (2026-07-10, subsystem maps + two end-to-end traces + adversarially verified cut candidates) plus live validation on a dev hub. This document is the decision record for refitting relay-ide into a multi-agent delegation substrate._

## The two requirements

- **R1** — any agent reads/writes shared context + mail via CLI (`relay-ide v1 ... --json`).
- **R2** — one web UI (mobile responsive) shows all agent TUI sessions running live.

Core loop to protect: orchestrator TUI (Claude/Hermes/Codex) calls the CLI → worker TUI spawns with its task → both stream live in the web UI → they exchange context/mail via CLI verbs.

## State of the core loop (verified live, branch `codex/hermes-cwd-mobile-density`)

### Spawn lane — works

`v1 sessions create --input-json '{"agent":"codex","cwd":...,"continuePolicy":"never","displayName":"worker-1","initialPrompt":"<task>"}'` spawns a fresh named Codex TUI that receives and auto-submits its prompt. Fixed this run: cwd-only create (99d201b), WS auth + local-node attach for input/stream/wait (c8a83ea), fire-and-forget input semantics (f8be90f), split-CR submit vs TUI paste coalescing (bf0aa02), initialPrompt fallback injection (6befc56), displayName (f65852f), worktree launch anchors (a47be60), error passthrough (b4760ff).

### Mail/context lane (R1) — works, one winner

**Winner: context packets + session inbox** (`context.create/get/list/pin/unpin`, `inbox.send/list/get/ack/resolve/ignore`, push topic `events subscribe --topic inbox`). Verified live: packet → addressed send → delivered list → packet readback; bounded blocking wait = `events subscribe --topic inbox --max-events 1 --idle-timeout-ms N`.
`work-context-messages.*` is a second, receipt-less mail store with no event topic — **park it** (fold threading/payloadSchema into inbox later if needed).

### Visibility lane (R2) — was broken twofold, being fixed

1. No `session-created` push → CLI-spawned sessions invisible until refresh. **Fixed** (server broadcast + frontend refresh).
2. `viewMode 'session'` — the only terminal mount — unreachable from the chat-first UI (session activation forces `'chat'`; every cockpit escape clears the active session). Terminal streaming plumbing itself is healthy. **Fix in flight**: live-session tiles on landing + reachable terminal view.

### Known remaining gaps (build list, ordered)

1. **Auth inversion** (biggest structural issue): the loop rides the hub-wide `RELAY_IDE_BROWSER_TOKEN` inherited by every PTY. The designed scoped actor lane cannot run the loop — server read allowlist omits `inbox.list/get`, `context.get/list`; the CLI binary blocks all mail verbs on actor tokens; `events.subscribe` reads only the browser token. Fix symmetrically, then auto-provision a per-session actor token at spawn and drop the ambient operator token from PTY env. (First half in flight.)
2. **Collaboration appendix**: only the `claude` framework gets the launch-time CLI cheatsheet (`--append-system-prompt`); Codex/Hermes workers are never told the gateway exists — and the appendix's taught `inbox list --json` example is invalid (router requires a target). Fix the example; deliver the appendix to Codex (config/AGENTS-file path) and Hermes; until then orchestrators must embed verbs in `initialPrompt`.
3. **`inbox wait` sugar**: one verb composing backlog list + one-shot subscribe, returning full message body. Plus `replyToMessageId` + auto-filled `sourceSessionId` so request/reply stops being a text convention; wire `actorId` through ack/resolve (currently dropped).
4. **`work-contexts create` verb** (or bless the no-WorkContext path in docs) — the durable-room lane is unreachable for a fresh orchestrator.
5. **Worker readiness signal**: Codex agentState is coarse (`initializing/processing/idle`); no `waiting-for-input`. `sessions wait --screen-text` unsupported. Orchestrators need "worker ready/blocked" without screen-scraping heuristics.
6. **Session lineage**: no parent/child recorded at spawn — cockpit can't group orchestrator + its workers. Small field on create (`spawnedBySessionId`), big UX payoff.
7. **Nightly gap**: all of the above lives on this branch; nightly (`f89eb3a`) still has the broken WS lane. Land the branch.

## Cut/park list (~95 features adversarially verified `safe-park-or-cut`)

Verifiers confirmed the core loop does NOT depend on these. Grouped, with disposition. "Park" = feature-flag off / hide from UI, delete in a later wave once nothing regresses.

### Delete now (dead or superseded)

- 18 orphaned frontend components/hooks; OpenPicker stub; rmux probe; Hermes metadata event validator (#556 spike); ChatEvent v1 legacy wire protocol + v1↔v2 compat bridge (after confirming web-chat lane parks); `relayctl` companion CLI; adapter tool-definition generators (claude/codex/hermes-tools.ts — contract says generate from `schema --json` instead).

### Park behind flag — frontend surfaces (the "so much in the sidebars" mass)

Org dashboard + ActiveWorkSurface; workbench block canvas + custom blocks + prompt hooks (epic #612); six-layer ViewSpine tree + BenchCreate + bench overlays + IA store/tree endpoints; hub nodes dashboard; analytics dashboard + telemetry detail; workspace evidence dashboard (#897) + artifact viewer/feedback; security audit panel; repo dashboard; workspace utility rail (6-tab right rail); PR surfaces (PrTopBar/PrRow/org PRs); tickets panel + start-work flow; file/IDE tooling (file tree, CodeMirror editor, diff viewers) — keep only what the terminal view needs; onboarding hints; pipeline handoff dialog/timeline.

### Park behind flag — backend features

Handoffs engine (plan/create/status/cancel/resume/launch, ~90KB); work-context artifacts + resume packets + message templates; agent view artifacts; workflow-runs, automation-runs (+finalizers), pr-overseer registries; command-center NL resolver/executor; webhooks + review poller + ticket transitions + Jira/GitHub integrations (gh proxy, GitHub App, GraphQL fetcher, branch linker); analytics/telemetry stores; web push; OpenCode relay plugin installer; diagnostics bundle; credential rotation scheduler; session rename resolver, image ingress, attribution/rollups; workspace groups (legacy); web-chat session lane (mode `'web'`, protocol adapters V2) — TUI-first substrate doesn't need it; control-mode/intervention engine + hash-chained audit (park, revisit when multi-operator matters).

### Keep (core loop or genuinely load-bearing)

Sessions + pty-handler + terminal streaming + scrollback; CLI gateway core (create/list/get/screen/input/stream/wait, supervisor submit/send-keys, files.\*); context packets + inbox + events bus; roster/presence + attention topic (supporting discovery); workspace-surfaces + workspace-topics (verified load-bearing for chat-first landing); node manifest/capability probing bundle (load-bearing infra); auth surfaces (consolidate later — flagged as duplicated); local-node; config/runtime-state paths.

### Federation (hub-node registry/router/link, pairing, policy evaluator, confirmation challenges, handshake grants)

Verified not load-bearing for the single-machine loop (local node is in-process and bypasses node-link). BUT it's the multi-device story (Mac node, devbox hub) and recently shipped (#979 epic). **Disposition: keep, do not grow.** Don't let new core-loop features route through federation machinery when a local path exists.

## Rebuild vs prune (web UI)

**Prune + re-shell. No rewrite.** Evidence: terminal tile, chat pane, session store, and mobile grouped-cockpit pieces are healthy and extractable; the problem is routing/IA (unreachable views) and surface count, not rot. The chat-first landing (#1058) already made the right call — finish it: landing = live sessions + new-chat, everything else behind a flag. Rewriting would re-litigate solved problems (terminal streaming, reconnect, mobile input) with high regression risk.

## Risks of cutting aggressively

- `workspace-topics`/`workspace-surfaces` look peripheral but are load-bearing for the chat-first landing — verified; don't cut.
- Parked backend routes may have frontend callers behind flags — park in matched pairs (surface + route) and watch hub logs for 404s.
- The web-chat lane (`mode: 'web'`) is Hermes' current default path; parking it means Hermes must run TUI mode (`hermes` CLI) — verify before parking.
- Epic overlap: this plan supersedes the remaining open items of #1058 (chat-first) and absorbs its "hide mechanics behind settings/advanced" decision; it does NOT touch #979 (node pairing) scope.

## CLI friction log (dogfood evidence)

Fourteen frictions found while using the CLI to drive the loop; 8 fixed same-day (see commits above). Outstanding: appendix delivery per framework, inbox wait sugar, reply-to threading, actor-token symmetry, readiness signal, lineage. Full log in session scratchpad; fold into issues when filing the build list.
