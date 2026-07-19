import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import './ChannelComposer.css';
import { useQuery } from '@tanstack/react-query';
import { createBrowserId } from '../../lib/browserId.js';
import { fetchChannelRoster } from '../../lib/api.js';
import { detectTrigger } from './slashTrigger.js';
import { MentionPalette, filterRoster } from './MentionPalette.js';

const LINE_BREAK_INPUT_TYPES = new Set(['insertLineBreak', 'insertParagraph']);
const LINE_BREAK_BEFOREINPUT_SKIP_WINDOW_MS = 500;
const IMAGE_ATTACH_TOOLTIP =
  'image attachments are coming in a future update — the channel API does not accept them yet';

interface ChannelComposerProps {
  channelId: string;
  channelTitle: string;
  placeholder?: string;
  /** Idempotent send: the SAME clientMessageId is reused across manual retries. */
  onSend: (text: string, clientMessageId: string) => Promise<void>;
  postPending: boolean;
  /** 503 CHANNEL_STORE_UNAVAILABLE — persistent inline banner, input stays live. */
  storeDown: boolean;
  /** 409 CHANNEL_ARCHIVED — composer replaced by a restore bar. */
  archived: boolean;
  onRestore: () => void;
  restorePending: boolean;
}

export const ChannelComposer: React.FC<ChannelComposerProps> = ({
  channelId,
  channelTitle,
  placeholder,
  onSend,
  postPending,
  storeDown,
  archived,
  onRestore,
  restorePending,
}) => {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const skipNextLineBreakUntilRef = useRef(0);
  // Idempotency (§6.3): one clientMessageId per draft attempt, reused on retry
  // until a send succeeds, so a flaky connection never double-posts.
  const clientIdRef = useRef<string | null>(null);
  const sendingRef = useRef(false);
  const [draft, setDraft] = useState('');
  const [caret, setCaret] = useState(0);
  const [activeIndex, setActiveIndex] = useState(0);
  const [paletteDismissed, setPaletteDismissed] = useState(false);

  // @mention trigger (#1167). Broader boundary than slash (`(@x`, `hey,@x` are
  // mentions) — see slashTrigger.detectTrigger. Roster is fetched lazily on the
  // first @ per channel and cached 30s; TanStack dedupes with the header query.
  const trigger = detectTrigger(draft, caret, ['@']);
  const rosterQuery = useQuery({
    queryKey: ['channel-roster', channelId],
    queryFn: () => fetchChannelRoster(channelId),
    staleTime: 30_000,
    enabled: trigger !== null,
    retry: false,
  });
  // Memoize on the query string + roster data (stable primitives) so palette
  // navigation callbacks don't churn on every keystroke that leaves both intact.
  const triggerQuery = trigger?.query ?? null;
  const rosterData = rosterQuery.data;
  const entries = useMemo(
    () =>
      triggerQuery === null ? [] : filterRoster(rosterData ?? [], triggerQuery),
    [triggerQuery, rosterData]
  );
  const paletteVisible =
    trigger !== null && !paletteDismissed && entries.length > 0;

  const resize = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    const lineHeight = parseInt(getComputedStyle(el).lineHeight, 10) || 20;
    const maxHeight = lineHeight * 6 + 32;
    el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`;
  }, []);

  useEffect(() => {
    resize();
  }, [draft, resize]);

  // Reset palette selection + reopen it whenever the draft changes (typing after
  // an Escape dismissal re-surfaces the palette).
  useEffect(() => {
    setActiveIndex(0);
    setPaletteDismissed(false);
  }, [draft]);

  const updateCaret = useCallback(() => {
    const el = textareaRef.current;
    if (el) setCaret(el.selectionStart ?? 0);
  }, []);

  const submit = useCallback(() => {
    const content = draft.trim();
    if (!content || sendingRef.current) return;
    if (!clientIdRef.current) clientIdRef.current = createBrowserId('chm');
    const clientMessageId = clientIdRef.current;
    sendingRef.current = true;
    void onSend(content, clientMessageId)
      .then(() => {
        // Success: the row arrives via the socket, not this promise. Reset the
        // draft and idempotency key so the next message is a fresh attempt.
        clientIdRef.current = null;
        setDraft('');
        setCaret(0);
      })
      .catch(() => {
        // Keep the draft AND the same clientMessageId so a retry (press enter
        // again) dedupes server-side instead of double-posting.
      })
      .finally(() => {
        sendingRef.current = false;
      });
  }, [draft, onSend]);

  // Splice the selected AVAILABLE agent into the draft as plain `@<id> ` text
  // (no rich pill), replacing the active trigger span.
  const applyMention = useCallback(() => {
    if (!trigger) return;
    const entry = entries[activeIndex];
    if (!entry || !entry.available) return;
    const replacement = `@${entry.id} `;
    const newDraft =
      draft.slice(0, trigger.span[0]) +
      replacement +
      draft.slice(trigger.span[1]);
    const newCaret = trigger.span[0] + replacement.length;
    setDraft(newDraft);
    setCaret(newCaret);
    setActiveIndex(0);
    setPaletteDismissed(false);
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (el) {
        el.selectionStart = newCaret;
        el.selectionEnd = newCaret;
        el.focus();
      }
    });
  }, [trigger, entries, activeIndex, draft]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      const nativeEvent = e.nativeEvent as KeyboardEvent;
      if (e.key === 'Enter' && nativeEvent.isComposing) return;

      if (paletteVisible) {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          setActiveIndex((i) => Math.min(i + 1, entries.length - 1));
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          setActiveIndex((i) => Math.max(i - 1, 0));
          return;
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          setPaletteDismissed(true);
          return;
        }
        if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
          e.preventDefault();
          const entry = entries[activeIndex];
          if (entry && entry.available) applyMention();
          // Unavailable/none → no-op: swallow the key so Enter neither sends
          // nor inserts and Tab does not move focus out of the composer.
          return;
        }
      }

      if (e.key === 'Enter' && e.shiftKey) {
        skipNextLineBreakUntilRef.current =
          performance.now() + LINE_BREAK_BEFOREINPUT_SKIP_WINDOW_MS;
        return;
      }
      skipNextLineBreakUntilRef.current = 0;
      if (e.key === 'Enter') {
        e.preventDefault();
        submit();
      }
    },
    [paletteVisible, entries, activeIndex, applyMention, submit]
  );

  // Mobile IME parity: some IMEs only report a beforeinput line-break intent for
  // the send key, no reliable keydown. Treat it as send (or, with the palette
  // open, a mention pick) before it mutates the controlled draft.
  const handleBeforeInput = useCallback(
    (inputEvent: InputEvent) => {
      if (!LINE_BREAK_INPUT_TYPES.has(inputEvent.inputType)) return;
      if (inputEvent.isComposing) return;
      if (
        skipNextLineBreakUntilRef.current > 0 &&
        performance.now() <= skipNextLineBreakUntilRef.current
      ) {
        skipNextLineBreakUntilRef.current = 0;
        return;
      }
      skipNextLineBreakUntilRef.current = 0;
      inputEvent.preventDefault();
      if (paletteVisible) {
        const entry = entries[activeIndex];
        if (entry && entry.available) applyMention();
        return;
      }
      submit();
    },
    [paletteVisible, entries, activeIndex, applyMention, submit]
  );

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.addEventListener('beforeinput', handleBeforeInput);
    return () => textarea.removeEventListener('beforeinput', handleBeforeInput);
  }, [handleBeforeInput]);

  // Paste/drop of image files is detected and swallowed (no text paste of
  // binary) — the attach affordance is visibly present but inert in slice 3.
  const swallowImagePaste = useCallback(
    (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const item of Array.from(items)) {
        if (item.kind === 'file' && item.type.startsWith('image/')) {
          e.preventDefault();
          return;
        }
      }
    },
    []
  );

  const swallowImageDrop = useCallback(
    (e: React.DragEvent<HTMLTextAreaElement>) => {
      const dropped = e.dataTransfer?.files;
      if (
        dropped &&
        Array.from(dropped).some((f) => f.type.startsWith('image/'))
      ) {
        e.preventDefault();
      }
    },
    []
  );

  if (archived) {
    return (
      <div className="ch-composer ch-composer--archived" role="form">
        <div className="ch-composer__archived-bar">
          <span>this channel is archived</span>
          <button
            type="button"
            className="ch-composer__restore"
            onClick={onRestore}
            disabled={restorePending}
          >
            {restorePending ? 'restoring…' : 'restore'}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="ch-composer" role="form" aria-label="message composer">
      {storeDown ? (
        <div className="ch-composer__banner" role="alert">
          channel store unavailable — retry shortly
        </div>
      ) : null}
      <div className="ch-composer__mention-anchor">
        <MentionPalette
          entries={entries}
          activeIndex={activeIndex}
          visible={paletteVisible}
        />
        <textarea
          ref={textareaRef}
          className="ch-composer__ta"
          placeholder={
            placeholder ??
            `message #${channelTitle}…  ·  @ to mention · shift+enter for newline`
          }
          value={draft}
          rows={1}
          enterKeyHint="send"
          aria-label="message input"
          data-pending={postPending ? 'true' : 'false'}
          onChange={(event) => {
            setDraft(event.currentTarget.value);
            setCaret(event.currentTarget.selectionStart ?? 0);
          }}
          onKeyDown={handleKeyDown}
          onKeyUp={updateCaret}
          onClick={updateCaret}
          onSelect={updateCaret}
          onPaste={swallowImagePaste}
          onDrop={swallowImageDrop}
          onDragOver={(e) => e.preventDefault()}
        />
      </div>
      <div className="ch-composer__bar">
        <button
          type="button"
          className="ch-composer__attach"
          aria-label="attach image"
          title={IMAGE_ATTACH_TOOLTIP}
          disabled
        >
          +img
        </button>
        <span className="ch-composer__hint">
          <kbd>↵</kbd>send <kbd>⇧↵</kbd>newline <kbd>@</kbd>mention
        </span>
      </div>
    </div>
  );
};

export default ChannelComposer;
