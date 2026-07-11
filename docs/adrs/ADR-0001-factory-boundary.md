# ADR-0001: keep the factory liveness-only

- **Status:** accepted
- **Date:** 2026-07-11

## Context

The reboot needs a runnable seam before product systems exist. An early HTTP endpoint can accidentally acquire ambient authority if it exposes configuration, paths, processes, provider state, or authentication details.

## Decision

The hub exposes only `GET /health`; the node exposes only a matching local `probe` command. Each returns a versioned, fixed-shape liveness record containing service identity and no operational state. Configuration accepts only the expected identity, bounds input to 32 bytes, and returns typed errors without reflecting raw input.

## Consequences

The PWA can prove a real hub boundary without becoming a workbench. Future runtime, authentication, persistence, or control surfaces require a new ADR and an accepted GitHub issue.
