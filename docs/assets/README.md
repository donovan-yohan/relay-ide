# README assets

**Status: empty. The README has no screenshots and needs them before a public
`@latest` push.** This file specifies what to capture so the shots are
consistent and safe to publish.

They are deliberately not committed as placeholders — a broken image on the npm
landing page is worse than no image. Capture them from a real hub, then add the
image references to `README.md` above "What is built".

## Required shots

| File                   | Surface                                                                                                                                             | Viewport   |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| `channel-timeline.png` | A channel mid-conversation: sidebar with a few channels, a human message, an agent reply, one expanded diff or output detail card, the presence row | 1440 × 900 |
| `mobile-cockpit.png`   | The same channel on a narrow viewport with the composer visible                                                                                     | 390 × 844  |

Optional, if they earn their space: the two-section search results, and the
message hover toolbar showing copy-link/edit/delete.

## Capture rules

Capture from a **real hub with a real conversation**. Do not use
`test-channel-timeline.html` — its fixture rows read `timeline row 21` and would
misrepresent the product.

Before capturing, check the frame for anything that should not be public:

- absolute filesystem paths containing a real username
- hostnames, tailnet addresses, node names, PINs, tokens
- private repository names, branch names, issue titles
- anything in a diff card that is not from a public repo

Prefer capturing against a public repository so diff and output cards are safe
by construction.

## Conventions

- Dark theme only — Relay is dark-only (#1174).
- PNG, 2x device pixel ratio, then compress.
- Keep each file under ~400 KB — they live in git and are fetched from GitHub
  when npm renders the README; they are not packed into the tarball
  (`files` is `dist/` + `scripts/`).
- No annotations, arrows, or drop shadows. The UI is the screenshot.
- Recapture when the channel surface changes shape, not on every release.
