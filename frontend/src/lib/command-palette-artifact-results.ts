import type { ArtifactKind } from '../../../shared/work-context.js';
import type { WorkspaceTopic } from '../../../shared/workspace-topics.js';
import { searchWorkContextArtifacts } from './api.js';
import type { PipelineHandoffArtifactEnvelope } from './pipeline-handoff-timeline.js';

export interface ArtifactPaletteResult {
  type: 'artifact';
  id: string;
  label: string;
  sublabel: string;
  data: PipelineHandoffArtifactEnvelope;
}

/** TUI-style glyph per artifact kind (#1065) — distinct from the generic per-type icon. */
export function artifactKindIcon(kind: ArtifactKind | undefined): string {
  switch (kind) {
    case 'diff':
      return '±';
    case 'log-ref':
      return '≣';
    case 'transcript-ref':
      return '¶';
    case 'screenshot':
      return '▧';
    case 'report':
      return '▥';
    case 'command-output-ref':
      return '»';
    case 'external':
      return '↗';
    case 'file':
    default:
      return '▤';
  }
}

/** The topic (channel) a WorkContext is linked to, so results show where to open it (mirrors #1093 for sessions). */
function topicTitleForWorkContext(
  workContextId: string,
  topics: WorkspaceTopic[]
): string | null {
  const topic = topics.find((candidate) =>
    candidate.linkedRefs.workContextIds?.includes(workContextId)
  );
  return topic?.display.title ?? null;
}

function toArtifactPaletteResult(
  envelope: PipelineHandoffArtifactEnvelope,
  topics: WorkspaceTopic[]
): ArtifactPaletteResult {
  const meta = envelope.metadata;
  const topicTitle = topicTitleForWorkContext(meta.workContextId, topics);
  return {
    type: 'artifact',
    id: `artifact-${meta.id}`,
    label: meta.title || meta.id,
    sublabel: `${topicTitle ?? meta.workContextId} · ${meta.kind}`,
    data: envelope,
  };
}

/** Pure mapping from already-fetched search results to palette result objects. */
export function buildArtifactPaletteResults(
  envelopes: PipelineHandoffArtifactEnvelope[],
  topics: WorkspaceTopic[] = [],
  limit = 5
): ArtifactPaletteResult[] {
  return envelopes
    .slice(0, limit)
    .map((envelope) => toArtifactPaletteResult(envelope, topics));
}

/**
 * Debounced-fetch entry point for the command palette (#1065): the palette
 * only calls this once `query` has settled (see CommandPalette's
 * `debouncedQuery`), so this function itself does a single hub-wide search
 * request and maps the metadata-only response to palette results. Never
 * fetches or renders artifact body/payload content.
 */
export async function fetchArtifactPaletteResults(
  query: string,
  topics: WorkspaceTopic[] = [],
  limit = 5
): Promise<ArtifactPaletteResult[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];
  const envelopes = await searchWorkContextArtifacts(trimmed, { limit });
  return buildArtifactPaletteResults(envelopes, topics, limit);
}
