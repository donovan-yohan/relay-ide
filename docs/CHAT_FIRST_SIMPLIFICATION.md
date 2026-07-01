# Chat-first Relay simplification — audit & implementation ladder

Planning artifact for epic **#1058** (chat-first Relay web simplification and
Hermes gateway). Combines the #1059 product/IA audit and the #1060
implementation ladder. Verified against `nightly` HEAD `30eab09` (2026-07-01).

> **TL;DR** — #1058 is a _finishing_ epic, not greenfield. Nightly already
> carries the topic foundation, the Command Center substrate, and a working
> Hermes `ProtocolAdapterV2`. The remaining work is: workspace-first grouping,
> topic→context wiring, richer chat cards, palette intents, and **hiding
> substrate mechanics** from the primary UI. The hiding work is the only part
> that needs product sign-off (it removes/moves surfaces some flows rely on).

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

Default landing should open to the **topic/chat spine**, not the `org`
WorkContext cockpit (`resolveAppViewMode` returns `'org'` today when there is no
active session/repo — `frontend/src/lib/state/app-view-mode.ts:22`).

## 3. User stories

- **Chat:** open a topic → land in chat → send a prompt to its Hermes/Claude/Codex agent → tool calls/artifacts render as cards.
- **Terminal:** from a topic, launch a terminal that inherits the pad's node + cwd/repo; find it back as a child of the topic.
- **Artifact review:** diffs, image/screenshot, PR/check links, terminal excerpts render as readable cards attached to messages.
- **Cross-node lookup:** from the palette, search topics/sessions/artifacts across nodes and attach context — without a fleet dashboard in the main chrome.

## 4. Implementation ladder (#1060)

### Per-ticket status

| Ticket                | Status                   | Remaining                                                                        |
| --------------------- | ------------------------ | -------------------------------------------------------------------------------- |
| #1059 audit           | **done** (this doc §2–3) | seeds the substrate-hiding workstream                                            |
| #1060 ladder          | **done** (this doc §4)   | —                                                                                |
| #1061 sidebar         | **partial** (2/5)        | workspace-first grouping; topic-select→context; hide `TopicDetail` mechanics     |
| #1062 Hermes gateway  | **mostly done** (4/6)    | `resumeSession`/`forkSession` stubs; workspace-context enrichment                |
| #1063 chat cards      | **mostly done** (4/5)    | rich media cards _(in progress, PR #1066)_; PR/check/terminal-excerpt item types |
| #1064 topic terminals | **done** (5/5)           | QA-verify; ad-hoc terminal inheritance depends on 1061-A                         |
| #1065 palette         | **partial** (3/5)        | topic/artifact search categories; intent actions                                 |

### Branch reuse ledger

| Branch                                                             | Verdict                  | Note                                                                                                                                                            |
| ------------------------------------------------------------------ | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `frontend/topic-sidebar-default`                                   | **discard**              | landed as #1042                                                                                                                                                 |
| `issue-1032-remove-legacy-sidebar`                                 | **discard**              | landed as #1057                                                                                                                                                 |
| `powerwash/frontend-topic-sidebar`, `powerwash/backend-first-pass` | **discard**              | landed as #1038 / #1036                                                                                                                                         |
| `issue-1025-hermes-topic-launch-resume`                            | **discard**              | 0 unique commits vs nightly                                                                                                                                     |
| `issue-1043-workspace-rail`                                        | **reuse (rebase)**       | 5 follow-on commits build the workspace-pad substrate (`ia-store`, `ia-workspace-router`, `WorkspaceBar`) for 1061 grouping; drop lead commit (landed as #1050) |
| `issue-1024/1027-*`                                                | **cherry-pick residual** | mobile polish only, off critical path                                                                                                                           |

### Recommended ship order

```
0.  #1059 audit + #1060 ladder ............ this doc
1.  1063-A rich media cards ............... PR #1066 (in review)
2.  1061-A topic-select → active context .. small keystone; unblocks #1064 ad-hoc + #1063 context
3.  #1064 QA-verify & close ............... after 1061-A
4.  rebase issue-1043 → land WorkspaceBar . substrate for grouping
5.  1061-B workspace-first grouping ....... large; consumes step 4
    ‖ 1063-B PR/check/terminal item types .. parallel, independent files
6.  1061-C hide TopicDetail mechanics ..... small polish
    ‖ #1059 substrate-hiding: Analytics/HubNodeDashboard/ActiveWork → settings/diagnostics  ← needs product sign-off
7.  1062-A/B Hermes resume + context enrich  follow-up tickets, non-blocking
8.  1065-A/B palette topic/artifact + intents  power-user layer, last
```

### QA gates

- **Sidebar:** topics grouped under their workspace; node shown as badge only; selecting a topic sets active node + cwd.
- **Chat:** topic opens to chat; send works; tool/artifact cards render; no backend internals in empty/error states.
- **Terminal inheritance:** both room-launch and ad-hoc `session.new-terminal` inherit the selected topic's node/cwd/repo.
- **Palette:** searches workspaces/topics/sessions/artifacts; intents gated by confirmation + capability context.

## 5. Open product decisions (need sign-off before step 6)

1. **How aggressively to hide the work cockpit / nodes / analytics.** Moving them to settings/diagnostics is the audit recommendation, but operator flows use them today. Options: (a) move wholesale behind settings, (b) keep a slim primary panel + move detail, (c) gate behind an "advanced" toggle.
2. **Default landing = topic/chat vs keep the `org` cockpit** for no-session state.
3. **Discoverability mitigations** for moved surfaces (settings header links, palette entries, `/diagnostics` route).

Everything above step 6 is decoupled from these decisions and safe to ship independently.
