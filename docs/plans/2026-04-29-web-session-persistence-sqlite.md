# Web Session Persistence — SQLite Store

Branch: TBD (suggest `feat/web-session-sqlite`)

Base branch: `nightly`

## Plan Summary

Replace the one-shot JSON snapshot in `pending-sessions.json` with a SQLite-backed store for web (V2) sessions. Relay owns the canonical transcript (`agent_session_v2_json`); vendor session id is stored alongside as an opaque resume pointer. On reconnect, relay renders the blob immediately and calls `adapter.resume(vendor_session_id)` in the background. If resume fails (expired thread, rotated id, vendor rejection), relay surfaces a single `errorMessage` (source `client`) into the timeline and leaves the session disconnected — the user must start a fresh session. A future enhancement may add a "Continue here" path that opens a new vendor session and merges turns under the same relay session id; out of scope for this slice.

PTY sessions stay on the JSON path for now. The sqlite store is web-only.

## Premises

| Premise                                                  | Assessment                                                                                                                                                                               |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Relay should own the full transcript, not vendor history | Valid. Vendor `resume` continues model context but does not replay items; relay-injected items (errors, slash echoes, approval transcript) only exist on the relay side.                 |
| Vendor session id is enough to resume model context      | Valid for Claude SDK (`resume: claudeSessionId`) and Codex app-server (`thread/start` with `threadId`). OpenCode and Hermes already expose vendor session ids through `providerSession`. |
| SQLite is the right substrate                            | Valid. `better-sqlite3` is already a dependency for `analytics.db`. Same WAL pattern, schema_version table, prepared statements.                                                         |
| One DB file or two                                       | Two: `analytics.db` is metrics, `relay-state.db` is canonical state. Different lifecycle, different backup posture, different access patterns. Avoid coupling.                           |
| Per-patch row vs single blob                             | Single blob. `agent_session_v2_json` is the reduced-state canonical form; `applyAgentPatchV2` already produces it. Patches are wire-format, not storage-format.                          |
| Resume failure UX                                        | Show a `errorMessage` source=`client` in the timeline and leave session disconnected. No silent drop. No automatic new-session creation in this slice.                                   |

## What Already Exists

| Sub-problem                 | Current code                                                                                                                                                                                                                                                                                                             |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Web session in-memory state | `server/sessions.ts` — `WebSession.agentSessionV2`, `agentPatchesV2` populated via `applyWebSessionPatchV2` (`server/web-session-v2-state.ts`).                                                                                                                                                                          |
| Persistence write path      | `server/sessions.ts:638 serializeWebSession`, `:670 serializeAll` writes to `pending-sessions.json`. Only fires on `SIGTERM` / `SIGINT` / update-restart.                                                                                                                                                                |
| Persistence read path       | `server/sessions.ts:970 restoreFromDisk` → `:916 restoreWebSession`. Stale-file wipe at 5min (`STALE_THRESHOLD_MS`). File unlinked after restore.                                                                                                                                                                        |
| SQLite infra                | `server/analytics.ts` — `Database` open with `journal_mode=WAL`, `MIGRATIONS` array keyed by `schema_version` table, prepared statements module-scoped.                                                                                                                                                                  |
| Vendor resume capability    | `AgentSessionV2.providerSession: Record<string, string>` carries vendor ids. `AgentCapabilitySetV2.resume?: boolean`. `useAgentChatSocket.resume()` and `agent-resume-v2` command already wire end-to-end. Claude adapter implements `connect({ resume })`. Codex native adapter handles `thread/start` with `threadId`. |
| Resume UI                   | `frontend/src/components/chat/ChatView.tsx:81` `canResume` flag and `tl-resume-banner`.                                                                                                                                                                                                                                  |
| Error timeline              | `errorMessage` item type with `source: 'agent' \| 'client'`, rendered in `frontend/src/components/chat/Turn.tsx:112`.                                                                                                                                                                                                    |

## What Will Change

### Schema

```sql
CREATE TABLE web_sessions (
  id TEXT PRIMARY KEY,
  vendor TEXT NOT NULL,
  vendor_session_id TEXT,
  cwd TEXT NOT NULL,
  repo_path TEXT,
  worktree_path TEXT,
  branch_name TEXT,
  display_name TEXT,
  workspace_id TEXT,
  agent_session_v2_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_activity INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'disconnected', 'archived'))
);
CREATE INDEX idx_web_sessions_vendor_session ON web_sessions(vendor, vendor_session_id);
CREATE INDEX idx_web_sessions_status_activity ON web_sessions(status, last_activity);
```

`agent_session_v2_json` holds the full `AgentSessionV2` shape — turns, items, capabilities, config, providerSession. Single source of truth for the web UI.

`vendor_session_id` is a denormalized cache of the resume pointer; `agent_session_v2_json.providerSession` carries the same value. Index lets us find sessions by vendor id (debugging, multi-window dedup).

### New module: `server/relay-state-db.ts`

Mirrors `server/analytics.ts` shape:

- `initRelayStateDb(configDir: string): void` — opens `<configDir>/relay-state.db`, runs migrations.
- `closeRelayStateDb(): void`
- `upsertWebSession(session: WebSession): void` — single prepared statement, writes everything from the in-memory session.
- `loadAllWebSessions(): SerializedWebSession[]` — for restore.
- `deleteWebSession(id: string): void` — for archived/closed.
- `markStatus(id: string, status: 'active' | 'disconnected' | 'archived'): void`

### Write path

Replace one-shot `serializeAll` for web sessions with two triggers:

1. **Debounced on patch.** In `applyWebSessionPatchV2` (`server/web-session-v2-state.ts`), after applying the patch, schedule `upsertWebSession(session)` via a 1s debounce keyed by session id. High-frequency streams (token-by-token deltas) collapse to one write per second per session.
2. **On structural events.** Immediate `upsertWebSession` on session create, vendor session id assignment, status change, shutdown.

`serializeAll` keeps writing PTY sessions to `pending-sessions.json`. Web sessions get removed from that file in this slice.

### Read path

`restoreFromDisk` calls `loadAllWebSessions()` after PTY restore. Each row is converted to `SerializedWebSession` and fed to existing `restoreWebSession`. No staleness wipe — DB rows persist indefinitely until user archives. Add `archived` status filter at load time.

### Resume + failure surface

`restoreWebSession` already calls `reconnectWebSession`. Extend that to:

1. If `capabilities.resume === true` and `providerSession` non-empty → call `adapter.resume(providerSession[vendorKey])`.
2. If resume rejects (any error from adapter), emit a synthetic `errorMessage` patch into the session timeline:
   ```json
   {
     "type": "errorMessage",
     "source": "client",
     "message": "Resume failed: <vendor> session expired or rotated. Start a new session to continue.",
     "context": "resume"
   }
   ```
   Set `status: 'disconnected'` on the live state. Do not retry. Do not auto-create a fresh vendor session.
3. UI consumes this via the existing `errorMessage` renderer; no new UI needed.

### What goes away

- `pending-sessions.json` web session entries (PTY entries stay).
- 5-minute staleness wipe for web sessions.
- Single-write-on-shutdown failure mode.

## Slice-by-slice

### Slice 1 — DB module + write path

1. Add `server/relay-state-db.ts`. Mirror `analytics.ts` skeleton: `Database`, WAL pragma, `schema_version` table, `MIGRATIONS` array, prepared statements.
2. Migration `1`: `CREATE TABLE web_sessions ...` plus indexes.
3. Wire `initRelayStateDb(configDir)` into `initializeRuntimeDirectories` in `server/index.ts:798` next to `initFileLogging` and `initAnalytics`.
4. Add debounced `upsertWebSession` call inside `applyWebSessionPatchV2`. Use a module-level `Map<sessionId, NodeJS.Timeout>` for debounce. Flush all timers on `gracefulShutdown`.
5. Add immediate writes on `createWebSession`, `closeWebSession`, vendor session id assignment in adapters (when `providerSession` is updated).

Test: vitest unit test `test/server/relay-state-db.test.ts` covers schema migration, upsert idempotence, load roundtrip.

### Slice 2 — Read path + JSON migration

1. Modify `restoreFromDisk` in `server/sessions.ts` to call `loadAllWebSessions()` after PTY restore.
2. Remove web session serialization from `serializeWebSession` / `serializeAll` write path; keep PTY-only.
3. **DEFERRED** — JSON→SQLite import. Shipped behavior abandons legacy web entries from `pending-sessions.json` on first run rather than migrating them. Re-evaluate if user friction warrants implementing.
4. Remove `STALE_THRESHOLD_MS` check from web restoration. PTY check stays.

Test: integration test that writes a fake `pending-sessions.json` with mixed PTY + web sessions, runs init, verifies DB has web sessions and JSON file has only PTY.

### Slice 3 — Resume failure surface

1. In `restoreWebSession`, wrap the `reconnectWebSession` call. On rejection, push a synthetic `errorMessage` patch into `agentSessionV2` and persist via existing `applyWebSessionPatchV2`.
2. Set live state `status: 'disconnected'`, clear `activeTurnId`.
3. Verify `ChatView.tsx` `canResume` still computes correctly post-failure (should: status disconnected + providerSession present → resume button shown again, user can retry manually).
4. Add unit test for the failure path: stub adapter `connect` to reject with `resume failed`, assert `errorMessage` item appears with `source: 'client'`, `context: 'resume'`, and live status is `disconnected`.

### Slice 4 — Cleanup + docs

1. Drop `agentSessionV2` and `agentPatchesV2` fields from `SerializedWebSession` interface. Drop `webSessions` field from `PendingSessionsFile` once migration shipped.
2. Bump `pending-sessions.json` version to 6 (PTY-only).
3. Update `docs/ARCHITECTURE.md` — new "Web session persistence" subsection pointing at `relay-state.db`.
4. Update `docs/DESIGN.md` if it references the old JSON path.

## Out of scope

- "Continue here" recovery (new vendor session merged into same relay session id on resume failure). Tracked separately.
- Per-patch row table for forensic replay. Blob is sufficient for the foreseeable need.
- Cross-vendor session search UI. DB schema supports it; UI surface is a follow-up.
- PTY session migration to SQLite. Tmux session lifecycle differs; keep the JSON path.
- Multi-device sync. Single-host store only.

## Risks

| Risk                                      | Mitigation                                                                                     |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Write amplification from streaming deltas | 1s debounce per session id collapses ~hundreds of patches per turn into one write.             |
| DB corruption on hard kill                | WAL mode + `synchronous = NORMAL` pragma. Acceptable durability tradeoff vs throughput.        |
| Vendor session id stale on long restart   | Already a known caveat. Resume-failure path surfaces clearly to user, no silent breakage.      |
| Schema evolution                          | `schema_version` + `MIGRATIONS` array (same pattern as `analytics.ts`). Forward-only.          |
| Concurrent writes from multiple sessions  | `better-sqlite3` is sync + serializes writes. WAL allows concurrent readers. No locking issue. |

## Open questions

- Archive policy: when does a row move to `status='archived'`? On explicit user action only, or also on idle timeout? Recommend explicit-only for first slice.
- Backup story: do we want an export command or rely on filesystem backup? Out of scope unless asked.
- Telemetry: should `web_sessions` row count + last_activity feed analytics dashboards? Future enhancement.
