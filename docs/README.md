# Relay IDE documentation

This index separates current source-of-truth docs from historical plans and spikes. Treat files in `docs/plans/`, `docs/spikes/`, and `docs/superpowers/plans/` as time-stamped design/implementation records unless another current doc explicitly promotes their behavior as shipped.

## Current source of truth

| Area                  | File                              | Use it for                                                                                   |
| --------------------- | --------------------------------- | -------------------------------------------------------------------------------------------- |
| Top-level agent map   | `../AGENTS.md`                    | Repo conventions, command quick reference, compact docs map                                  |
| User onboarding       | `../README.md`                    | Install, run, CLI, config, hub/node overview                                                 |
| Product/design system | `../DESIGN.md`                    | Product positioning, visual language, spacing/color/button rules                             |
| Architecture          | `ARCHITECTURE.md`                 | Module boundaries, API routes, data flow, ADR index                                          |
| Workbench boundary    | `WORKBENCH_BOUNDARY.md`           | Relay-as-control-plane scope, canonical nouns, mobile/dogfood journeys                       |
| Backend design notes  | `DESIGN.md`                       | Backend patterns, auth/session/PTY behavior                                                  |
| Frontend              | `FRONTEND.md`                     | React components, frontend state, UI entrypoints                                             |
| Quality               | `QUALITY.md`                      | Test strategy, isolation rules, known gate behavior                                          |
| Terminal backends     | `TERMINAL_BACKENDS.md`            | `relay-pty` rollout, `tmux-compat` fallback, migration/import behavior                       |
| Review                | `REVIEW_GUIDANCE.md`              | Reviewer prompts, risk areas, escape log                                                     |
| Deployment            | `references/deployment.md`        | Branching, npm channels, publishing flow                                                     |
| Devbox deploy         | `references/devbox-hub-deploy.md` | Shared devbox hub deploy, Mac node-link restart, verification evidence, process hygiene      |
| Dogfood recovery      | `references/dogfood-recovery.md`  | Relay-develops-Relay proof loop, recovery matrix, diagnostics, no-force-merge gate           |
| Self-hosting          | `SELF_HOSTING.md`                 | Running Relay from inside Relay with isolated config/ports                                   |
| Security policy       | `SECURITY_POLICY.md`              | Trust tiers, capability bits, hub ACL defaults, exact-operation approvals, handshake grants  |
| Handshake grants      | `OPERATOR_HANDSHAKE_GRANTS.md`    | One-time operator grant ceremony copy, lane separation, validation, audit/redaction contract |
| rmux helper protocol  | `RMUX_HELPER_PROTOCOL.md`         | Experimental #707 helper JSON/stdin-stdout boundary and prototype gates                      |
| Hub/node packaging    | `RELAY_HUB_NODE_PACKAGING.md`     | Hub/node command shape and npm packaging decisions                                           |
| Node bootstrap        | `RELAY_NODE_BOOTSTRAP.md`         | Pair/install/update/unpair flows and diagnostics                                             |
| Federated dev         | `FEDERATED_DEV.md`                | Multi-machine dev workflow and version-skew handling                                         |
| Federated Relay       | `federated-relay.md`              | Hub/node architecture, pairing, routing, ADR history                                         |
| Learnings             | `LEARNINGS.md`                    | Durable repo learnings gathered across sessions                                              |

## Vocabulary baseline

`WORKBENCH_BOUNDARY.md` is the canonical source for Relay's workbench/control-plane boundary, #552 nouns, and mobile/pair/dogfood journey acceptance criteria. Use the six-layer IA vocabulary consistently in current docs:

1. View — UI mode or surface.
2. Workspace — grouping/config/pins layer; not a synonym for repo.
3. Project — work/product scope.
4. Instance — concrete node/repo/worktree occurrence.
5. Bench — arrangement of working surfaces.
6. Tab — leaf surface carrying active context such as node id, cwd, kind, and optional repo/worktree binding.

Current implementation is incremental. Do not claim the full six-layer persistence/UI migration is complete unless the implementing PR and tests have landed.

## Historical, proposed, and audit material

These directories are useful evidence, but they are not current product docs by default:

| Directory            | Status                                                                                                                           |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `plans/`             | Historical implementation plans and design proposals. Check code/current docs before treating as shipped.                        |
| `spikes/`            | Research spikes and proposed protocols. Some findings may be implemented elsewhere; the spike itself is not a current guarantee. |
| `superpowers/plans/` | Historical plan records for earlier agent/chat protocol work.                                                                    |
| `superpowers/specs/` | Specs/design records; verify against `shared/`, `server/`, `frontend/`, and tests.                                               |
| `bug-analyses/`      | Debugging writeups and postmortems. Use as history, not current behavior.                                                        |
| `refactor/`          | Audit/refactor notes. Use as evidence for cleanup decisions.                                                                     |
| `adrs/`              | Accepted/current ADR files where present. Older ADR summaries may still live in `federated-relay.md` or `ARCHITECTURE.md`.       |

## Guardrails for future doc edits

- Evidence first: source files, tests, package scripts, and CLI help beat old plans.
- Do not overclaim planned work as shipped: especially File RPC beyond the listed v1 commands, `logs.tail`/node-log proxying, high-risk approval UX/auth strength beyond the exact-operation #807 contract, and the complete six-layer UI/data migration.
- Keep `AGENTS.md` compact; add details here or in focused docs instead.
- When a historical plan is still linked from a current doc, label it as historical/proposed unless implementation has been verified.
