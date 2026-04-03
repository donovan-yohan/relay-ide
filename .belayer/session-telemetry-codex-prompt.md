# Session Telemetry Implementation

## What to Build

Add real-time session telemetry to Relay: a bottom status bar showing model, context %, tokens, cost, current tool, and rate limits for the active session. Plus dashboard usage panels and mobile layout improvements.

## Architecture Overview

Claude Code's `statusLine` hook provides a JSON payload with all telemetry data. We add `statusLine` to the **per-session settings file** (the same temp file that already carries hooks). The statusLine script writes the full JSON to a telemetry file that the server reads and broadcasts via WebSocket.

```
Claude Code (per session)
  │ statusLine hook (300ms debounce)
  ▼
/tmp/relay-ide/<sessionId>/relay-statusline.sh
  │ writes full JSON payload
  ▼
<configDir>/telemetry/<sessionId>.json
  │ read by server every 2s
  ▼
server/telemetry.ts (StatusLineCollector)
  │ broadcasts WS events
  ▼
frontend/src/lib/state/telemetry.svelte.ts
  │ reactive Svelte 5 store
  ▼
SessionStatusBar.svelte + Dashboard panels
```

## Implementation Steps (in order)

### Step 1: Extend per-session settings with statusLine

**File: `server/pty-handler.ts`**

The function `writeHooksSettingsFile()` (line ~40) writes per-session hooks to `/tmp/relay-ide/<sessionId>/hooks-settings.json`. Extend it to:

1. Add `statusLine` to the settings JSON alongside `hooks`:

```json
{
  "hooks": { ... existing hooks ... },
  "statusLine": {
    "type": "command",
    "command": "/tmp/relay-ide/<sessionId>/relay-statusline.sh"
  }
}
```

2. Write a `relay-statusline.sh` script to the same temp directory:

```bash
#!/usr/bin/env bash
input=$(cat)
mkdir -p "<configDir>/telemetry"
echo "$input" > "<configDir>/telemetry/<sessionId>.json"
GLOBAL_CMD="<globalStatusLineCommand>"
[ -n "$GLOBAL_CMD" ] && [ -x "$GLOBAL_CMD" ] && echo "$input" | "$GLOBAL_CMD" || echo "$input" | jq -r '"\\(.model.display_name // \"Claude\") | \\(.context_window.remaining_percentage // \"?\")% ctx"'
```

The `<configDir>` is the Relay config directory (same dir as `config.json` — use `getConfigDir()` from `server/config.ts`). The `<globalStatusLineCommand>` is read from `~/.claude/settings.json` → `statusLine.command` (if it exists). If the user has no global statusLine, the fallback outputs a minimal model + context % line.

Make the script executable (`chmod 0o755`).

The function signature needs to accept `configDir` as a parameter so it knows where to write telemetry files.

### Step 2: Build `server/telemetry.ts`

New module, single concern. Follow the pattern of `server/hooks.ts` (dependency injection).

**Types** (add to `server/types.ts`):

```typescript
export interface TelemetryData {
  sessionId: string;
  model: string | null;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheRead: number;
  totalCacheWrite: number;
  contextPercent: number; // 0-100, -1 if unknown
  contextWindowSize: number;
  costUsd: number | null;
  source: 'statusLine' | 'jsonl';
}

export interface AccountTelemetry {
  fiveHourUsedPercent: number; // -1 if unavailable
  fiveHourResetsAt: string;
  sevenDayUsedPercent: number;
  sevenDayResetsAt: string;
  updatedAt: string;
}
```

**TelemetryDeps interface:**

```typescript
export interface TelemetryDeps {
  getActiveSessions: () => Session[];
  broadcastEvent: (type: string, data?: Record<string, unknown>) => void;
  configDir: string;
}
```

**StatusLineCollector logic:**

- On each 2s tick, iterate active sessions
- For each session, try to read `<configDir>/telemetry/<sessionId>.json`
- Parse the statusLine JSON payload. Extract:
  - `model.display_name` → `model`
  - `context_window.total_input_tokens` → `totalInputTokens`
  - `context_window.total_output_tokens` → `totalOutputTokens`
  - `context_window.current_usage.cache_read_input_tokens` → `totalCacheRead`
  - `context_window.current_usage.cache_creation_input_tokens` → `totalCacheWrite`
  - `context_window.used_percentage` → `contextPercent`
  - `context_window.context_window_size` → `contextWindowSize`
  - `cost.total_cost_usd` → `costUsd`
  - `rate_limits.five_hour.used_percentage` → account telemetry
  - `rate_limits.seven_day.used_percentage` → account telemetry
  - `rate_limits.*.resets_at` → account telemetry
- If data changed since last broadcast, emit `session-telemetry` WS event
- If rate limit data changed, emit `account-telemetry` WS event

**Persistence:**

- Every 60s, write all telemetry data to `<configDir>/pending-telemetry.json`
- On shutdown (SIGTERM/SIGINT), write it too
- On startup, restore from this file if it exists (and isn't stale > 5 min)
- Follow the exact pattern of `pending-sessions.json` in `server/sessions.ts`

**REST endpoints** (mount in `server/index.ts`):

- `GET /telemetry/sessions` — returns `Record<string, TelemetryData>` for all tracked sessions
- `GET /telemetry/account` — returns `AccountTelemetry | null`
- Both behind the existing auth middleware (mount AFTER auth, like other API routes)

**Exports:**

```typescript
export function startTelemetry(deps: TelemetryDeps): void;
export function stopTelemetry(): void;
export function getTelemetryForSession(
  sessionId: string
): TelemetryData | undefined;
export function getAccountTelemetry(): AccountTelemetry | null;
```

**Error handling:**

- File not found (ENOENT) → session not yet resolved, skip
- Malformed JSON → log warning, skip this tick
- All errors are non-fatal — telemetry is best-effort

### Step 3: Mount telemetry in `server/index.ts`

Wire the telemetry module into the server startup:

1. After session store is initialized, call `startTelemetry({ getActiveSessions: sessions.list, broadcastEvent, configDir })`
2. Mount REST endpoints after auth middleware
3. On shutdown, call `stopTelemetry()`
4. Create `<configDir>/telemetry/` directory on startup if it doesn't exist

### Step 4: Frontend telemetry store

**New file: `frontend/src/lib/state/telemetry.svelte.ts`**

Reactive Svelte 5 store. Listen for WS events on the existing `/ws/events` connection.

```typescript
let sessionTelemetry = $state<Map<string, TelemetryData>>(new Map());
let accountTelemetry = $state<AccountTelemetry | null>(null);
```

Handle events:

- `session-telemetry` → update the Map entry, then **reassign** (`sessionTelemetry = new Map(sessionTelemetry)`) to trigger Svelte reactivity
- `account-telemetry` → update `accountTelemetry`

Export:

- `getSessionTelemetry(sessionId: string): TelemetryData | undefined`
- `accountTelemetry` (reactive)

On session end, clean up the entry from the Map (listen for `session-ended` event).

### Step 5: `SessionStatusBar.svelte`

**New file: `frontend/src/components/SessionStatusBar.svelte`**

Position: below Terminal, above Toolbar in the session view layout in `App.svelte`.

Visual style (read DESIGN.md for full spec):

- Full width, ~28px tall, single row
- `font-family: var(--font-mono)`, `font-size: var(--font-size-xs)`
- `background: var(--bg)`, `border-top: 1px solid var(--border)`
- NO border-radius (0px everywhere per DESIGN.md)
- Dense left-to-right flex layout

Segments (left to right):

1. **Model badge** — muted text (`color: var(--text-muted)`)
2. **Context meter** — thin inline bar + percent. Colors: white text <60%, `var(--status-warning)` <85%, `var(--status-error)` ≥85%
3. **Token counts** — `↓12.4k ↑3.2k` (abbreviate with k/M suffixes)
4. **Cost** — `~$0.42` (from `costUsd`, prefix with `~`)
5. **Current tool** — `[Read: app.ts]` (from existing `session.currentActivity` via hooks)
6. **Right-aligned: rate limits** — `5h: 78% | 7d: 92%` (from accountTelemetry)

**Responsive:**

- Below 600px: show only context meter + current tool
- Below 400px: show only context meter

**Unresolved state:** When telemetry data is not yet available, show dashes: `— ░░░░░░░░░░░░░░ —%  ↓— ↑—`

**Hidden when:** `keyboardOpen` is true (see Step 7)

Props: `sessionId: string`

### Step 6: Dashboard usage panels

**Modify: `frontend/src/components/RepoDashboard.svelte`**

Add a "usage" section above the PR table. Query telemetry data from the REST endpoint or use the reactive store (aggregate sessions matching the current repo).

Show:

- Sessions tracked count
- Total tokens (input/output/cache) across repo sessions
- Rate limit bars (if available from accountTelemetry)
- If no telemetry data, show "no telemetry data available" muted text

**Modify: `frontend/src/components/OrgDashboard.svelte`**

Add per-repo usage breakdown with bars showing relative token usage per repo.

Style: all lowercase labels, monospace, `var(--border)` separators, no border-radius on bars.

### Step 7: Mobile layout — lift `keyboardOpen` to shared state

**Modify: `frontend/src/lib/state/ui.svelte.ts`** (or create if it doesn't exist as a `.svelte.ts` file)

Move the `keyboardOpen` `$state` from `App.svelte` (currently a local variable set via `visualViewport` resize handler) to the shared UI state store so multiple components can read it.

**Modify: `frontend/src/App.svelte`**

- Import `keyboardOpen` from the shared store instead of local state
- The `visualViewport` handler still writes to it, but via the store

**Modify: `frontend/src/components/PrTopBar.svelte`**

- Import `keyboardOpen` from UI state store
- Add `style:display={keyboardOpen ? 'none' : ''}` or equivalent

**Modify: `frontend/src/components/SessionTabBar.svelte`**

- Same pattern as PrTopBar

**`SessionStatusBar.svelte`** already reads `keyboardOpen` (see Step 5).

### Step 8: Tests

**New file: `test/telemetry.test.ts`**

Test the server telemetry module:

- StatusLineCollector reads a sample JSON file and extracts correct fields
- Missing file returns undefined (no crash)
- Malformed JSON is handled gracefully
- Persistence writes and restores correctly
- REST endpoints return expected shapes

Use real fixture data. Sample statusLine JSON:

```json
{
  "session_id": "abc-123",
  "model": { "id": "claude-opus-4-6", "display_name": "Claude Opus 4.6" },
  "context_window": {
    "total_input_tokens": 12400,
    "total_output_tokens": 3200,
    "context_window_size": 200000,
    "used_percentage": 7.8,
    "remaining_percentage": 92.2,
    "current_usage": {
      "input_tokens": 500,
      "output_tokens": 100,
      "cache_creation_input_tokens": 1000,
      "cache_read_input_tokens": 5000
    }
  },
  "cost": { "total_cost_usd": 0.42 },
  "rate_limits": {
    "five_hour": { "used_percentage": 22, "resets_at": "2026-03-31T19:30:00Z" },
    "seven_day": { "used_percentage": 8, "resets_at": "2026-04-03T00:00:00Z" }
  }
}
```

## Codebase Patterns to Follow

- **All imports use `.js` extensions** and `node:` prefix for Node builtins
- **DI pattern:** see `server/hooks.ts` (`HookDeps` interface) — telemetry uses the same pattern (`TelemetryDeps`)
- **WS events:** use `broadcastEvent(type, data)` from `server/ws.ts` — same pattern as `session-backend-state-changed`, `session-activity-changed`
- **Config dir:** use `getConfigDir()` from `server/config.ts` for the config directory path
- **Persistence:** follow `pending-sessions.json` pattern in `server/sessions.ts` — write on shutdown + periodic, restore on startup
- **Svelte 5 runes:** use `$state`, `$derived`, `$effect`. When mutating a Map, **always reassign** after `.set()` or `.delete()` to trigger reactivity
- **Frontend types:** mirror server types in `frontend/src/lib/types.ts`
- **Monospace everything**, all lowercase labels, no emoji, no border-radius — see DESIGN.md

## Files to Create

- `server/telemetry.ts`
- `frontend/src/components/SessionStatusBar.svelte`
- `frontend/src/lib/state/telemetry.svelte.ts`
- `test/telemetry.test.ts`

## Files to Modify

- `server/pty-handler.ts` — extend `writeHooksSettingsFile()` for statusLine
- `server/types.ts` — add TelemetryData, AccountTelemetry, TelemetryDeps
- `server/index.ts` — mount telemetry, REST endpoints, shutdown hook
- `frontend/src/App.svelte` — add SessionStatusBar to session view layout, lift keyboardOpen
- `frontend/src/lib/types.ts` — mirror TelemetryData, AccountTelemetry
- `frontend/src/lib/ws.ts` — handle new WS event types
- `frontend/src/lib/state/ui.svelte.ts` — add keyboardOpen state (or create file)
- `frontend/src/components/PrTopBar.svelte` — hide when keyboardOpen
- `frontend/src/components/SessionTabBar.svelte` — hide when keyboardOpen
- `frontend/src/components/RepoDashboard.svelte` — add usage panel
- `frontend/src/components/OrgDashboard.svelte` — add per-repo usage breakdown

## What NOT to Build

- No JSONL transcript file reading (statusLine provides everything for Claude)
- No Codex collector (deferred to v2)
- No global `~/.claude/settings.json` modification (per-session only)
- No user consent banner (per-session statusLine is transparent)
- No usage alerts/notifications (deferred)
