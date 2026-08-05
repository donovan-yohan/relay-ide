# README assets

**Status: captured.** The README embeds every file in this directory. This file
records what each one shows, how it was produced, and the rules a recapture has
to keep.

Nothing here is a placeholder — a broken image on the npm landing page is worse
than no image. Capture from a real hub, then keep the references in `README.md`
above "What is built".

## Committed assets

| File                   | Surface                                                                                                                                             | Viewport / size    |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| `channel-timeline.png` | A channel mid-conversation: sidebar with a few channels, a human message, an agent reply, one expanded diff or output detail card, the presence row | 1440 × 900 @2x     |
| `mobile-cockpit.png`   | The same channel on a narrow viewport with the composer visible                                                                                     | 390 × 844 @2x      |
| `agents-collab.gif`    | One channel where Claude Code, Codex, and Hermes all answer the same standup prompt: three thinking rows, then three replies                        | 960 px wide, 10fps |
| `agents-collab.mp4`    | The same clip as h264, for the GitHub Release page and anywhere a GIF is the wrong container                                                        | 1440 × 900         |

Optional, if they earn their space: the two-section search results, and the
message hover toolbar showing copy-link/edit/delete.

## How these were captured

A throwaway hub (temp config dir, loopback-only port, PIN discarded with the
directory) seeded with:

- one project — a scratch `demo-app` git repo with a planted post-login redirect
  bug, so every path in a diff or output card is a temp path with no username in
  it;
- four channels plus a `@claude` DM, a few of them left unread so the sidebar
  shows real unread state;
- **real agent turns.** Claude Code, Codex, and Hermes were spawned by the hub
  and answered for themselves. Nothing in these frames is mocked, and no fixture
  page was used.

Two isolation details worth repeating on a recapture: the hub was started with
`CLAUDE_CONFIG_DIR` and `CODEX_HOME` pointed at temp directories holding only
credentials. Without that, the operator's own global agent config (hooks, house
style, personal instruction files) leaks into the demo — in the first take,
Codex read `~/.codex/RTK.md` and put the operator's home path on screen.

Playwright drove Chromium: `deviceScaleFactor: 2` for the PNGs, `1` plus
`recordVideo` for the clip, `colorScheme: 'dark'` throughout. The clip was
trimmed and sped up 1.6× with ffmpeg, then palette-optimised
(`palettegen`/`paletteuse`) for the GIF.

## Capture rules

Capture from a **real hub with a real conversation**. Do not use
`test-channel-timeline.html` — its fixture rows read `timeline row 21` and would
misrepresent the product.

Before capturing, check the frame for anything that should not be public:

- absolute filesystem paths containing a real username
- hostnames, tailnet addresses, node names, PINs, tokens
- private repository names, branch names, issue titles
- anything in a diff card that is not from a public repo

The hostname-derived default workspace lane counts: rename or archive it before
capturing. Prefer a scratch or public repository so diff and output cards are
safe by construction.

## Conventions

- Dark theme only — Relay is dark-only (#1174).
- PNG, 2x device pixel ratio, then compress. Keep each PNG under ~400 KB.
- Motion assets get a looser budget because there is no still that shows three
  agents answering at once: keep the GIF under ~4 MB and the MP4 under ~2 MB.
  They live in git and are fetched from GitHub when npm renders the README; they
  are not packed into the tarball (`files` is `dist/` + `scripts/`).
- No annotations, arrows, or drop shadows. The UI is the screenshot.
- Recapture when the channel surface changes shape, not on every release.
