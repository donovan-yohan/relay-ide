---
name: adapter-review
description: >
  Review a PR diff that touches server/protocol-adapters/** for generality
  classification: reject copied choreography, reject generalized quirks, and
  check the "Adapter generality:" PR-body line is truthful. Use when reviewing
  or preparing an adapter change, when the user says "review this adapter PR",
  "adapter review", or when a diff adds/edits a ProtocolAdapterV2 adapter.
---

# Adapter review

Review step for any PR touching `server/protocol-adapters/**`. About half of
that directory is choreography repeated across adapters with known drift, so
the reviewer's job is to check the author's QUIRK-vs-CHOREOGRAPHY call, not
just the code.

Background: `.chalk/skills/add-provider/SKILL.md` § Editing existing adapters.

## Checklist

1. **Copied choreography.** Does the diff add logic that already exists in a
   sibling adapter? Grep the other adapters for the concern. If it is the third
   copy of the same shape, reject: route it through
   `server/protocol-adapters/adapter-utils.ts` and have the callers use it.
2. **Generalized quirk.** Does the diff lift harness-specific behavior into
   shared code? Event vocabularies, protocol handshakes, resume-id names, and
   permission-mode flags stay adapter-local. Reject shared helpers that carry a
   provider name or a provider-shaped branch.
3. **The `Adapter generality:` line.** A PR-body line must start with it and it
   must be true. CI checks presence — and accepts an
   `adapter-generality-reviewed` label instead — so accuracy is yours: a line
   claiming "quirk" over a diff that duplicates a sibling's lifecycle is a
   reject, and a label with no classification behind it is worse.
4. **Honest capabilities.** Resume, queue, approvals, questions, images, and
   env-refresh flags in `server/protocol-adapters/index.ts` must still match
   what the adapter actually does. A capability toggled to make a test pass is
   a defect.
5. **Stable-id and never-drop invariants.** Native ids stay stable across the
   run; deterministic fallbacks only where no native id exists. No path may
   swallow a native event without emitting a patch or a logged reason.
6. **Scatter sites.** If the diff adds or renames a provider, confirm the sites
   outside the adapters directory moved with it: the resume-id ladder in
   `server/channel-agent-runtime.ts` and the launch contracts plus capability
   sets in `server/protocol-adapters/index.ts`.

## Verdicts

- Correct classification, shared code untouched → approve.
- Copy N+1 of an existing shape → request shared-utils routing.
- Quirk pushed into shared code → request it stays local, with the reason in
  the PR body.
- Missing or false `Adapter generality:` line → request the honest one before
  reading further.

Do not ask for a broad extraction pass. Mass extraction of repeated
choreography is sequenced behind an adapter conformance suite; a review is not
the place to start it.
