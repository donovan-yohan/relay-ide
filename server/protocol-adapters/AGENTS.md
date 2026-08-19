# server/protocol-adapters

One `ProtocolAdapterV2` per provider, registered in `index.ts` (`v2Adapters`,
`CHANNEL_ADAPTER_LAUNCH_CONTRACTS`). No conversation identity, history, routing.

> Map, not manual. Keep under 60 lines. `CLAUDE.md` symlinks to this file.

## Quirk vs choreography

Much of this directory is choreography once repeated per adapter, so every edit
is a classification — audit the siblings for the concern before landing it:

- **QUIRK** — harness-specific: event vocabularies, protocol handshakes,
  resume-id names, permission-mode flags, availability probes. Stays
  adapter-local and is **never** copied to a sibling harness for symmetry.
- **CHOREOGRAPHY** — provider-agnostic sequencing: turn lifecycle, patch
  emission order, teardown, env sanitizing, stream framing. Goes through the
  shared layer (`adapter-utils.ts`, `wire-values.ts`, `provider-env.ts`,
  `../line-framer.ts`, `../utils.ts`), never a third hand-written copy.

Default posture is quirk containment. Propagating a fix into a sibling needs
proof of the same behavior, not the same-looking code, and a hook per
difference is not sharing: extract only what is already identical.
`reconnect()` and the turn-started/turn-completed patches qualify; the
user-message item and live-state payload do not — key order, attachment rules,
and arity differ per adapter. Providers sharing ONE wire vocabulary share it
from a provider-scoped module (`opencode-shared.ts`, `pi-rpc-shared.ts`), never
`adapter-utils.ts`, whose doc comments hold the turn-lifecycle rationale:
`createTurnQueue`'s one settlement semantic (settle on turn START, reject a
failed start, keep draining), plus `AdapterProcessRegistry` and claude-only
`TurnGuardrails` — clocks and policy, never child kills or patches.

## Fidelity invariants

- Native event to `AgentPatchV2` mapping is deterministic: same in, same patch.
- Native ids (turn, item, session) stay stable across a turn and across resume.
- Never drop. An unmapped native event is a logged gap, not silence.
- Capability flags are honest. A flag whose patch cannot render stays `false` —
  see the `telemetry: false` note on `hermes` in `index.ts`.

## One descriptor, no scatter sites

`index.ts` `PROVIDER_DESCRIPTORS` is the single home for every provider fact
code outside this directory needs by name: fill in a row, never re-derive it in
the consumer. A descriptor without an adapter, or the reverse, is a COMPILE
error; `test/provider-registry-drift.test.ts` holds each consuming seam to the
record. Claude-flavored defaults are NAMED fields (`yoloPermissionMode`); env
keys are constants in `provider-env.ts`, read by BOTH
`launch.processEnvDenylist` and `buildChildEnv`.

## Sequencing and PR rule

Extraction is gated on the conformance suite
(`test/server/protocol-adapters/conformance/`), the arbiter that a rewrite did
not reshape a harness: red means revert the step, never loosen the fixture.
Every PR here states its classification in a body line starting with `Adapter
generality:`, or takes `adapter-generality-reviewed`; CI checks the line,
reviewers validate the claim. Tests: `test/server/protocol-adapters/`. See
`docs/provider-guide.md`, `/add-provider`, `/adapter-review`.
