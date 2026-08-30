# Interactive endpoint performance baseline — 2026-08-29

Snapshot of HTTP latency for every endpoint on a real-time interactive path,
measured against the live prod hub. Dated material: re-measure before citing.
Tracked by epic [#1446](https://github.com/donovan-yohan/relay-ide/issues/1446).

## Method

- Target: `relay-stable-hub` at `http://127.0.0.1:3456`, the live prod instance.
- Auth: PIN cookie (`POST /auth`), plus `x-relay-capabilities: context:read` on
  channel and context routes (403 without it).
- Read-only traffic, concurrency 1, 3 runs per endpoint, `curl -w "%{time_total}"`.
- "Warm" is the steady-state run with OS page cache and any in-process cache
  populated. "Cold" is the first observed run against an empty cache; the hub was
  never restarted, so cold numbers only exist where a request-level cache was
  observed to start empty.
- Host at measurement time: 24 GB RAM, ~18 GB available. Provider stores on disk:
  `~/.claude/projects` 1.2 GB / 1,704 `.jsonl`; `~/.codex/sessions` 7.5 GB /
  1,883 `.jsonl`. 33 repos configured.

Real IDs used: channel `topic:01kzcckfc2ctary2ksdmhxfqa0` (936 messages),
workspaces `ws:local`, `ws:project%3A3f5ff012d9530235`.

## Trigger legend

| Code   | Meaning                                            |
| ------ | -------------------------------------------------- |
| MOUNT  | fires on app mount / initial load                  |
| NAV    | fires on navigation (channel/DM/dialog/panel open) |
| POLL   | `setInterval` / `refetchInterval`                  |
| ACTION | user-initiated click, submit, or typing            |
| WS     | refetched on a websocket event invalidation        |
| CLI    | CLI-gateway verb only; not called by the browser   |

## Over budget (> 200 ms)

| Endpoint                                   | Trigger                                             | Bytes     | Warm       | Cold        | Root cause                                                                                                                                                                                                                                                                                                                                                                           | Proposed fix                                                                                                                                                                 | Ticket                                                          |
| ------------------------------------------ | --------------------------------------------------- | --------- | ---------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `POST /gh/enrich-branches`                 | MOUNT, once **per repo** (33) + NAV re-arm          | 422 B ea. | 10 ms      | **6.90 s**  | Client-side N+1 — `frontend/src/lib/stores/sessions.ts:423-428` maps `ensureFresh` over repo paths, each issuing its own POST via `frontend/src/lib/api.ts:2922`; fired at `frontend/src/App.tsx:1224` and re-armed at `:1288-1291`. The server is already batched (`server/gh-routes.ts:53-70`) and the client discards that.                                                       | Send one request with all `{repoPath, branchName}` pairs; demux the already-keyed response. Client-only change.                                                              | [#1447](https://github.com/donovan-yohan/relay-ide/issues/1447) |
| `GET /sessions/native`                     | CLI (agent interactive)                             | 1.09 MB   | **4.43 s** | ~15 s       | Serial provider loop `server/provider-state/registry.ts:78`; every file fully streamed, sha256'd and `JSON.parse`d per request (`server/provider-state/claude-jsonl-state-adapter.ts:140-152`, `:343-390`; same shape in `codex-jsonl-state-adapter.ts:134,311`); scope filters applied **after** the parse (`claude-jsonl-state-adapter.ts:144-146`); serial dir walk (`:312-340`). | Prune by path before reading (cwd is the project dir name); `Promise.all` the provider loop; summary cache keyed on `(path, mtimeMs, size)`; drop sha256 from the list path. | [#1449](https://github.com/donovan-yohan/relay-ide/issues/1449) |
| `GET /sessions/native/:provider/:nativeId` | CLI                                                 | 1.27 KB   | **1.79 s** | —           | `readRef` calls the full `listNativeSessions` walk then `.find()` on `nativeId` — `server/provider-state/claude-jsonl-state-adapter.ts:269-276`.                                                                                                                                                                                                                                     | Resolve `nativeId` → path directly (it is the filename stem), keeping the `resolveSafeSourcePath` guard at `:279`.                                                           | [#1449](https://github.com/donovan-yohan/relay-ide/issues/1449) |
| `GET /hub/repo-inventory`                  | NAV (session-create dialog, node dashboard)         | 374 KB    | **660 ms** | —           | Uncached call to `collectLocalRepoInventory` per request (`server/features/repo-router.ts:355-369`); collector is a serial `for` over every repo (`server/repo-inventory.ts:210`) doing ~7+ `git` forks each (`:212,214,219-241,245-247`).                                                                                                                                           | Short-TTL memo + in-flight coalescing shared by all three routes; bounded-concurrency outer loop.                                                                            | [#1448](https://github.com/donovan-yohan/relay-ide/issues/1448) |
| `GET /hub/repo-groups`                     | NAV (env picker)                                    | 5.7 KB    | **657 ms** | —           | Same collector (`server/features/repo-router.ts:377-387`). Computes dirty/divergence/worktrees then drops them from the response — 657 ms to return 5.7 KB.                                                                                                                                                                                                                          | Above, plus an identity-only projection so it never computes what it discards.                                                                                               | [#1448](https://github.com/donovan-yohan/relay-ide/issues/1448) |
| `GET /hub/ia/tree`                         | CLI / derived read model (no frontend caller found) | 153 KB    | **656 ms** | —           | Same collector (`server/features/repo-router.ts:395-402`).                                                                                                                                                                                                                                                                                                                           | Same memo.                                                                                                                                                                   | [#1448](https://github.com/donovan-yohan/relay-ide/issues/1448) |
| `GET /org-dashboard/prs`                   | NAV (org dashboard) + WS invalidation               | 2.5 KB    | 0.5 ms     | **11.74 s** | Network fan-out to GitHub with no coalescing and no persisted warm cache — `server/org-dashboard.ts:248`. In-process cache starts empty each hub restart.                                                                                                                                                                                                                            | Coalesce in-flight requests; serve stale-while-revalidate; prime in background at hub start.                                                                                 | [#1450](https://github.com/donovan-yohan/relay-ide/issues/1450) |

## Under budget but on the mount path

Same root-cause family (serial `git` subprocess fan-out, synchronous `fs` on the
request path). Watch these — they degrade with repo count.

| Endpoint                    | Trigger              | Bytes   | Warm                    | Note                                                                                                                                                            |
| --------------------------- | -------------------- | ------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /git/worktrees`        | MOUNT (`refreshAll`) | 11.4 KB | 171 ms                  | git subprocess per repo                                                                                                                                         |
| `GET /workspaces`           | MOUNT (`refreshAll`) | 7.0 KB  | 151 ms                  | —                                                                                                                                                               |
| `GET /repos`                | MOUNT-adjacent       | 6.4 KB  | 146 ms                  | `readdirSync` + `statSync` per entry blocks the event loop (`server/index.ts:554-575`), then one `git symbolic-ref` fork per repo (`server/index.ts:5346-5352`) |
| `GET /work-contexts/active` | POLL 15 s + WS       | 28.0 KB | 137 ms cold / 3 ms warm | poll interval is fine at 3 ms warm                                                                                                                              |
| `GET /api/node/manifest`    | ACTION               | 3.9 KB  | 65 ms                   | —                                                                                                                                                               |
| `GET /workspace-surfaces`   | NAV                  | 7.5 KB  | 34 ms                   | —                                                                                                                                                               |

## Within budget

Measured, 3 runs each, all warm. No action needed.

| Endpoint                                                               | Trigger                          | Bytes             | Warm   |
| ---------------------------------------------------------------------- | -------------------------------- | ----------------- | ------ |
| `GET /channels`                                                        | MOUNT (sidebar, staleTime 5 min) | 7.2 KB            | 8 ms   |
| `GET /channels/:id/messages`                                           | NAV (channel open)               | 419 KB @ limit 50 | 5 ms   |
| `GET /channels/:id`                                                    | NAV + POLL 30 s liveness probe   | 904 B             | 1 ms   |
| `GET /channels/:id/roster`                                             | NAV + POLL 30 s (conditional)    | 3.7 KB            | 1 ms   |
| `GET /channels/search?q=`                                              | ACTION (palette/sidebar typing)  | 24.4 KB           | 2 ms   |
| `GET /channels/read-state`                                             | MOUNT (sidebar)                  | 356 B             | 0.5 ms |
| `GET /workspace-topics`                                                | MOUNT (sidebar) + NAV (palette)  | 6.1 KB            | 1 ms   |
| `GET /nodes`                                                           | MOUNT (sidebar) + WS             | 6.0 KB            | 0.4 ms |
| `GET /work-contexts`                                                   | NAV                              | 22.2 KB           | 1 ms   |
| `GET /sessions`                                                        | MOUNT                            | 2 B               | 2 ms   |
| `GET /api/frameworks`                                                  | MOUNT                            | 2.1 KB            | 3 ms   |
| `GET /telemetry/{sessions,account,setup-status}`                       | MOUNT (3 calls)                  | ≤18 B             | < 1 ms |
| `GET /config/{defaultAgent,terminalBackend}`                           | MOUNT                            | ≤55 B             | < 1 ms |
| `GET /agent-profiles`                                                  | NAV (settings)                   | 768 B             | 0.7 ms |
| `GET /auth/status`                                                     | MOUNT                            | 15 B              | 0.5 ms |
| `GET /push/vapid-key`                                                  | MOUNT                            | 108 B             | 0.5 ms |
| `GET /version`                                                         | ACTION                           | 121 B             | 0.5 ms |
| `GET /branch-linker/links`                                             | NAV                              | 6.9 KB            | 0.5 ms |
| `GET /presets`                                                         | NAV                              | 189 B             | 0.4 ms |
| `GET /hub/{ia/benches,ia/workspaces,pairing/requests,scoped-sessions}` | NAV                              | ≤1.1 KB           | < 1 ms |
| `GET /workspace-groups`                                                | MOUNT                            | 2 B               | 0.4 ms |
| `GET /context`                                                         | NAV                              | 935 B             | 0.5 ms |

## Client polling intervals

| Interval | Endpoint                                                        | Source                                                                                                         |
| -------- | --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| 2 s      | `GET /auth/github/status` (only mid-OAuth device flow)          | `frontend/src/components/dialogs/integrations/GitHubIntegration.tsx:168-198`                                   |
| 3 s      | confirmation-challenge tick                                     | `frontend/src/components/ConfirmationPrompt.tsx:22,122`                                                        |
| 10 s     | session mailbox                                                 | `frontend/src/hooks/useSessionMailbox.ts:15,57`                                                                |
| 15 s     | `GET /work-contexts/active`                                     | `frontend/src/components/ActiveWorkSurface.tsx:35,600`                                                         |
| 15 s     | workspace evidence artifacts/sessions                           | `frontend/src/components/WorkspaceEvidenceArtifactsSection.tsx:200`, `WorkspaceEvidenceSessionsSection.tsx:33` |
| 30 s     | `GET /channels/:id/roster` (conditional, stale socket)          | `frontend/src/components/chat/ChannelView.tsx:333,1145`                                                        |
| 30 s     | `GET /channels/:id` liveness probe (only while WS idle > 120 s) | `frontend/src/hooks/useChannelChatSocket.ts:38-39,331-334`                                                     |

No poller is over budget; every polled endpoint measures < 5 ms warm.

## Notes and corrections

- **`GET /harnesses` does not exist.** No route matching `/harness` is registered
  anywhere under `server/**`, and no such CLI-gateway verb exists in
  `shared/relay-command-manifest.ts`. Requesting it returns the SPA
  `index.html` fallback (1,166 B) in 0.6 ms. An earlier baseline attributing
  ~4.6 s to it most likely measured the provider install-detection fan-out
  inside `GET /sessions/native`.
- **`GET /sessions/native` is not on the browser mount path.** It has no frontend
  caller; it is reached only through `bin/relay-ide.ts` (`sessions.native.*`).
  It still counts as interactive because agents block on it.
- **`GET /channels/:id/messages` does honour `limit`** (default 50, `before`
  cursor works). The 419 KB payload is 50 messages at ~8.4 KB each — a payload
  size question, not a pagination bug, and the endpoint serves it in 5 ms.
- Several SPA-fallback 200s look like healthy endpoints at 1,166 B / 0.6 ms.
  Check the body, not the status, when probing: `/harnesses`, `/profiles`,
  `/config/agent-profiles`, `/channels/:id/history`, `/channels/:id/receipts`
  all fell back during this pass.
