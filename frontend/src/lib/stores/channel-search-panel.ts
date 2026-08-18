import { create } from 'zustand';

export function formatChannelSearchScope(
  alias: string | null | undefined
): string {
  const normalized = alias?.normalize('NFKC').trim();
  if (!normalized) return '';
  const escaped = normalized.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
  const rendered = /\s|["\\]/.test(normalized) ? `"${escaped}"` : escaped;
  return `in:${rendered} `;
}

export function resolvedChannelSearchAlias(
  channelTitle: string | null | undefined,
  topicTitle: string | null | undefined
): string | null {
  return channelTitle?.trim() || topicTitle?.trim() || null;
}

interface ChannelSearchPanelState {
  open: boolean;
  query: string;
  /** True until the operator edits the generated active-channel scope. */
  autoSeeded: boolean;
  seedPrefix: string;
  boundChannelId: string | null;
  openForAlias: (alias?: string | null, channelId?: string | null) => void;
  close: () => void;
  setQuery: (query: string) => void;
}

export const useChannelSearchPanelStore = create<ChannelSearchPanelState>()(
  (set, get) => ({
    open: false,
    query: '',
    autoSeeded: true,
    seedPrefix: '',
    boundChannelId: null,
    openForAlias: (alias, channelId) => {
      const current = get();
      // An already-open panel is an active search session. Re-focusing its
      // trigger must not replace appended terms or a user-chosen scope.
      if (current.open) return;
      const seedPrefix = formatChannelSearchScope(alias);
      set({
        open: true,
        ...(current.autoSeeded
          ? {
              query: seedPrefix,
              seedPrefix,
              boundChannelId: seedPrefix ? (channelId ?? null) : null,
            }
          : {}),
      });
    },
    // A dismissed search is a completed search session. Reopening should adopt
    // the channel that is active then; navigation while still open preserves
    // the operator's edits because it never passes through this reset.
    close: () =>
      set({
        open: false,
        autoSeeded: true,
        seedPrefix: '',
        boundChannelId: null,
      }),
    setQuery: (query) => {
      const current = get();
      const keepsGeneratedScope =
        current.autoSeeded &&
        current.seedPrefix.length > 0 &&
        query.startsWith(current.seedPrefix);
      set({
        query,
        autoSeeded: keepsGeneratedScope,
        ...(keepsGeneratedScope
          ? {}
          : { seedPrefix: '', boundChannelId: null }),
      });
    },
  })
);
