# Frontend

The frontend is React 19 with Zustand for client state, TanStack Query for
server state, and Vite for development/builds. The primary collaboration
surface is channel-first: channels and DMs open the same `ChannelView`.

## Entry and navigation

`App.tsx` composes authentication, global queries, navigation, dialogs, and
the active content area. `PinGate` blocks unauthenticated access.

`TopicSidebarShell` is the main navigation surface. It exposes channels,
profile DMs, unread activity, and active execution. Selecting a channel sets
`activeChannelId`; `ChatHome` then mounts `ChannelView`.

Terminal, file, diff, artifact, settings, and diagnostics surfaces remain
available as execution/control tools. They do not own agent conversations.

## Live channel tree

```text
ChatHome
  └─ ChannelView
       ├─ ChannelTimeline
       │    ├─ ChannelMessageGroup
       │    └─ ChannelMessageRow
       │         ├─ AssistantMarkdown
       │         ├─ AgentDetailCard
       │         └─ ChannelImagePart
       ├─ ChannelComposer
       └─ ChannelThreadPanel
```

### `ChannelView`

`ChannelView` owns one open conversation:

- joins REST metadata/history with the channel socket reducer;
- resolves DM identity from workspace-topic routing;
- captures last-read position into the activity store, which converges it
  through the hub (see State ownership below);
- resolves `#msg-` deep links, walking bounded older-history pages;
- renders archived, disconnected, resync, and unavailable states;
- fetches the profile roster and current agent status;
- posts top-level and threaded messages;
- exposes interrupt, approval, and orchestrator controls.

### Timeline and rows

`ChannelTimeline` owns grouping, date markers, unread markers, history prepend,
bottom-follow behavior, and the new-message affordance. It renders only
top-level rows; replies appear in `ChannelThreadPanel`.

`ChannelMessageRow` is the acceptance host for agent output. It renders:

- human/agent Markdown through `AssistantMarkdown`;
- typed reasoning, tool, code, output, and diff rows through
  `AgentDetailCard`;
- native images through `ChannelImagePart`;
- explicit streaming, truncated, interrupted, failed, and system states;
- thread reply counts and open-thread controls.

Agent code fences use collapsible cards with Shiki syntax highlighting. Diff
cards use addition/deletion tint. These behaviors must be tested through the
channel row/timeline, not only through isolated primitives.

### Composer and threads

`ChannelComposer` supports text, mention completion, submit state, and up to
four bounded native images. The thread panel reuses it with a root message id.

`ChannelThreadPanel` loads the root plus replies, preserves channel identity,
and posts through the same message contract as the main composer.

While a bound agent is mid-turn the composer reveals two explicit controls:
`queue` (plain `enter`) and `interrupt & send` (`cmd/ctrl`+`enter`). Steering is
never inferred from message text.

### Message toolbar and deep links

`ChannelMessageRow` exposes a hover toolbar: copy link, edit, delete, and retry
on failed rows. Links are `/channel/<segment>#msg-<message id>`, built and
parsed by `frontend/src/lib/url-nav.ts`. Opening an anchor that is outside the
loaded window walks older pages up to `ANCHOR_WALK_MAX_PAGES` before giving up
with a toast.

## Notifications, badges, and update toast

`NotificationStack.tsx` renders the `notifications.ts` stack. `UpdateToast.tsx`
checks the server version on mount, and on a one-click update reloads through
`frontend/src/lib/server-restart.ts` once the server returns.

The notification runtime is `frontend/src/lib/notify/`:

| Module               | Responsibility                                         |
| -------------------- | ------------------------------------------------------ |
| `leader.ts`          | Elects one leader tab so N tabs raise one notification |
| `os-notification.ts` | Permission state and OS notification delivery          |
| `favicon-badge.ts`   | Favicon count badge                                    |
| `title-badge.ts`     | Document title count                                   |
| `signals.ts`         | Derives what is worth announcing                       |
| `producers.ts`       | Maps channel activity into notification signals        |
| `summary-watch.ts`   | Watches channel summaries for background activity      |

Notifications fire only while the tab is hidden and read the same client-derived
unread state as the sidebar; they do not add a second source of truth.

## Search

`TopicSidebarShell` renders search results in two sections — matching channels
and matching messages — from `GET /channels/search`. The same query is a command
palette category. Selecting a message result navigates to its channel and jumps
to the row.

## Data flow

`useChannelChatSocket(channelId)`:

1. fetches channel metadata through TanStack Query;
2. opens `/ws/channels/:channelId` with the last applied sequence;
3. validates and reduces channel events with
   `shared/channel-chat-protocol.ts`;
4. detects gaps and reconnects/catches up from durable history;
5. pages older history through REST;
6. posts messages through REST.

The socket is server-to-client. Posting, attachments, agent controls, and
orchestrator designation use authenticated HTTP routes.

Reconnect uses bounded exponential backoff plus visibility/network liveness
probes. A full snapshot is authoritative and can reset stale browser sequence
state after channel recreation.

## State ownership

### Zustand

| Store                          | Responsibility                                                                         |
| ------------------------------ | -------------------------------------------------------------------------------------- |
| `ui.ts`                        | Active channel/thread, dialogs, and local navigation                                   |
| `channel-activity.ts`          | Last-read marks: local fast path, hub push/seed, monotonic-up merge, clamp-epoch fence |
| `channel-agent-status.ts`      | Live profile status keyed by channel/profile                                           |
| `channel-queued-sends.ts`      | Client-side memory of messages sent into a busy agent; drives the `queued` chip        |
| `unread.ts`                    | Unread derivation from marks against durable sequence                                  |
| `notifications.ts`             | Notification stack entries (including the update toast)                                |
| `notify-settings.ts`           | Operator notification preferences                                                      |
| `reasoning-detail-settings.ts` | Client-local collapsed/expanded default for new reasoning details                      |
| `notify-badge.ts`              | Derived badge count for favicon and title                                              |
| `sessions.ts`                  | Terminal/process session summaries                                                     |
| `toasts.ts`                    | Transient notifications                                                                |

Last-read marks are not browser-local. `channel-activity.ts` persists locally as
the fast path, then pushes to `PUT /channels/:id/read-state`, seeds from
`GET /channels/read-state`, and applies `channel-read-state` broadcasts from
`/ws/events`. Merges are monotonic up and fenced per channel by a clamp epoch,
so a stale device cannot pull a channel back to unread and a recreated DM does
not inherit a dead one's mark. Unread counts stay client-derived.

### TanStack Query

Query-backed data includes channel/topic metadata, agent profiles, rosters,
nodes, sessions, repositories, integrations, and evidence. Writes invalidate
the smallest owning query family.

### Shared reducers

Channel message state is reduced by the shared protocol module, not by
component-local event reconstruction. Pure frontend helpers handle identity,
DM channel ids, timeline anchoring, unread arithmetic, and runtime status
projection.

## Agent profiles and channel status

Agent profiles are durable participants. Profile UI edits provider, model,
permission, system prompt, working-directory, and display configuration
through the profile API.

The roster combines profiles with availability and current binding status.
Sender badges resolve from the profile actor id so multiple profiles from one
provider remain visually distinct.

The channel header can designate one profile as persistent orchestrator.
Active Work groups spawned workers beneath their orchestrator using explicit
runtime/session lineage.

## Execution surfaces

`WorkspaceArea` hosts execution and artifact views:

- terminal tabs using xterm.js;
- file and diff viewers/editors;
- HTML artifacts and previews;
- repo/evidence surfaces;
- related utility rail content.

These surfaces can be opened from channel work without becoming a second
conversation model. Public terminal/process sessions use `relay-pty`; private
channel-agent runtimes never appear as terminal tabs.

## Mobile behavior

The channel surface is the mobile default. Touch targets, composer behavior,
timeline anchoring, image picking, thread layout, unread controls, and roster
actions must work with the virtual keyboard and narrow viewport.

The terminal remains a fallback/control surface. Mobile terminal changes use
the fixtures under `test/fixtures/mobile-input/` and require real-browser or
device proof when unit/e2e coverage cannot establish the behavior.

## Styling

- Global tokens live in `frontend/src/App.css`.
- Component styles live beside their TSX files.
- Channel styles use `ChannelView.css`, `ChannelComposer.css`, and
  `ChannelImagePart.css`.
- Markdown typography belongs to `AssistantMarkdown.css`.
- Rich card styles belong to their reusable card/code/diff primitives.

Follow [`../DESIGN.md`](../DESIGN.md): monospace typography, restrained color,
outline controls, zero-radius geometry, explicit focus states, and bounded
motion.

## Verification map

| Change                      | Minimum proof                                    |
| --------------------------- | ------------------------------------------------ |
| Message rendering           | `ChannelMessageRow` component tests              |
| Scroll/history behavior     | `ChannelTimeline` anchor/scroll tests            |
| Composer/mentions/images    | composer and channel-thread tests                |
| Threads                     | thread history/component/e2e tests               |
| Agent cards                 | card tests plus the live channel fixture         |
| Profile/roster/orchestrator | profile, roster, and channel-view tests          |
| Mobile interaction          | responsive browser smoke and target-device proof |

Run `npm run check`, targeted tests, and `npm run build`. Package/global mode
serves `dist/frontend`, so a source edit is not visible there until rebuilt.
