import type { TaskRef, ArtifactKind } from './work-context.js';

export const PIPELINE_HANDOFF_ARTIFACT_SCHEMA_VERSION = 1 as const;

export const PIPELINE_HANDOFF_STAGES = [
  'implementation',
  'qa',
  'review',
  'release',
] as const;

export type PipelineHandoffStageName =
  (typeof PIPELINE_HANDOFF_STAGES)[number];

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

export interface PipelineHandoffImplementationStage
  extends PipelineHandoffStageBase {
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

export interface PipelineHandoffReviewStage extends PipelineHandoffStageBase {
  stage: 'review';
  verdict: PipelineHandoffReviewVerdict;
  reviewedHeadSha: string;
  blockers: string[];
  nitsOrFollowUps: string[];
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
const SHA_RE = /^[a-f0-9]{40,64}$/i;
const ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const GITHUB_TASK_KINDS = new Set<string>(['github-issue', 'github-pr']);

const FORBIDDEN_FIELD_NAMES = new Set<string>([
  'accessToken',
  'apiKey',
  'authToken',
  'authorization',
  'bearer',
  'clientSecret',
  'cookie',
  'env',
  'environment',
  'hermesDbPath',
  'hermesProfilePath',
  'localPath',
  'logPayload',
  'messages',
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
]);

const SECRET_TEXT_RE =
  /(?:bearer\s+[a-z0-9._~+/-]+=*|sk-[a-z0-9_-]{8,}|relay-sac-v1[a-z0-9._-]*)/gi;
const ABSOLUTE_LOCAL_PATH_RE =
  /(?:^|[\s:=('"])(?:\/home\/[^\s)'"]+|\/Users\/[^\s)'"]+|\/tmp\/[^\s)'"]+)/g;

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
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isEnumValue(value: unknown, values: Set<string>): value is string {
  return typeof value === 'string' && values.has(value);
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === 'string' && ISO_TIMESTAMP_RE.test(value);
}

function isSha(value: unknown): value is string {
  return typeof value === 'string' && SHA_RE.test(value);
}

function isSafeRelativePath(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  SECRET_TEXT_RE.lastIndex = 0;
  return (
    value.trim().length > 0 &&
    !value.startsWith('/') &&
    !value.includes('..') &&
    !SECRET_TEXT_RE.test(value)
  );
}

function normalizedFieldName(key: string): string {
  return key.replace(/[_\s-]/g, '').toLowerCase();
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
    const normalized = normalizedFieldName(key);
    for (const forbidden of Array.from(FORBIDDEN_FIELD_NAMES)) {
      if (normalized === normalizedFieldName(forbidden)) {
        errors.push(`unsafe handoff field rejected: ${path}.${key}`);
      }
    }
    collectUnsafeFields(nested, `${path}.${key}`, errors);
  }
  return errors;
}

function collectUnsafePublicText(
  value: unknown,
  path = '$',
  errors: string[] = []
): string[] {
  if (typeof value === 'string') {
    SECRET_TEXT_RE.lastIndex = 0;
    ABSOLUTE_LOCAL_PATH_RE.lastIndex = 0;
    if (SECRET_TEXT_RE.test(value)) {
      errors.push(`secret-looking text rejected from public handoff: ${path}`);
    }
    if (ABSOLUTE_LOCAL_PATH_RE.test(value)) {
      errors.push(`local absolute path rejected from public handoff: ${path}`);
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

function validateTaskRef(value: unknown, errors: string[], path: string): boolean {
  if (!isRecord(value)) {
    errors.push(`${path} must be a task ref object`);
    return false;
  }
  if (!hasString(value.kind)) errors.push(`${path}.kind is required`);
  if (!hasString(value.id)) errors.push(`${path}.id is required`);
  if (!isOptionalString(value.title)) errors.push(`${path}.title must be a string`);
  if (!isOptionalString(value.url)) errors.push(`${path}.url must be a string`);
  if (!isOptionalString(value.status)) errors.push(`${path}.status must be a string`);
  return true;
}

function validateHead(value: unknown, errors: string[]): value is PipelineHandoffHeadRef {
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
  if (isRecord(value.base) && value.base.sha !== undefined && !isSha(value.base.sha)) {
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
  if (
    !isRecord(value.staleIf) ||
    value.staleIf.headShaChanges !== true
  ) {
    errors.push('head.staleIf.headShaChanges must be true');
  }
  if (!isIsoTimestamp(value.capturedAt)) {
    errors.push('head.capturedAt must be an ISO timestamp');
  }
  return errors.length === 0;
}

function validateScope(value: unknown, errors: string[]): value is PipelineHandoffScope {
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
        (taskRef) => isRecord(taskRef) && GITHUB_TASK_KINDS.has(String(taskRef.kind))
      )
    ) {
      errors.push('scope.taskRefs must include a GitHub issue or PR ref');
    }
  }
  if (!isStringArray(value.acceptance) || value.acceptance.length === 0) {
    errors.push('scope.acceptance requires at least one item');
  }
  if (!isStringArray(value.nonGoals)) errors.push('scope.nonGoals must be strings');
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
        if (!hasString(artifact.id)) errors.push(`${artifactPath}.id is required`);
        if (!hasString(artifact.kind)) {
          errors.push(`${artifactPath}.kind is required`);
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
        if (artifact.hashSha256 !== undefined && !isSha(artifact.hashSha256)) {
          errors.push(`${artifactPath}.hashSha256 must be a sha when present`);
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
  if (!isEnumValue(stage.stage, STAGE_SET)) errors.push(`${path}.stage is invalid`);
  if (!isIsoTimestamp(stage.addedAt)) {
    errors.push(`${path}.addedAt must be an ISO timestamp`);
  }
  if (!hasString(stage.actorId)) errors.push(`${path}.actorId is required`);
  if (!hasString(stage.summary)) errors.push(`${path}.summary is required`);
  if (!Array.isArray(stage.acceptanceEvidence) || stage.acceptanceEvidence.length === 0) {
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
  if (!isStringArray(stage.downstreamFocus) || stage.downstreamFocus.length === 0) {
    errors.push(`${path}.downstreamFocus requires at least one item`);
  }
  if (!isStringArray(stage.nonGoals)) errors.push(`${path}.nonGoals must be strings`);
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

function validateReviewStage(
  record: Record<string, unknown>,
  errors: string[],
  path: string,
  headSha: string
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
  headSha: string
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
      validateReviewStage(record, errors, path, headSha);
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
    const headSha = isRecord(artifact.head) && typeof artifact.head.headSha === 'string'
      ? artifact.head.headSha
      : '';
    artifact.stages.forEach((stage, index) => {
      const path = `stages[${index}]`;
      if (validateStageBase(stage, errors, path)) {
        validateStageSpecific(stage, errors, path, headSha);
        stages.push(stage as PipelineHandoffStage);
      }
    });
    validateAppendOnlyStageOrder(stages, errors);
    if (stages[0]?.stage !== 'implementation') {
      errors.push('stages must start with implementation');
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
  return value
    .replace(SECRET_TEXT_RE, '[redacted-secret]')
    .replace(ABSOLUTE_LOCAL_PATH_RE, (match) => {
      const prefix = " \t:=('\"".includes(match[0] ?? '') ? match[0] : '';
      return `${prefix}[redacted-local-path]`;
    });
}

function sanitizeTextTree<T>(value: T): T {
  if (typeof value === 'string') return redactPublicText(value) as T;
  if (Array.isArray(value)) return value.map((item) => sanitizeTextTree(item)) as T;
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
  sanitized.stages = sanitized.stages.map((stage) => ({
    ...stage,
    actorId: stage.actorId.startsWith('agent:') ? 'agent' : stage.actorId,
  })) as PipelineHandoffStage[];
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
  const reason = evidence.reason ? ` (${evidence.reason})` : '';
  return `- ${evidence.label}: ${evidence.disposition}${reason} — ${evidence.summary}`;
}

function commandLine(command: PipelineHandoffCommandEvidence): string {
  const reason = command.reason ? ` (${command.reason})` : '';
  return `- ${command.label}: ${command.status}${reason} — \`${command.command}\` — ${command.summary}`;
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
    .map((taskRef) => (taskRef.url ? `${taskRef.kind} ${taskRef.url}` : `${taskRef.kind} ${taskRef.id}`))
    .join(', ');
  const lines = [
    `# Pipeline handoff artifact: ${rendered.title}`,
    '',
    `schemaVersion: ${rendered.schemaVersion}`,
    `scope: ${rendered.scope.summary}`,
    `taskRefs: ${taskRefs}`,
    `head: ${rendered.head.headSha}`,
    `staleIf: headShaChanges=${String(rendered.head.staleIf.headShaChanges)}`,
    '',
    '## Acceptance',
    ...rendered.scope.acceptance.map((item) => `- ${item}`),
    '',
    '## Non-goals',
    ...rendered.scope.nonGoals.map((item) => `- ${item}`),
  ];

  for (const stage of rendered.stages) {
    lines.push(
      '',
      `## ${stage.stage}`,
      `verdict: ${stageVerdict(stage)}`,
      stage.summary,
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
      ...stage.downstreamFocus.map((item) => `- ${item}`)
    );
  }
  return `${lines.join('\n')}\n`;
}

export const PIPELINE_HANDOFF_PRIVATE_KANBAN_MARKDOWN_TEMPLATE = `# Pipeline handoff artifact (private Kanban)

Use this in private Kanban comments. Keep values bounded and evidence-only.

\`\`\`json
{
  "schemaVersion": 1,
  "id": "pipeline-handoff:<issue-or-pr>:<headSha>",
  "title": "<short scope>",
  "createdAt": "<ISO timestamp>",
  "updatedAt": "<ISO timestamp>",
  "scope": {
    "summary": "<what changed and why>",
    "risk": "low",
    "taskRefs": [{ "kind": "github-issue", "id": "883", "url": "https://github.com/.../issues/883" }],
    "acceptance": ["<acceptance criterion>"],
    "nonGoals": ["no workflow engine", "no raw transcripts/env/auth/log ingestion"]
  },
  "head": {
    "repo": { "ownerRepo": "donovan-yohan/relay-ide" },
    "base": { "name": "nightly" },
    "branch": { "name": "<branch>" },
    "pr": { "number": 0, "url": "https://github.com/.../pull/0" },
    "headSha": "<exact git sha>",
    "staleIf": { "headShaChanges": true },
    "capturedAt": "<ISO timestamp>"
  },
  "stages": [
    {
      "stage": "implementation",
      "addedAt": "<ISO timestamp>",
      "actorId": "agent:<profile>",
      "summary": "<bounded implementation summary>",
      "acceptanceEvidence": [{ "label": "<criterion>", "disposition": "provided", "summary": "<proof/ref>" }],
      "commands": [{ "label": "targeted tests", "command": "npm test -- <file>", "status": "passed", "summary": "<pass/fail counts>" }],
      "downstreamFocus": ["<what QA/review/release should inspect>"],
      "nonGoals": ["<what this stage intentionally did not do>"],
      "decision": "implemented",
      "changedFiles": ["shared/example.ts"],
      "migrationOrStateRisk": "none"
    }
  ]
}
\`\`\`
`;

export const PIPELINE_HANDOFF_PUBLIC_MARKDOWN_TEMPLATE = `# Pipeline handoff artifact (public PR/issue comment)

Use the sanitized public renderer before posting. Public comments must omit private Kanban task ids, local paths, profile paths, raw logs/transcripts, env, provider auth, and secret-looking values.

Required public shape:
- scope summary and GitHub issue/PR refs
- exact head SHA and staleIf.headShaChanges=true
- stage verdicts/decisions
- acceptance evidence summaries
- commands with pass/fail/skipped/not-applicable reason codes
- downstream QA/review/release focus
`;
