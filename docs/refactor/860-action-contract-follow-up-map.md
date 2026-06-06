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

## Follow-up issues

| Issue                                                         | Group                                    | Owner area                          | Gap type                | Scope                                                                                                                                                                                     | Parent closeout impact                                                           |
| ------------------------------------------------------------- | ---------------------------------------- | ----------------------------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| [#869](https://github.com/donovan-yohan/relay-ide/issues/869) | Session close/kill/rename                | backend + CLI, then frontend bridge | `needs gateway command` | Add stable lifecycle command descriptors for `session.close-active`, `session.kill`, `session.rename`, and `sidebar.rename-session`.                                                      | Does not block #849 closeout after #860 lands; it is remaining parity burn-down. |
| [#870](https://github.com/donovan-yohan/relay-ide/issues/870) | Workspace/repo/worktree lifecycle        | backend + CLI, then frontend bridge | `needs gateway command` | Add stable workspace/repo add, workspace launch, worktree create, and worktree delete/archive command coverage.                                                                           | Does not block #849 closeout after #860 lands.                                   |
| [#871](https://github.com/donovan-yohan/relay-ide/issues/871) | Ticket/PR branch start-work workflows    | backend + CLI + frontend            | `needs gateway command` | Define typed ticket-context start-work, PR branch open, branch session, and conflict-fix launch contracts instead of treating dashboard navigation or `sessions.create` alone as parity.  | Does not block #849 closeout after #860 lands.                                   |
| [#872](https://github.com/donovan-yohan/relay-ide/issues/872) | File/context/handoff UI execution bridge | frontend                            | `needs ui bridge`       | Route selected browser actions to existing `files.*`, `context.*`, `handoffs.*`, `artifacts.read`, and disabled `gateway.<command>` descriptors where the gateway command already exists. | Does not block #849 closeout after #860 lands.                                   |
| [#873](https://github.com/donovan-yohan/relay-ide/issues/873) | Settings/integration mutations           | backend + CLI, then frontend bridge | `needs gateway command` | Split real durable settings/integration mutations from settings dialog openers, with secret redaction and confirmation/audit requirements. Related to #199.                               | Does not block #849 closeout after #860 lands.                                   |

## UI-only surfaces that stay UI-only for now

The #857 inventory intentionally leaves browser chrome outside the stable agent API unless a later product issue accepts an agent use case. Examples include local tab switching, command palette navigation, dashboard sorting/filtering, terminal viewport scrolling, external-link openers, dialog/section openers, clipboard helpers, and browser panel focus.

Do not convert those by naming them in the CLI manifest just to make the inventory look complete. The invariant is one Relay-owned command vocabulary for product operations, not every click becoming an automation surface.

## Parent #849 closeout recommendation

After the #860 docs PR lands and #849 links to this map, #849 has delivered its intended first pass: inventory (#857), shared descriptor foundation (#858), converted session launch slice (#859), parity rule documentation, and explicit follow-up issues for the remaining web-only groups.

Parent #849 should not wait for #869-#873 unless the parent is re-scoped to require full web/CLI parity across every remaining action group. Those issues are the burn-down map for the next parity wave, not hidden acceptance debt for this first pass.
