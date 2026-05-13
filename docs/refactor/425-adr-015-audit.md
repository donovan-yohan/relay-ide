# #425 — ADR-015 core audit

Audit pass against [ADR-015](../adrs/ADR-015-core-primitives-domain-agnostic.md).
This document is the audit deliverable; it does not change behavior. Each
finding is filed as a sub-issue of #425 so refactor work can land in
reviewable, independent slices.

## Audit scope

Eight modules that ADR-015 declares as the relay core (must stay
domain-agnostic):

- `server/hub-node-link.ts`
- `server/node-link-client.ts`
- `server/node-link-pty-host.ts`
- `server/hub-node-registry.ts`
- `server/hub-node-router.ts` (routing-only surface; ADR acknowledges this
  file is currently mixed-responsibility)
- `server/node-manifest.ts`
- `shared/relay-node-protocol.ts`
- `shared/node-manifest.ts`

Plus an outer pass on tests that exercise these modules.

## Findings summary

| Group | Theme                                                                   | Count |
| ----- | ----------------------------------------------------------------------- | ----- |
| A     | Repo-inventory types imported into core link/registry/client            | 4     |
| B     | Repo-aware HTTP endpoints embedded in `hub-node-router.ts`              | 2     |
| C     | Required repo/worktree/branch fields in `SessionSummary`                | 2     |
| D     | `worktreeCapabilityStatus` baked into core registry summary             | 1     |
| E     | Framework probing wired into `server/node-manifest.ts`                  | 1     |
| F     | Test fixtures hardcode framework names (`claude/codex/opencode/hermes`) | 4     |

`shared/relay-node-protocol.ts`, `shared/node-manifest.ts`, `server/hub-node-link.ts`
(stream-side), `server/node-link-client.ts` (stream-side),
`server/node-link-pty-host.ts` are otherwise clean.

## Detailed findings

### Group A — repo-inventory types in core (4 findings)

Core modules import `RepoInventoryReport` from `shared/repo-inventory.ts`,
which couples them to the repo feature contract even though the payload is
optional on the wire.

- `server/hub-node-link.ts:8-10` — `import type { RepoInventoryReport }` plus
  inline validation `manifestFromPayload` / `repoInventoryFromPayload`. Core
  validates a feature-layer shape.
- `server/node-link-client.ts:5,~164-167` — accepts `getRepoInventory()` as an
  optional dep; type-imports the repo contract into the client.
- `server/hub-node-registry.ts:8,47,~521-528,~555-562` — stores
  `RepoInventoryReport` as a typed field on the persisted node record and
  exposes `listRepoInventoryReports()`.
- `server/hub-node-router.ts:5-12,~495-507,~689-699` — imports + validates
  repo inventory at the router edge.

Remediation: split the feature shape from the core protocol. Core treats
the payload as `Record<string, unknown>`; a feature-layer module owns the
typed validation, persistence, and surfacing. **Filed as #425.1.**

### Group B — repo-aware HTTP endpoints in `hub-node-router.ts` (2 findings)

`server/hub-node-router.ts` mixes pure routing with feature-layer endpoints.

- `server/hub-node-router.ts:~689` — `GET /hub/repo-inventory` (and POST shape
  for inventory submission via heartbeat).
- `server/hub-node-router.ts:~320-422,~701-805` — `POST /hub/nodes/:nodeId/sessions/reopen`
  cold-reopen flow depends on `RepoInventoryWorktreeInstance`, `repoIdentity`,
  branch divergence/dirty state. Pure repo-feature logic embedded in the core
  router.

Remediation: extract repo endpoints into `server/features/repo-router.ts`
(or similar). Mount from the composition root. Keep pure routing
(pairing, heartbeat envelope, node list, node lifecycle) in the existing
file. **Filed as #425.2.**

### Group C — required repo fields on `SessionSummary` (2 findings)

The core router's `SessionSummary` validator and routing helper mandate
repo/worktree/branch fields. A non-repo node cannot host a session today.

- `server/hub-node-router.ts:~90-113` — `isSessionSummary` requires
  `repoPath: string`, `worktreePath: string | null`, `branchName: string`.
- `server/hub-node-router.ts:~115-141` — `scopedNodeSession` derives
  `repoInstanceId` and `worktreeInstanceId` from those fields as a side
  effect of routing.

Remediation: make `repoPath`, `worktreePath`, `branchName` optional in
`SessionSummary`. Derivation moves to the repo feature layer and decorates
the session summary when present. **Filed as #425.3.**

### Group D — worktree capability baked into core summary (1 finding)

- `server/hub-node-registry.ts:~173-190` — `worktreeCapabilityStatus()`
  computes a `worktrees` capability bucket from `git` availability and
  emits it as a top-level capability on the registry's public summary.

Remediation: move `worktrees` out of the core capability summary. Either
remove it from `HubNodeSummary.capabilities.core` entirely and resurface
from the repo feature, or keep the bucket but make it null/absent when
the repo feature is not active. **Filed as #425.4.**

### Group E — framework probing in core manifest (1 finding)

- `server/node-manifest.ts:9-11,~180-206,~221` — `getNodeManifest` calls
  `getFrameworkClientInfoWithRuntime` from `server/frameworks.js`, walks the
  configured framework set, and emits an `agents` capability map keyed by
  framework id. Core manifest knows about Claude/Codex/OpenCode/Hermes by
  inheritance from the framework registry.

Remediation: core manifest probes tool availability only (tmux, git, ssh,
clipboard, browser-automation). Framework-specific probes (`claude --help`,
`codex --version`, etc.) move to a framework feature module that
decorates the manifest after core builds it. **Filed as #425.5.**

### Group F — test fixtures hardcode framework names (4 findings)

Existing tests pin the agent set:

- `test/node-manifest.test.ts:45` — `expect.arrayContaining(['claude',
'codex', 'opencode', 'hermes'])`.
- `test/hub-node-registry.test.ts:64-75,~264` — manifest fixtures populate
  `agents: { claude, codex, opencode, hermes }` and assert on those exact
  IDs.
- `test/multi-node-smoke.test.ts:79-92` — fixture populates `claude, codex`.

Remediation: parameterize agent IDs in fixtures (helper that builds a
manifest from a list of agent IDs). Drop assertions that the manifest
contains specific framework IDs from core tests; move those assertions to
the framework feature test suite. **Filed as #425.6.**

## Out of scope for this audit

- Frontend (`frontend/`). React + Zustand state assumes repos. ADR-015
  scopes the invariant to the server core; frontend remains a known
  IDE-flavored consumer and is not part of this audit.
- `bin/relay-ide.ts` CLI surface. Existing `worktree` subcommand is a
  feature-layer caller and stays; the future agent-facing CLI gateway is
  #429.
- ADR-009..014 documents that already live inline in
  `docs/federated-relay.md`. Backfilling them into `docs/adrs/` is a
  separate housekeeping task.

## Compliance gate

After the six sub-issues land, `/adr:review` should reject any PR that
re-introduces:

1. A repo-inventory type import in the core modules listed above.
2. A repo/worktree/branch field marked required on a core protocol type.
3. A framework-specific identifier reference in `server/node-manifest.ts`
   or `shared/node-manifest.ts`.
4. A new `/hub/...` route mounted by the core router that operates on
   repo data.

## Sub-issue map

| Sub-issue | Group | Title                                                                          |
| --------- | ----- | ------------------------------------------------------------------------------ |
| #432      | A     | Remove repo-inventory type imports from core link/client/registry              |
| #433      | B     | Extract repo HTTP endpoints out of `hub-node-router.ts` into a feature router  |
| #434      | C     | Make `repoPath`/`worktreePath`/`branchName` optional on `SessionSummary`       |
| #435      | D     | Move `worktreeCapabilityStatus` out of core registry summary                   |
| #436      | E     | Move framework probing from `node-manifest.ts` into a framework feature module |
| #437      | F     | Parameterize agent IDs in test fixtures; drop hardcoded framework assertions   |

All six are filed as GitHub sub-issues of #425. Intra-group blockers:

- #433 is blocked by #432 (remove imports before moving the routes).
- #437 is blocked by #436 (framework feature module is the right home for the
  framework-specific assertions).

Recommended landing order: #432 → #433 (group A then B), then #434 and #435
in parallel (groups C and D), then #436 → #437 (group E then F).
