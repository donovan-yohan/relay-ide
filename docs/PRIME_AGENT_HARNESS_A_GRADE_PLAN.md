# Prime Agent handoff: make the delivery harness A/A+

## Executive verdict

The seven merged changes were productive, mostly coherent, and backed by a
substantial amount of targeted testing. They are not A/A+ delivery yet because
the campaign's correctness checks were stronger than its independent-review
and invariant-enforcement loop. The most important improvement is not a more
elaborate prompt: it is a small executable harness that binds a work packet,
review artifact, findings, and final verification to one exact Git head.

This is a forward-looking handoff, not a claim that any particular public
GitHub identity was Prime Agent. It covers the observed `nightly` commits for
PRs #1360, #1362--#1367 and proposes repository work for Prime Agent to carry
out in subsequent, separately reviewed slices.

## What the merged campaign did well

- It kept most changes within existing module seams and added focused tests.
- #1362 and #1367 added fixture-backed Chromium evidence for narrow mobile
  layout claims rather than relying only on component tests.
- #1363 used profile/provider-aware adapter code and tested launch preflight
  paths.
- #1364 added bounded mention-context assembly and query-plan-oriented storage
  coverage.
- #1365 persisted the orchestration role rather than treating an ephemeral
  runtime as the durable source of truth.
- #1366 introduced a provider-neutral reasoning-detail UI with state-specific
  rendering and tests.

Those are the ingredients of good work. The missing ingredient is a repeatable
way to force the next agent to test the defining invariant and to obtain an
independent adversarial verdict before it can call the work complete.

## Findings from the seven PRs

| PR    | Observed result                                                                  | What kept it below A/A+                                                                                                                                                                                                                                                                                                                                                                                                   | Required upgrade                                                                                                                                                                                                                                        |
| ----- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #1360 | Designation errors became visible and accessible in `ChannelView`.               | The conflict test supplies both the top-level `SESSION_CONFLICT` and nested `CHANNEL_ROLE_CONFLICT`; it does not independently prove the nested-reason branch. The later #1367 repair also shows the original mobile/error-state proof was incomplete.                                                                                                                                                                    | Split the nested-only and unknown-409 fixtures; retain the already-covered top-level-only and retry cases. Add a 320px browser retry assertion only if making that end-to-end claim.                                                                    |
| #1362 | Composer growth received unusually good browser geometry/hit-target proof.       | The implementation quality was high, but the process did not record an independent review artifact tied to the final head.                                                                                                                                                                                                                                                                                                | Preserve the browser artifact and require a fresh independent review verdict on the same SHA.                                                                                                                                                           |
| #1363 | Profile launch command preflight was strongly typed and tested across adapters.  | The key contract is a provider/profile matrix; no reusable matrix/eval contract makes it easy for a future provider to bypass the same preflight.                                                                                                                                                                                                                                                                         | Encode the profile/provider launch matrix as a shared test helper and require new adapters to satisfy it.                                                                                                                                               |
| #1364 | Mention context now keeps prose text-only and applies row/byte limits.           | The `buildChannelMentionContextCountSql`/mention-context storage seam examines the full cursor range, including text/JSON predicates. On a long channel that synchronous SQLite work can still monopolize the Node event loop; the current tests prove result shape, not an explicit work budget. Its final head `28fa03b` also differs from reviewed head `0611d507`, so the recorded review cannot be exact-head proof. | Add a deterministic cost boundary (candidate cap, indexed prefilter, or refusal/degraded result), telemetry, a pathological-history test that proves the boundary rather than a machine-dependent latency number, and a fresh review for the final SHA. |
| #1365 | Bare posts route to a durable designated orchestrator and cold-resume correctly. | The public designation route can persist another orchestrator role. `designatedOrchestratorProfile` then sees multiple matches and deliberately refuses to choose, silently skipping bare-post routing. This violates the one-designated-orchestrator invariant.                                                                                                                                                          | Make designation atomic: either replace the prior designation in one store transaction or reject a second profile with a stable conflict. Add route-level sequential and concurrent designation tests plus an invariant query test.                     |
| #1366 | Reasoning details are provider-neutral and expose terminal state.                | `pending` falls through to the cancelled status CSS class despite an existing pending class. Its final head `97d4b2d` differs from reviewed head `0f45c22f`; a later recheck only reported that it was running, not a final verdict on the final head.                                                                                                                                                                    | Map `pending` to the existing pending class and add an exhaustive state-to-class table test. Require a fresh completed review on the final SHA.                                                                                                         |
| #1367 | The designation error was bounded and validated at 320px.                        | It repaired defects found after #1360's merge, demonstrating that the review outcome was not reliably closed on the original head.                                                                                                                                                                                                                                                                                        | Make the first broad review and one focused re-review mandatory, recorded, and exact-head-bound before merge.                                                                                                                                           |

### Code-level acceptance additions

These are small corrective follow-ups, not a request to rewrite the campaign.

1. **#1360/#1367:** in `test/components/channel-view-orchestrator.test.ts`,
   use separate cases for a nested-only `CHANNEL_ROLE_CONFLICT` and an unknown 409. The top-level-only `SESSION_CONFLICT`, error clearing on retry, and a
   second retry are already covered. Add a 320px browser retry only if it is
   intended as a new end-to-end claim.
2. **#1363:** centralize the launch-command preflight contract in one table
   consumed by every native/attached adapter test. The matrix must cover:
   missing command, empty command, unavailable executable, valid executable,
   profile override, built-in default, and provider-specific environment
   sanitation. A new provider without every required row must fail its test.
3. **#1364:** at the `buildChannelMentionContextCountSql`/mention-context
   storage seam, export a named cost policy such as
   `MENTION_CONTEXT_CANDIDATE_SCAN_BUDGET`. Test the exact refusal/degradation
   behavior with more candidates than that budget, and emit only safe counts
   and channel IDs in a structured warning. Do not make CI depend on elapsed
   milliseconds.
4. **#1365:** add a storage API whose name states the invariant, for example
   `designateSoleOrchestrator(...)`, rather than allowing generic upserts to
   construct invalid durable state. Back it with a transaction and a partial
   unique index or equivalent transactional enforcement. Test sequential
   replacement/rejection, two in-flight requests, hub restart, and bare-post
   routing after each outcome.
5. **#1366:** replace the ternary fallback with an exhaustive status-to-class
   map that maps `pending` to the existing pending class. Type the map against
   the status union so a new status cannot inherit the cancelled class.

## Root cause: doctrine is ahead of executable backpressure

Relay already states the right intentions:

- `AGENTS.md` calls for one adversarial review, a batched fix pass, a focused
  re-review, and exact-head evidence.
- `docs/REVIEW_GUIDANCE.md` supplies a useful question bank.
- `docs/risk-contract.json` describes risk tiers, required checks, remediation
  attempts, and a review provider.
- `docs/pipeline-handoff-artifact-template.md` already supplies a durable,
  append-only, exact-head evidence contract.

The current checkout does not contain an executable consumer for the
`risk-contract.json` fields such as `risk-policy-gate`, `code-review-agent`,
`maxRemediationAttempts`, or `pr:review`; `.github/workflows/ci.yml` currently
runs type-check, build, changed-file lint, unit tests, and smoke E2E only.
The listed risk paths are also stale for the present TypeScript tree (for
example `server/auth.js`, `server/ws.js`, and `public/**`). As a result, the
review configuration is valuable doctrine but cannot presently block a merge
or demonstrate that it ran.

The repository also lacks a first-class agentic cycle command, a tracked
context map, and PR-template fields for intent, risk seams, harness, review
identity, and reviewed SHA. Existing test/build gates are real and useful, but
they cannot determine whether the defining invariant was identified, whether a
separate model reviewed it, or whether the review was invalidated by a later
push.

## Target operating model

The following division is deliberate.

| Doctrine (guidance)                                                   | Executable harness (can fail)                                                                                                                                                                                                                                                     |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Review question bank, model prompts, examples, and role descriptions. | A local pre-merge validator that parses the work packet and canonical handoff artifact, verifies `git rev-parse HEAD`, classifies changed paths, and rejects stale/missing evidence.                                                                                              |
| The rule that a channel has one orchestrator.                         | A store-level invariant and route-level sequential/concurrent tests.                                                                                                                                                                                                              |
| The rule that expensive gates follow adversarial review.              | A local cycle runner that refuses full gate/release mode until the required review artifact is accepted for the current head.                                                                                                                                                     |
| The rule that reviews are independent.                                | Artifact fields for immutable implementer/reviewer actor, session, and run IDs, context digest, changed-range digest, findings, verdict, and conflict-of-interest declaration; validator rejects equal implementation/reviewer identities. Provider/model are informational only. |
| The rule that comments are triaged.                                   | A required disposition for every finding and a validator that rejects unresolved P0/P1 or evidence-free dismissals.                                                                                                                                                               |

Do not build a parallel evidence database. Extend the existing
`PipelineHandoffArtifact` review stage and publish/inspect it through the
existing `handoff-artifacts attach`, `list`, `show`, and `copy` surfaces. Use
the existing `pr-overseer` record as the local PR-level observation/closure
ledger only when a Relay hub, authentication, and WorkContext are provisioned.
The local gate must resolve Relay-minted global session/run provenance through
the trusted registry and validate the actor's ownership/authoring relationship.
Without that resolution, identity fields are merely auditable declarations,
not enforcement. GitHub-hosted CI must not query the hub directly. Instead, an
external independent-review GitHub App or workflow must create a bounded Check
Run on the reviewed `headSha` and canonical diff digest. CI validates the
trusted issuer, completed conclusion, head SHA, digest, and bounded
payload/artifact reference. Remote Relay-to-GitHub attestation is a later,
explicitly provisioned slice with a scoped service identity.

## Proposed repository changes

Implement these in small PRs; each must itself use the proposed packet and
review flow as soon as the minimum implementation is available.

### 1. Establish an executable contract

- Add `docs/context-map.md`: map channel routing, durable bindings, provider
  adapters, message storage, frontend chat surfaces, test fixtures, CI, and
  release evidence to their owner files and decisive tests.
- Extend the canonical types, validator, and tests in
  `shared/pipeline-handoff-artifact.ts` and
  `test/pipeline-handoff-artifact.test.ts`; generate any JSON schema from that
  canonical source rather than adding a second hand-maintained schema. Add an
  optional artifact-level `supersedesArtifactId` to the canonical artifact so
  append-only replacement remains visible through storage, validation, and
  summaries instead of existing only in publish metadata.
- Keep an ephemeral local work packet separate from the durable handoff
  artifact. Durable evidence may contain sanitized repository-relative globs,
  changed-file paths, opaque artifact IDs, command names, exit codes, bounded
  counts, and allowlisted context-map references. It must not contain absolute
  filesystem paths, raw command arguments, environment values, prompts,
  transcripts, logs, provider payloads, or secrets. Unredacted inputs exist only
  ephemerally for the active process and are never attached or uploaded.
- Add `scripts/risk-policy-gate.mjs`,
  `scripts/adversarial-review-gate.mjs`, and focused tests. The first validates
  current-head changed-path classification against the risk contract; the
  second validates packet/artifact fields, current SHA, stage ordering,
  reviewer independence, and finding dispositions. In local pre-merge mode it
  also validates Relay-minted global session/run IDs, trusted-registry
  ownership/authoring, and `pr-overseer` closure state. The test suite must
  include missing review, stale SHA, missing finding disposition, equal or
  registry-unresolvable actor/session/run identity, malformed JSON, stale
  path-rule fixtures, and unresolved review-thread fixtures. Provider/model
  selection is recorded but is not an identity proof.
- Add root commands in `package.json`:
  `agentic:preflight`, `agentic:review-check`, and `agentic:cycle`. They may
  compose the two gates, but each command must have a stable exit-code contract
  and be usable locally and in CI.
- Replace stale path literals in `docs/risk-contract.json` with current
  TypeScript glob rules, and add a schema/version check so unmatched rules or
  unknown rule keys fail instead of silently downgrading risk. Classification
  must evaluate every matching rule, prefer the most-specific glob, and choose
  the highest risk when equally specific rules overlap; declaration order and a
  catch-all `**` rule may never lower risk. Extend the canonical
  `PipelineHandoffRiskLevel` union to include `critical` and preserve its full
  policy, including remediation-attempt limits. Add fixtures for `server/auth.ts`,
  generated `server/auth.js`, `bin/**`, overlapping rules, and unknown paths.

### 2. Make CI enforce only what it can observe

- Add an `agentic-harness` job to `.github/workflows/ci.yml` (or a clearly
  named dedicated workflow) that runs on non-draft PRs and validates the
  current PR head, changed-path classification, PR packet fields, and the
  bounded independent-review Check Run. An external GitHub App or independent
  review workflow produces that Check Run on the reviewed head and canonical
  diff digest. The job validates the trusted issuer, completed conclusion,
  exact SHA, digest, and bounded payload/artifact reference. The issuer must be
  a dedicated GitHub App or a protected default-branch workflow with immutable
  identity, pinned action references, least-privilege permissions, and no
  execution of PR-controlled workflow code; a workflow introduced or modified
  by the reviewed PR cannot attest that PR. The job must not make a hub-backed
  `handoff-artifacts` or `pr-overseer` call without a separately provisioned
  Relay endpoint, scoped credentials, and WorkContext.
- Require a `review` artifact only for medium/high/critical changes at first;
  keep docs-only and clearly test-only work cheap. The classifier must be
  conservative: unknown paths are medium until deliberately classified.
- Make the job fail closed when the Check Run issuer is untrusted, its
  conclusion is not accepted, its SHA/digest/payload reference mismatches, a
  required review status is still pending, or a P0/P1 lacks a verified
  fix/follow-up disposition. Infrastructure unavailability is `blocked`, never
  `passed`. The local pre-merge gate also rejects a stale `pr-overseer` record,
  unresolved review threads, or unresolvable/mismatched Relay provenance when
  that optional Relay context is available.
- Preserve the existing `ci`, `e2e`, and changelog jobs. The new job validates
  process/evidence; it must not pretend to replace TypeScript, Vitest,
  Playwright, or human approval requirements.
- Upload a compact sanitized JSON report on failure and success. It should
  include head/base SHAs, classified risk, required/observed stages, verdict,
  command names and statuses, and finding counts--not raw prompts or logs.

### 3. Improve intake and visibility

Update `.github/pull_request_template.md` with compact required sections:

```md
## Intent and non-goals

## Context map and risk seams

## Harness / decisive tests

## Exact-head evidence

- base SHA:
- implementation head SHA:
- QA head SHA:
- independent review head SHA:
- canonical diff algorithm and digest:
- review artifact ID / sanitized reference:
- reviewer actor / session / run IDs:
- trusted provenance disposition:
- verdict and finding counts:
- finding disposition artifact/reference:
```

Add a `docs/references/prime-agent-delivery.md` explaining the commands, risk
classification, failure cases, and how to recover from stale evidence. Update
`docs/REVIEW_GUIDANCE.md` and `docs/references/review-agent-setup.md` to
separate what is advisory from what is CI-enforced; remove the present
implication that an unwired `pr:review` configuration is already a running
check.

### 4. Add an eval layer for recurring Relay risks

Create small, deterministic fixtures under `test/fixtures/agentic-harness/`:

- ambiguous durable-role state and duplicate designation attempts;
- large mention-context history reaching a cost boundary;
- provider/profile command matrix mutations;
- reasoning status-to-style mutation;
- mobile error-wrap and retry behavior at 320px.

Each fixture needs a named mutation that makes its target test fail. This is
the appropriate proof that the test is testing the invariant rather than just
executing code nearby.

## Cross-model adversarial review protocol

The implementing Prime Agent must delegate this pass to an independent Codex
or Claude reviewer. “Independent” means a separately created reviewer actor,
session, and run, each with immutable IDs distinct from the implementer's; it
did not author the patch or receive the author's conclusions. The same model
family is acceptable when these identities are distinct. Provider/model are
useful provenance, not independence evidence. Select Codex or Claude by role
availability and record that choice; do not hard-code either provider. The
reviewer must explicitly declare any conflict of interest; `none` is required
for acceptance, while an omitted, unknown, or non-none declaration blocks. The
reviewer may receive the work packet, changed-file list, base/head SHA, diff
digest, relevant context-map links, risk tier, and test commands; it must not
receive a pre-written claim that the patch is correct. Local enforcement also
requires trusted-registry resolution of Relay-minted global session/run IDs and
their actor ownership/authoring relationship; without it, this packet is an
auditable declaration only.

### Required review packet

```json
{
  "schemaVersion": 1,
  "role": "adversarial-review",
  "promptVersion": "adversarial-review-v1",
  "implementation": {
    "actorId": "<immutable actor id>",
    "sessionId": "<immutable session id>",
    "runId": "<immutable run id>",
    "relayGlobalSessionId": "<Relay-minted global session id>",
    "provider": "<informational provider>",
    "model": "<informational model>"
  },
  "reviewer": {
    "provider": "codex-or-claude",
    "model": "exact model identifier",
    "actorId": "<immutable actor id>",
    "sessionId": "<immutable session id>",
    "runId": "<immutable run id>",
    "relayGlobalSessionId": "<Relay-minted global session id>",
    "independentFromImplementation": true,
    "conflictOfInterest": "none"
  },
  "head": {
    "baseSha": "<merge-base SHA>",
    "headSha": "<git rev-parse HEAD>",
    "changedRange": "<baseSha>...<headSha>",
    "diffSha256": "<sha256 of canonical changed range>",
    "staleIf": { "headShaChanges": true }
  },
  "scope": {
    "intent": "<observable behavior>",
    "nonGoals": ["<bounded non-goal>"],
    "riskSeams": ["state", "concurrency", "persistence", "mobile"],
    "contextMapRefs": ["docs/context-map.md#..."],
    "commandsAlreadyRun": ["<allowlisted command name and bounded result>"]
  },
  "reviewQuestions": ["<invariant-specific question>"],
  "findings": [],
  "verdict": "pending"
}
```

The compact review-stage artifact must include the same exact `headSha`, base
SHA, diff digest, prompt version, immutable reviewer identity, explicit
conflict-of-interest declaration, trusted provenance disposition, context
digest/references, a per-finding severity and location, evidence, disposition,
final verdict, and the statement that it contains no raw transcript or secrets.
It extends the existing `review` stage. `PipelineHandoffArtifact` carries the
optional artifact-level `supersedesArtifactId`; validation and public summaries
must preserve it, and the WorkContext store must reject missing, cross-context,
or non-append-only predecessors. A chain contains implementation, QA, and
review stages for one SHA only; a replacement artifact supersedes the preceding
artifact in that WorkContext while prior-head chains remain stale history.

### Review sequence

1. Prime writes the work packet and runs the cheap local preflight.
2. Prime selects an available Codex **or** Claude reviewer by role, creates a
   distinct reviewer actor/session/run, and asks for one broad adversarial
   review of the exact range. The reviewer investigates correctness, public
   behavior, persistence, concurrency, security, performance bounds,
   accessibility, and test falsifiability; it reports only reproducible
   findings or explicit no-finding evidence.
3. Prime triages each finding once: fix, follow-up with owner/issue and
   risk-accepted rationale, or refute with direct code/test evidence. P0/P1
   cannot be dismissed as a follow-up for the same merge.
4. Prime batches all accepted fixes into one coherent patch. **If the fixes
   change HEAD**, the prior artifact chain becomes stale history and Prime
   starts a **new** chain for the new SHA with fresh implementation and QA
   stages; it must not attempt to supersede a prior-head stage because the
   current router's unique/stage constraints are same-head-only. A
   non-semantic new head may reference reusable earlier evidence with an
   explicit disposition, but it still records the delta and reruns only the
   checks/review required by that delta. If no fix changes HEAD, retain the
   current chain.
5. When HEAD changed, a reviewer (preferably the same independent reviewer)
   performs one focused re-review of the changed hunks and immediate contracts
   in the new chain. It must bind to the new SHA and diff digest; it is not a
   rubber-stamp of the old result.
6. Prime runs the required full CI/browser/device gates only after the broad
   review is triaged. The release/merge evidence references the accepted
   focused review plus the current CI artifacts.

### Stop conditions and fail-closed rules

- Stop successfully only when the **current-head chain** has implementation,
  QA, and required review stages for its SHA (with any reused earlier proof
  declared explicitly); required CI is green; no P0/P1 is unresolved; and
  required browser/device proof is present for a claim that unit tests cannot
  establish.
- A head change makes the old QA, review, and release chain stale history. It
  never permits a cross-head stage supersession: even a non-semantic delta gets
  a new implementation/QA/review chain that may cite reusable earlier evidence
  with an explicit disposition, while the validator scopes newly run commands
  and focused review to that delta.
- The reviewer being unavailable, rate-limited, timing out, returning an
  unparseable artifact, using an equal implementer/reviewer actor, session, or
  run ID, or returning a digest that does not match the range is `blocked`. It
  does not count as zero findings or permit a green review gate.
- For CI, a missing/untrusted issuer, non-accepted Check Run conclusion, or
  mismatched Check Run SHA/digest/payload reference is also `blocked`. A local
  packet without resolved Relay provenance remains an auditable declaration,
  not a passing enforcement result.
- Do not self-review. Do not let the implementation agent choose a passing
  verdict on behalf of an unavailable reviewer. Do not convert an unresolved
  high-severity finding into a “nice to have” merely to exhaust a remediation
  counter.
- One broad review, one batched remediation pass, and one focused re-review is
  the normal ceiling. Reopen broad review only for a material architecture,
  security, public-behavior, protocol, or runtime-risk change, or concrete new
  evidence invalidating the prior review.

## Phased implementation plan

| Phase                                   | Deliverable                                                                                                                              | Decisive proof                                                                                                                          |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| 0: Correct the discovered behavior gaps | Follow-up PRs for duplicate orchestrator designation, pending reasoning class, mention-context cost boundary, and missing test branches. | Targeted mutation/invariant tests plus existing browser fixture where applicable.                                                       |
| 1: Minimum viable harness               | Canonical artifact validator extension, two `.mjs` gates, ephemeral work-packet fixture, review-stage extension, `agentic:preflight`.    | Gate tests fail on stale SHA, equal actor/session/run identity, absent artifact, undisposed blocker, and cross-head stage supersession. |
| 2: CI and template wiring               | Current path rules, PR template, CI job, trusted GitHub-native independent-review Check Run.                                             | PR fixture matrix proves low/medium/high/critical classification and that medium+ cannot pass without a trusted current-head Check Run. |
| 3: Cycle runner and reviewer adapters   | `agentic:cycle`, role-selected Codex/Claude packet renderers, local attach/list/show and `pr-overseer` integration.                      | Dry-run tests prove identical packet semantics for both providers and fail closed on unavailable or identity-colliding review.          |
| 4: Recurring-risk evals                 | Mutations for routing, storage bounds, adapter matrix, UI state, and mobile layout.                                                      | Each named mutation turns the owning test red; CI runs the fast eval subset.                                                            |
| 5: Dogfood and tighten                  | Use the harness on several real PRs, measure false blocks, then tighten risk rules deliberately.                                         | Public-safe exact-head artifacts and a short retrospective with only evidence-backed rule changes.                                      |

## Definition of A / A+

A delivery has an explicit invariant, a decisive test at the actual contract
boundary, current-head QA, one independent adversarial review, triaged
findings, and appropriately scoped browser/runtime evidence. A+ adds a
deterministic cost/concurrency/security boundary where relevant, a mutation or
negative test proving the guard can fail, a reusable provider/domain matrix for
extensible seams, and a compact artifact that a future maintainer can audit
without reconstructing the agent conversation.

## Work packet Prime Agent can execute

> Implement the Relay agentic delivery harness in phased, mergeable slices.
> Work from `nightly` in an explicit issue worktree. First create
> `docs/context-map.md` and extend the canonical `PipelineHandoffArtifact`
> types/validator/tests--do not create a second schema or ledger. Then add
> deterministic `scripts/risk-policy-gate.mjs` and
> `scripts/adversarial-review-gate.mjs`, tests, and package commands that
> validate current-head binding, risk path classification, distinct immutable
> implementer/reviewer actor, session, and run IDs, required finding
> dispositions, and same-head stage order. Wire a trusted external
> independent-review GitHub App/workflow Check Run into Actions; it must attest
> the reviewed head SHA, canonical diff digest, conclusion, and bounded payload
> or artifact reference. Local pre-merge mode may use Relay
> `handoff-artifacts`/`pr-overseer` only when its hub, auth, and WorkContext are
> provisioned and it resolves Relay-minted global session/run provenance against
> the trusted registry; otherwise label the packet auditable but unenforced.
> Preserve current typecheck, build,
> Vitest, Playwright, changelog, and human-approval safeguards. Refresh stale
> TypeScript path rules in `docs/risk-contract.json` and make unmatched/unknown
> rules fail closed. Update the PR template and review docs to distinguish
> advice from enforcement. For every implementation slice: write the short
> work packet, delegate one broad read-only adversarial review to a Codex or
> Claude reviewer with distinct immutable actor/session/run IDs using the exact
> base/head range, batch accepted fixes, and, **only if those fixes change
> HEAD**, start a **new** implementation/QA/review chain for the new SHA before
> requesting a focused re-review of the changed hunks. For a non-semantic new
> head, record reusable evidence with an explicit disposition and rerun only
> delta-required checks/review. Treat reviewer
> timeout/rate-limit/identity collision as blocked, never green. Do not claim
> completion until the harness's own mutation fixtures prove stale evidence,
> self-review, absent review, undisposed blocker, stale risk rules, and
> cross-head supersession all fail.

### Handoff evidence Prime must return

- PR URLs, base/head SHA, and tree identity if a squash merge changes metadata.
- The exact commands run, exit codes, and bounded pass/fail counts.
- Sanitized opaque `PipelineHandoffArtifact` IDs or repository-relative artifact
  references for implementation, QA, review, and release where applicable;
  never return absolute paths. Every stage within the **current-head chain**
  must name that chain's one SHA, while prior-head chains remain stale history.
- Independent reviewer actor/session/run IDs plus informational provider/model,
  the reviewed range/diff digest, verdict, finding counts by severity, and a
  disposition/evidence link for every finding.
- The list of named mutations and proof that each one fails before restoration.
- Any intentionally deferred work as a linked issue with owner, reason, and
  why it is safe to merge without it.
