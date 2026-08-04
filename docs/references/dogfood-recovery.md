# Dogfood and recovery runbook

Use this when Relay is used to develop Relay through the shared dogfood topology: devbox hub on `dev` / `100.77.36.51:3456`, a paired Mac node such as `macbook-relay-node`, and browser/mobile Active Work proof.

This runbook is deliberately narrow. Relay is the federated workbench and control plane: identity, routing, `WorkContext` handoff, bounded inspection/control, and audit/evidence. It is not a replacement for Hermes Agent, Hermes dashboard, hermes-workspace, GitHub, Kanban, terminal/process supervisors, or native Claude/Codex/OpenCode/Hermes CLIs.

Do not paste pair tokens, bearer tokens, cookies, node credentials, private auth URLs, raw env, or unbounded terminal/transcript output into issues, PRs, logs, or screenshots.

## What counts as dogfood proof

A Relay-developing-Relay closeout needs current evidence for all of these, not just a local self-host run:

1. Package/deploy state: the hub package/source SHA, service status, `/health`, and served frontend version match the build under test.
2. Node state: the target node is online/current in the hub registry, protocol-compatible, and running the matching package/source SHA when node-side behavior changed.
3. Work context: the routed session is created with a `workContextId`, and the session plus `/work-contexts/active` preserve task/repo/node/cwd/session metadata without raw secrets.
4. Browser/mobile Active Work: desktop and mobile show the fresh routed session as live/fresh, attach opens the session surface, and small scoped input reaches the routed PTY.
5. Offline/stale behavior: an offline node returns a typed failure such as `NODE_OFFLINE`; stale/last-known sessions stay visible but live controls are disabled.
6. Privacy/audit: captured evidence uses ids, statuses, summaries, screenshots, and artifact paths; it does not include auth material or raw transcript dumps.
7. Release gate: no force/admin merge of unknown checks. A release gate must use current green checks plus latest-head QA/review/bot evidence, and only one release gate should own the final merge/deploy step at a time.

For #562, the passing deployed proof was against `relay-ide@0.1.0-nightly.20260518.457`: devbox hub healthy/current, `macbook-relay-node` online/current, mobile Active Work attach opened the routed session surface, and small-input `pwd` send succeeded. Keep future claims tied to the then-current version/SHA instead of reusing that proof for new code.

## First response checklist

Before fixing anything, preserve enough state to avoid guessing:

```bash
relay-ide --version
relay-ide hub status
relay-ide hub logs --lines 80
relay-ide hub doctor
relay-ide hub nodes --json
relay-ide node status
relay-ide node logs
relay-ide node doctor --hub <devbox-hub-url>
relay-ide diag bundle --lines 120 --json
```

Run hub commands on the hub host and node commands on the node host unless the command explicitly supports a remote hub URL. If authenticated CLI/browser context is required, use scoped local files or environment supplied by the operator, but never print the credential.

Also capture the UI/API state that proves the symptom:

- global session id: `<nodeId>:<sessionId>`;
- `workContextId` and task refs;
- node id, node label, cwd, repo/worktree if any;
- `/sessions/:globalSessionId` summary when available;
- `/work-contexts/active` summary when available;
- desktop/mobile screenshots for Active Work and the attached session surface;
- console/network summary: warning/error count, failed request count, and any typed error code.

## Recovery matrix

| Symptom                        | Diagnose                                                                                                                                                                                                                                                                        | Recover                                                                                                                                                                                                                  | Do not                                                                                                                                                       |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Stuck routed session           | Confirm `globalSessionId`, `nodeId`, cwd, `status`, `controlMode`, `controlFreshness`, and whether the node is online. Try a harmless attach/send only if the card is live/fresh and policy allows input.                                                                       | If live and controllable, use the UI or scoped API to send a minimal command such as `pwd` or to stop the exact session. If only local cleanup is needed, inspect the exact PID first.                                   | Do not use `killall node`, broad `pkill -f relay-ide`, or kill a session whose node/cwd/task identity you have not verified.                                 |
| Node offline/stale             | Check hub registry, node logs, `node status`, `node doctor`, package versions, and protocol compatibility. The expected routed-create failure for an offline node is typed, retryable `NODE_OFFLINE`.                                                                           | Restart the exact node-link supervisor only after confirming the label/service. On macOS, inspect the actual launchd label first; the #562 dogfood node used `com.relay-ide-node-link`. Then recheck registry freshness. | Do not treat a successful local `relay-ide node status` as proof that the hub has a live reverse link. Do not route work to a different local node silently. |
| Bad `WorkContext` metadata     | Compare the create payload, session descriptor, `/sessions/:globalSessionId`, and `/work-contexts/active`. Look for null/absent `workContextId`, wrong task refs, stale `nodeId`, wrong cwd, or stale-read-model downgrades.                                                    | File a focused blocker with the create payload shape, sanitized API summaries, screenshots, and exact version/SHA. Re-run QA only after the fix is merged, published/deployed, and the hub/node versions are refreshed.  | Do not call the dogfood loop live on API-only control if browser/mobile Active Work cannot attach/send. Do not patch evidence by hand in comments.           |
| Plugin/event ingestion failure | First confirm the integration is actually in scope for the build under test. Relay should ingest bounded metadata events, not scrape Hermes profile DBs or raw transcripts. Capture event schema version, source, task/session refs, validator error code, and redaction class. | Retry only with a bounded sanitized payload. If the plugin or ingestion endpoint is not shipped in the target build, mark the plugin proof as not applicable or blocked rather than inventing behavior.                  | Do not sync raw Hermes SQLite DBs, provider auth, env, or full transcript/log payloads into Relay to make a test pass.                                       |
| Diagnostics capture needed     | Use hub/node status, logs, doctor output, sanitized API summaries, screenshots, and artifact paths. Keep raw logs local when they may contain secrets; quote only the typed error and last relevant non-secret lines.                                                           | Attach artifact paths or issue/PR links, plus version/SHA and timestamps. Prefer summaries with ids and hashes over payload dumps.                                                                                       | Do not paste tokens, cookies, private auth URLs, raw env, or full PTY transcripts.                                                                           |
| Release gate uncertainty       | Check PR base/head, issue linkage, current checks, latest-head QA/review/bot triage, and whether the dogfood environment was actually updated after publish.                                                                                                                    | Block the gate with the exact missing proof or rerun the relevant gate on the latest head/deployed version.                                                                                                              | Do not force/admin merge failed, pending, skipped, or unknown checks. Do not reuse stale QA/review after the head SHA or deployed version changed.           |

## Safe process cleanup

Process cleanup is part of recovery, but only after identity is clear. Distinguish these before stopping anything:

- production/global hub: `relay-ide hub` or compiled server on the configured production port, production config;
- ordinary source dev: `npm run dev`, local dev config;
- self-host source dev: allocator ports, self-host config;
- node link: `relay-ide node link --hub ...`, usually supervised by launchd/systemd/manual shell;
- test/fixture server: Playwright/Vitest-owned temporary process.

Prefer exact inspection and exact termination:

```bash
lsof -nP -iTCP:<port> -sTCP:LISTEN
ps -p <pid> -o pid,ppid,lstart,command
lsof -p <pid> | grep cwd
```

Then kill only the intended PID. Escalate from `kill` to `kill -KILL` only after rechecking the PID was not reused.

## Evidence comment template

```markdown
Dogfood/recovery evidence for <issue/PR>:

- Scope: <source/nightly package; hub-only/node-only/protocol; local/self-host/devbox>
- Hub: <host/url>, version/SHA <...>, service <active/restarted>, `/health` <result>
- Frontend: served assets/version <...>
- Node: <node label/id>, version/SHA <...>, registry state <online/stale/offline>, protocol <...>
- WorkContext: <id>, task refs <...>, cwd <...>, global session <nodeId:sessionId>
- Active Work desktop/mobile: <live/fresh attach/send result OR typed stale/offline disabled state>
- Routed proof: <harmless command/result marker, no secrets>
- Offline/stale proof: <typed error or disabled-control state>
- Diagnostics/artifacts: <paths or URLs to sanitized summaries/screenshots/log excerpts>
- Redaction: no pair tokens, bearer tokens, cookies, auth URLs, raw env, or unbounded transcripts included
- Gate policy: latest-head/deployed evidence used; no force/admin merge of unknown checks
```

## Sources

- Issue #562 dogfood lane and passing QA evidence after PR #585 / `0.1.0-nightly.20260518.457`.
- Issue #552 product boundary and dogfood acceptance criteria.
- `docs/WORKBENCH_BOUNDARY.md` for Relay's control-plane boundary and canonical nouns.
- `docs/references/devbox-hub-deploy.md` for shared devbox hub deploy and process hygiene.
- `docs/SELF_HOSTING.md` for isolated local self-host mode.
- `docs/FEDERATED_DEV.md` and `docs/RELAY_NODE_BOOTSTRAP.md` for hub/node version skew, node status, logs, and doctor flows.
