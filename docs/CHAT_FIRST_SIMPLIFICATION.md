# Chat-first Relay simplification — audit & implementation ladder

Planning artifact for epic **#1058** (chat-first Relay web simplification and
Hermes gateway). Combines the #1059 product/IA audit and the #1060
implementation ladder. Verified against `nightly` HEAD `e8d43e0` (2026-07-01).

> **TL;DR** — #1058 is a _finishing_ epic, not greenfield. Since this doc was
> last written (single commit `7c6382c`), #1061/#1062/#1063/#1065 all moved
> from "partial" to "mostly/fully done": workspace-first grouping shipped
> (#1089), topic→context wiring shipped (#1068), id/select-key leaks are
> swept (#1070, #1103), Hermes gained durable resume + context metadata +
> channel prompt defaults (#1096, #1072, #1090), with SSE hardening (#1102)
> queued but not yet merged (`mergeStateStatus: DIRTY`, conflicts to
> resolve), and the default landing swapped to the chat/topic spine (#1101).
> Remaining:
> `forkSession` (deliberately unbuilt), a telemetry-bridge gap, PR/check/
> terminal-excerpt chat cards (blocked on a producer decision), and the
> substrate-hiding advanced-toggle work, which is **in progress, not
> shipped**. See the #1075 reconciliation (§4a) for the parallel multi-agent
> prototype train, which is separate from this ladder but touches the same
> surfaces.

## 1. Product direction (from #1058)

Primary UI collapses back to the core job: open a workspace, talk to agents,
run terminals/TUIs, review artifacts. Everything else (nodes, links, protocol,
telemetry, fleet state) moves to settings/diagnostics/CLI.

Primary nouns: **workspace pad → topic → chat → terminal → artifact**. Node is
compact metadata, never the navigation hierarchy. Command palette is a
convenience/escape hatch, not the substrate UI.

## 2. Surface audit (#1059)

Disposition legend: **primary** = stays in main chrome · **settings** ·
**diagnostics** · **cli-only** · **delete**.

| Surface                                           | Current mount                               | Disposition                                                           | Rationale                                                                                                                                                           |
| ------------------------------------------------- | ------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Topic sidebar (`TopicSidebarShell`)               | `Sidebar` main nav                          | **primary**                                                           | The chat-first spine. Needs workspace-first grouping (#1061).                                                                                                       |
| Chat surface (`chat/*`, `workbench/blocks/agent`) | topic/session main pane                     | **primary**                                                           | The central interaction unit (#1063).                                                                                                                               |
| Topic-scoped terminals                            | topic detail / room launch                  | **primary**                                                           | Core job; already context-inheriting (#1064).                                                                                                                       |
| Command palette (`CommandPalette`)                | ⌘K overlay                                  | **primary (as escape hatch)**                                         | Convenience layer; add topic/artifact search + intents (#1065).                                                                                                     |
| `HubNodeDashboard`                                | `OrgDashboard` **nodes** tab                | **settings / diagnostics**                                            | Node status/locality/capabilities/security posture is operator plumbing, not a landing surface. Move to Settings → Nodes (a `SettingsNodesSection` already exists). |
| `AnalyticsDashboard`                              | `App` viewMode `analytics` + sidebar button | **settings**                                                          | Raw telemetry (tokens/latency/rate-limits). Move under Settings; drop the main-nav button.                                                                          |
| `ActiveWorkSurface` (work cockpit)                | `OrgDashboard` **active-work** tab          | **diagnostics** (keep session attach/control in a slim primary panel) | Exposes session/node/context IDs + control state. Keep _attach/send-input_ affordances in the primary session view; move the ID/control detail to diagnostics.      |
| `InterventionStrip`                               | session chrome                              | **primary (simplified)**                                              | Keep a control-status badge (warn tone when degraded); move detailed intervention records to diagnostics.                                                           |
| `AutomationPanel`                                 | orphaned                                    | **settings**                                                          | Mount under Settings → Automations when wired; do not add a standalone sidebar surface.                                                                             |
| `OrgDashboard` tab strip                          | default landing (`viewMode:'org'`)          | **restructure**                                                       | Drop `active-work` + `nodes` tabs from the default; keep user-facing PRs/tickets/audit.                                                                             |

### Surface tiers

- **Primary:** topic sidebar, chat, topic terminals, command palette, PRs/tickets/audit, simplified control badge.
- **Settings:** nodes, analytics, automations, provider/gateway config.
- **Diagnostics:** work-cockpit ID/control detail, intervention history, node link/protocol state.
- **CLI-only (already):** node link/pair/unpair, session protocol ops, gateway verbs (`relay-ide v1 … --json`).

### Landing surface

**Shipped (#1101).** Default landing now opens to the **topic/chat spine**:
`resolveAppViewMode` returns `'chat'` for the no-session/no-repo case and only
falls back to `'org'` via an explicit `forceOrgCockpit` escape hatch —
`frontend/src/lib/state/app-view-mode.ts:36` — reachable from the command
palette's `navigation.open-work-cockpit` action
(`frontend/src/lib/actions/definitions/navigation.ts:61`). #1071's banner
approach was superseded by this direct default-view swap. #1098 further
center-aligned the empty-state CTA inside the (now diagnostics-reachable)
work cockpit.

## 3. User stories

- **Chat:** open a topic → land in chat → send a prompt to its Hermes/Claude/Codex agent → tool calls/artifacts render as cards.
- **Terminal:** from a topic, launch a terminal that inherits the pad's node + cwd/repo; find it back as a child of the topic.
- **Artifact review:** diffs, image/screenshot, PR/check links, terminal excerpts render as readable cards attached to messages.
- **Cross-node lookup:** from the palette, search topics/sessions/artifacts across nodes and attach context — without a fleet dashboard in the main chrome.

## 4. Implementation ladder (#1060)

### Per-ticket status

| Ticket                | Status                                    | Remaining                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| --------------------- | ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #1059 audit           | **done** (this doc §2–3)                  | seeds the substrate-hiding workstream                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| #1060 ladder          | **done** (this doc §4)                    | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| #1061 sidebar         | **3/5 confirmed, 2 pending verification** | workspace grouping #1089, topic-select→context #1068, id/select-key leak sweep #1070+#1103 are the 3 boxes checked on the issue. The other 2 ("node as compact metadata/badge", "sessions as children of topic") are plausibly satisfied by code already on nightly — `routingLabel()` (`frontend/src/lib/state/topic-nav.ts:317`) folds provider/node/path into a single meta-strip string via `TopicSidebarShell.tsx:944`, and `topicRoomGroupedSessions()` (`TopicSidebarShell.tsx:299`) renders a topic's sessions grouped under it in `TopicDetail` — but neither was formally re-verified against the acceptance wording in this pass, so left unchecked pending author sign-off; issue left open pending #1058 epic close |
| #1062 Hermes gateway  | **done (5/6) + follow-up**                | context metadata #1072, channel prompt defaults #1090, durable resume #1096, SSE hardening #1102 (auto-merge queued, `mergeStateStatus: DIRTY`, conflicts to resolve); `forkSession` deliberately unbuilt (dead stub, no call sites); telemetry-bridge gap tracked as a new follow-up issue                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| #1063 chat cards      | **partial, wave 2 in-flight**             | rich media cards shipped (#1066); markdown/autoscroll/reasoning-label polish shipped (#1099); question/plan cards **in progress, not started in any open PR**; PR/check/terminal-excerpt item types blocked on a producer decision — new follow-up issue                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| #1064 topic terminals | **done (5/5), closed**                    | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| #1065 palette         | **mostly done**                           | topic search #1069, session-result parent-channel sublabel #1093 shipped; artifact search **in progress, not started in any open PR**; intent actions remaining                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

### §4a. #1075 reconciliation — multi-agent prototype train (parallel, not part of this ladder)

Epic **#1075** ("multi-agent chat-first workspace prototype", CLOSED) ran
alongside this ladder and touched the same chat/session surfaces without
being tracked in this doc until now:

- **Slice 1+2** (#1076, #1077) — one-click "New Hermes chat" + side-by-side
  agent spawning, both shipped in **PR #1080**: `openTabBeside()`
  (`frontend/src/lib/stores/workspace-layout-store.ts:150`) composes `addTab` +
  `splitPaneWithTab`, idempotent against the `WorkspaceArea` reconciler; a
  "+chat" pane control creates a native Hermes agent session and places it
  beside via `openTabBeside`.
- **Slice 3** (#1078, Claude Code as a native Relay session with Relay-CLI
  injection) — **closed as substrate-complete, no new code.** Verified
  pre-existing since #955: `writeRelayctlShim` + `injectRelaySessionEnv` +
  the `--append-system-prompt` collaboration appendix
  (`server/pty-handler.ts:481,726,1019`) already make every Claude PTY
  session a Relay-CLI-aware agent that can message local friends.
- **Slice 4** (#1079, LOCAL-friend vs cross-workspace-MAIL messaging UI) —
  **PR #1081** added a compose box to the session mailbox panel routed by
  `targetSessionId` (LOCAL friend, same workspace); **PR #1082** completed it
  with an explicit `friend` / `mail` toggle, `mail` routing by
  `targetWorkContextId` to another work context. Both use the same
  `sendInboxMessage` contract.

Net effect on this ladder: none of #1075's slices changed the #1061–#1065
acceptance criteria, but #1080's `openTabBeside` is now the mechanism any
future "spawn a card/cockpit beside the chat" work (§4 wave 2) should reuse
rather than re-deriving pane-placement logic.

### Branch reuse ledger

| Branch                                                             | Verdict                                | Note                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------ | -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `frontend/topic-sidebar-default`                                   | **discard**                            | landed as #1042                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `issue-1032-remove-legacy-sidebar`                                 | **discard**                            | landed as #1057                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `powerwash/frontend-topic-sidebar`, `powerwash/backend-first-pass` | **discard**                            | landed as #1038 / #1036                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `issue-1025-hermes-topic-launch-resume`                            | **discard**                            | 0 unique commits vs nightly                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `issue-1043-workspace-rail`                                        | **merged dead weight — do not rebase** | Lead commit landed as **PR #1050** ("persist workspace rail selection"), merged 2026-06-28. The follow-on commits this doc previously recommended rebasing never landed separately; workspace grouping instead shipped fresh via #1089 (branch `issue-1083-workspace-grouping`). What's left on this branch is the opt-in `viewSpineEnabled` legacy rail path (`frontend/src/lib/stores/ui.ts:171-174`, `Sidebar.tsx`, `WorkspaceBar.tsx`) — flag defaults OFF (`ls(VIEW_SPINE_KEY) === '1'`), superseded by the shipped grouping. Rebasing it now would reintroduce a parallel, unused nav model. |
| `issue-1024/1027-*`                                                | **cherry-pick residual**               | mobile polish only, off critical path                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |

### Recommended ship order

```
0.  #1059 audit + #1060 ladder ............ this doc — done
1.  1063-A rich media cards ............... PR #1066 — done
2.  1061-A topic-select → active context .. PR #1068 — done
3.  #1064 QA-verify & close ............... done, closed
4.  1061-B workspace-first grouping ....... PR #1089 — done (fresh branch, not the issue-1043 rebase originally planned)
    ‖ 1063-B PR/check/terminal item types .. still blocked on producer decision — new follow-up issue
5.  1061-C hide TopicDetail mechanics ..... PR #1070 + #1103 — done
    ‖ #1058 landing default: chat/topic spine . PR #1101 — done (small-first, shipped ahead of substrate-hiding sign-off)
    ‖ substrate-hiding advanced toggle ....... IN PROGRESS — no PR yet; decision recorded in §5, not yet built
6.  1062-A/B Hermes resume + context enrich  PR #1096 (resume), #1072 (metadata), #1090 (prompt defaults), #1102 (SSE hardening, auto-merge queued) — done/queued
7.  1065-A/B palette topic/artifact + intents  #1069 (topic search) + #1093 (session sublabel) done; artifact search + intent actions IN PROGRESS, no PR yet
```

Ship-order note: small-first shipped out of the originally-drafted order —
#1101 (landing default) shipped before the substrate-hiding sign-off item it
was drafted alongside, since it needed no product decision and was small.

### QA gates

- **Sidebar:** topics grouped under their workspace; node shown as badge only; selecting a topic sets active node + cwd.
- **Chat:** topic opens to chat; send works; tool/artifact cards render; no backend internals in empty/error states.
- **Terminal inheritance:** both room-launch and ad-hoc `session.new-terminal` inherit the selected topic's node/cwd/repo.
- **Palette:** searches workspaces/topics/sessions/artifacts; intents gated by confirmation + capability context.

## 5. Product decisions

Decided (recorded here for the record; encode in implementation, not further
debate):

1. **Substrate hiding = Settings + advanced toggle, palette-discoverable —
   NOT delete.** Work cockpit / nodes / analytics move behind a Settings
   section gated by an explicit "advanced" toggle, with a command-palette
   entry point (`navigation.open-work-cockpit` already exists as the
   escape hatch — §2 Landing surface). Nothing in this ladder deletes the
   surfaces or their data; it only changes default visibility. **Status:
   in progress** — the toggle/settings-section work has no open PR yet as
   of this doc's last verification pass.
2. **Default landing = topic/chat spine, not the `org` cockpit.** **Shipped**
   — PR #1101 (§2 Landing surface).
3. **Ship order = small-first.** Small, decision-free items (rich cards,
   topic-select context, id-leak sweeps, landing default) ship ahead of
   larger items that need sign-off or more surface area, rather than
   waiting for the full ladder to be sequenced. This is why #1101 shipped
   before the substrate-hiding toggle even though the original draft ship
   order in §4 sequenced them together.

Still open:

- **Discoverability mitigations** for moved surfaces beyond the palette
  entry already shipped: settings header links, a `/diagnostics` route
  convention for the moved work-cockpit detail.

Everything in §4 above the substrate-hiding line is decoupled from these
decisions and safe to ship independently; that's how #1061/#1062/#1063/#1065
progressed without waiting on the toggle.
