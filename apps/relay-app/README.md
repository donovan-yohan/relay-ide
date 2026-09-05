# relay-app (spike)

Slack-style desktop client for Relay, built by forking the [Buzz](https://github.com/block/buzz) desktop app (Apache 2.0) and pointing it at a Relay hub instead of a Nostr relay.

Status: **spike**. Browser mode is verified end to end on Linux against a live hub. The Tauri desktop shell has not been built yet (the build host had no WebKit); see "Tauri desktop mode" below.

What it proves (evidence in `evidence/`, details in `SPIKE.md`):

- Real Relay channels, DMs, history, composer send, and live updates render in the Buzz UI (`evidence/00`–`04`).
- Room altitude: the timeline shows only final prose from humans and agents. Each agent reply carries a run pill (duration, tool count, files touched). Clicking it opens the agent run view with the full tool trace, diffs, reasoning, and a runs list (`evidence/05`–`07`).
- Mention autocomplete is fed by Relay's agent profile catalog and channel roster; sent mentions are routed by the hub (`evidence/08`–`09`).
- A hub connect screen (URL + PIN) replaces Nostr key onboarding (`evidence/10`–`11`).

## How it works

Buzz's React app talks to its Rust side through Tauri `invoke` calls and a WebSocket plugin. `src/relayBridge.ts` intercepts both with Tauri's own `mockIPC`, answers from the Relay hub's HTTP and WebSocket routes, and hands the UI Nostr-shaped events (channels as kind 39000/39002, rows as kind 9/40002, system rows as 40099, profiles as kind 0). Pubkeys are `sha256(senderId)`; signatures are placeholders.

Relay-specific code lives in:

- `src/relayBridge.ts` — the seam: auth, channel and message mapping, live subscription, run aggregation by `runId`.
- `src/features/agent-runs/` — run pill, run view panel, and renderers ported from Relay's frontend (`AgentDetailCard`, `ReasoningDetail`, `AssistantMarkdown`).
- `src/features/onboarding/ui/HubConnectScreen.tsx` — hub connect screen.
- `src/main.tsx` — bootstrap hook that installs the bridge before React renders.

Twelve upstream Buzz files were edited (timeline, message row, channel pane, welcome setup, agent session context). `README.buzz.md` is the original Buzz desktop README.

## Prerequisites on macOS

- Xcode Command Line Tools: `xcode-select --install`
- [Homebrew](https://brew.sh)
- Node.js 24 via nvm: `brew install nvm`, then `nvm install 24 && nvm use 24` (the repo root has an `.nvmrc`)
- pnpm: `corepack enable && corepack prepare pnpm@latest --activate`
- A running Relay hub. Either install the published package or run the repo:

```bash
# published
npm install -g relay-ide@nightly
relay-ide            # hub on http://127.0.0.1:3456; set or reset the PIN with `relay-ide pin reset`

# or from this repo
npm install && npm run dev:backend
```

The bridge signs in with PIN `4242` by default (`authenticateRelay` in `src/relayBridge.ts`). Set your hub's PIN to `4242` for the spike, or open the app with `?screen=hub-connect` and enter yours.

## Browser mode (verified)

```bash
cd apps/relay-app
pnpm install
RELAY_HUB_URL=http://127.0.0.1:3456 pnpm dev
```

Open http://localhost:1420. Vite proxies `/auth`, `/channels`, `/agent-profiles`, `/workspace-topics`, and `/ws` to `RELAY_HUB_URL` (default `http://127.0.0.1:3456`). Open `http://localhost:1420/?screen=hub-connect` for the connect screen, or `?resetDevState=1` to clear local state.

Reproduce the evidence with a hub running:

```bash
node run-spike-test.mjs      # milestone 1: boot, channels, history, send, live update
node run-slice1-test.mjs     # room altitude + run view
node run-slice23-test.mjs    # mention autocomplete + hub connect screen
```

Each script starts Vite itself, drives headless Chromium, and writes PNGs to `evidence/`. They post into a sandbox topic on your hub.

## Tauri desktop mode (unverified)

`src-tauri/` depends on seven Buzz workspace crates through `../../crates/*` paths, so it only builds inside a Buzz checkout. Overlay this directory onto the pinned Buzz commit the spike was forked from:

```bash
# Rust toolchain
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

git clone https://github.com/block/buzz.git
cd buzz && git checkout 5073e075d7e7d95558c57f24d86d5db6196491c4
rm -rf desktop
cp -R /path/to/relay-ide/apps/relay-app desktop
cd desktop
pnpm install
RELAY_HUB_URL=http://127.0.0.1:3456 pnpm tauri dev
```

Caveats: the bridge uses `mockIPC`, which was exercised only in a browser; inside a real Tauri webview it must win over the native IPC, and that has not been tested. The Rust side still contains Buzz's Nostr, keychain, voice, and local ACP code, which the kill list in `SPIKE.md` proposes removing. Expect to spend time here before the first native build succeeds.

## Known hub gaps

- `GET /channels/:id/messages` has no `principalOnly` or `runId` query parameters, so room filtering and run grouping happen client-side in `relayBridge.ts`.
- `GET /agent-profiles` returns an empty `displayName` for built-in profiles; the roster route has the names.

## Licensing

Buzz is Copyright Block, Inc. and licensed under Apache 2.0; the license text is in `LICENSE`. Files under `src/features/agent-runs/` were ported from Relay's own frontend.
