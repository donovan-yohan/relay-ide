# ADR-0003: persist Workspace layout as bounded presentation-only references

- **Status:** accepted
- **Date:** 2026-07-12

## Context

Issue #1139 requires one operator-visible Workspace that can be reopened and arranged in tabs and panes without coupling presentation changes to the Node-owned Session lifecycle. The existing Session seam is intentionally direct-PTY/owned-runtime and provider-neutral at its public boundary. The PWA has only the hub liveness boundary, so it cannot truthfully issue Session control commands.

## Decision

The PWA stores one local Workspace binding (one Node identity and approved local root) plus a versioned layout tree in browser storage. The tree has explicit caps: depth 3, four panes, six tabs, 256-character Workspace metadata, and 128-character opaque Session references. Layout content contains opaque Session references only; splits create another reference to the same ID, never a Session. Runtime availability is never persisted and is checked afresh through the existing `/health` liveness record.

Malformed, unsupported-version, invalid/cap-exceeding, and overlong saved trees recover to a deterministic default with a visible recovery message. Closing or moving a pane and showing or hiding a tab strip are presentation mutations. Session input and end actions remain distinct Node/runtime authority and are not exposed by this PWA slice.

## Consequences

The PWA can prove stable Session identity before and after layout changes without creating a Session API, terminal implementation, file browser, cross-node Workspace, provider adapter, or browser-control surface. A later accepted Session-control issue must add its own Node-bound authority contract; it must not reuse the layout persistence path as a capability channel.
