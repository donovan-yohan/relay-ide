# #857 action parity inventory

Issue: [#857](https://github.com/donovan-yohan/relay-ide/issues/857)
Parent epic: [#849](https://github.com/donovan-yohan/relay-ide/issues/849)

This audit maps the current browser action surfaces to the stable Relay gateway contract. It is intentionally an inventory only: no frontend handlers were rewritten in this slice.

## Sources inspected

- `frontend/src/lib/actions/definitions/*`
- `frontend/src/hooks/useActionRegistry.ts`
- `frontend/src/hooks/useSessionHandlers.ts`
- `frontend/src/lib/session-utils.ts`
- `frontend/src/lib/launch-environment.ts`
- `frontend/src/components/TerminalNodePicker.tsx`
- `frontend/src/components/WorkspaceArea.tsx`
- `frontend/src/components/dialogs/CustomizeSessionDialog.tsx`
- `frontend/src/components/dialogs/EnvPickerDialog.tsx`
- `frontend/src/components/StartWorkModal.tsx`
- `frontend/src/App.tsx`
- `shared/relay-command-manifest.ts`
- `shared/cli-gateway-contract.ts`
- `docs/CLI_GATEWAY.md`

## Classification

Use these exact values for follow-up planning:

| Classification | Meaning |
| --- | --- |
| `covered` | A stable `relay-ide v1 ... --json` command already covers the action semantics; no browser-only product behavior remains beyond rendering/navigation. |
| `needs ui bridge` | A stable gateway command exists, but the web path still invokes private React/API handler logic instead of a shared action/command execution bridge. |
| `needs gateway command` | The browser action has product semantics that are not represented in the stable v1 gateway manifest yet. Add/extend the Relay-owned command contract before exposing it to agents. |
| `ui-only non-agent surface` | The action is browser chrome, local navigation, sorting/filtering, clipboard, or dialog selection. Do not promote it to stable agent API unless a later product issue names an agent use case. |

## Stable gateway source of truth

Stable command metadata comes from `shared/cli-gateway-contract.ts` and its projection in `shared/relay-command-manifest.ts`, not from Command Center definitions. `docs/CLI_GATEWAY.md` explicitly separates UI-only Command Center actions from stable CLI gateway commands and agent-callable commands.

Current stable gateway command families:

- contract discovery: `contract.list`, `contract.schema`
- node/session descriptors and launch: `nodes.manifest`, `nodes.list`, `sessions.list`, `sessions.get`, `sessions.create`, `sessions.renew`, `sessions.attach`, `sessions.detach`, `sessions.stream`, `sessions.input`, `sessions.interventions`, `sessions.handBack`
- file RPC: `files.list`, `files.stat`, `files.read`, `files.write`
- work context/context packets: `work-contexts.get`, `context.create`, `context.get`, `context.list`, `context.pin`, `context.unpin`
- inbox and handoff: `inbox.send`, `inbox.list`, `inbox.get`, `inbox.ack`, `inbox.resolve`, `inbox.ignore`, `handoffs.plan`, `handoffs.create`, `handoffs.status`, `handoffs.cancel`, `handoffs.resume`, `handoffs.launch`, `artifacts.read`
- supervisor/control: `supervisor.sessions`, `supervisor.snapshot`, `supervisor.sendText`, `supervisor.submit`, `events.subscribe`

`frontend/src/lib/actions/definitions/cli-gateway.ts` already projects those commands into disabled `gateway.<command>` Command Center entries. Those entries are `covered` for CLI/agent use and `needs ui bridge` only if the browser should execute them directly from the palette.

## First vertical conversion target: node/session launch

The node/session launch subset is the right first conversion target for #849/#859 because the stable command already exists (`sessions.create`) and the browser has several duplicate launch paths that all eventually call `createAgentSession()` or `createSessionWithoutActivation()`.

Recommended first target set:

| Entrypoint | Current handler path | Existing CLI/API command | Gap classification | Recommended owner | Notes |
| --- | --- | --- | --- | --- | --- |
| `session.new-agent` | `useActionRegistry.ts` -> `handleQuickAgent()` -> `createAgentSession()` -> private `/sessions` or `/hub/nodes/:nodeId/sessions` | `sessions.create` | `needs ui bridge` | `ika-frontend` after #858 | Convert through shared action execution with typed inputs/result/error. |
| `session.start-on-repo` | `useActionRegistry.ts` -> `handleQuickAgent()` | `sessions.create` | `needs ui bridge` | `ika-frontend` after #858 | Same launch shape as quick agent. |
| `session.new-terminal` | `useActionRegistry.ts` -> `handleQuickTerminal()` -> `createAgentSession()` | `sessions.create` | `needs ui bridge` | `ika-frontend` after #858 | Local terminal launch should use the same descriptor as CLI `sessions.create`. |
| `TerminalNodePicker` local terminal | `WorkspaceArea.tsx` -> `TerminalNodePicker.onSelect()` -> `createAgentSession({ type: 'terminal', sessionLane: 'local-repo' })` | `sessions.create` | `needs ui bridge` | `ika-frontend` after #858 | Includes pane placement UI state; the actual create is command-shaped. |
| `TerminalNodePicker` remote terminal | `WorkspaceArea.tsx` -> pending remote cwd -> `createAgentSession({ nodeId, cwd, type: 'terminal', sessionLane })` | `sessions.create` | `needs ui bridge` | `ika-frontend` after #858 | Important #848 path: node picker + free/remote cwd launch. |
| `session.start-work-in-env` | `useActionRegistry.ts` -> `EnvPickerDialog` -> `launchEnvironment()` -> `environmentToCreateSessionOptions()` -> `createAgentSession()` | `sessions.create` | `needs ui bridge` | `ika-frontend` after #858 | Already has typed environment selection and block-on-stale checks; bridge this before other actions. |
| `CustomizeSessionDialog` start | `CustomizeSessionDialog.tsx` -> `createSessionFromForm()` -> `createAgentSession()` | `sessions.create` | `needs ui bridge` | `ika-frontend` after #858 | Covers configured agent/terminal, mode, yolo, continue, args, remote cwd. |
| dynamic `framework.<id>` actions | `useActionRegistry.ts` contextual framework action -> `createAgentSession({ agent: framework.id })` | `sessions.create` | `needs ui bridge` | `ika-frontend` after #858 | Framework-specific palette entries should become parameterized `sessions.create` actions, not separate command ids. |
| `handleViewSpineCreateTab` | `useSessionHandlers.ts` -> bench env overlay lookup -> `createAgentSession({ nodeId, cwd, repoPath, worktreePath })` | `sessions.create` | `needs ui bridge` | `ika-frontend` after #858 | Preserve best-effort env overlay behavior as action input/availability metadata if it remains part of launch. |
| utility rail terminal | `App.tsx` -> `useUtilityTerminalHandlers()` -> `createSessionWithoutActivation({ type: 'terminal' })` | `sessions.create` | `needs ui bridge` | `ika-frontend` after #858 | Same command result, different browser placement semantics. |
| `StartWorkModal` | `StartWorkModal.tsx` -> `useStartWork()` -> `createAgentSession({ ticketContext, branchName })` | partial: `sessions.create`; `ticketContext` is not in the v1 schema | `needs gateway command` | `kani-backend` for schema, then `ika-frontend` | Extend `sessions.create` or add a work-start action before agents rely on ticket-context launch. |

## Action registry inventory

### Session actions

| UI action id / entrypoint | Current handler path | Existing CLI/API command | Gap classification | Recommended owner | Notes |
| --- | --- | --- | --- | --- | --- |
| `session.new-agent` | `useActionRegistry.ts` -> `handleQuickAgent()` | `sessions.create` | `needs ui bridge` | `ika-frontend` | First vertical target. |
| `session.new-terminal` | `useActionRegistry.ts` -> `handleQuickTerminal()` | `sessions.create` | `needs ui bridge` | `ika-frontend` | First vertical target. |
| `session.close-active` | `useActionRegistry.ts` -> `handleCloseSession()` -> `killSession()` -> private `DELETE /sessions/:id` or routed node delete | none; `sessions.detach` only releases CLI handle and does not kill | `needs gateway command` | `kani-backend` | Add a typed close/kill command with confirmation/control semantics before agent exposure. |
| `session.kill` | `useActionRegistry.ts` -> `killSession()` | none; see above | `needs gateway command` | `kani-backend` | Same missing destructive session command. |
| `session.start-on-repo` | `useActionRegistry.ts` -> `handleQuickAgent()` | `sessions.create` | `needs ui bridge` | `ika-frontend` | First vertical target. |
| `session.start-on-ticket` | `useActionRegistry.ts` -> `navigateToDashboard()` | none | `ui-only non-agent surface` | `ika-frontend` | Palette shortcut currently navigates to dashboard; actual ticket start lives in `StartWorkModal`. |
| `session.customize` | `useActionRegistry.ts` -> `CustomizeSessionDialog.open()` | none for dialog open; create path maps to `sessions.create` | `ui-only non-agent surface` | `ika-frontend` | Keep dialog open as UI-only; bridge its submit path, not the opener. |
| `session.switch-to-tab` | noop placeholder in `useActionRegistry.ts` | none | `ui-only non-agent surface` | `ika-frontend` | Local browser tab selection. |
| `session.rename` | `useActionRegistry.ts` -> `handleRenameActiveSession()` -> private `PATCH /sessions/:id` | none | `needs gateway command` | `kani-backend` | Rename is durable session metadata, not just browser chrome. |
| `session.start-work-in-env` | `useActionRegistry.ts` -> `EnvPickerDialog` -> `launchEnvironment()` | `sessions.create` | `needs ui bridge` | `ika-frontend` | First vertical target. |
| `session.handoff-to-hub` | `useActionRegistry.ts` -> `HandoffPlanDialog` | `handoffs.plan`, `handoffs.create`, `handoffs.status`, `handoffs.cancel`, `handoffs.resume`, `handoffs.launch`, `artifacts.read` | `needs ui bridge` | `ika-frontend` | Current action opens a planning dialog; bridge execution to the existing handoff gateway family when live execution is wired. |

### Launch/session entrypoints not represented as static `ActionMeta`

| UI action id / entrypoint | Current handler path | Existing CLI/API command | Gap classification | Recommended owner | Notes |
| --- | --- | --- | --- | --- | --- |
| `handleQuickAgent` | `useSessionHandlers.ts` -> `createAgentSession({ type: 'agent' })` | `sessions.create` | `needs ui bridge` | `ika-frontend` | Shared by several registered actions and buttons. |
| `handleQuickTerminal` | `useSessionHandlers.ts` -> `createAgentSession({ type: 'terminal' })` | `sessions.create` | `needs ui bridge` | `ika-frontend` | Shared by palette and direct UI controls. |
| `handleLaunchRepoSession` | `useSessionHandlers.ts` -> `createAgentSession({ repoPath, worktreePath: null })` | `sessions.create` | `needs ui bridge` | `ika-frontend` | Repo dashboard/sidebar launch path. |
| `handleLaunchWorkspaceSession` | `useSessionHandlers.ts` -> `launchWorkspaceSession(workspaceId)` private API | none | `needs gateway command` | `kani-backend` | Workspace launch is not represented in v1; decide whether this becomes a workspace action or expands `sessions.create`. |
| `handleNewWorktree` | `useSessionHandlers.ts` -> `createWorktree()` then `createAgentSession()` | partial: `sessions.create` after worktree exists | `needs gateway command` | `kani-backend` | Worktree creation is private API; do not pretend `sessions.create` covers the whole flow. |
| `handleFixConflicts` | `useSessionHandlers.ts` -> `createWorktree()`/`createAgentSession()` then delayed PTY prompt | partial: `sessions.create` plus `sessions.input`/`supervisor.sendText` | `needs gateway command` | `kani-backend` | Needs a typed workflow action if agents are expected to request conflict-fix sessions. |
| `handleOpenPrBranch` | `useSessionHandlers.ts` -> worktree/session resolution -> `createAgentSession()` and optional delayed PTY prompt | partial: `sessions.create` plus `sessions.input`/`supervisor.sendText` | `needs gateway command` | `kani-backend` | PR branch resolution/worktree creation is currently web-private. |
| `handleOpenBranchSession` | `useSessionHandlers.ts` -> worktree/session resolution -> `createAgentSession()` and optional prompt | partial: `sessions.create` plus `sessions.input`/`supervisor.sendText` | `needs gateway command` | `kani-backend` | Same branch/session workflow gap. |
| `handleArchive` | `useSessionHandlers.ts` -> `killSession()` then `deleteWorktree()` | none | `needs gateway command` | `kani-backend` | Destructive session + worktree cleanup needs typed confirmation/audit before agent exposure. |
| `handleDeleteWorktree` | `useSessionHandlers.ts` -> `fetchWorktreeStatus()`/`deleteWorktree()` | none | `needs gateway command` | `kani-backend` | Worktree deletion is private API today. |
| `TerminalNodePicker` | `TerminalNodePicker.tsx` + `WorkspaceArea.tsx` | `nodes.list` for inventory, `sessions.create` for launch | `needs ui bridge` | `ika-frontend` | First vertical target; preserve disabled node reasons. |
| `EnvPickerDialog` | `EnvPickerDialog.tsx` -> `launchEnvironment()` | `sessions.create` | `needs ui bridge` | `ika-frontend` | Good candidate because selection is already typed and freshness-gated. |
| `CustomizeSessionDialog` | `CustomizeSessionDialog.tsx` -> `createSessionFromForm()` | `sessions.create` | `needs ui bridge` | `ika-frontend` | Good candidate after quick launch because it adds options. |
| `StartWorkModal` | `StartWorkModal.tsx` -> `createAgentSession({ ticketContext })` | partial: `sessions.create` lacks `ticketContext` schema | `needs gateway command` | `kani-backend` | Add/extend a typed command before parity claims. |

### Workspace, file, and workbench actions

| UI action id / entrypoint | Current handler path | Existing CLI/API command | Gap classification | Recommended owner | Notes |
| --- | --- | --- | --- | --- | --- |
| `workspace.add` | `useActionRegistry.ts` -> `setActiveModal({ modal: 'add-repo' })` | none | `needs gateway command` | `kani-backend` | Adding a repo/workspace has durable config effects; #199 may overlap. |
| `workspace.new-worktree` | `useActionRegistry.ts` -> `handleNewWorktree()` | partial: `sessions.create` after private worktree create | `needs gateway command` | `kani-backend` | Needs typed worktree create before agent parity. |
| `workspace.open-branch-divergence` | inline action in `useActionRegistry.ts` -> `openUtilityRailTab(ws, 'branch')` | none | `ui-only non-agent surface` | `ika-frontend` | Browser utility rail state only. |
| `workspace.open-diff-view` | inline action in `useActionRegistry.ts` -> `openReviewWorkspace(ws)` | none | `ui-only non-agent surface` | `ika-frontend` | Browser review-pane state only. |
| `workspace.close-diff-view` | inline action in `useActionRegistry.ts` -> clear `fullPageDiff` | none | `ui-only non-agent surface` | `ika-frontend` | Browser overlay state only. |
| `workspace.open-file-browser` | `useActionRegistry.ts` noop placeholder | `files.list`, `files.stat`, `files.read`, `files.write` | `needs ui bridge` | `ika-frontend` | Existing file RPC covers data operations; browser panel execution is not wired. |
| `workspace.add-file-block` | `useActionRegistry.ts` noop placeholder | `files.list`, `files.stat`, `files.read`, `files.write`; possibly `context.create`/`context.pin` later | `needs ui bridge` | `ika-frontend` | Bridge to File RPC/context commands when the workbench block surface is real. |
| `navigation.open-file` | `useActionRegistry.ts` -> `setFilePickerOpen(true)`; `App.tsx` -> `FilePicker.onSelect()` opens local UI tab/review | `files.list`, `files.read` for file data | `ui-only non-agent surface` | `ika-frontend` | Opening a browser file tab is UI state; agents should use `files.read` unless a later issue defines a shared tab-open action. |

### PR, branch, and dashboard actions

| UI action id / entrypoint | Current handler path | Existing CLI/API command | Gap classification | Recommended owner | Notes |
| --- | --- | --- | --- | --- | --- |
| `pr.create` | `useActionRegistry.ts` -> `navigateToDashboard()` | none | `needs gateway command` | `kani-backend` | PR creation is not in the Relay v1 manifest. Do not substitute GitHub-specific schemas without a Relay command decision. |
| `pr.push-branch` | `useActionRegistry.ts` -> `navigateToDashboard()` | none | `needs gateway command` | `kani-backend` | Needs a Relay command only if Relay owns branch push automation. |
| `pr.switch-branch` | `useActionRegistry.ts` -> `navigateToDashboard()` | none | `needs gateway command` | `kani-backend` | Branch checkout/worktree mutation is not stable gateway API. |
| `pr.fix-conflicts` | `useActionRegistry.ts` -> `navigateToDashboard()`; direct handler exists as `handleFixConflicts()` | partial: `sessions.create` + input/supervisor commands | `needs gateway command` | `kani-backend` | The registered action is a dashboard jump, but the real workflow starts sessions and injects prompts. |
| `pr.archive-branch` | `useActionRegistry.ts` -> `navigateToDashboard()` | none | `needs gateway command` | `kani-backend` | Destructive branch/worktree semantics require typed audit/confirmation if exposed. |
| `pr.rename-branch` | `useActionRegistry.ts` -> `navigateToDashboard()` | none | `needs gateway command` | `kani-backend` | Missing stable branch mutation command. |
| `pr.copy-branch-name` | `useActionRegistry.ts` -> `navigator.clipboard.writeText(branch)` | none | `ui-only non-agent surface` | `ika-frontend` | Clipboard helper only. |
| `pr.open-external` | `useActionRegistry.ts` -> `navigateToDashboard()` or browser external link elsewhere | none | `ui-only non-agent surface` | `ika-frontend` | Browser navigation helper. |
| `pr.refresh` | `useActionRegistry.ts` -> `useSessionsStore.refreshAll()` | `sessions.list`, `sessions.get`, possibly `nodes.list` | `needs ui bridge` | `ika-frontend` | Data refresh can be represented as descriptor reads, but browser cache refresh remains UI state. |
| `pr.change-target` | `useActionRegistry.ts` -> `navigateToDashboard()` | none | `needs gateway command` | `kani-backend` | Target branch mutation is not in Relay v1. |
| `pr.skip-checks` | `useActionRegistry.ts` -> `navigateToDashboard()` | none | `needs gateway command` | `kani-backend` | Release/check policy override needs explicit command/audit if it becomes agent-operable. |
| `dashboard.open-pr-session` | `useActionRegistry.ts` -> `handleQuickAgent()`; direct dashboard `handleOpenPrSession()` opens PR branch | partial: `sessions.create` | `needs gateway command` | `kani-backend` | Registered action is too generic; the real PR branch workflow needs typed branch/worktree selection. |
| `dashboard.sort-prs` | noop placeholder | none | `ui-only non-agent surface` | `ika-frontend` | Browser table sorting. |
| `dashboard.clear-filters` | noop placeholder | none | `ui-only non-agent surface` | `ika-frontend` | Browser filter state. |
| `org.switch-tab` | noop placeholder | none | `ui-only non-agent surface` | `ika-frontend` | Browser tab state. |
| `org.save-filter` | noop placeholder | none | `ui-only non-agent surface` | `ika-frontend` | Treat as UI preference until a durable saved-filter command is requested. |
| `org.delete-filter` | noop placeholder | none | `ui-only non-agent surface` | `ika-frontend` | Same saved-filter caveat. |
| `org.toggle-pr-status` | noop placeholder | none | `ui-only non-agent surface` | `ika-frontend` | Browser filter state. |
| `org.navigate-to-workspace` | noop placeholder | none | `ui-only non-agent surface` | `ika-frontend` | Browser navigation. |
| `ticket.switch-provider` | noop placeholder | none | `ui-only non-agent surface` | `ika-frontend` | Browser tab/filter state. |
| `ticket.open-external` | noop placeholder | none | `ui-only non-agent surface` | `ika-frontend` | Browser external link. |

### Settings and integration actions

| UI action id / entrypoint | Current handler path | Existing CLI/API command | Gap classification | Recommended owner | Notes |
| --- | --- | --- | --- | --- | --- |
| `settings.open` | `useActionRegistry.ts` -> `handleOpenSettings()` | none | `ui-only non-agent surface` | `ika-frontend` | Dialog opener only. |
| `settings.connect-github` | `useActionRegistry.ts` -> settings integrations section | none | `needs gateway command` | `kani-backend` | #199 overlap; auth/connect mutation needs stable command before agent exposure. |
| `settings.disconnect-github` | `useActionRegistry.ts` -> settings integrations section | none | `needs gateway command` | `kani-backend` | Same #199 overlap. |
| `settings.setup-webhooks` | `useActionRegistry.ts` -> settings integrations section | none | `needs gateway command` | `kani-backend` | Webhook mutation should be typed/audited if agent-operable. |
| `settings.remove-webhook` | `useActionRegistry.ts` -> settings integrations section | none | `needs gateway command` | `kani-backend` | Destructive integration mutation. |
| `settings.test-webhook` | `useActionRegistry.ts` -> settings integrations section | none | `needs gateway command` | `kani-backend` | Agent-operable test may be useful, but no v1 command exists. |
| `settings.connect-jira` | `useActionRegistry.ts` -> settings integrations section | none | `needs gateway command` | `kani-backend` | #199 overlap. |
| `settings.disconnect-jira` | `useActionRegistry.ts` -> settings integrations section | none | `needs gateway command` | `kani-backend` | #199 overlap. |
| `settings.toggle-yolo` | `useActionRegistry.ts` -> `setDefaultYolo()` private API | none | `needs gateway command` | `kani-backend` | Existing mutation has durable config semantics. |
| `settings.check-updates` | `useActionRegistry.ts` -> settings about section | none | `ui-only non-agent surface` | `ika-frontend` | Dialog navigation; a future update command should be separate if needed. |
| `settings.toggle-devtools` | `useActionRegistry.ts` -> settings advanced section | none | `ui-only non-agent surface` | `ika-frontend` | Browser-local setting unless made durable. |
| `settings.clear-analytics` | `useActionRegistry.ts` -> settings advanced section | none | `needs gateway command` | `kani-backend` | If this clears stored analytics, it should be a typed destructive command; currently just opens the section. |
| `settings.toggle-continue` | `useActionRegistry.ts` -> settings general section | none | `needs gateway command` | `kani-backend` | Durable launch default if the setting is persisted. |
| `settings.toggle-notifications` | `useActionRegistry.ts` -> settings general section | none | `needs gateway command` | `kani-backend` | Durable notification default if persisted. |
| `settings.change-default-agent` | `useActionRegistry.ts` -> settings general section | none | `needs gateway command` | `kani-backend` | Durable launch default. |

### Sidebar, terminal chrome, and navigation actions

| UI action id / entrypoint | Current handler path | Existing CLI/API command | Gap classification | Recommended owner | Notes |
| --- | --- | --- | --- | --- | --- |
| `sidebar.collapse` | `useActionRegistry.ts` -> `toggleSidebarCollapsed()` | none | `ui-only non-agent surface` | `ika-frontend` | Browser chrome. |
| `sidebar.navigate-dashboard` | `useActionRegistry.ts` -> `navigateToDashboard()` | none | `ui-only non-agent surface` | `ika-frontend` | Browser navigation. |
| `sidebar.workspace-settings` | `useActionRegistry.ts` -> `WorkspaceSettingsDialog.open()` | none for opener | `ui-only non-agent surface` | `ika-frontend` | Bridge individual settings mutations, not the opener. |
| `sidebar.rename-session` | `useActionRegistry.ts` -> `handleRenameActiveSession()` | none | `needs gateway command` | `kani-backend` | Same gap as `session.rename`. |
| `sidebar.delete-worktree` | `useActionRegistry.ts` -> `DeleteWorktreeDialog.open()` then private delete path | none | `needs gateway command` | `kani-backend` | Destructive worktree mutation. |
| `sidebar.resume-session` | `useActionRegistry.ts` -> `handleQuickAgent()` | `sessions.create` or future resume-specific command | `needs ui bridge` | `ika-frontend` | Current label says resume, but handler starts quick agent; validate semantics in #859. |
| `sidebar.resume-yolo` | `useActionRegistry.ts` -> `handleQuickAgent()` | `sessions.create` | `needs ui bridge` | `ika-frontend` | Current yolo label is not reflected in the handler; follow-up should decide whether it is stale or needs typed input. |
| `terminal.scroll-top` | `useActionRegistry.ts` -> xterm `scrollToLine(0)` | none | `ui-only non-agent surface` | `ika-frontend` | Browser terminal viewport only. |
| `terminal.scroll-bottom` | `useActionRegistry.ts` -> xterm `scrollToBottom()` | none | `ui-only non-agent surface` | `ika-frontend` | Browser terminal viewport only. |
| `navigation.previous-tab` | `useActionRegistry.ts` -> local session selection | none | `ui-only non-agent surface` | `ika-frontend` | Browser tab selection. |
| `navigation.next-tab` | `useActionRegistry.ts` -> local session selection | none | `ui-only non-agent surface` | `ika-frontend` | Browser tab selection. |
| `navigation.switch-to-tab` | noop placeholder | none | `ui-only non-agent surface` | `ika-frontend` | Browser tab selection. |

### Gateway projection actions

| UI action id / entrypoint | Current handler path | Existing CLI/API command | Gap classification | Recommended owner | Notes |
| --- | --- | --- | --- | --- | --- |
| `gateway.<command>` for every `RELAY_COMMAND_MANIFEST.commands[]` entry | `definitions/cli-gateway.ts` -> disabled Command Center action with CLI argv in `disabledReason` | exact command named after `gateway.` prefix | `covered` | `kani-backend` for command contract; `ika-frontend` for optional UI execution bridge | These are already the stable CLI/agent surface. Do not duplicate them as separate frontend actions. |

## Follow-up map

Recommended issue ownership from this inventory:

1. #858 should reconcile `ActionMeta` and `RelayCommandDefinition` into one descriptor/projection layer. It should not create a second command system.
2. #859 should convert the `sessions.create` launch family first: quick agent, quick terminal, `TerminalNodePicker`, `EnvPickerDialog`/`launchEnvironment`, and `CustomizeSessionDialog` submit.
3. Backend follow-ups should add or extend gateway commands for durable/mutating web-only semantics before agents depend on them:
   - session close/kill and rename;
   - worktree create/delete/archive;
   - workspace/repo add and workspace launch;
   - ticket-context start-work and PR/branch workflow actions;
   - settings/integration mutations from #199.
4. UI-only surfaces should stay UI-only unless a later product issue names an agent use case: browser navigation, tab switching, sorting/filtering, terminal viewport scrolling, external-link openers, dialog openers, and clipboard helpers.

## Key invariant for implementers

For #849, the stable product direction is: web UI, Command Center, mobile/action cards, `relay-ide v1 ... --json`, and provider adapters should be projections of one Relay command/action manifest. Raw PTY input and private React handlers remain escape hatches and implementation details, not the product automation contract.
