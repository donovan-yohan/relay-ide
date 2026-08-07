# Pipeline handoff artifact template

Status: shared contract/template foundation for issue #883.

`PipelineHandoffArtifact` is evidence/provenance only. It is not a workflow engine, release approval system, GitHub/Kanban state replacement, or executable instruction channel.

## Invariants

- Stages are append-only layers in this exact order: `implementation` -> `qa` -> `review` -> `release`.
- A successor records its canonical predecessor in payload-level `supersedesArtifactId`. A CLI/request flag is a compatibility assertion and must match. Supersession edges stay within one payload kind. The durable store rejects forks, changed immutable roots, changed prior stages, and cross-head successors.
- Every artifact names the exact covered `headSha` and declares `staleIf.headShaChanges: true`. If the PR/branch head changes, all prior QA/review/release evidence is stale until refreshed for the new head.
- Every stage carries bounded acceptance evidence, commands/checks, downstream focus, non-goals, and a stage-specific decision/verdict.
- Not-tested evidence must use machine-readable distinctions:
  - `not-applicable`: irrelevant for this scope.
  - `skipped-time`: skipped for time budget.
  - `skipped-blocked`: skipped because a dependency/system/human gate blocked it.
  - `skipped-deferred`: intentionally deferred to a later stage/follow-up.
- Artifacts must not store raw transcripts, PTY bytes, env, provider auth, secrets, raw local paths, or unbounded logs.
- Public PR/issue comments must be sanitized before posting: omit private Kanban refs and redact local paths/secret-looking values.

## Standard live Relay worker publication pattern

Workers should publish the handoff artifact while the lane is live, not reconstruct it after the PR lands:

1. **Implementation** creates the artifact with one `implementation` stage and calls `handoff-artifacts.attach` for the current WorkContext.
2. **QA** reads the latest non-stale artifact for the same `workContextId`/PR head, sets payload `supersedesArtifactId`, preserves the canonical root and implementation layer, appends a `qa` stage, and calls `handoff-artifacts.attach`. The optional `--supersedes-artifact-id` flag must equal the payload value when supplied.
3. **Review** appends a `review` stage the same way, superseding the QA artifact.
4. **Release** appends a `release` stage, superseding the review artifact.

Each publication must repeat the same public-safe `head` block for the exact PR/head it covers:

```json
{
  "head": {
    "repo": { "ownerRepo": "donovan-yohan/relay-ide" },
    "base": { "name": "nightly" },
    "branch": { "name": "issue-903-live-handoff-artifacts" },
    "pr": {
      "number": 904,
      "url": "https://github.com/donovan-yohan/relay-ide/pull/904"
    },
    "headSha": "1111111111111111111111111111111111111111",
    "staleIf": { "headShaChanges": true },
    "capturedAt": "2026-06-10T00:00:00.000Z"
  }
}
```

Stage-specific exact-head fields must also equal `head.headSha`:

| Worker stage   | Stage field that must equal `head.headSha`                    | Publish command shape                                                                                                                                                                                             |
| -------------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| implementation | artifact-level `head.headSha` covers the implementation layer | `relay-ide v1 handoff-artifacts attach --work-context-id <wc> --artifact-file implementation.json --current-head-sha <headSha> --stage implementation --visibility public --json`                                 |
| QA             | `testedHeadSha`                                               | `relay-ide v1 handoff-artifacts attach --work-context-id <wc> --artifact-file qa.json --current-head-sha <headSha> --supersedes-artifact-id <implementation-artifact-id> --stage qa --visibility public --json`   |
| review         | `reviewedHeadSha`                                             | `relay-ide v1 handoff-artifacts attach --work-context-id <wc> --artifact-file review.json --current-head-sha <headSha> --supersedes-artifact-id <qa-artifact-id> --stage review --visibility public --json`       |
| release        | `verifiedHeadSha`                                             | `relay-ide v1 handoff-artifacts attach --work-context-id <wc> --artifact-file release.json --current-head-sha <headSha> --supersedes-artifact-id <review-artifact-id> --stage release --visibility public --json` |

Before public PR/issue posting, use `handoff-artifacts copy` or `renderPipelineHandoffMarkdown(artifact, { public: true })`. Public-safe output must not include local paths, private queue/task IDs, secrets/env, raw logs/transcripts, or dispatcher internals.

A review stage may add one complete `adversarialReview` block. It binds the declared implementation and reviewer actor/session/run identities, exact base and reviewed head, canonical diff/context digests, allowlisted [`context-map.md`](context-map.md) references, conflict declaration, trusted-provenance disposition, findings, and evidence-backed dispositions. The block is all-or-nothing and requires contiguous implementation, QA, and review stages; legacy schema-v1 review stages remain readable without it. `provider` and `model` are informational. Until a trusted actor/session/run resolver exists, use `trustedProvenance.disposition: declared-unverified`; client-authored `verified` is rejected, and declarations must not be described as verified identity proof.

The smoke fixture at `test/fixtures/pipeline-handoff/live-worker-pattern.json` demonstrates attaching an implementation layer and appending QA through the stable `handoff-artifacts.*` route surface.

## Private Kanban JSON skeleton

Use this inside private Kanban comments where internal task refs may be useful. Keep paths relative and evidence summaries bounded.

```json
{
  "schemaVersion": 1,
  "id": "pipeline-handoff:883:<headSha>",
  "title": "Define pipeline handoff artifact schema and templates",
  "createdAt": "2026-06-08T01:02:03Z",
  "updatedAt": "2026-06-08T01:02:03Z",
  "scope": {
    "summary": "Shared/backend schema plus markdown/JSON template foundation",
    "risk": "low",
    "taskRefs": [
      {
        "kind": "github-issue",
        "id": "883",
        "url": "https://github.com/donovan-yohan/relay-ide/issues/883"
      },
      {
        "kind": "kanban-task",
        "id": "t_<private-task-id>"
      }
    ],
    "acceptance": [
      "stage-required fields for implementation/QA/review/release",
      "exact headSha stale semantics",
      "sanitized public handoff form"
    ],
    "nonGoals": [
      "no workflow engine",
      "no release auto-approval",
      "no raw transcripts/env/auth/log ingestion"
    ]
  },
  "head": {
    "repo": { "ownerRepo": "donovan-yohan/relay-ide" },
    "base": { "name": "nightly" },
    "branch": { "name": "issue-883-handoff-schema" },
    "pr": {
      "number": 883,
      "url": "https://github.com/donovan-yohan/relay-ide/pull/883"
    },
    "headSha": "<exact git sha>",
    "staleIf": { "headShaChanges": true },
    "capturedAt": "2026-06-08T01:02:03Z"
  },
  "stages": [
    {
      "stage": "implementation",
      "addedAt": "2026-06-08T01:02:03Z",
      "actorId": "agent:kani-backend",
      "summary": "Implemented the shared schema/template foundation.",
      "acceptanceEvidence": [
        {
          "label": "schema validation",
          "disposition": "provided",
          "summary": "Unit tests validate full layers, stale detection, minimal artifact, and public sanitization."
        }
      ],
      "commands": [
        {
          "label": "targeted tests",
          "command": "npm test -- test/pipeline-handoff-artifact.test.ts",
          "status": "passed",
          "summary": "<pass/fail counts>",
          "exitCode": 0
        },
        {
          "label": "browser QA",
          "command": "not run",
          "status": "not-applicable",
          "summary": "Schema-only backend/shared change.",
          "reason": "not-applicable"
        }
      ],
      "downstreamFocus": [
        "Review exact head SHA and schema non-goals.",
        "QA should verify public rendering does not leak private refs."
      ],
      "nonGoals": ["No API route or workflow engine in this slice."],
      "decision": "implemented",
      "changedFiles": ["shared/pipeline-handoff-artifact.ts"],
      "migrationOrStateRisk": "none"
    }
  ]
}
```

## Public PR/issue markdown form

Before posting publicly, run the artifact through `sanitizePipelineHandoffArtifactForPublic()` or render with `renderPipelineHandoffMarkdown(artifact, { public: true })`.

```md
# Pipeline handoff artifact: <title>

schemaVersion: 1
scope: <public scope summary>
taskRefs: github-issue https://github.com/donovan-yohan/relay-ide/issues/883
head: <exact head sha>
staleIf: headShaChanges=true

## Acceptance

- <acceptance criterion>

## Non-goals

- no workflow engine
- no raw transcripts/env/auth/log ingestion

## implementation

verdict: implemented
<bounded implementation summary>

### Evidence

- schema validation: provided — <bounded proof/ref>

### Commands

- targeted tests: passed — `npm test -- test/pipeline-handoff-artifact.test.ts` — <pass/fail counts>
- browser QA: not-applicable (not-applicable) — `not run` — Schema-only backend/shared change.

### Downstream focus

- Review exact head SHA and non-goals.
- QA should verify public rendering does not leak private refs.
```
