# Repository context map

This map provides stable, public-safe references for pipeline handoff and
adversarial-review artifacts. The anchor names below are the only context-map
references accepted by the canonical handoff validator. They identify seams,
not ownership claims: confirm the current tree and decisive tests before
changing behavior.

## Channel routing

- Owner seams: `server/channel-chat-router.ts`, `server/channel-hub.ts`, and
  `server/channel-agent-binder.ts`.
- Protocol contracts: `shared/channel-chat-protocol.ts`.
- Decisive tests: `test/channel-routes.test.ts`,
  `test/channel-agent-binder.test.ts`, and `test/channel-hub.test.ts`.

## Durable bindings

- Owner seams: the binding schema/store in `server/channel-hub.ts` and runtime
  designation in `server/channel-agent-binder.ts`.
- Decisive tests: `test/channel-hub.test.ts`,
  `test/channel-agent-binder.test.ts`, and route-level binding cases in
  `test/channel-routes.test.ts`.
- Invariant: durable uniqueness belongs in SQLite; in-process serialization is
  only the runtime-spawn backstop.

## Provider adapters

- Owner seams: `server/protocol-adapter.ts`, `server/protocol-adapters/`, and
  `server/channel-agent-runtime.ts`.
- Provider configuration: `server/config.ts` and `docs/provider-guide.md`.
- Decisive tests: `test/server/protocol-adapters/`,
  `test/channel-agent-runtime.test.ts`, and provider launch-contract tests.

## Message storage and context

- Owner seams: `server/channel-message-store.ts`,
  `server/channel-context-packet.ts`, and `server/channel-attachments.ts`.
- Decisive tests: `test/channel-message-store.test.ts`,
  `test/channel-context-packet.test.ts`, and `test/channel-mention-e2e.test.ts`.
- Fixtures: `test/fixtures/channel-chat/`.

## Frontend chat surfaces

- Owner seams: `frontend/src/components/chat/` and
  `frontend/src/hooks/useChannelChatSocket.ts`.
- Decisive tests: `test/components/`, `test/channel-thread-e2e.test.ts`, and
  `test/e2e/channel-*.spec.ts`.
- Visual changes must also follow `DESIGN.md`; browser claims require browser
  evidence rather than component tests alone.

## Test fixtures

- Test policy and commands: `docs/QUALITY.md` and `package.json`.
- Canonical fixtures live under `test/fixtures/`; do not place runtime state or
  machine-specific paths in fixtures.
- Handoff fixtures: `test/fixtures/pipeline-handoff/`.

## CI and release evidence

- Hosted checks: `.github/workflows/ci.yml`.
- Publication: `.github/workflows/publish.yml` and
  `docs/references/deployment.md`.
- Risk doctrine: `docs/risk-contract.json` (not an executable gate until a
  consumer is installed).
- Hosted CI must validate repository-visible evidence and must not query or
  reconstruct Relay runtime state.

## Handoff evidence

- Canonical schema and validator: `shared/pipeline-handoff-artifact.ts`.
- Durable index/payload store: `server/work-context-artifacts.ts`.
- API/CLI surface: `server/features/work-context-artifact-router.ts` and the
  `handoff-artifacts` CLI verbs.
- Decisive tests: `test/pipeline-handoff-artifact.test.ts`,
  `test/work-context-artifacts.test.ts`,
  `test/work-context-artifact-router.test.ts`, and
  `test/pipeline-handoff-timeline.test.ts`.
- `supersedesArtifactId` is canonical in the payload; request metadata is a
  compatibility assertion. Successors retain the same head and immutable root,
  preserve every prior stage, and append at least one new stage.
