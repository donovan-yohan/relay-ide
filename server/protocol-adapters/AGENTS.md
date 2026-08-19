# server/protocol-adapters

One `ProtocolAdapterV2` implementation per provider, plus its registration in
`index.ts` (`v2Adapters` factory and `CHANNEL_ADAPTER_LAUNCH_CONTRACTS`).
Nothing here owns conversation identity, history, or routing.

> Map, not manual. Keep under 60 lines. `CLAUDE.md` symlinks to this file.

## Quirk vs choreography

About half of this directory is choreography repeated across adapters, with
known drift. Every edit to one adapter is therefore a classification, and you
must audit the sibling adapters for the same concern before landing it:

- **QUIRK** — harness-specific: event vocabularies, protocol handshakes,
  resume-id names, permission-mode flags, availability probes. Stays
  adapter-local and is **never** copied to a sibling harness for symmetry.
- **CHOREOGRAPHY** — provider-agnostic sequencing: turn lifecycle, patch
  emission order, teardown, env sanitizing. Goes through the shared utils layer
  (`adapter-utils.ts`, `../utils.ts`), never a third hand-written copy.

Default posture is quirk containment. Propagating a fix into a sibling needs
proof of the same underlying behavior, not the same-looking code. `reconnect()`
matches across claude, codex-native, hermes, and opencode apart from the
not-connected wording the shared helper parameterizes; pi-agent and prime-agent
fold `providerSessionId` into config — a config-transform hook, not a copy.

## Fidelity invariants

- Native event to `AgentPatchV2` mapping is deterministic: same in, same patch.
- Native ids (turn, item, session) stay stable across a turn and across resume.
- Never drop. An unmapped native event is a logged gap, not silence.
- Capability flags are honest. A flag whose patch cannot render stays `false` —
  see the `telemetry: false` note on `hermes` in `index.ts`.

## Scatter sites a new or renamed provider must also touch

- `server/channel-agent-runtime.ts` `providerResumeId` — the resume-state ladder
  maps `providerId` to a resume key. **Missing it fails silently**: the provider
  connects, then loses resume with no error.
- `index.ts` — launch contract (`command` / `gateway` / `embedded`) and, for
  bridged adapters, the hand-transcribed capability set.
- `server/utils.ts` `cleanEnv` plus `index.ts` `sanitizeChannelAdapterProcessEnv`
  own env stripping. Provider-specific keys go in the contract's
  `processEnvDenylist`, never at spawn sites.

## Sequencing

No mass choreography extraction until an adapter conformance suite exists —
without it a shared rewrite silently reshapes five harnesses at once. Small
helpers proven identical may move into `adapter-utils.ts` with tests now.

## PR rule

Every PR touching this directory states its classification in the body on a line
starting with `Adapter generality:`, or takes the `adapter-generality-reviewed`
label. CI checks for the line; reviewers validate the claim, not its presence.
Tests live in `test/server/protocol-adapters/`. See `docs/provider-guide.md`,
`/add-provider`, `/adapter-review`.
