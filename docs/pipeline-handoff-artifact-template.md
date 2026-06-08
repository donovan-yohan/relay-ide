# Pipeline handoff artifact template

Status: shared contract/template foundation for issue #883.

`PipelineHandoffArtifact` is evidence/provenance only. It is not a workflow engine, release approval system, GitHub/Kanban state replacement, or executable instruction channel.

## Invariants

- Stages are append-only layers in this exact order: `implementation` -> `qa` -> `review` -> `release`.
- Every artifact names the exact covered `headSha` and declares `staleIf.headShaChanges: true`. If the PR/branch head changes, all prior QA/review/release evidence is stale until refreshed for the new head.
- Every stage carries bounded acceptance evidence, commands/checks, downstream focus, non-goals, and a stage-specific decision/verdict.
- Not-tested evidence must use machine-readable distinctions:
  - `not-applicable`: irrelevant for this scope.
  - `skipped-time`: skipped for time budget.
  - `skipped-blocked`: skipped because a dependency/system/human gate blocked it.
  - `skipped-deferred`: intentionally deferred to a later stage/follow-up.
- Artifacts must not store raw transcripts, PTY bytes, env, provider auth, secrets, raw local paths, or unbounded logs.
- Public PR/issue comments must be sanitized before posting: omit private Kanban refs and redact local paths/secret-looking values.

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
    "pr": { "number": 883, "url": "https://github.com/donovan-yohan/relay-ide/pull/883" },
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
