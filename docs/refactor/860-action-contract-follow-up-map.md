# #860 action-contract parity rule and follow-up map

Issue: [#860](https://github.com/donovan-yohan/relay-ide/issues/860)
Parent epic: [#849](https://github.com/donovan-yohan/relay-ide/issues/849)
Source inventory: [#857 action parity inventory](857-action-parity-inventory.md)
First converted launch slice: [#859](https://github.com/donovan-yohan/relay-ide/issues/859)

## Action-contract parity rule

Relay's web UI is one client over Relay action contracts. The stable agent-facing source of truth is the v1 CLI/API gateway contract declared in `shared/cli-gateway-contract.ts` and projected through `shared/relay-command-manifest.ts` / `shared/action-descriptor.ts`.

Command Center actions may be searchable browser affordances, but they are not automatically stable agent API. UI-only helpers must stay marked as UI-only until a product issue names an agent/operator use case and the stable Relay command manifest has the typed input, typed result/error envelope, side-effect class, capability/availability behavior, confirmation/control requirements, and audit/redaction expectations.

## #859 converted launch path

The first converted vertical is session launch through the stable command id `sessions.create`:

- Stable CLI/API command: `relay-ide v1 sessions create --input-json '{...}' --json`
- Shared descriptor source: `sessionCreateActionDescriptor()` in `frontend/src/lib/actions/session-create.ts`, generated from `relayCommandDefinition('sessions.create')`
- Browser action metadata using the descriptor: `session.new-agent`, `session.new-terminal`, `session.start-on-repo`, and `session.start-work-in-env`
- Typed input: `CreateSessionBody` / the `sessions.create` input schema, including local `repoPath` + optional `worktreePath`, routed `nodeId` + `cwd`, `type`, `mode`, `agent`, lifecycle/session-envelope fields where supported, and the typed `environment` object for routed environment launches
- Typed success result: the normal v1 `RelayCliGatewayEnvelope<SessionSummary>` with `ok`, `contract`, `contractVersion`, `command: "sessions.create"`, and `data` containing session identity such as `id`, `globalSessionId`, `nodeId`, `cwd`, `repoPath`, `worktreePath`, `type`, `mode`, and `agent` when present
- Typed failure result: the normal v1 gateway error envelope from `gatewayError('sessions.create', ...)`, including stable error codes such as `NODE_OFFLINE`, `SESSION_CONFLICT`, `CONFIRMATION_REQUIRED`, `INVALID_ARGUMENT`, `UNSUPPORTED`, or `UPSTREAM_ERROR`
- Availability/capability behavior: `sessionCreateActionAvailability()` reports the shared availability shape. Missing workspace/cwd/selected environment is unavailable; offline node or unsupported capability reasons stay unavailable with the `sessions.create` capability hints. Web and CLI callers must not silently downgrade those failures into private UI fallbacks.

This documents only the converted `sessions.create` launch family. Other action groups below remain follow-up work.

## #869 converted lifecycle slice

The second converted vertical is session close/kill/rename through the stable command ids `sessions.kill` and `sessions.rename`:

- Stable CLI/API commands: `relay-ide v1 sessions kill --id <session-id> --json` and `relay-ide v1 sessions rename --id <session-id> --display-name <display-name> --json`
- Shared descriptor source: `sessionKillActionDescriptor()` / `sessionRenameActionDescriptor()` in `frontend/src/lib/actions/session-lifecycle.ts`, generated from `relayCommandDefinition('sessions.kill')` and `relayCommandDefinition('sessions.rename')`
- Browser action metadata using the descriptors: `session.close-active` and `session.kill` bridge to `sessions.kill`; `session.rename` and `sidebar.rename-session` bridge to `sessions.rename`
- Typed input: `{ id, confirmationToken? }` for kill and `{ id, displayName }` for rename, matching the `sessions.kill` / `sessions.rename` input schemas
- Typed success result: the normal v1 `RelayCliGatewayEnvelope` with `ok`, `contract`, `contractVersion`, `command`, and `data` carrying session identity. Kill data is `{ ok, killed, id, sessionId, requestedId, nodeId, globalSessionId }`; rename data is `{ renamed, id, sessionId, requestedId, nodeId, globalSessionId, displayName, session? }`
- Typed failure result: the normal v1 gateway error envelope from `gatewayError('sessions.kill', ...)` / `gatewayError('sessions.rename', ...)`, including stable codes `NOT_FOUND`, `NODE_OFFLINE`, `FORBIDDEN`, `CONFIRMATION_REQUIRED`, and `UPSTREAM_ERROR`. Session-control `reasonCode`s (`SESSION_NOT_FOUND`, `SESSION_DISCONNECTED`, `CONTROL_STATE_STALE`, `CONTROL_STATE_UNKNOWN`, `CAPABILITY_REQUIRED`) ride on `error.details.reasonCode`; stale/unknown control state and disconnected/unsupported-mode sessions surface as gateway `FORBIDDEN`
- Confirmation/side-effect: `sessions.kill` is a destructive command (`sideEffect: 'destructive'`, `confirmation.required: true`); execution delegates to api.ts `killSession`, whose `registerConfirmationRetry` loop remains the single confirmation-token path. `sessions.rename` is a non-destructive write (`sideEffect: 'write'`, `confirmation.required: false`)
- Availability/capability behavior: `sessionKillActionAvailability()` / `sessionRenameActionAvailability()` report the shared availability shape with the `session:read` + `session:control:kill` / `session:control:rename` capability hints. Missing session, offline node, unsupported session mode, and stale/unknown control state map to `unavailable`

### `session.close-active` → `sessions.kill` split rationale

`close` is `kill` plus a tab-selection UI layered on top, not a distinct verb. Closing the active tab destroys the underlying session, which is exactly the `sessions.kill` destructive contract; the only extra behavior is selecting the next tab in the web UI, which stays browser-only. No new `sessions.close` command is introduced. `sessions.detach` already owns the non-destructive close path (handle-release only) and is untouched by this slice.

### `sidebar.rename-session` → `sessions.rename` collapse

`sidebar.rename-session` was a duplicate browser-only rename affordance. It collapses into the single `sessions.rename` descriptor and shares the same executor; there is no separate sidebar rename command. The sidebar entry point remains a UI affordance over the one stable rename contract.

## #870 converted workspace/worktree lifecycle slice

The third converted vertical is workspace launch + worktree create/delete/archive through the stable command ids `workspaces.launch`, `worktrees.create`, `worktrees.delete`, and `worktrees.archive`. The backend gateway verbs, manifest classification, and server fail-closed gates were already complete before this slice; #870 is the frontend bridge only.

- Stable CLI/API commands: `relay-ide v1 workspaces launch --input-json '{...}' --json`, `relay-ide v1 worktrees create --input-json '{...}' --json`, `relay-ide v1 worktrees delete --input-json '{...}' --json`, and `relay-ide v1 worktrees archive --input-json '{...}' --json`
- Shared descriptor source: `worktreeCreateActionDescriptor()`, `worktreeDeleteActionDescriptor()`, `worktreeArchiveActionDescriptor()`, and `workspaceLaunchActionDescriptor()` in `frontend/src/lib/actions/workspace-lifecycle.ts`, generated from `relayCommandDefinition('worktrees.create' | 'worktrees.delete' | 'worktrees.archive' | 'workspaces.launch')`
- Browser action metadata using the descriptors: `workspace.new-worktree` bridges its createWorktree step to `worktrees.create`; the new `workspace.launch` Command Center action bridges to `workspaces.launch`; `sidebar.delete-worktree` collapses onto `worktrees.delete`
- Typed input (browser inputs pass explicit `repoPath` / `worktreePath` / `workspaceId` — never read from browser active-repo state inside the bridge module): `{ environment?, repoPath?, branch?, confirmationToken? }` for create → `{ branchName, mountainName?, worktreePath, existing? }`; `{ environment?, repoPath?, worktreePath?, force?, confirmationToken? }` for delete/archive → `{ ok, action, branchDeleted, audit }`; `{ workspaceId, agent?, yolo?, ... }` for launch → the `sessions.create`-style session descriptor envelope
- Typed failure result: the normal v1 gateway error envelope from `gatewayError('worktrees.create' | 'worktrees.delete' | 'worktrees.archive' | 'workspaces.launch', ...)`, including stable codes `NOT_FOUND`, `NODE_OFFLINE`, `FORBIDDEN`, `CONFIRMATION_REQUIRED`, `UNSUPPORTED`, and `UPSTREAM_ERROR`. Server fail-closed reasonCodes (`uncommitted_changes`, `active_sessions`) ride on `error.details.reasonCode`; `rejectRemoteLifecycleWrite` surfaces `UNSUPPORTED` for non-local nodes
- Confirmation/side-effect: `worktrees.delete` and `worktrees.archive` are destructive (`sideEffect: 'destructive'`, `confirmation.required: true` — they are in `DESTRUCTIVE_GATEWAY_COMMANDS`); `workspaces.launch` and `worktrees.create` are non-destructive writes (`sideEffect: 'write'`)
- Availability/capability behavior: the `*ActionAvailability()` helpers report the shared availability shape with each command's capability hints. Missing workspace / repo / worktree path, offline node, and unsupported remote capability map to `unavailable`

### `handleArchive` → `worktrees.archive` (branch-preserving) decision

`handleArchive` previously killed the session and then called `deleteWorktree`, which removed the branch. This slice deliberately changes that to ARCHIVE the worktree via `worktrees.archive`, which is branch-PRESERVING. The session kill goes through the existing `executeSessionKillAction` (#869); only the worktree removal switches to the archive executor. This is a behavior change, not a refactor: archived branches are kept. Preservation is ENFORCED, not just labelled: the archive executor calls `deleteWorktree(..., deleteBranch=false)` because the DELETE `/worktrees` route treats a missing `deleteBranch` flag as `true` (`deleteBranch !== false`) — omitting it would silently delete the branch while the envelope reported `branchDeleted: false`. UI copy that mentions deletion must stay honest about preservation. A registry test asserts that `handleArchive` calls the kill executor first and then the archive executor (not the delete executor); an action test asserts the archive envelope reports `branchDeleted: false`.

### `sidebar.delete-worktree` → `worktrees.delete` collapse

`sidebar.delete-worktree` and `handleDeleteWorktree` collapse onto the single `worktrees.delete` descriptor and executor; there is no separate sidebar delete command. `DeleteWorktreeDialog` stays the browser confirmation surface layered over the destructive contract, and preserves its force re-send flow (it always force-deletes the dirty/active worktree it confirms).

### `workspace.add` stays UI-only (named exception)

`workspace.add` remains a dialog opener and does NOT attach the `repos.add` descriptor. `AddWorkspaceDialog` does multi-path bulk add, while the stable `repos.add` verb is single-path; bulk-add parity is deferred. This is the explicit #870 UI-only exception, analogous to the dialog/section openers listed under "UI-only surfaces that stay UI-only for now."

## #871/#876 converted start-work slice

The fourth converted vertical is ticket/PR/branch start-work through the stable command ids `tickets.startWork` and `branches.openSession`. The backend gateway verbs, manifest classification, and workflow input/output schemas landed via PR #879 and are frozen; #871/#876 is the frontend bridge only. One PR closes BOTH #871 (contracts honored + docs) and #876 (UI bridged).

- Stable CLI/API commands: `relay-ide v1 tickets start-work --input-json '{...}' --json` and `relay-ide v1 branches open-session --input-json '{...}' --json`
- Shared descriptor source: `ticketStartWorkActionDescriptor()` / `branchOpenSessionActionDescriptor()` in `frontend/src/lib/actions/start-work-lifecycle.ts`, generated from `relayCommandDefinition('tickets.startWork')` and `relayCommandDefinition('branches.openSession')`. That module also exposes the composite executors `executeTicketStartWorkAction` / `executeBranchOpenSessionAction` — thin client compositions that (1) keep the store-state reuse lookup in the handlers as a fast path, (2) optionally call `executeWorktreeCreateAction`, (3) call `createSession` with `initialPrompt` / `ticketContext`, and (4) project the result into the `workflowCommandOutputSchema` shape (`session`, `created`/`reused`, `promptHandoff`, `branch`, `pr`)
- Browser action metadata using the descriptors: `session.start-on-ticket` (the `StartWorkModal` ticket entry point) bridges to `tickets.startWork`; `pr.fix-conflicts`, `pr.switch-branch`, and `dashboard.open-pr-session` bridge to `branches.openSession`. The three `useSessionHandlers` handlers (`handleFixConflicts`, `handleOpenPrBranch`, `handleOpenBranchSession`) call `executeBranchOpenSessionAction`; `StartWorkModal`'s `useStartWork` calls `executeTicketStartWorkAction`
- Typed input: `TicketStartWorkActionInput { ticket{source,id,title?,url?,description?}, repo{repoPath,...}, branch?, worktree?, session?, prompt? }` for tickets (the modal maps `ticketId` -> `id`, preserving the `GH-<number>` formatting buildCtx applies); `BranchOpenSessionActionInput { repo, branch?|pr?, worktree?, session?, prompt?, existingWorktreePath? }` for branches/PRs (PR target = `pr{head,base}` + `branch{name:head}`, branch target = `branch{name}`). Both project to `workflowCommandOutputSchema`
- Typed failure result: the normal v1 gateway error envelope, including stable codes `UNAUTHORIZED`, `FORBIDDEN`, `INVALID_ARGUMENT`, `INVALID_JSON`, `UNSUPPORTED`, `NOT_FOUND`, `SESSION_CONFLICT`, `CONFIRMATION_REQUIRED`, `NODE_OFFLINE`, and `UPSTREAM_ERROR`. The `PROMPT_HANDOFF_UNSUPPORTED` reasonCode rides on the envelope for prompt mode `unsupported` + `requireTypedDelivery`
- Confirmation/side-effect: `tickets.startWork` and `branches.openSession` are non-destructive writes (`sideEffect: 'write'`, `confirmation.required: false` — they are in `WRITE_GATEWAY_COMMANDS`)
- Availability/capability behavior: `ticketStartWorkActionAvailability()` / `branchOpenSessionActionAvailability()` report the shared availability shape with the start-work capability hints. Missing workspace maps to `unavailable`. Local-first: remote-node start-work is deferred and fails closed like worktree writes

### typed `initialPrompt` replaces the setTimeout/sendPtyData anti-pattern

The three branch handlers previously delivered the conflict/PR/branch prompt with `setTimeout(() => sendPtyData(prompt + '\r'), 1500)` — a race-prone fire-and-forget that hoped the terminal WebSocket had connected. This slice removes those blocks. The prompt now rides `prompt: { mode: 'initial-prompt', prompt }` on the executor input; the executor passes it through `createSession`'s `initialPrompt` field, which the server delivers as a one-shot typed prompt on session create (the contract's `promptHandoff.method = 'sessions.create.initialPrompt'`). The `sendPtyData` import was dropped from `useSessionHandlers` once no caller remained.

### `SESSION_CONFLICT` is focus-existing success

A `sessions.create` 409 carrying a `sessionId` is success/focus-existing semantics, not an error. The composite executors surface it as a `SESSION_CONFLICT` error envelope whose `details.sessionId` names the existing session. Every UI call site treats that as a focus-existing success: `StartWorkModal` maps it to `onSessionCreated(sessionId)` (preserving the prior `ConflictError` behavior), and the three branch handlers set the active repo/session and close the sidebar. This preserves the exact prior `ConflictError` focus-existing flow.

### UI-only exceptions (named)

`pr.copy-branch-name` (clipboard) and `pr.open-external` (external link) stay descriptor-free browser chrome — no stable agent contract, per the #860 parity rule. `controlMode` stays optional/default so there is no #859 regression.

## Follow-up issues

| Issue                                                         | Group                                    | Owner area                          | Gap type                | Scope                                                                                                                                                                                     | Parent closeout impact                                                           |
| ------------------------------------------------------------- | ---------------------------------------- | ----------------------------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| [#869](https://github.com/donovan-yohan/relay-ide/issues/869) | Session close/kill/rename                | backend + CLI, then frontend bridge | `needs gateway command` | Add stable lifecycle command descriptors for `session.close-active`, `session.kill`, `session.rename`, and `sidebar.rename-session`.                                                      | Does not block #849 closeout after #860 lands; it is remaining parity burn-down. |
| [#870](https://github.com/donovan-yohan/relay-ide/issues/870) | Workspace/repo/worktree lifecycle        | frontend bridge (backend already complete) | `converted` (see #870 slice above) | Backend gateway verbs `workspaces.launch`, `worktrees.create`, `worktrees.delete`, `worktrees.archive` were already complete; this slice bridges the browser handlers + Command Center to them. `workspace.add` (`repos.add` bulk-parity) stays UI-only — remaining follow-up. | Done as a parity burn-down slice; does not block #849 closeout. |
| [#871](https://github.com/donovan-yohan/relay-ide/issues/871) | Ticket/PR branch start-work workflows    | frontend bridge (backend landed via #879) | `converted` (see #871/#876 slice above) | Backend gateway verbs `tickets.startWork` and `branches.openSession` (typed ticket-context start-work, PR branch open, branch session, conflict-fix) landed via PR #879 and are frozen; this slice bridges `StartWorkModal` + the three `useSessionHandlers` handlers + Command Center to them. Replaces the dashboard-navigation/`sessions.create`-alone parity stub. | Done as a parity burn-down slice; does not block #849 closeout. |
| [#876](https://github.com/donovan-yohan/relay-ide/issues/876) | Start-work UI execution bridge           | frontend                            | `converted` (see #871/#876 slice above) | UI counterpart to #871: routes `StartWorkModal`, `handleFixConflicts`, `handleOpenPrBranch`, and `handleOpenBranchSession` through `executeTicketStartWorkAction` / `executeBranchOpenSessionAction`, removing the `setTimeout(sendPtyData)` prompt anti-pattern in favor of typed `initialPrompt`. Closed together with #871 in one PR. | Done as a parity burn-down slice; does not block #849 closeout. |
| [#872](https://github.com/donovan-yohan/relay-ide/issues/872) | File/context/handoff UI execution bridge | frontend                            | `needs ui bridge`       | Route selected browser actions to existing `files.*`, `context.*`, `handoffs.*`, `artifacts.read`, and disabled `gateway.<command>` descriptors where the gateway command already exists. | Does not block #849 closeout after #860 lands.                                   |
| [#873](https://github.com/donovan-yohan/relay-ide/issues/873) | Settings/integration mutations           | backend + CLI, then frontend bridge | `needs gateway command` | Split real durable settings/integration mutations from settings dialog openers, with secret redaction and confirmation/audit requirements. Related to #199.                               | Does not block #849 closeout after #860 lands.                                   |

## UI-only surfaces that stay UI-only for now

The #857 inventory intentionally leaves browser chrome outside the stable agent API unless a later product issue accepts an agent use case. Examples include local tab switching, command palette navigation, dashboard sorting/filtering, terminal viewport scrolling, external-link openers, dialog/section openers, clipboard helpers, and browser panel focus.

Do not convert those by naming them in the CLI manifest just to make the inventory look complete. The invariant is one Relay-owned command vocabulary for product operations, not every click becoming an automation surface.

## Parent #849 closeout recommendation

After the #860 docs PR lands and #849 links to this map, #849 has delivered its intended first pass: inventory (#857), shared descriptor foundation (#858), converted session launch slice (#859), parity rule documentation, and explicit follow-up issues for the remaining web-only groups.

Parent #849 should not wait for #869-#873 unless the parent is re-scoped to require full web/CLI parity across every remaining action group. Those issues are the burn-down map for the next parity wave, not hidden acceptance debt for this first pass.
