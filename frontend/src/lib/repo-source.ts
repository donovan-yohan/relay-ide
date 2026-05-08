import type { Repo, RepoWebhookStatus } from './types.js';

interface RepoEnrichmentSourceMeta {
  source?: 'webhook' | 'manual' | undefined;
}

export function deriveRepoWebhookStatus(
  repo: Pick<Repo, 'webhookStatus'> | null | undefined,
  meta?: RepoEnrichmentSourceMeta | null
): RepoWebhookStatus {
  return repo?.webhookStatus ?? (meta?.source === 'webhook' ? 'live' : 'manual');
}
