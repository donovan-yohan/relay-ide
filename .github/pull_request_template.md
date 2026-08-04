## What

<!-- 1-2 lines: the user-visible change, not the implementation. -->

## Why

Refs #

## Checklist

- [ ] `CHANGELOG.md` `[Unreleased]` entry added, or the literal phrase "no user-visible change" stated in this body (CI checks it on `server/`, `frontend/`, `shared/` diffs; the `no-user-visible-change` label works too)
- [ ] Docs updated — name which (`AGENTS.md` / `docs/*.md` / `DESIGN.md`) — or "none needed" stated here
- [ ] Tests added/updated, with the decisive command under Verification
- [ ] New HTTP route → added to `AUTH_ROUTE_LANE_INVENTORY` (`server/auth.ts`) and `test/auth.test.ts`
- [ ] New gateway verb → `scopeKinds` set in `shared/relay-command-manifest.ts`
- [ ] UI change conforms to `DESIGN.md`

## Verification

<!-- Decisive line(s): exact command and result on this head.
     e.g. `npm run check` -> 0 errors; `npx vitest run test/channel-agent-bridge.test.ts` -> 24 passed -->
