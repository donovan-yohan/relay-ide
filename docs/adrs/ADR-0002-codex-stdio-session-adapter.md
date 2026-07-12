# ADR-0002: supervise Codex only through local app-server stdio

- **Status:** accepted
- **Date:** 2026-07-11

## Context

Issue #1140 needs a native Codex Session seam after the liveness-only factory
foundation. The installed Codex CLI exposes experimental app-server transports,
including stdio and transports that could become network/socket control paths.
A Relay adapter that chooses a network path, retains raw provider output, or
silently answers approvals would acquire unreviewed authority.

## Decision

The node supervises one local `codex app-server --stdio` child per Session. The
adapter uses bounded JSONL/JSON-RPC framing, fixed stdio argv, process reaping,
finite control deadlines, ordered neutral events, redacted bounded diagnostics,
and bounded queues. Network/socket flags and transport selections are rejected
by an executable negative probe.

The generic Session contract keeps identities, statuses, events, stream signals,
and a small per-request approval seam provider-neutral. Only current documented
command/file approval requests can be surfaced and explicitly answered once.
Persistent grants, policy changes, unknown server requests, and legacy approval
shapes are unsupported/degraded rather than guessed or auto-approved.

## Consequences

Relay can truthfully create, resume, prompt, cancel, and observe a local Codex
Session without creating a generic adapter platform, browser control, provider
state copy, cross-node routing, or transcript store. Process recovery is
explicit close/reap plus a new create/resume; automatic restarts and approval
persistence require later accepted scope.
