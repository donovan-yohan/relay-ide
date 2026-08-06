# Project sidebar creation design QA

- Source visual truth: `/home/donovanyohan/.codex/attachments/cecede37-1181-469d-97cc-f0c96860e928/codex-clipboard-ab88af3f-b066-4503-910b-7f932b0060d0.png`
- Desktop implementation: `sidebar-project-create.png`
- Mobile implementation: `sidebar-project-create-mobile.png`
- Source pixels: 520 x 386 at source density.
- Desktop capture: 240 x 720 element capture from a 1280 x 720 CSS viewport at device scale 1.
- Mobile capture: 390 x 844 element capture from a 390 x 844 CSS viewport at device scale 1.
- State: dark theme, populated project groups expanded, project-scoped add actions enabled.

## Full-view comparison evidence

The source and desktop implementation were opened together in one visual comparison. The implementation preserves the source's compact monochrome TUI rail, lowercase project and direct-message headings, square controls, mono typography, border rhythm, and muted hierarchy. The requested control change is visible on every real project: the fold control is now a left chevron, while the right edge is reserved for the add action.

The source is a cropped production rail at a different width and content state, so geometry was judged at the component level rather than by overlaying the full frames. No density normalization was needed because typography, spacing, controls, and borders were judged in CSS-pixel element captures rather than against browser chrome.

## Focused region comparison evidence

The project header rows were legible in the combined comparison and did not require a second crop. The implementation shows three independent targets in the expected order: chevron, project title, add. The add action remains pinned right, and the title truncation region remains flexible. Desktop and mobile captures both preserve that order.

## Required fidelity surfaces

- Fonts and typography: existing Relay mono tokens, lowercase labels, weights, line heights, truncation, and muted hierarchy are preserved.
- Spacing and layout rhythm: the chevron uses the fixed left icon slot; add uses the right action slot; project rows remain aligned with channel and direct-message sections; radii remain zero.
- Colors and visual tokens: existing background, border, muted text, accent hover/focus, and status tokens are reused.
- Image quality and assets: no raster assets were introduced. Chevron and plus use the existing Lucide icon dependency with consistent stroke weight.
- Copy and content: accessible labels name the exact target project (`collapse`, `expand`, and `start a chat in …`); the global composer labels its destination selector `project`.

## Interaction evidence

- Desktop chevron changed `aria-expanded` from `true` to `false`, then restored the group without invoking add.
- Mobile chevron changed `aria-expanded` from `true` to `false`, then restored the group.
- Desktop and mobile add controls exposed `start a chat in Relay workspace`.
- The browser fixture produced four expected 401 resource errors from optional authenticated backend requests because the isolated QA backend had no PIN session. The seeded rail rendered normally; there were no JavaScript exceptions or component render errors.

## Comparison history

1. Initial review found no visual P0/P1/P2 mismatch. No visual fix iteration was required.

## Findings

No actionable P0/P1/P2 visual findings remain.

## Follow-up polish

None required for this change.

final result: passed
