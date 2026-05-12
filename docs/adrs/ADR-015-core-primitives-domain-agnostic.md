# ADR-015: Core relay primitives are domain-agnostic; repo/git is a feature layer

- **Status:** Accepted
- **Date:** 2026-05-12
- **Refs:** #420, #103, #317
- **Supersedes:** none

## Context

Relay started as a remote IDE for Claude Code sessions. The platform has since
grown a federated hub/node substrate (#317, #371, #385, #416, #418) whose
primitives — paired nodes, persistent `/hub/node-link`, routed PTY, RPC
channel, capability manifest, file ops (forthcoming) — are general-purpose
remote-fleet primitives that do not require a git repo or an IDE frontend.

Future work depends on this generality:

- A CLI gateway exposing primitives to arbitrary agents (Claude tool-use,
  Codex function-calls, Hermes, scripts).
- File RPC for fleet-wide remote file inspection.
- Workspaces / multi-repo groupings (#103) as a feature-layer concept rather
  than a core requirement.
- Hosts that participate in the fleet without serving a programming use case
  at all (build farms, content boxes, home automation, future).

Today the core makes implicit assumptions that block that future:

- Heartbeat and manifest carry repo inventory as a first-class field.
- Session creation pulls in framework registry, agent commands, and tmux
  defaults.
- Worktree scanning, divergence summaries, and git status are wired into
  manifest probes.
- "Workspace" is used to mean both "a paired node's set of repos" and "a
  grouping of repos for the IDE UI."

Each assumption is fine for the IDE use case but constrains the broader
platform story and bleeds repo/IDE semantics into modules that should be
generic.

## Decision

The relay core is domain-agnostic. Repo, git, worktree, framework, and
workspace logic live in a clearly named **feature layer** that consumes the
core; the core does not depend on them.

### Core (must remain domain-agnostic)

- `server/hub-node-link.ts`, `server/node-link-client.ts`,
  `server/node-link-pty-host.ts`
- `server/hub-node-registry.ts`, `server/hub-node-router.ts` (routing only;
  no repo semantics)
- `server/node-manifest.ts` (capability probes for tmux, git binary
  availability, agent CLIs — *availability*, not repo state)
- `shared/relay-node-protocol.ts`
- `shared/node-manifest.ts`
- Session, node, and stream identifiers are opaque strings as far as the core
  is concerned.

### Feature layer (consumes core, does not bleed into it)

- Repo inventory + aggregation: `server/repo-inventory.ts`,
  `server/hub-node-router.ts` repo endpoints, divergence summaries.
- Worktree management: `server/watcher.ts`, `bin/relay-ide.ts` worktree
  subcommand.
- Agent framework registry, framework-specific spawn defaults.
- Workspace groupings (#103) when shipped.
- IDE-specific UI state under `frontend/`.

### Rules new code must follow

1. Core APIs accept opaque identifiers (`sessionId`, `nodeId`, `path`).
   They must not encode "this path is a repo root" or "this session belongs
   to a git worktree" in their contracts.
2. Heartbeat and manifest envelopes may carry feature-layer payloads (repo
   inventory, framework probes), but the core registry must not require them
   to be present. A node with zero repos and no framework CLI must be a
   valid first-class participant.
3. New `/hub/...` REST routes that operate on repo data live in the repo
   feature module and are mounted by the hub composition root, not embedded
   in the core registry/router modules.
4. New protocol channels (PTY, RPC, files) are core. Verbs that carry
   repo/git semantics on top of those channels are feature-layer.
5. PRs that touch the listed core modules and add repo/git/IDE semantics
   must be redirected to a feature-layer module or rejected.

## Consequences

- **Positive.** Generic hosts (no repos, no IDE use case) can join the fleet
  with no special handling. CLI gateway, file RPC, and future agent
  adapters compose over a stable, narrow core. Plugin model for agents is
  cleaner because the integration contract does not assume repos.
- **Positive.** Repo/git/workspace features evolve independently of the
  routing/PTY/RPC plumbing.
- **Negative.** Existing modules need an audit and partial refactor (tracked
  in #425). Several manifest fields move from "required" to "optional
  feature payload."
- **Negative.** Some routes that look natural to put in the core registry
  (e.g., a `/nodes/:id/repos` endpoint) now require explicit mounting from
  the feature layer. Slightly more wiring up front.

## Compliance and review

- `/adr:review` should fail PRs that introduce repo/git/worktree/framework
  imports into the core modules listed above.
- New `epic`-labeled work that touches these modules must reference this ADR
  in its PR description.
- Re-evaluate this ADR if the platform commits to a single use case (very
  unlikely) or if a downstream constraint forces tight coupling (e.g., a
  routing optimization that genuinely requires repo identity).
