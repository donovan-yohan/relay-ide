import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  CHANNEL_SEARCH_MIN_QUERY_CHARS,
  parseChannelSearchSnippet,
  type ChannelMessageSearchResult,
} from '../../../shared/channel-chat-protocol.js';
import { parseChannelSearchQuery } from '../../../shared/channel-search-query.js';
import type { WorkspaceTopic } from '../../../shared/workspace-topics.js';
import { fetchWorkspaceTopics, searchChannelMessages } from '../lib/api.js';
import { senderShortLabel } from '../lib/channel-sender-label.js';
import { useChannelSearchPanelStore } from '../lib/stores/channel-search-panel.js';
import { openChannelMessageSelection } from '../lib/topic-selection.js';
import { formatRelativeTimeCompact } from '../lib/utils.js';
import './ChannelSearchPanel.css';

const SEARCH_DEBOUNCE_MS = 150;
const SEARCH_RESULT_LIMIT = 50;

function useDebouncedValue(value: string): string {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    if (settled === value) return;
    const timer = setTimeout(() => setSettled(value), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [settled, value]);
  return settled;
}

function SearchSnippet({ snippet }: { snippet: string }) {
  return (
    <span className="channel-search-result__snippet">
      {parseChannelSearchSnippet(snippet).map((segment, index) =>
        segment.highlight ? (
          <mark key={index} className="channel-search-result__hit">
            {segment.text}
          </mark>
        ) : (
          <span key={index}>{segment.text}</span>
        )
      )}
    </span>
  );
}

function SearchResult({
  hit,
  topic,
}: {
  hit: ChannelMessageSearchResult;
  topic?: WorkspaceTopic | undefined;
}) {
  return (
    <button
      type="button"
      className="channel-search-result"
      data-message-id={hit.messageId}
      title={`open ${hit.channelTitle} at this message`}
      onClick={() =>
        openChannelMessageSelection({
          channelId: hit.channelId,
          messageId: hit.messageId,
          ...(topic ? { topic } : {}),
        })
      }
    >
      <span className="channel-search-result__head">
        <span className="channel-search-result__channel">
          {hit.channelTitle}
        </span>
        <span className="channel-search-result__sender">
          {senderShortLabel(hit)}
        </span>
        {hit.threadId ? (
          <span className="channel-search-result__tag">thread</span>
        ) : null}
        {hit.archived ? (
          <span className="channel-search-result__tag">older</span>
        ) : null}
        <time className="channel-search-result__time" dateTime={hit.createdAt}>
          {formatRelativeTimeCompact(hit.createdAt)}
        </time>
      </span>
      <SearchSnippet snippet={hit.snippet} />
    </button>
  );
}

function searchGuidance(input: {
  query: string;
  text: string;
  aliases: readonly string[];
  invalidAlias?: string | undefined;
  unavailableReason?: string | undefined;
  scopeAlias?: string | undefined;
}): string {
  if (input.invalidAlias !== undefined)
    return 'finish the in: project or channel scope';
  if (!input.query.trim()) return 'type to search message history';
  if (!input.text && input.aliases.length > 0)
    return 'scope set — add search terms after the in: filter';
  if (input.text.length < CHANNEL_SEARCH_MIN_QUERY_CHARS)
    return `type ${CHANNEL_SEARCH_MIN_QUERY_CHARS} characters to search messages`;
  if (input.unavailableReason === 'scope_not_found')
    return input.scopeAlias
      ? `no visible project or channel named “${input.scopeAlias}”`
      : 'no visible project or channel matches that scope';
  if (input.unavailableReason === 'scope_ambiguous')
    return input.scopeAlias
      ? `“${input.scopeAlias}” matches more than one project or channel`
      : 'that project or channel scope is ambiguous';
  if (input.unavailableReason === 'search_query_too_broad')
    return 'too many matches to rank — type more characters';
  if (input.unavailableReason === 'search_timeout')
    return 'search took too long — type more characters';
  if (input.unavailableReason === 'no_searchable_term')
    return 'no searchable term to look up';
  return `no messages match “${input.text}”`;
}

export function ChannelSearchPanel({ open }: { open: boolean }) {
  const query = useChannelSearchPanelStore((state) => state.query);
  const setQuery = useChannelSearchPanelStore((state) => state.setQuery);
  const close = useChannelSearchPanelStore((state) => state.close);
  const boundChannelId = useChannelSearchPanelStore(
    (state) => state.boundChannelId
  );
  const [includeArchived, setIncludeArchived] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const typed = query.trim();
  const settled = useDebouncedValue(typed);
  const parsedTyped = useMemo(() => parseChannelSearchQuery(typed), [typed]);
  const parsedSettled = useMemo(
    () => parseChannelSearchQuery(settled),
    [settled]
  );
  const enabled =
    open &&
    parsedSettled.invalidAlias === undefined &&
    parsedSettled.text.length >= CHANNEL_SEARCH_MIN_QUERY_CHARS;
  const resultsQuery = useQuery({
    queryKey: [
      'channel-message-search',
      'right-panel',
      settled,
      boundChannelId ?? 'alias-scope',
      includeArchived ? 'with-archived' : 'active-only',
    ],
    queryFn: () =>
      searchChannelMessages({
        q: settled,
        limit: SEARCH_RESULT_LIMIT,
        includeArchived,
        ...(boundChannelId ? { channelId: boundChannelId } : {}),
      }),
    enabled,
    staleTime: 10_000,
  });
  // Reuse the rail's canonical topic cache so result jumps carry the same
  // workspace/repo context as opening that channel from navigation. Older hits
  // use the archived cache; a retained message whose topic is outside the
  // bounded list still opens safely by id through the helper's fallback.
  const topicsQuery = useQuery({
    queryKey: ['workspace-topics', 'with-archived'],
    queryFn: () => fetchWorkspaceTopics({ includeArchived: true }),
    staleTime: 30_000,
    enabled: open,
  });
  const topicsById = useMemo(
    () =>
      new Map(
        (topicsQuery.data?.topics ?? []).map((topic) => [topic.id, topic])
      ),
    [topicsQuery.data]
  );

  const handleClose = useCallback(() => {
    const restoreTarget = previousFocusRef.current;
    close();
    requestAnimationFrame(() => restoreTarget?.focus());
  }, [close]);

  useEffect(() => {
    if (!open) return;
    previousFocusRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const frame = requestAnimationFrame(() => {
      inputRef.current?.focus();
      const end = inputRef.current?.value.length ?? 0;
      inputRef.current?.setSelectionRange(end, end);
    });
    return () => cancelAnimationFrame(frame);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      handleClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [handleClose, open]);

  const debouncePending = typed !== settled;
  const loading = enabled && (debouncePending || resultsQuery.isFetching);
  const data = resultsQuery.data;
  const results = data?.results ?? [];
  const canClaimEmpty = enabled && !loading && !resultsQuery.isError;
  const resultCountLabel = loading
    ? 'searching…'
    : data
      ? `${results.length} results`
      : 'ready';

  const focusResult = useCallback((index: number) => {
    const rows = resultsRef.current?.querySelectorAll<HTMLButtonElement>(
      '.channel-search-result'
    );
    if (!rows?.length) return;
    rows[Math.max(0, Math.min(index, rows.length - 1))]?.focus();
  }, []);

  return (
    <aside
      id="channel-search-panel"
      className="channel-search-panel"
      aria-label="message search"
    >
      <header className="channel-search-panel__header">
        <span>search messages</span>
        <button
          type="button"
          className="channel-search-panel__close"
          aria-label="close message search"
          onClick={handleClose}
        >
          close
        </button>
      </header>
      <label className="channel-search-panel__input-row">
        <span aria-hidden="true">/</span>
        <input
          ref={inputRef}
          id="channel-search-panel-input"
          type="text"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="search messages or use in:project"
          aria-label="search message history"
          spellCheck={false}
          onKeyDown={(event) => {
            if (event.key !== 'ArrowDown') return;
            event.preventDefault();
            focusResult(0);
          }}
        />
        {query ? (
          <button type="button" onClick={() => setQuery('')}>
            clear
          </button>
        ) : null}
      </label>
      <div className="channel-search-panel__options">
        <button
          type="button"
          aria-pressed={includeArchived}
          onClick={() => setIncludeArchived((value) => !value)}
        >
          [{includeArchived ? 'x' : ' '}] include older chats
        </button>
        <span aria-live="polite">{resultCountLabel}</span>
      </div>
      <div
        ref={resultsRef}
        className="channel-search-panel__body"
        onKeyDown={(event) => {
          const row = (event.target as HTMLElement).closest(
            '.channel-search-result'
          );
          if (!row) return;
          const rows = Array.from(
            resultsRef.current?.querySelectorAll('.channel-search-result') ?? []
          );
          const index = rows.indexOf(row);
          if (event.key === 'ArrowDown') {
            event.preventDefault();
            focusResult(index + 1);
          } else if (event.key === 'ArrowUp') {
            event.preventDefault();
            focusResult(index - 1);
          } else if (event.key === 'Home') {
            event.preventDefault();
            focusResult(0);
          } else if (event.key === 'End') {
            event.preventDefault();
            focusResult(rows.length - 1);
          }
        }}
      >
        {resultsQuery.isError ? (
          <div className="channel-search-panel__state error" role="status">
            <span>message search unavailable</span>
            <button type="button" onClick={() => void resultsQuery.refetch()}>
              retry
            </button>
          </div>
        ) : null}
        {loading && results.length === 0 ? (
          <div className="channel-search-panel__state" role="status">
            searching history…
          </div>
        ) : null}
        {results.map((hit) => (
          <SearchResult
            key={hit.messageId}
            hit={hit}
            topic={topicsById.get(hit.channelId)}
          />
        ))}
        {canClaimEmpty && results.length === 0 ? (
          <div className="channel-search-panel__state" role="status">
            {searchGuidance({
              query: typed,
              text: parsedTyped.text,
              aliases: parsedTyped.aliases,
              ...(parsedTyped.invalidAlias !== undefined
                ? { invalidAlias: parsedTyped.invalidAlias }
                : {}),
              ...(data?.unavailableReason
                ? { unavailableReason: data.unavailableReason }
                : {}),
              ...(data?.scopeAlias ? { scopeAlias: data.scopeAlias } : {}),
            })}
          </div>
        ) : null}
        {!enabled && !resultsQuery.isError ? (
          <div className="channel-search-panel__state" role="status">
            {searchGuidance({
              query: typed,
              text: parsedTyped.text,
              aliases: parsedTyped.aliases,
              ...(parsedTyped.invalidAlias !== undefined
                ? { invalidAlias: parsedTyped.invalidAlias }
                : {}),
            })}
          </div>
        ) : null}
        {data?.truncated ? (
          <div className="channel-search-panel__state">
            results truncated — refine search
          </div>
        ) : null}
      </div>
      <footer className="channel-search-panel__footer">
        <kbd>esc</kbd> close · edit or remove <code>in:</code> to change scope
      </footer>
    </aside>
  );
}

export default ChannelSearchPanel;
