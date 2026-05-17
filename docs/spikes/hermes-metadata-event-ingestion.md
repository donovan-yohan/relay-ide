# Hermes metadata event ingestion spike (#556)

Status: spike handler implemented, route deferred.

## Decision

Relay should accept Hermes Agent integration data only as bounded metadata events. The shared contract lives in `shared/hermes-metadata-events.ts` and is deliberately narrower than a generic payload envelope:

- required identity: `eventId`, `schemaVersion`, timestamp, Hermes source profile/runtime, actor, event kind, and status;
- work linkage: `workContextId`, task refs, node/session/cwd anchors, optional repo/worktree/project refs;
- bounded work evidence: child session refs, tool summaries, artifact refs, and audit hints;
- privacy/retention: every event and artifact carries `WorkContextPrivacyMetadata` with `rawPayloadStored: false` by default.

The spike intentionally does not mount a public ingestion endpoint yet. That keeps the privacy boundary reviewable before adding auth, storage, rate limits, and replay semantics. yeah, shipping a route before proving the filter would be how the cursed sqlite-scraper gremlin gets in.

## Explicitly rejected by the validator

The spike handler rejects events containing raw/secret/transcript-shaped keys anywhere in the object tree, including:

- env and process environment shapes;
- provider auth, bearer/API token shapes;
- raw payload/content/log/stdout/stderr/scrollback fields;
- transcript, conversation, or messages fields;
- Hermes profile DB path / SQLite DB path fields;
- events or artifacts with `privacy.rawPayloadStored: true`.

This is intentionally conservative. If a future Hermes plugin needs a raw payload exception, it should be a separate privileged capability with explicit operator policy, not a default metadata ingestion behavior.

## Fixture coverage

Fixtures live under `test/fixtures/hermes-metadata-events/`:

- `session-lifecycle-started.json` proves lifecycle status, task refs, node/cwd/repo/worktree links, artifact refs, and privacy metadata;
- `tool-summary.json` proves compact tool result metadata;
- `child-session-linked.json` proves parent/child session linkage;
- `artifact-recorded.json` proves PR/diagnostic artifact refs without raw evidence blobs.

`test/hermes-metadata-events.test.ts` validates all fixtures and rejects malformed unsafe payloads.

## Next implementation recommendation

Open a follow-up issue to add an authenticated server route, probably `POST /integrations/hermes/events`, that calls `ingestHermesMetadataEventCandidate()` and persists only accepted metadata into the future WorkContext/audit store.

Minimum route requirements before merge:

1. Auth: localhost/plugin token or hub policy grant; never browser PIN cookies alone for agent plugin ingestion.
2. Storage: append accepted event metadata only; no raw payload/blob table.
3. Replay/idempotency: de-duplicate by `eventId` plus source profile/runtime/run/session.
4. Privacy audit: preserve `privacy`, redaction class, retention class, and artifact pointer metadata.
5. Backpressure: size cap and rate limit before JSON parse can become a footgun.
6. Tests: keep the current fixture tests and add route tests for accepted event, duplicate event, unauthenticated event, oversized body, raw env, secret key, and transcript-shaped body.

Do not implement raw Hermes DB sync, Hermes memory-provider behavior, provider auth/env capture, or raw transcript export as part of this lane.
