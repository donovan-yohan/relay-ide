# Milestone 1 Spike: Buzz Desktop React UI on Relay Hub ("relay-app")

This document details the findings and implementation of the Milestone 1 spike evaluating Buzz's desktop React frontend as the channel-first, Slack-style desktop application for Relay IDE.

---

## 1. The Wire Seam

Buzz was architected as a Nostr-native desktop client with a dual-layer communication model:
1. **Tauri IPC (`invokeTauri` / `@tauri-apps/api/core`)**: Handles identity lookups, channel discovery (`get_channels`, `get_open_channel_directory`, `get_channel_details`), message window paging (`get_channel_window`, `get_channel_messages_before`), profile resolution (`get_users_batch`, `get_profile`), and message posting (`send_channel_message`).
2. **WebSocket Client (`RelayClient` / `plugin:websocket|*`)**: Handles live streaming subscriptions (`["REQ", subId, filter]`), auth handshakes, and real-time event dispatching.

### Bridge Implementation
The wire seam was implemented completely in userland without modifying Relay Hub backend code:
- **`src/relayBridge.ts`**: The core wire adapter bridge. Intercepts Tauri commands via `@tauri-apps/api/mocks` (`mockIPC` and `mockWindows`), bridges REST endpoints to Relay Hub (`http://127.0.0.1:3456`), translates Relay JSON schemas into Nostr `RelayEvent` / `RawChannel` models, and bridges live WebSockets from `/ws/channels/:id` into Nostr frame deliveries.
- **`src/main.tsx`**: Bootstraps Relay mode by invoking `configureRelayBridge()` on startup: authenticates session with Relay Hub (`POST /auth`), seeds localStorage keys (`buzz-communities`, `buzz-active-community-id`, `buzz-onboarding-complete.v1:*`, `buzz-machine-onboarding-complete.v2`), sets zero splash hold, and registers the mock IPC before React mounts.
- **`vite.config.ts`**: Configures path aliases and adds local proxy routing for `/channels`, `/auth`, `/workspace-topics`, and `/ws` to `http://127.0.0.1:3456`.

---

## 2. Kind & Tag Mapping Table

| Relay Concept | Nostr Kind / Buzz Shape | Tags & Attributes | Implementation Details |
| :--- | :--- | :--- | :--- |
| **Workspace Topic / Channel** | Kind `39000` (Metadata) & `39002` (Members) / `RawChannel` | `id: topic.id`<br>`channel_type: "stream"` | Mapped from `GET /channels`. Topics map to `stream` channels. Members registered in profile map. |
| **Direct Message (DM)** | Kind `39000` / `RawChannel` | `id: topic.id`<br>`channel_type: "dm"` | `topic:dm~...` IDs and `kind: "dm"` map to Buzz 1:1 direct messages. |
| **Channel Message** | Kind `9` (Stream Message) / `RelayEvent` | `["h", channelId]`<br>`["p", authorPubkey]` | `id: sha256(message.id)`, `pubkey: sha256(sender.id)`, `content: message.body.text`, `created_at: unixSec`. |
| **System Message** | Kind `40099` (System Message) / `RelayEvent` | `["h", channelId]` | Relay `kind: "system"` messages map to Kind 40099 for membership / topic updates. |
| **Window Bounds** | Kind `39006` (Channel Window Bounds) / `RelayEvent` | `["d", "${channelId}:${cursor}"]` | Synthetic bounds event appended to `get_channel_window` with `{"has_more": false, "next_cursor": null}`. |
| **Sender / Profile** | Kind `0` (Metadata) / `UserProfileSummary` | `pubkey: sha256(sender.id)` | Deterministic 32-byte hex pubkeys for `human:operator`, `agent-profile:codex:default`, etc. `isAgent` derived from `sender.kind`. |
| **Thread Reply** | Kind `9` / `RelayEvent` | `["e", sha256(threadId), "", "root"]`<br>`["e", sha256(parentMessageId), "", "reply"]` | NIP-10 positional markers mapped from `message.threadId` and `message.parentMessageId`. |
| **Live Subscriptions** | `plugin:websocket|connect` & `plugin:websocket|send` | `["REQ", subId, {"#h": [channelId]}]` | Opens Relay Hub WebSocket `/ws/channels/:id`; translates `channel-message-created-v1` to Nostr `["EVENT", subId, event]`. |
| **Message Posting** | `send_channel_message` Tauri command | `channelId`, `content`, `parentEventId` | Executes `POST /channels/:id/messages` with `x-relay-capabilities: context:read,context:write,session:read,session:create:agent`. |

---

## 3. Lossy or Impossible Mappings

1. **Streaming Agent Detail Cards & Tool Calls**:
   - *Relay*: Streams incremental itemized tool invocations, bash executions, and expandable thought cards (`agentDetail.card`).
   - *Buzz*: Nostr chat expects a flat text/markdown content string. In this spike, thoughts are formatted as markdown blockquotes (`> **[thought] title**\ncontent`), but live interactive inspection widgets require native React component integration.
2. **Turn & Run Lifecycle vs Discrete Nostr Events**:
   - *Relay*: Tracks fine-grained agent run lifecycles (`channel-run-lifecycle-v1`), active turn status, and per-profile delivery receipts (`channel-delivery-receipt-v1`).
   - *Buzz*: Nostr only records static event persistence (`["OK", eventId, true]`) and reaction receipts.
3. **Capability-Based Auth vs Cryptographic Signatures**:
   - *Relay*: Authenticates via session cookies and capability scopes (`context:read,context:write`).
   - *Buzz*: Built around Schnorr signatures (`sig`) and NIP-42 auth challenges. The spike generates deterministic mock signatures (`00`.repeat(64)).

---

## 4. Buzz Features with No Relay Meaning (Kill List)

The following Nostr-specific systems in Buzz should be pruned when packaging `relay-app`:
1. **Nostr Relay Management**: Multi-relay pooling, relay switching, NIP-65 relay lists, and NIP-05 DNS verification.
2. **Cryptographic Key & Wallet Infrastructure**: NIP-44 direct message encryption keys, NCryptSec passphrase exports, lightning zaps/wallets, and keychain recovery flows.
3. **Local ACP Spawning & Runtimes**: Local Python/Debian ACP provider discovery and process management. Relay Hub owns all agent execution and node runtimes.
4. **Client SQLite Sync Engine**: Local SQLite replica and save-subscription synchronizer; Relay Hub is the single source of truth for channel history.
5. **Standalone Voice/TTS System**: Local Pocket voice and TTS registry (unless repurposed for future Relay voice channels).

---

## 5. Files Edited Outside the Seam

All modifications were restricted to `.worktrees/relay-app-spike/`:
- `vite.config.ts`: Added proxy configurations and fixed manifest alias paths.
- `preview-features.json` & `scripts/model-capabilities.json`: Copied locally for build manifest resolution.
- `package.json` / `pnpm-lock.yaml`: Installed node modules and Playwright chromium binary.
- `run-spike-test.mjs` *(new file)*: End-to-end Playwright verification suite.

*The root Relay IDE repository (`server/`, `frontend/`, `shared/`) remained completely untouched.*

---

## 6. Time Spent

- **Discovery & Dependencies** (~30 min): Initialized spike worktree, resolved dependencies, inspected Relay Hub REST and WebSocket schemas.
- **Wire Seam Implementation** (~45 min): Implemented `src/relayBridge.ts`, mapped `RawChannel`, `RelayEvent`, bounds events (Kind 39006), and mock IPC routing.
- **WebSocket & Realtime Sync** (~30 min): Bridged `RelayClient` subscription protocol to Relay Hub fan-out WebSocket (`/ws/channels/:id`).
- **Playwright Verification & Evidence** (~25 min): Authored `run-spike-test.mjs`, verified complete flow against live hub, and captured verification screenshots.

---

## 7. Ranked Milestone 2 Candidates

1. **Room Altitude + Agent Drill-in View Fed by `runId` Rows (Completed in Slice 1)**:
   Slack-like room altitude filtering (principal prose only in main channel timeline), compact `AgentRunPill` on agent responses, and deep drill-in `AgentRunViewPanel` auxiliary panel displaying turn execution trace, tool cards, diffs, and reasoning.
2. **Threads Panel**:
   Connect Relay's thread message hierarchy (`threadId` / `parentMessageId`) directly into Buzz's right-hand `MessageThreadPanel` for full side-by-side thread discussions.
3. **Presence Chips & Agent State**:
   Map Relay agent run lifecycles (`channel-run-lifecycle-v1`) to Buzz's member presence indicators to show when agents are thinking, running tools, or idle.
4. **Direct Messages (DMs)**:
   Wire deterministic `topic:dm~...` channels into the sidebar Direct Messages section with dedicated 1:1 agent profile views.
5. **Tauri Packaging & Native Distribution**:
   Package the tailored React frontend with Tauri 2.0 into a lightweight native desktop binary connecting directly to local or remote Relay Hubs.

---

## 8. Milestone 2 Slice 1: Room Altitude + Agent Drill-in View

### Overview
Milestone 2 Slice 1 delivers Relay's core conversation ergonomics to the desktop application:
1. **Room Altitude**: The main channel timeline remains clean and readable, rendering only principal prose messages from humans and agents. Granular execution detail items (`tool_call`, `thought`, `output`, `diff`, turn start/finish system events) are filtered out of room altitude.
2. **Compact Agent Run Pill**: Every agent prose message row displays an inline `AgentRunPill` with run duration, tool invocation count, and files touched (e.g. `Run 78m 6s · 129 tools · 52 files`). Clicking either the pill or the agent's avatar opens the run drill-in panel.
3. **Agent Run View Drill-in (`AgentRunViewPanel`)**: An auxiliary right panel that renders:
   - **Metrics Summary Bar**: Duration, tool call count, files touched count, and pending approval state.
   - **Multi-Turn Run Selector**: Tabbed selection for multi-turn runs.
   - **Execution Trace**: Itemized timeline of tool invocations (`AgentDetailCard`), command outputs, unified file diffs with added/removed line badges, and collapsible reasoning disclosure blocks (`ReasoningDetail`).
   - **Assistant Markdown**: Final response formatted with stream-compatible syntax highlighting (`AssistantMarkdown`).

### Architecture & Wire Seam Implementation

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                             ChannelPane Layout                              │
│                                                                             │
│  ┌────────────────────────────────────┐  ┌────────────────────────────────┐ │
│  │       Room Altitude Timeline       │  │       AgentRunViewPanel        │ │
│  │                                    │  │      (Auxiliary Right Panel)   │ │
│  │ 👤 Human: "Build the spike UI"     │  │                                │ │
│  │                                    │  │ ┌────────────────────────────┐ │ │
│  │ 🤖 Agent: "Here is the summary..." │  │ │ Metrics: 78m · 129 tools   │ │ │
│  │    ┌───────────────────────────┐   │  │ └────────────────────────────┘ │ │
│  │    │ ⚡ Run 78m · 129 tools    │───┼─▶│ ⚙️ Tool: view_file (120 lines)│ │ │
│  │    └───────────────────────────┘   │  │ ⚙️ Tool: run_command (git ...)│ │ │
│  │                                    │  │ 📝 Diff: +45 -12 in Bridge.ts │ │ │
│  │                                    │  │ 💡 Reasoning disclosure      │ │ │
│  └────────────────────────────────────┘  └────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────────┘
```

- **Room Altitude Filter (`src/relayBridge.ts`)**:
  `channelMessageIsPrincipalProse()` identifies principal human/agent prose and suppresses internal detail kinds (`tool_call`, `diff`, `thought`, `output`) from the main window event stream.
- **Run Aggregation & Metrics (`src/relayBridge.ts`)**:
  `rebuildChannelRuns()` aggregates message sequences by `runId` into structured `AgentRunRecord` objects, computing turn duration, tool counts, and touched file lists.
- **IPC Handlers**:
  - `get_agent_runs`: Returns `AgentRunSummary[]` for the active channel.
  - `get_run_details`: Returns full `AgentRunRecord` with structured execution items.
  - `get_run_rows`: Returns ordered `AgentDetailCardV2[]` rows for turn replay.
  - `list_relay_agents` / `list_managed_agents` / `get_channel_members`: Exposes all registered agent profiles to prevent unwanted session panel auto-dismissal.
- **UI Components (`src/features/agent-runs/ui/`)**:
  - `AgentRunPill.tsx`: Clickable badge attached to `MessageRow.tsx` agent messages.
  - `AgentRunViewPanel.tsx`: Auxiliary panel mounted inside `ChannelPane.tsx` side-by-side with timeline.
  - `AgentDetailCard.tsx`: Structured rendering of tool calls, outputs, diffs, and turn cards with `data-testid="agent-detail-card"`.
  - `ReasoningDetail.tsx`: Collapsible `<details>` wrapper for agent chain-of-thought blocks.
  - `AssistantMarkdown.tsx`: Stream-compatible code-highlighted markdown.

### Hub Gap Analysis (Milestone 2 Finding)

> [!NOTE]
> **REST Query Parameter Gap on Hub**:
> The Relay Hub endpoint `GET /channels/:id/messages` currently lacks query parameters for:
> - `principalOnly=true` (server-side room altitude filtering)
> - `runId=<id>` (server-side execution trace retrieval)
>
> In this spike, room altitude filtering and run grouping are handled client-side in `relayBridge.ts`. Adding `?principalOnly=true` and `?runId=` to Relay Hub REST APIs will optimize network bandwidth for channels with large agent execution traces.

### Verification & Evidence

Automated Playwright verification (`node run-slice1-test.mjs`) verified all Slice 1 requirements against a live Relay Hub channel with 200 messages and 3 agent runs:

| Step | Assertion | Result | Evidence Screenshot |
| :--- | :--- | :--- | :--- |
| **1. Room Altitude** | Timeline contains only human & agent principal prose; zero inline tool cards (`count = 0`). | **PASS** | `evidence/05-room-altitude-prose-only.png` |
| **2. Run Pill** | Agent prose row renders `AgentRunPill` with `"Run 78m 6s · 129 tools · 52 files"`. | **PASS** | `evidence/05-room-altitude-prose-only.png` |
| **3. Run View Drill-in** | Clicking pill opens `AgentRunViewPanel` in auxiliary panel. | **PASS** | `evidence/06-agent-run-view-opened.png` |
| **4. Trace & Metrics** | Auxiliary panel displays metrics summary bar, itemized tool call cards, and diffs. | **PASS** | `evidence/07-agent-run-tool-details.png` |

---

## 9. Milestone 2 Slice 2: Mention Autocomplete from Relay Profile Catalog

### Overview
Milestone 2 Slice 2 connects Relay's agent profile catalog and channel rosters directly into the desktop message composer:
1. **Catalog & Roster Ingestion**: The client queries `GET /agent-profiles` on startup and `GET /channels/:id/roster` when opening channels, dynamically registering all configured agent profiles (built-in providers: Codex, Pi, Claude Code, Cursor, DeepSeek Harness, Hermes, Prime Agent, Antigravity, plus custom Hermes personas like Ebi, Hotate Design, Koi Product, Tako Planner, etc.) into `profileRegistry`.
2. **Mention Autocomplete Popover**: Typing `@` in the composer immediately surfaces the live agent roster from the Relay Hub with agent badges (`agent · managed by you`) and avatars.
3. **Mention Delivery & Hub Routing**: Selecting an agent suggestion (e.g. `@Pi`) and sending the message posts directly to `POST /channels/:id/messages`, where the Relay Hub binder tokenizer parses the mention and resolves `message.mentions = [{ profileId: "agent-profile:pi:default", providerId: "pi", raw: "@pi" }]`.

### Wire Seam & Files Changed
- **`src/relayBridge.ts`**:
  - Implemented `fetchAgentProfilesFromRelay()` (`GET /agent-profiles`) and `fetchChannelRoster()` (`GET /channels/:id/roster`).
  - Updated `get_channel_members` to ingest channel roster and return agent members.
  - Updated `list_managed_agents` and `list_relay_agents` to return rich catalog profiles.
  - Added stubs for `revalidate_relay_agents`, `sync_agents_to_active_huddle`, `start_managed_agent`, and `attach_managed_agent_to_channel`.
- **`vite.config.ts`**:
  - Added proxy forwarding for `/agent-profiles` to `http://127.0.0.1:3456`.
- **`run-slice23-test.mjs`**:
  - Automated Playwright test verifying autocomplete popup population and backend mention routing.

### Hub Gap Analysis
- `GET /agent-profiles` returns `displayName: ""` for built-in framework profiles (relying on client provider capitalization fallbacks), whereas `GET /channels/:id/roster` returns fully resolved display names ("Antigravity", "Claude Code", "Codex", "Pi", etc.). Bridged by querying channel roster to register rich profile metadata.

### Verification & Evidence
- **Evidence 08**: `evidence/08-mention-autocomplete-roster.png` (Mention popover listing Relay agents: local-cli, Antigravity, Operator, Claude Code, Codex, Hermes, Prime Agent, Pi, Cursor, DeepSeek Harness).
- **Evidence 09**: `evidence/09-mention-sent-and-routed.png` (Sent `@pi` message routed on Relay Hub with `profileId: "agent-profile:pi:default"`).

---

## 10. Milestone 2 Slice 3: Hub Connect Screen Replacing Nostr Onboarding

### Overview
Milestone 2 Slice 3 eliminates all Nostr-specific onboarding (keypair generation, `nsec` export, passphrase encryption, Nostr relay lists, ACP spawn wizards) and replaces them with a native **Relay Hub Connect Screen**:
1. **Direct Hub Authentication**: Clean, zero-radius form with **Hub URL** (defaults to `http://127.0.0.1:3456` or current origin) and **Hub PIN / Gateway Token** (e.g. `4242`).
2. **Session Persistence**: On submit, calls `authenticateRelay()`, stores session metadata in `localStorage` (`buzz-communities`, `buzz-active-community-id`, `relay-hub-connected-url`), and immediately enters the workspace channel list.
3. **Zero Cryptographic Friction**: No Nostr keys generated, no recovery phrases, no machine onboarding hurdles.

### Wire Seam & Files Changed
- **`src/features/onboarding/ui/HubConnectScreen.tsx` *(new file)***:
  - Relay-branded connection screen with URL & PIN inputs, connection status states, error feedback, and session bootstrap.
- **`src/features/communities/ui/WelcomeSetup.tsx`**:
  - Replaced Nostr community onboarding flow with `HubConnectScreen`.
- **`src/main.tsx`**:
  - Added `?screen=hub-connect` support in `bootstrap()` for explicit connection testing and fresh-profile onboarding.

### Verification & Evidence
- **Evidence 10**: `evidence/10-hub-connect-screen.png` (Hub Connect screen with Hub URL, PIN input, and zero Nostr elements).
- **Evidence 11**: `evidence/11-fresh-boot-channel-list.png` (Fresh profile connection transition landing in Relay channel list).


