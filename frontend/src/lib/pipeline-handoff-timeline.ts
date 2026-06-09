import {
  PIPELINE_HANDOFF_STAGES,
  renderPipelineHandoffMarkdown,
  type PipelineHandoffArtifact,
  type PipelineHandoffStage,
  type PipelineHandoffStageName,
} from '../../../shared/pipeline-handoff-artifact.js';
import type { ArtifactKind, TaskRef } from '../../../shared/work-context.js';

export type HandoffArtifactState =
  | 'missing'
  | 'current'
  | 'stale'
  | 'failed'
  | 'unknown';

export interface PublicPipelineHandoffArtifactSummary {
  id: string;
  workContextId: string;
  projectId?: string;
  taskRef?: Pick<TaskRef, 'kind' | 'id' | 'title' | 'url' | 'status'>;
  stage?: PipelineHandoffStageName;
  kind: ArtifactKind;
  title: string;
  summary: string;
  visibility: 'private' | 'public';
  capturedAt: string;
  payloadKind: 'pipeline-handoff-artifact';
  payloadSha256: string;
  payloadBytes: number;
  prNumber?: number;
  headSha?: string;
  baseName?: string;
  branchName?: string;
  supersedesArtifactId?: string;
}

export interface PipelineHandoffArtifactStaleness {
  stale: boolean;
  staleIf: { headShaChanges: true };
  artifactHeadSha: string;
  currentHeadSha: string;
}

export interface PipelineHandoffArtifactEnvelope {
  metadata: PublicPipelineHandoffArtifactSummary;
  payload?: PipelineHandoffArtifact;
  staleness?: PipelineHandoffArtifactStaleness;
  payloadError?: string;
}

export interface HandoffTimelineStageSummary {
  stage: PipelineHandoffStageName;
  status: 'present' | 'missing';
  evidenceCount: number;
  verdict: string;
  downstreamFocus: string[];
}

export interface HandoffTimelineSummary {
  state: HandoffArtifactState;
  stateLabel: string;
  stageLabel: string;
  shortHeadSha: string | null;
  evidenceCount: number;
  verdict: string;
  downstreamFocus: string[];
  openUrl: string | null;
  payloadError: string | null;
  stages: HandoffTimelineStageSummary[];
}

const STAGE_ORDER: PipelineHandoffStageName[] = [...PIPELINE_HANDOFF_STAGES];

export function shortSha(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, 7);
}

export function stageVerdict(stage: PipelineHandoffStage | null | undefined): string {
  if (!stage) return 'missing';
  switch (stage.stage) {
    case 'implementation':
      return stage.decision;
    case 'qa':
      return stage.verdict;
    case 'review':
      return stage.verdict;
    case 'release':
      return stage.verdict;
    default: {
      const _exhaustive: never = stage;
      return String(_exhaustive);
    }
  }
}

export function stageEvidenceCount(
  stage: PipelineHandoffStage | null | undefined
): number {
  if (!stage) return 0;
  return stage.acceptanceEvidence.length + stage.commands.length;
}

function latestStage(
  artifact: PipelineHandoffArtifact | null | undefined
): PipelineHandoffStage | null {
  return artifact?.stages.at(-1) ?? null;
}

function artifactHeadSha(envelope: PipelineHandoffArtifactEnvelope): string | null {
  return envelope.metadata.headSha ?? envelope.payload?.head.headSha ?? null;
}

function stateFor(
  envelope: PipelineHandoffArtifactEnvelope,
  currentHeadSha?: string | null
): HandoffArtifactState {
  if (envelope.payloadError) return 'failed';
  const head = artifactHeadSha(envelope);
  if (envelope.staleness?.stale) return 'stale';
  if (currentHeadSha && head) return currentHeadSha === head ? 'current' : 'stale';
  if (envelope.staleness && !envelope.staleness.stale) return 'current';
  return 'unknown';
}

function labelForState(state: HandoffArtifactState): string {
  switch (state) {
    case 'missing':
      return 'missing';
    case 'current':
      return 'current';
    case 'stale':
      return 'stale';
    case 'failed':
      return 'failed';
    case 'unknown':
      return 'captured';
  }
}

export function safeExternalUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(
      value,
      typeof window === 'undefined' ? 'http://localhost' : window.location.origin
    );
    if (url.protocol !== 'https:') return null;
    return url.toString();
  } catch {
    return null;
  }
}

function openUrlFor(envelope: PipelineHandoffArtifactEnvelope): string | null {
  const candidates = [
    envelope.metadata.taskRef?.url,
    envelope.payload?.head.pr?.url,
    ...(envelope.payload?.scope.taskRefs.map((taskRef) => taskRef.url) ?? []),
  ];
  for (const candidate of candidates) {
    const safeUrl = safeExternalUrl(candidate);
    if (safeUrl) return safeUrl;
  }
  return null;
}

export function formatDownstreamFocus(items: string[], limit = 2): string {
  if (items.length === 0) return 'none';
  const visible = items.slice(0, limit).join(' · ');
  const hidden = items.length - limit;
  return hidden > 0 ? `${visible} · +${hidden}` : visible;
}

export function summarizeHandoffArtifact(
  envelope: PipelineHandoffArtifactEnvelope,
  currentHeadSha?: string | null
): HandoffTimelineSummary {
  const stage = latestStage(envelope.payload);
  const state = stateFor(envelope, currentHeadSha);
  const presentStages = new Map(
    envelope.payload?.stages.map((item) => [item.stage, item]) ?? []
  );
  return {
    state,
    stateLabel: labelForState(state),
    stageLabel: stage?.stage ?? envelope.metadata.stage ?? 'missing',
    shortHeadSha: shortSha(artifactHeadSha(envelope)),
    evidenceCount: stageEvidenceCount(stage),
    verdict: stageVerdict(stage),
    downstreamFocus: stage?.downstreamFocus ?? [],
    openUrl: openUrlFor(envelope),
    payloadError: envelope.payloadError ?? null,
    stages: STAGE_ORDER.map((name) => {
      const item = presentStages.get(name);
      return {
        stage: name,
        status: item ? 'present' : 'missing',
        evidenceCount: stageEvidenceCount(item),
        verdict: stageVerdict(item),
        downstreamFocus: item?.downstreamFocus ?? [],
      };
    }),
  };
}

export function missingHandoffArtifactSummary(): HandoffTimelineSummary {
  return {
    state: 'missing',
    stateLabel: 'missing',
    stageLabel: 'missing',
    shortHeadSha: null,
    evidenceCount: 0,
    verdict: 'missing',
    downstreamFocus: [],
    openUrl: null,
    payloadError: null,
    stages: STAGE_ORDER.map((stage) => ({
      stage,
      status: 'missing',
      evidenceCount: 0,
      verdict: 'missing',
      downstreamFocus: [],
    })),
  };
}

export function formatHandoffArtifactCopy(
  artifact: PublicPipelineHandoffArtifactSummary | { metadata: PublicPipelineHandoffArtifactSummary; payload?: PipelineHandoffArtifact }
): string {
  if ('payload' in artifact && artifact.payload) {
    return renderPipelineHandoffMarkdown(artifact.payload, { public: true });
  }
  return `${JSON.stringify(artifact, null, 2)}\n`;
}
