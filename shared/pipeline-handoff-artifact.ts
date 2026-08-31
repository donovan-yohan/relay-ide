import {
  ARTIFACT_KINDS,
  type TaskRef,
  type ArtifactKind,
} from './work-context.js';

export const PIPELINE_HANDOFF_ARTIFACT_SCHEMA_VERSION = 1 as const;

export const PIPELINE_HANDOFF_STAGES = [
  'implementation',
  'qa',
  'review',
  'release',
] as const;

export type PipelineHandoffStageName = (typeof PIPELINE_HANDOFF_STAGES)[number];

export const PIPELINE_HANDOFF_EVIDENCE_DISPOSITIONS = [
  'provided',
  'not-applicable',
  'skipped-time',
  'skipped-blocked',
  'skipped-deferred',
] as const;

export type PipelineHandoffEvidenceDisposition =
  (typeof PIPELINE_HANDOFF_EVIDENCE_DISPOSITIONS)[number];

export const PIPELINE_HANDOFF_COMMAND_STATUSES = [
  'passed',
  'failed',
  'skipped-time',
  'skipped-blocked',
  'skipped-deferred',
  'not-applicable',
] as const;

export type PipelineHandoffCommandStatus =
  (typeof PIPELINE_HANDOFF_COMMAND_STATUSES)[number];

export const PIPELINE_HANDOFF_RISK_LEVELS = ['low', 'medium', 'high'] as const;
export type PipelineHandoffRiskLevel =
  (typeof PIPELINE_HANDOFF_RISK_LEVELS)[number];

export const PIPELINE_HANDOFF_IMPLEMENTATION_DECISIONS = [
  'implemented',
  'minimal-low-risk',
  'blocked',
  'deferred',
] as const;

export type PipelineHandoffImplementationDecision =
  (typeof PIPELINE_HANDOFF_IMPLEMENTATION_DECISIONS)[number];

export const PIPELINE_HANDOFF_QA_VERDICTS = [
  'passed',
  'failed',
  'blocked',
  'deferred',
  'not-applicable',
] as const;

export type PipelineHandoffQaVerdict =
  (typeof PIPELINE_HANDOFF_QA_VERDICTS)[number];

export const PIPELINE_HANDOFF_REVIEW_VERDICTS = [
  'approved',
  'changes-requested',
  'blocked',
  'deferred',
  'not-applicable',
] as const;

export type PipelineHandoffReviewVerdict =
  (typeof PIPELINE_HANDOFF_REVIEW_VERDICTS)[number];

export const PIPELINE_HANDOFF_REVIEW_FINDING_SEVERITIES = [
  'P0',
  'P1',
  'P2',
  'P3',
] as const;
export type PipelineHandoffReviewFindingSeverity =
  (typeof PIPELINE_HANDOFF_REVIEW_FINDING_SEVERITIES)[number];

export const PIPELINE_HANDOFF_REVIEW_FINDING_DISPOSITIONS = [
  'fixed',
  'follow-up',
  'refuted',
  'unresolved',
] as const;
export type PipelineHandoffReviewFindingDispositionKind =
  (typeof PIPELINE_HANDOFF_REVIEW_FINDING_DISPOSITIONS)[number];

export const PIPELINE_HANDOFF_TRUSTED_PROVENANCE_DISPOSITIONS = [
  'verified',
  'declared-unverified',
  'unresolvable',
  'mismatched',
] as const;
export type PipelineHandoffTrustedProvenanceDisposition =
  (typeof PIPELINE_HANDOFF_TRUSTED_PROVENANCE_DISPOSITIONS)[number];

export const PIPELINE_HANDOFF_REVIEW_CONFLICTS = [
  'none',
  'declared',
  'unknown',
] as const;
export type PipelineHandoffReviewConflict =
  (typeof PIPELINE_HANDOFF_REVIEW_CONFLICTS)[number];

export const PIPELINE_HANDOFF_CONTEXT_MAP_REFS = [
  'docs/context-map.md#channel-routing',
  'docs/context-map.md#durable-bindings',
  'docs/context-map.md#provider-adapters',
  'docs/context-map.md#message-storage-and-context',
  'docs/context-map.md#frontend-chat-surfaces',
  'docs/context-map.md#test-fixtures',
  'docs/context-map.md#ci-and-release-evidence',
  'docs/context-map.md#handoff-evidence',
] as const;
export type PipelineHandoffContextMapRef =
  (typeof PIPELINE_HANDOFF_CONTEXT_MAP_REFS)[number];

export const PIPELINE_HANDOFF_RELEASE_VERDICTS = [
  'released',
  'not-released',
  'blocked',
  'deferred',
  'not-applicable',
] as const;

export type PipelineHandoffReleaseVerdict =
  (typeof PIPELINE_HANDOFF_RELEASE_VERDICTS)[number];

export interface PipelineHandoffRepoRef {
  ownerRepo: string;
  repoIdentity?: string;
  /** Public-safe remote identifier. Prefer owner/repo; do not store local paths. */
  remoteUrl?: string;
}

export interface PipelineHandoffBaseRef {
  name: string;
  sha?: string;
}

export interface PipelineHandoffBranchRef {
  name: string;
}

export interface PipelineHandoffPrRef {
  number: number;
  url: string;
}

export interface PipelineHandoffHeadRef {
  repo: PipelineHandoffRepoRef;
  base: PipelineHandoffBaseRef;
  branch?: PipelineHandoffBranchRef;
  pr?: PipelineHandoffPrRef;
  /** Exact PR/branch head covered by every appended stage. */
  headSha: string;
  /** Exact stale semantics: any different head SHA makes the artifact stale. */
  staleIf: {
    headShaChanges: true;
  };
  capturedAt: string;
}

export interface PipelineHandoffScope {
  summary: string;
  risk: PipelineHandoffRiskLevel;
  /** External durable task refs. Public rendering omits private Kanban refs. */
  taskRefs: TaskRef[];
  acceptance: string[];
  nonGoals: string[];
}

export interface PipelineHandoffEvidenceArtifactRef {
  id: string;
  kind: ArtifactKind;
  title?: string;
  uri?: string;
  summary?: string;
  hashSha256?: string;
}

export interface PipelineHandoffEvidence {
  label: string;
  disposition: PipelineHandoffEvidenceDisposition;
  summary: string;
  reason?: string;
  artifacts?: PipelineHandoffEvidenceArtifactRef[];
}

export interface PipelineHandoffCommandEvidence {
  label: string;
  command: string;
  status: PipelineHandoffCommandStatus;
  summary: string;
  exitCode?: number;
  reason?: string;
}

export interface PipelineHandoffStageBase {
  stage: PipelineHandoffStageName;
  addedAt: string;
  actorId: string;
  summary: string;
  acceptanceEvidence: PipelineHandoffEvidence[];
  commands: PipelineHandoffCommandEvidence[];
  downstreamFocus: string[];
  nonGoals: string[];
}

export interface PipelineHandoffImplementationStage extends PipelineHandoffStageBase {
  stage: 'implementation';
  decision: PipelineHandoffImplementationDecision;
  changedFiles: string[];
  migrationOrStateRisk: string;
}

export interface PipelineHandoffQaStage extends PipelineHandoffStageBase {
  stage: 'qa';
  verdict: PipelineHandoffQaVerdict;
  testedHeadSha: string;
  findings: string[];
}

export interface PipelineHandoffReviewParticipant {
  actorId: string;
  sessionId: string;
  runId: string;
  relayGlobalSessionId: string;
  /** Informational only; never an independence proof. */
  provider: string;
  /** Informational only; never an independence proof. */
  model: string;
}

export interface PipelineHandoffReviewLocation {
  /** Repository-relative path only. */
  path: string;
  lineStart?: number;
  lineEnd?: number;
}

export type PipelineHandoffReviewEvidenceRef =
  | { kind: 'artifact-id'; artifactId: string }
  | {
      kind: 'repository';
      path: string;
      lineStart?: number;
      lineEnd?: number;
    };

export interface PipelineHandoffReviewFindingFollowUp {
  owner: string;
  taskRef: TaskRef;
  riskAcceptedRationale: string;
}

export interface PipelineHandoffReviewFindingDisposition {
  kind: PipelineHandoffReviewFindingDispositionKind;
  summary: string;
  evidenceRefs: PipelineHandoffReviewEvidenceRef[];
  followUp?: PipelineHandoffReviewFindingFollowUp;
}

export interface PipelineHandoffReviewFinding {
  id: string;
  severity: PipelineHandoffReviewFindingSeverity;
  summary: string;
  location: PipelineHandoffReviewLocation;
  evidenceSummary: string;
  disposition: PipelineHandoffReviewFindingDisposition;
}

export interface PipelineHandoffAdversarialReviewEvidence {
  promptVersion: string;
  baseSha: string;
  diffSha256: string;
  implementation: PipelineHandoffReviewParticipant;
  reviewer: PipelineHandoffReviewParticipant & {
    independentFromImplementation: boolean;
    conflictOfInterest: PipelineHandoffReviewConflict;
    conflictSummary?: string;
  };
  trustedProvenance: {
    disposition: PipelineHandoffTrustedProvenanceDisposition;
    summary: string;
  };
  context: {
    digestSha256: string;
    refs: PipelineHandoffContextMapRef[];
  };
  findings: PipelineHandoffReviewFinding[];
  containsNoRawTranscriptOrSecrets: true;
}

export interface PipelineHandoffReviewStage extends PipelineHandoffStageBase {
  stage: 'review';
  verdict: PipelineHandoffReviewVerdict;
  reviewedHeadSha: string;
  blockers: string[];
  nitsOrFollowUps: string[];
  /** Optional additive structured evidence; later gates decide when required. */
  adversarialReview?: PipelineHandoffAdversarialReviewEvidence;
}

export interface PipelineHandoffReleaseStage extends PipelineHandoffStageBase {
  stage: 'release';
  verdict: PipelineHandoffReleaseVerdict;
  target: string;
  verifiedHeadSha: string;
  mergeCommitSha?: string;
  releaseNotes?: string;
}

export type PipelineHandoffStage =
  | PipelineHandoffImplementationStage
  | PipelineHandoffQaStage
  | PipelineHandoffReviewStage
  | PipelineHandoffReleaseStage;

export interface PipelineHandoffArtifact {
  schemaVersion: typeof PIPELINE_HANDOFF_ARTIFACT_SCHEMA_VERSION;
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  /** Canonical append-only predecessor; request metadata must agree when given. */
  supersedesArtifactId?: string;
  scope: PipelineHandoffScope;
  head: PipelineHandoffHeadRef;
  /** Append-only stage layers in implementation -> QA -> review -> release order. */
  stages: PipelineHandoffStage[];
}

export interface PipelineHandoffValidationResult {
  valid: boolean;
  errors: string[];
}

const STAGE_ORDER_INDEX = new Map<PipelineHandoffStageName, number>(
  PIPELINE_HANDOFF_STAGES.map((stage, index) => [stage, index])
);
const STAGE_SET = new Set<string>(PIPELINE_HANDOFF_STAGES);
const EVIDENCE_DISPOSITION_SET = new Set<string>(
  PIPELINE_HANDOFF_EVIDENCE_DISPOSITIONS
);
const COMMAND_STATUS_SET = new Set<string>(PIPELINE_HANDOFF_COMMAND_STATUSES);
const RISK_SET = new Set<string>(PIPELINE_HANDOFF_RISK_LEVELS);
const IMPLEMENTATION_DECISION_SET = new Set<string>(
  PIPELINE_HANDOFF_IMPLEMENTATION_DECISIONS
);
const QA_VERDICT_SET = new Set<string>(PIPELINE_HANDOFF_QA_VERDICTS);
const REVIEW_VERDICT_SET = new Set<string>(PIPELINE_HANDOFF_REVIEW_VERDICTS);
const RELEASE_VERDICT_SET = new Set<string>(PIPELINE_HANDOFF_RELEASE_VERDICTS);
const REVIEW_FINDING_SEVERITY_SET = new Set<string>(
  PIPELINE_HANDOFF_REVIEW_FINDING_SEVERITIES
);
const REVIEW_FINDING_DISPOSITION_SET = new Set<string>(
  PIPELINE_HANDOFF_REVIEW_FINDING_DISPOSITIONS
);
const TRUSTED_PROVENANCE_DISPOSITION_SET = new Set<string>(
  PIPELINE_HANDOFF_TRUSTED_PROVENANCE_DISPOSITIONS
);
const REVIEW_CONFLICT_SET = new Set<string>(PIPELINE_HANDOFF_REVIEW_CONFLICTS);
const CONTEXT_MAP_REF_SET = new Set<string>(PIPELINE_HANDOFF_CONTEXT_MAP_REFS);
const ARTIFACT_KIND_SET = ARTIFACT_KINDS;
const GIT_SHA_RE = /^[a-f0-9]{40,64}$/i;
const SHA256_RE = /^[a-f0-9]{64}$/i;
const ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const GITHUB_TASK_KINDS = new Set<string>(['github-issue', 'github-pr']);

const FORBIDDEN_FIELD_NAMES = new Set<string>([
  'accessToken',
  'apiKey',
  'authToken',
  'authorization',
  'bearer',
  'clientSecret',
  'capabilityGrant',
  'credential',
  'cookie',
  'env',
  'environment',
  'grant',
  'grantHandle',
  'grantToken',
  'hermesDbPath',
  'hermesProfilePath',
  'localPath',
  'logPayload',
  'messages',
  'nodeCredential',
  'pairToken',
  'pairingToken',
  'profilePath',
  'providerAuth',
  'rawContent',
  'rawLog',
  'rawPayload',
  'rawTranscript',
  'secret',
  'stderr',
  'stdout',
  'token',
  'transcript',
  'xRelayNodeCredential',
]);

const REVIEW_FORBIDDEN_FIELD_NAMES = new Set<string>([
  'prompt',
  'rawPrompt',
  'providerPayload',
  'log',
  'logs',
  'commandArguments',
  'arguments',
  'argv',
  'args',
]);

const SECRET_TEXT_RE =
  /(?:bearer\s+[a-z0-9._~+/-]+=*|sk-[a-z0-9_-]{8,}|relay-(?:sac|ohg|grant|auth|pair)-v1[a-z0-9._-]*|pair_[a-z0-9_-]{8,}|node_[a-z0-9._~+/=-]+\.secret_[a-z0-9._~+/=-]+|secret_[a-z0-9._~+/=-]+)/gi;
const ABSOLUTE_LOCAL_PATH_RE = /(?<![a-z0-9._:/<-])\/(?!\/)[^\s)\]}'",;<>]+/gi;
const WINDOWS_ABSOLUTE_PATH_RE = /(?:^|[\s:=('"])[a-z]:[\\/][^\s)'"]+/gi;
const UNC_PATH_RE = /(?:^|[\s:=('"])\\\\[^\s\\/'"]+[\\/][^\s)'"]+/g;
const KANBAN_TASK_ID_RE = /\bt_[a-f0-9]{8,}\b/gi;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === 'string')
  );
}

function isEnumValue(value: unknown, values: Set<string>): value is string {
  return typeof value === 'string' && values.has(value);
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === 'string' && ISO_TIMESTAMP_RE.test(value);
}

function isSha(value: unknown): value is string {
  return typeof value === 'string' && GIT_SHA_RE.test(value);
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && SHA256_RE.test(value);
}

function isWindowsAbsolutePath(value: string): boolean {
  return /^[a-z]:[\\/]/i.test(value) || /^\\\\[^\\/]+[\\/][^\\/]+/.test(value);
}

function isSafeRelativePath(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  SECRET_TEXT_RE.lastIndex = 0;
  return (
    value.trim().length > 0 &&
    !value.startsWith('/') &&
    !isWindowsAbsolutePath(value) &&
    !value.includes('..') &&
    !SECRET_TEXT_RE.test(value)
  );
}

function normalizedFieldName(key: string): string {
  return key.replace(/[_\s-]/g, '').toLowerCase();
}

function isForbiddenFieldName(key: string): boolean {
  const normalized = normalizedFieldName(key);
  if (
    Array.from(FORBIDDEN_FIELD_NAMES).some(
      (forbidden) => normalized === normalizedFieldName(forbidden)
    )
  ) {
    return true;
  }
  return (
    /(?:auth|authorization|bearer|credential|grant|pairtoken|pairingtoken|secret|token)/.test(
      normalized
    ) && !['taskrefs', 'containsnorawtranscriptorsecrets'].includes(normalized)
  );
}

function collectUnsafeFields(
  value: unknown,
  path = '$',
  errors: string[] = []
): string[] {
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      collectUnsafeFields(item, `${path}[${index}]`, errors)
    );
    return errors;
  }
  if (!isRecord(value)) return errors;
  for (const [key, nested] of Object.entries(value)) {
    if (isForbiddenFieldName(key)) {
      errors.push(`unsafe handoff field rejected: ${path}.${key}`);
    }
    collectUnsafeFields(nested, `${path}.${key}`, errors);
  }
  return errors;
}

function containsControlText(value: string): boolean {
  return /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value);
}

function collectUnsafeReviewFields(
  value: unknown,
  path: string,
  errors: string[]
): void {
  if (typeof value === 'string') {
    if (containsControlText(value)) {
      errors.push(`unsafe adversarial review control text rejected: ${path}`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      collectUnsafeReviewFields(item, `${path}[${index}]`, errors)
    );
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, nested] of Object.entries(value)) {
    const normalized = normalizedFieldName(key);
    if (
      Array.from(REVIEW_FORBIDDEN_FIELD_NAMES).some(
        (forbidden) => normalized === normalizedFieldName(forbidden)
      )
    ) {
      errors.push(`unsafe adversarial review field rejected: ${path}.${key}`);
    }
    collectUnsafeReviewFields(nested, `${path}.${key}`, errors);
  }
}

function isBoundedString(value: unknown, maxLength = 2048): value is string {
  return hasString(value) && value.length <= maxLength;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function collectUnsafePublicText(
  value: unknown,
  path = '$',
  errors: string[] = []
): string[] {
  if (typeof value === 'string') {
    SECRET_TEXT_RE.lastIndex = 0;
    ABSOLUTE_LOCAL_PATH_RE.lastIndex = 0;
    WINDOWS_ABSOLUTE_PATH_RE.lastIndex = 0;
    UNC_PATH_RE.lastIndex = 0;
    KANBAN_TASK_ID_RE.lastIndex = 0;
    if (SECRET_TEXT_RE.test(value)) {
      errors.push(`secret-looking text rejected from public handoff: ${path}`);
    }
    if (
      ABSOLUTE_LOCAL_PATH_RE.test(value) ||
      WINDOWS_ABSOLUTE_PATH_RE.test(value) ||
      UNC_PATH_RE.test(value)
    ) {
      errors.push(`local absolute path rejected from public handoff: ${path}`);
    }
    if (KANBAN_TASK_ID_RE.test(value)) {
      errors.push(
        `private Kanban task id rejected from public handoff: ${path}`
      );
    }
    return errors;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      collectUnsafePublicText(item, `${path}[${index}]`, errors)
    );
    return errors;
  }
  if (!isRecord(value)) return errors;
  for (const [key, nested] of Object.entries(value)) {
    collectUnsafePublicText(nested, `${path}.${key}`, errors);
  }
  return errors;
}

function validateTaskRef(
  value: unknown,
  errors: string[],
  path: string
): boolean {
  if (!isRecord(value)) {
    errors.push(`${path} must be a task ref object`);
    return false;
  }
  if (!hasString(value.kind)) errors.push(`${path}.kind is required`);
  if (!hasString(value.id)) errors.push(`${path}.id is required`);
  if (!isOptionalString(value.title))
    errors.push(`${path}.title must be a string`);
  if (!isOptionalString(value.url)) errors.push(`${path}.url must be a string`);
  if (!isOptionalString(value.status))
    errors.push(`${path}.status must be a string`);
  return true;
}

function validateHead(
  value: unknown,
  errors: string[]
): value is PipelineHandoffHeadRef {
  if (!isRecord(value)) {
    errors.push('head is required');
    return false;
  }
  if (!isRecord(value.repo)) errors.push('head.repo is required');
  else {
    if (!hasString(value.repo.ownerRepo)) {
      errors.push('head.repo.ownerRepo is required');
    }
    if (!isOptionalString(value.repo.repoIdentity)) {
      errors.push('head.repo.repoIdentity must be a string');
    }
    if (!isOptionalString(value.repo.remoteUrl)) {
      errors.push('head.repo.remoteUrl must be a string');
    }
  }
  if (!isRecord(value.base) || !hasString(value.base.name)) {
    errors.push('head.base.name is required');
  }
  if (
    isRecord(value.base) &&
    value.base.sha !== undefined &&
    !isSha(value.base.sha)
  ) {
    errors.push('head.base.sha must be a git sha when present');
  }
  if (value.branch !== undefined) {
    if (!isRecord(value.branch) || !hasString(value.branch.name)) {
      errors.push('head.branch.name must be a string when branch is present');
    }
  }
  if (value.pr !== undefined) {
    if (!isRecord(value.pr)) errors.push('head.pr must be an object');
    else {
      if (
        typeof value.pr.number !== 'number' ||
        !Number.isInteger(value.pr.number) ||
        value.pr.number <= 0
      ) {
        errors.push('head.pr.number must be a positive integer');
      }
      if (!hasString(value.pr.url)) errors.push('head.pr.url is required');
    }
  }
  if (!isSha(value.headSha)) errors.push('head.headSha must be a git sha');
  if (!isRecord(value.staleIf) || value.staleIf.headShaChanges !== true) {
    errors.push('head.staleIf.headShaChanges must be true');
  }
  if (!isIsoTimestamp(value.capturedAt)) {
    errors.push('head.capturedAt must be an ISO timestamp');
  }
  return errors.length === 0;
}

function validateScope(
  value: unknown,
  errors: string[]
): value is PipelineHandoffScope {
  if (!isRecord(value)) {
    errors.push('scope is required');
    return false;
  }
  if (!hasString(value.summary)) errors.push('scope.summary is required');
  if (!isEnumValue(value.risk, RISK_SET)) errors.push('scope.risk is invalid');
  if (!Array.isArray(value.taskRefs) || value.taskRefs.length === 0) {
    errors.push('scope.taskRefs requires at least one taskRef or PR');
  } else {
    value.taskRefs.forEach((taskRef, index) =>
      validateTaskRef(taskRef, errors, `scope.taskRefs[${index}]`)
    );
    if (
      !value.taskRefs.some(
        (taskRef) =>
          isRecord(taskRef) && GITHUB_TASK_KINDS.has(String(taskRef.kind))
      )
    ) {
      errors.push('scope.taskRefs must include a GitHub issue or PR ref');
    }
  }
  if (!isStringArray(value.acceptance) || value.acceptance.length === 0) {
    errors.push('scope.acceptance requires at least one item');
  }
  if (!isStringArray(value.nonGoals))
    errors.push('scope.nonGoals must be strings');
  return true;
}

function validateEvidence(
  evidence: unknown,
  errors: string[],
  path: string
): evidence is PipelineHandoffEvidence {
  if (!isRecord(evidence)) {
    errors.push(`${path} must be an evidence object`);
    return false;
  }
  if (!hasString(evidence.label)) errors.push(`${path}.label is required`);
  if (!isEnumValue(evidence.disposition, EVIDENCE_DISPOSITION_SET)) {
    errors.push(`${path}.disposition is invalid`);
  }
  if (!hasString(evidence.summary)) errors.push(`${path}.summary is required`);
  if (evidence.disposition !== 'provided' && !hasString(evidence.reason)) {
    errors.push(`${path}.reason is required when evidence is not provided`);
  }
  if (evidence.artifacts !== undefined) {
    if (!Array.isArray(evidence.artifacts)) {
      errors.push(`${path}.artifacts must be an array`);
    } else {
      evidence.artifacts.forEach((artifact, index) => {
        const artifactPath = `${path}.artifacts[${index}]`;
        if (!isRecord(artifact)) {
          errors.push(`${artifactPath} must be an object`);
          return;
        }
        if (!hasString(artifact.id))
          errors.push(`${artifactPath}.id is required`);
        if (!isEnumValue(artifact.kind, ARTIFACT_KIND_SET)) {
          errors.push(`${artifactPath}.kind must be a valid artifact kind`);
        }
        if (!isOptionalString(artifact.title)) {
          errors.push(`${artifactPath}.title must be a string`);
        }
        if (!isOptionalString(artifact.uri)) {
          errors.push(`${artifactPath}.uri must be a string`);
        }
        if (!isOptionalString(artifact.summary)) {
          errors.push(`${artifactPath}.summary must be a string`);
        }
        if (
          artifact.hashSha256 !== undefined &&
          !isSha256(artifact.hashSha256)
        ) {
          errors.push(
            `${artifactPath}.hashSha256 must be a 64-character sha256 when present`
          );
        }
      });
    }
  }
  return true;
}

function validateCommand(
  command: unknown,
  errors: string[],
  path: string
): command is PipelineHandoffCommandEvidence {
  if (!isRecord(command)) {
    errors.push(`${path} must be a command evidence object`);
    return false;
  }
  if (!hasString(command.label)) errors.push(`${path}.label is required`);
  if (!hasString(command.command)) errors.push(`${path}.command is required`);
  if (!isEnumValue(command.status, COMMAND_STATUS_SET)) {
    errors.push(`${path}.status is invalid`);
  }
  if (!hasString(command.summary)) errors.push(`${path}.summary is required`);
  if (
    command.exitCode !== undefined &&
    (typeof command.exitCode !== 'number' ||
      !Number.isInteger(command.exitCode) ||
      command.exitCode < 0)
  ) {
    errors.push(`${path}.exitCode must be a non-negative integer`);
  }
  if (command.status !== 'passed' && !hasString(command.reason)) {
    errors.push(`${path}.reason is required when command did not pass`);
  }
  return true;
}

function validateStageBase(
  stage: unknown,
  errors: string[],
  path: string
): stage is PipelineHandoffStageBase {
  if (!isRecord(stage)) {
    errors.push(`${path} must be a stage object`);
    return false;
  }
  if (!isEnumValue(stage.stage, STAGE_SET))
    errors.push(`${path}.stage is invalid`);
  if (!isIsoTimestamp(stage.addedAt)) {
    errors.push(`${path}.addedAt must be an ISO timestamp`);
  }
  if (!hasString(stage.actorId)) errors.push(`${path}.actorId is required`);
  if (!hasString(stage.summary)) errors.push(`${path}.summary is required`);
  if (
    !Array.isArray(stage.acceptanceEvidence) ||
    stage.acceptanceEvidence.length === 0
  ) {
    errors.push(`${path}.acceptanceEvidence requires at least one item`);
  } else {
    stage.acceptanceEvidence.forEach((item, index) =>
      validateEvidence(item, errors, `${path}.acceptanceEvidence[${index}]`)
    );
  }
  if (!Array.isArray(stage.commands)) {
    errors.push(`${path}.commands must be an array`);
  } else {
    stage.commands.forEach((item, index) =>
      validateCommand(item, errors, `${path}.commands[${index}]`)
    );
  }
  if (
    !isStringArray(stage.downstreamFocus) ||
    stage.downstreamFocus.length === 0
  ) {
    errors.push(`${path}.downstreamFocus requires at least one item`);
  }
  if (!isStringArray(stage.nonGoals))
    errors.push(`${path}.nonGoals must be strings`);
  return true;
}

function validateImplementationStage(
  record: Record<string, unknown>,
  errors: string[],
  path: string
): void {
  if (!isEnumValue(record.decision, IMPLEMENTATION_DECISION_SET)) {
    errors.push(`${path}.decision is invalid`);
  }
  if (!Array.isArray(record.changedFiles) || record.changedFiles.length === 0) {
    errors.push(`${path}.changedFiles requires at least one relative path`);
  } else if (!record.changedFiles.every(isSafeRelativePath)) {
    errors.push(`${path}.changedFiles must be relative, public-safe paths`);
  }
  if (!hasString(record.migrationOrStateRisk)) {
    errors.push(`${path}.migrationOrStateRisk is required`);
  }
}

function validateQaStage(
  record: Record<string, unknown>,
  errors: string[],
  path: string,
  headSha: string
): void {
  if (!isEnumValue(record.verdict, QA_VERDICT_SET)) {
    errors.push(`${path}.verdict is invalid`);
  }
  if (record.testedHeadSha !== headSha) {
    errors.push(`${path}.testedHeadSha must equal artifact head.headSha`);
  }
  if (!isStringArray(record.findings)) {
    errors.push(`${path}.findings must be strings`);
  }
}

function validateReviewParticipant(
  value: unknown,
  errors: string[],
  path: string
): value is PipelineHandoffReviewParticipant {
  if (!isRecord(value)) {
    errors.push(`${path} must be a participant object`);
    return false;
  }
  for (const field of [
    'actorId',
    'sessionId',
    'runId',
    'relayGlobalSessionId',
    'provider',
    'model',
  ] as const) {
    if (!isBoundedString(value[field], 256)) {
      errors.push(
        `${path}.${field} is required and must be at most 256 characters`
      );
    }
  }
  return true;
}

function validateReviewLocation(
  value: unknown,
  errors: string[],
  path: string
): void {
  if (!isRecord(value)) {
    errors.push(`${path} must be a location object`);
    return;
  }
  if (
    !isSafeRelativePath(value.path) ||
    value.path.length > 512 ||
    value.path.includes('\\')
  ) {
    errors.push(
      `${path}.path must be a bounded repository-relative public-safe path`
    );
  }
  if (value.lineStart !== undefined && !isPositiveInteger(value.lineStart)) {
    errors.push(`${path}.lineStart must be a positive integer`);
  }
  if (value.lineEnd !== undefined && !isPositiveInteger(value.lineEnd)) {
    errors.push(`${path}.lineEnd must be a positive integer`);
  }
  if (
    typeof value.lineStart === 'number' &&
    typeof value.lineEnd === 'number' &&
    value.lineEnd < value.lineStart
  ) {
    errors.push(`${path}.lineEnd must be greater than or equal to lineStart`);
  }
}

function validateReviewEvidenceRef(
  value: unknown,
  errors: string[],
  path: string
): void {
  if (!isRecord(value)) {
    errors.push(`${path} must be an evidence ref object`);
    return;
  }
  if (value.kind === 'artifact-id') {
    if (!isBoundedString(value.artifactId, 256)) {
      errors.push(`${path}.artifactId is required and must be bounded`);
    }
    return;
  }
  if (value.kind === 'repository') {
    validateReviewLocation(value, errors, path);
    return;
  }
  errors.push(`${path}.kind must be artifact-id or repository`);
}

function validateReviewFinding(
  value: unknown,
  errors: string[],
  path: string
): value is PipelineHandoffReviewFinding {
  if (!isRecord(value)) {
    errors.push(`${path} must be a finding object`);
    return false;
  }
  if (!isBoundedString(value.id, 256))
    errors.push(`${path}.id is required and bounded`);
  if (!isEnumValue(value.severity, REVIEW_FINDING_SEVERITY_SET)) {
    errors.push(`${path}.severity is invalid`);
  }
  if (!isBoundedString(value.summary))
    errors.push(`${path}.summary is required and bounded`);
  if (!isBoundedString(value.evidenceSummary)) {
    errors.push(`${path}.evidenceSummary is required and bounded`);
  }
  validateReviewLocation(value.location, errors, `${path}.location`);
  if (!isRecord(value.disposition)) {
    errors.push(`${path}.disposition is required`);
    return true;
  }
  const disposition = value.disposition;
  if (!isEnumValue(disposition.kind, REVIEW_FINDING_DISPOSITION_SET)) {
    errors.push(`${path}.disposition.kind is invalid`);
  }
  if (!isBoundedString(disposition.summary)) {
    errors.push(`${path}.disposition.summary is required and bounded`);
  }
  if (
    !Array.isArray(disposition.evidenceRefs) ||
    disposition.evidenceRefs.length > 8
  ) {
    errors.push(`${path}.disposition.evidenceRefs must contain at most 8 refs`);
  } else {
    disposition.evidenceRefs.forEach((ref, index) =>
      validateReviewEvidenceRef(
        ref,
        errors,
        `${path}.disposition.evidenceRefs[${index}]`
      )
    );
    if (
      (disposition.kind === 'fixed' || disposition.kind === 'refuted') &&
      disposition.evidenceRefs.length === 0
    ) {
      errors.push(`${path}.disposition ${disposition.kind} requires evidence`);
    }
  }
  if (disposition.kind === 'follow-up') {
    if (value.severity === 'P0' || value.severity === 'P1') {
      errors.push(`${path}.disposition follow-up is not allowed for P0/P1`);
    }
    if (!isRecord(disposition.followUp)) {
      errors.push(`${path}.disposition.followUp is required`);
    } else {
      if (!isBoundedString(disposition.followUp.owner, 256)) {
        errors.push(
          `${path}.disposition.followUp.owner is required and bounded`
        );
      }
      validateTaskRef(
        disposition.followUp.taskRef,
        errors,
        `${path}.disposition.followUp.taskRef`
      );
      if (
        !isRecord(disposition.followUp.taskRef) ||
        disposition.followUp.taskRef.kind !== 'github-issue'
      ) {
        errors.push(
          `${path}.disposition.followUp.taskRef must be a GitHub issue`
        );
      } else if (
        !isBoundedString(disposition.followUp.taskRef.id, 256) ||
        (disposition.followUp.taskRef.title !== undefined &&
          !isBoundedString(disposition.followUp.taskRef.title, 512)) ||
        (disposition.followUp.taskRef.url !== undefined &&
          !isBoundedString(disposition.followUp.taskRef.url, 2048)) ||
        (disposition.followUp.taskRef.status !== undefined &&
          !isBoundedString(disposition.followUp.taskRef.status, 256))
      ) {
        errors.push(
          `${path}.disposition.followUp.taskRef fields must be bounded`
        );
      }
      if (!isBoundedString(disposition.followUp.riskAcceptedRationale)) {
        errors.push(
          `${path}.disposition.followUp.riskAcceptedRationale is required and bounded`
        );
      }
    }
  } else if (disposition.followUp !== undefined) {
    errors.push(`${path}.disposition.followUp is only valid for follow-up`);
  }
  return true;
}

function validateTrustedReviewProvenance(
  value: unknown,
  verdict: unknown,
  errors: string[],
  path: string
): void {
  if (!isRecord(value)) {
    errors.push(`${path} is required`);
    return;
  }
  if (!isEnumValue(value.disposition, TRUSTED_PROVENANCE_DISPOSITION_SET)) {
    errors.push(`${path}.disposition is invalid`);
  } else if (value.disposition === 'verified') {
    errors.push(`${path} verified requires a trusted server resolver`);
  }
  if (
    verdict === 'approved' &&
    (value.disposition === 'unresolvable' || value.disposition === 'mismatched')
  ) {
    errors.push(`${path} cannot be ${String(value.disposition)} for approval`);
  }
  if (!isBoundedString(value.summary)) {
    errors.push(`${path}.summary is required and bounded`);
  }
}

function validateAdversarialReview(
  value: unknown,
  errors: string[],
  path: string,
  artifactBaseSha: unknown,
  implementationActorId: unknown,
  stageActorId: unknown,
  verdict: unknown
): void {
  if (!isRecord(value)) {
    errors.push(`${path} must be an adversarial review object`);
    return;
  }
  collectUnsafeReviewFields(value, path, errors);
  // Structured review evidence is durable/exportable by contract, so reject
  // rather than merely redact unsafe text at this boundary.
  collectUnsafePublicText(value, path, errors);
  if (!isBoundedString(value.promptVersion, 256)) {
    errors.push(`${path}.promptVersion is required and bounded`);
  }
  if (!isSha(value.baseSha)) errors.push(`${path}.baseSha must be a git sha`);
  if (!isSha(artifactBaseSha)) {
    errors.push(`${path} requires artifact head.base.sha`);
  } else if (value.baseSha !== artifactBaseSha) {
    errors.push(`${path}.baseSha must equal artifact head.base.sha`);
  }
  if (!isSha256(value.diffSha256)) {
    errors.push(`${path}.diffSha256 must be a 64-character sha256`);
  }
  const implementationValid = validateReviewParticipant(
    value.implementation,
    errors,
    `${path}.implementation`
  );
  if (
    implementationValid &&
    isRecord(value.implementation) &&
    value.implementation.actorId !== implementationActorId
  ) {
    errors.push(
      `${path}.implementation.actorId must equal implementation stage actorId`
    );
  }
  const reviewerValid = validateReviewParticipant(
    value.reviewer,
    errors,
    `${path}.reviewer`
  );
  if (reviewerValid && isRecord(value.reviewer)) {
    if (value.reviewer.independentFromImplementation !== true) {
      errors.push(
        `${path}.reviewer.independentFromImplementation must be true`
      );
    }
    if (!isEnumValue(value.reviewer.conflictOfInterest, REVIEW_CONFLICT_SET)) {
      errors.push(`${path}.reviewer.conflictOfInterest is invalid`);
    }
    if (
      value.reviewer.conflictOfInterest !== 'none' &&
      !isBoundedString(value.reviewer.conflictSummary)
    ) {
      errors.push(
        `${path}.reviewer.conflictSummary is required for a conflict`
      );
    }
    if (
      value.reviewer.conflictOfInterest === 'none' &&
      value.reviewer.conflictSummary !== undefined
    ) {
      errors.push(
        `${path}.reviewer.conflictSummary is not allowed when conflictOfInterest is none`
      );
    }
    if (stageActorId !== value.reviewer.actorId) {
      errors.push(`${path}.reviewer.actorId must equal review stage actorId`);
    }
    if (
      verdict === 'approved' &&
      value.reviewer.conflictOfInterest !== 'none'
    ) {
      errors.push(
        `${path}.reviewer.conflictOfInterest must be none for approval`
      );
    }
  }
  if (
    implementationValid &&
    reviewerValid &&
    isRecord(value.implementation) &&
    isRecord(value.reviewer)
  ) {
    for (const field of [
      'actorId',
      'sessionId',
      'runId',
      'relayGlobalSessionId',
    ] as const) {
      if (value.implementation[field] === value.reviewer[field]) {
        errors.push(`${path} implementation and reviewer ${field} must differ`);
      }
    }
  }
  validateTrustedReviewProvenance(
    value.trustedProvenance,
    verdict,
    errors,
    `${path}.trustedProvenance`
  );
  if (!isRecord(value.context)) {
    errors.push(`${path}.context is required`);
  } else {
    if (!isSha256(value.context.digestSha256)) {
      errors.push(`${path}.context.digestSha256 must be a 64-character sha256`);
    }
    if (
      !Array.isArray(value.context.refs) ||
      value.context.refs.length === 0 ||
      value.context.refs.length > 16 ||
      !value.context.refs.every((ref) => isEnumValue(ref, CONTEXT_MAP_REF_SET))
    ) {
      errors.push(
        `${path}.context.refs must contain 1-16 allowlisted context refs`
      );
    } else if (new Set(value.context.refs).size !== value.context.refs.length) {
      errors.push(`${path}.context.refs must be unique`);
    }
  }
  if (!Array.isArray(value.findings) || value.findings.length > 100) {
    errors.push(`${path}.findings must contain at most 100 findings`);
  } else {
    const findingIds = new Set<string>();
    value.findings.forEach((finding, index) => {
      if (
        validateReviewFinding(finding, errors, `${path}.findings[${index}]`) &&
        isRecord(finding)
      ) {
        if (findingIds.has(String(finding.id))) {
          errors.push(`${path}.findings[${index}].id must be unique`);
        }
        findingIds.add(String(finding.id));
        if (
          verdict === 'approved' &&
          isRecord(finding.disposition) &&
          finding.disposition.kind === 'unresolved'
        ) {
          errors.push(
            `${path}.findings[${index}] cannot be unresolved for approval`
          );
        }
      }
    });
  }
  if (value.containsNoRawTranscriptOrSecrets !== true) {
    errors.push(`${path}.containsNoRawTranscriptOrSecrets must be true`);
  }
}

function validateReviewStage(
  record: Record<string, unknown>,
  errors: string[],
  path: string,
  headSha: string,
  baseSha: unknown,
  implementationActorId: unknown
): void {
  if (!isEnumValue(record.verdict, REVIEW_VERDICT_SET)) {
    errors.push(`${path}.verdict is invalid`);
  }
  if (record.reviewedHeadSha !== headSha) {
    errors.push(`${path}.reviewedHeadSha must equal artifact head.headSha`);
  }
  if (!isStringArray(record.blockers)) {
    errors.push(`${path}.blockers must be strings`);
  }
  if (!isStringArray(record.nitsOrFollowUps)) {
    errors.push(`${path}.nitsOrFollowUps must be strings`);
  }
  if (record.adversarialReview !== undefined) {
    validateAdversarialReview(
      record.adversarialReview,
      errors,
      `${path}.adversarialReview`,
      baseSha,
      implementationActorId,
      record.actorId,
      record.verdict
    );
  }
}

function validateReleaseStage(
  record: Record<string, unknown>,
  errors: string[],
  path: string,
  headSha: string
): void {
  if (!isEnumValue(record.verdict, RELEASE_VERDICT_SET)) {
    errors.push(`${path}.verdict is invalid`);
  }
  if (!hasString(record.target)) errors.push(`${path}.target is required`);
  if (record.verifiedHeadSha !== headSha) {
    errors.push(`${path}.verifiedHeadSha must equal artifact head.headSha`);
  }
  if (record.mergeCommitSha !== undefined && !isSha(record.mergeCommitSha)) {
    errors.push(`${path}.mergeCommitSha must be a git sha when present`);
  }
  if (!isOptionalString(record.releaseNotes)) {
    errors.push(`${path}.releaseNotes must be a string`);
  }
}

function validateStageSpecific(
  stage: PipelineHandoffStageBase,
  errors: string[],
  path: string,
  headSha: string,
  baseSha: unknown,
  implementationActorId: unknown
): void {
  const record = stage as unknown as Record<string, unknown>;
  switch (stage.stage) {
    case 'implementation':
      validateImplementationStage(record, errors, path);
      break;
    case 'qa':
      validateQaStage(record, errors, path, headSha);
      break;
    case 'review':
      validateReviewStage(
        record,
        errors,
        path,
        headSha,
        baseSha,
        implementationActorId
      );
      break;
    case 'release':
      validateReleaseStage(record, errors, path, headSha);
      break;
  }
}

function validateAppendOnlyStageOrder(
  stages: PipelineHandoffStage[],
  errors: string[]
): void {
  let previousIndex = -1;
  const seen = new Set<PipelineHandoffStageName>();
  stages.forEach((stage, index) => {
    const orderIndex = STAGE_ORDER_INDEX.get(stage.stage) ?? -1;
    if (seen.has(stage.stage)) {
      errors.push(`stages[${index}] duplicates stage ${stage.stage}`);
    }
    if (orderIndex <= previousIndex) {
      errors.push(
        `stages[${index}] must append in implementation -> QA -> review -> release order`
      );
    }
    seen.add(stage.stage);
    previousIndex = orderIndex;
  });
}

export function validatePipelineHandoffArtifact(
  artifact: unknown
): PipelineHandoffValidationResult {
  const errors: string[] = [];
  if (!isRecord(artifact)) {
    return { valid: false, errors: ['artifact must be an object'] };
  }
  errors.push(...collectUnsafeFields(artifact));

  if (artifact.schemaVersion !== PIPELINE_HANDOFF_ARTIFACT_SCHEMA_VERSION) {
    errors.push('schemaVersion is unsupported');
  }
  if (!hasString(artifact.id)) errors.push('id is required');
  if (
    artifact.supersedesArtifactId !== undefined &&
    !isBoundedString(artifact.supersedesArtifactId, 256)
  ) {
    errors.push('supersedesArtifactId must be a non-empty bounded artifact id');
  }
  if (!hasString(artifact.title)) errors.push('title is required');
  if (!isIsoTimestamp(artifact.createdAt)) {
    errors.push('createdAt must be an ISO timestamp');
  }
  if (!isIsoTimestamp(artifact.updatedAt)) {
    errors.push('updatedAt must be an ISO timestamp');
  }
  validateScope(artifact.scope, errors);
  validateHead(artifact.head, errors);

  if (!Array.isArray(artifact.stages) || artifact.stages.length === 0) {
    errors.push('stages requires at least an implementation layer');
  } else {
    const stages: PipelineHandoffStage[] = [];
    const headSha =
      isRecord(artifact.head) && typeof artifact.head.headSha === 'string'
        ? artifact.head.headSha
        : '';
    const baseSha =
      isRecord(artifact.head) && isRecord(artifact.head.base)
        ? artifact.head.base.sha
        : undefined;
    const implementationActorId =
      isRecord(artifact.stages[0]) &&
      artifact.stages[0].stage === 'implementation'
        ? artifact.stages[0].actorId
        : undefined;
    artifact.stages.forEach((stage, index) => {
      const path = `stages[${index}]`;
      if (validateStageBase(stage, errors, path)) {
        validateStageSpecific(
          stage,
          errors,
          path,
          headSha,
          baseSha,
          implementationActorId
        );
        stages.push(stage as PipelineHandoffStage);
      }
    });
    validateAppendOnlyStageOrder(stages, errors);
    if (stages[0]?.stage !== 'implementation') {
      errors.push('stages must start with implementation');
    }
    const structuredReviewIndex = stages.findIndex(
      (stage) =>
        stage.stage === 'review' && stage.adversarialReview !== undefined
    );
    if (
      structuredReviewIndex !== -1 &&
      (structuredReviewIndex !== 2 ||
        stages[0]?.stage !== 'implementation' ||
        stages[1]?.stage !== 'qa')
    ) {
      errors.push(
        'structured adversarial review requires contiguous implementation -> QA -> review stages'
      );
    }
  }

  return { valid: errors.length === 0, errors };
}

export function isPipelineHandoffArtifact(
  artifact: unknown
): artifact is PipelineHandoffArtifact {
  return validatePipelineHandoffArtifact(artifact).valid;
}

export function isPipelineHandoffArtifactStale(
  artifact: Pick<PipelineHandoffArtifact, 'head'>,
  currentHeadSha: string
): boolean {
  return (
    artifact.head.staleIf.headShaChanges === true &&
    artifact.head.headSha !== currentHeadSha
  );
}

function redactPublicText(value: string): string {
  SECRET_TEXT_RE.lastIndex = 0;
  ABSOLUTE_LOCAL_PATH_RE.lastIndex = 0;
  WINDOWS_ABSOLUTE_PATH_RE.lastIndex = 0;
  UNC_PATH_RE.lastIndex = 0;
  KANBAN_TASK_ID_RE.lastIndex = 0;
  return value
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, ' ')
    .replace(SECRET_TEXT_RE, '[redacted-secret]')
    .replace(ABSOLUTE_LOCAL_PATH_RE, (match) => {
      const prefix = ' \t:=(\'"'.includes(match[0] ?? '') ? match[0] : '';
      return `${prefix}[redacted-local-path]`;
    })
    .replace(WINDOWS_ABSOLUTE_PATH_RE, (match) => {
      const prefix = ' \t:=(\'"'.includes(match[0] ?? '') ? match[0] : '';
      return `${prefix}[redacted-local-path]`;
    })
    .replace(UNC_PATH_RE, (match) => {
      const prefix = ' \t:=(\'"'.includes(match[0] ?? '') ? match[0] : '';
      return `${prefix}[redacted-local-path]`;
    })
    .replace(KANBAN_TASK_ID_RE, '[redacted-kanban-task]');
}

function sanitizeTextTree<T>(value: T): T {
  if (typeof value === 'string') return redactPublicText(value) as T;
  if (Array.isArray(value))
    return value.map((item) => sanitizeTextTree(item)) as T;
  if (!isRecord(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    out[key] = sanitizeTextTree(nested);
  }
  return out as T;
}

export function sanitizePipelineHandoffArtifactForPublic(
  artifact: PipelineHandoffArtifact
): PipelineHandoffArtifact {
  const sanitized = sanitizeTextTree(
    JSON.parse(JSON.stringify(artifact)) as PipelineHandoffArtifact
  );
  sanitized.scope.taskRefs = sanitized.scope.taskRefs.filter((taskRef) =>
    GITHUB_TASK_KINDS.has(taskRef.kind)
  );
  sanitized.scope.nonGoals = sanitized.scope.nonGoals.filter(
    (nonGoal) => !/kanban|internal dispatcher|local worktree/i.test(nonGoal)
  );
  const hasStructuredReview = sanitized.stages.some(
    (stage) => stage.stage === 'review' && stage.adversarialReview !== undefined
  );
  const publicActorAliases = new Map<string, string>();
  const publicActorId = (actorId: string): string => {
    if (!actorId.startsWith('agent:')) return actorId;
    if (!hasStructuredReview) return 'agent';
    const existing = publicActorAliases.get(actorId);
    if (existing) return existing;
    const alias = `agent:public-${publicActorAliases.size + 1}`;
    publicActorAliases.set(actorId, alias);
    return alias;
  };
  sanitized.stages = sanitized.stages.map((stage) => {
    const actorId = publicActorId(stage.actorId);
    if (stage.stage !== 'review' || !stage.adversarialReview) {
      return { ...stage, actorId };
    }
    return {
      ...stage,
      actorId,
      adversarialReview: {
        ...stage.adversarialReview,
        implementation: {
          ...stage.adversarialReview.implementation,
          actorId: publicActorId(
            stage.adversarialReview.implementation.actorId
          ),
        },
        reviewer: {
          ...stage.adversarialReview.reviewer,
          actorId: publicActorId(stage.adversarialReview.reviewer.actorId),
        },
      },
    };
  }) as PipelineHandoffStage[];
  return sanitized;
}

export function validatePublicPipelineHandoffArtifact(
  artifact: PipelineHandoffArtifact
): PipelineHandoffValidationResult {
  const schema = validatePipelineHandoffArtifact(artifact);
  const publicErrors = collectUnsafePublicText(artifact);
  const privateTaskRefs = artifact.scope.taskRefs.filter(
    (taskRef) => !GITHUB_TASK_KINDS.has(taskRef.kind)
  );
  if (privateTaskRefs.length > 0) {
    publicErrors.push('public handoff must not include private task refs');
  }
  return {
    valid: schema.valid && publicErrors.length === 0,
    errors: [...schema.errors, ...publicErrors],
  };
}

function evidenceLine(evidence: PipelineHandoffEvidence): string {
  const reason = evidence.reason
    ? ` (${escapeMarkdownInline(evidence.reason)})`
    : '';
  return `- ${escapeMarkdownInline(evidence.label)}: ${evidence.disposition}${reason} — ${escapeMarkdownInline(evidence.summary)}`;
}

function markdownCodeSpan(value: string): string {
  const normalized = value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, ' ');
  const longestRun = Math.max(
    0,
    ...Array.from(normalized.matchAll(/`+/g), (match) => match[0].length)
  );
  const fence = '`'.repeat(longestRun + 1);
  return longestRun === 0
    ? `${fence}${normalized}${fence}`
    : `${fence} ${normalized} ${fence}`;
}

function commandLine(command: PipelineHandoffCommandEvidence): string {
  const reason = command.reason
    ? ` (${escapeMarkdownInline(command.reason)})`
    : '';
  return `- ${escapeMarkdownInline(command.label)}: ${command.status}${reason} — ${markdownCodeSpan(command.command)} — ${escapeMarkdownInline(command.summary)}`;
}

function escapeMarkdownInline(value: string): string {
  return value
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, ' ')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)')
    .replace(/\\\[(redacted-(?:secret|local-path|kanban-task))\\\]/g, '[$1]');
}

function stageVerdict(stage: PipelineHandoffStage): string {
  switch (stage.stage) {
    case 'implementation':
      return stage.decision;
    case 'qa':
      return stage.verdict;
    case 'review':
      return stage.verdict;
    case 'release':
      return stage.verdict;
  }
}

export function renderPipelineHandoffMarkdown(
  artifact: PipelineHandoffArtifact,
  options: { public?: boolean } = {}
): string {
  const rendered = options.public
    ? sanitizePipelineHandoffArtifactForPublic(artifact)
    : artifact;
  const taskRefs = rendered.scope.taskRefs
    .map((taskRef) =>
      taskRef.url
        ? `${taskRef.kind} ${escapeMarkdownInline(taskRef.url)}`
        : `${taskRef.kind} ${escapeMarkdownInline(taskRef.id)}`
    )
    .join(', ');
  const lines = [
    `# Pipeline handoff artifact: ${escapeMarkdownInline(rendered.title)}`,
    '',
    `schemaVersion: ${rendered.schemaVersion}`,
    `scope: ${escapeMarkdownInline(rendered.scope.summary)}`,
    `taskRefs: ${taskRefs}`,
    `head: ${rendered.head.headSha}`,
    ...(rendered.supersedesArtifactId
      ? [`supersedes: ${escapeMarkdownInline(rendered.supersedesArtifactId)}`]
      : []),
    `staleIf: headShaChanges=${String(rendered.head.staleIf.headShaChanges)}`,
    '',
    '## Acceptance',
    ...rendered.scope.acceptance.map(
      (item) => `- ${escapeMarkdownInline(item)}`
    ),
    '',
    '## Non-goals',
    ...rendered.scope.nonGoals.map((item) => `- ${escapeMarkdownInline(item)}`),
  ];

  for (const stage of rendered.stages) {
    lines.push(
      '',
      `## ${stage.stage}`,
      `verdict: ${stageVerdict(stage)}`,
      escapeMarkdownInline(stage.summary),
      '',
      '### Evidence',
      ...stage.acceptanceEvidence.map(evidenceLine),
      '',
      '### Commands',
      ...(stage.commands.length > 0
        ? stage.commands.map(commandLine)
        : ['- none recorded']),
      '',
      '### Downstream focus',
      ...stage.downstreamFocus.map((item) => `- ${escapeMarkdownInline(item)}`)
    );
    if (stage.stage === 'review' && stage.adversarialReview) {
      const review = stage.adversarialReview;
      const inline = escapeMarkdownInline;
      lines.push(
        '',
        '### Adversarial review',
        `promptVersion: ${inline(review.promptVersion)}`,
        `reviewedHead: ${stage.reviewedHeadSha}`,
        `baseHead: ${review.baseSha}`,
        `diffSha256: ${review.diffSha256}`,
        `implementation: ${inline(review.implementation.actorId)} / ${inline(review.implementation.sessionId)} / ${inline(review.implementation.runId)}`,
        `reviewer: ${inline(review.reviewer.actorId)} / ${inline(review.reviewer.sessionId)} / ${inline(review.reviewer.runId)}`,
        `conflictOfInterest: ${review.reviewer.conflictOfInterest}`,
        `trustedProvenanceDeclaration: ${review.trustedProvenance.disposition} — ${inline(review.trustedProvenance.summary)}`,
        `contextDigestSha256: ${review.context.digestSha256}`,
        `contextRefs: ${review.context.refs.join(', ')}`,
        '',
        '#### Findings',
        ...(review.findings.length > 0
          ? review.findings.map(
              (finding) =>
                `- ${inline(finding.id)} [${finding.severity}] ${inline(finding.location.path)}:${finding.location.lineStart ?? 1} — ${inline(finding.summary)} — ${finding.disposition.kind}: ${inline(finding.disposition.summary)}`
            )
          : ['- none'])
      );
    }
  }
  return `${lines.join('\n')}\n`;
}
