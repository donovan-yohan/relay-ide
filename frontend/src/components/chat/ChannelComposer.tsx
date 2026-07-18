import React, { useCallback, useEffect, useRef, useState } from 'react';
import './ChannelComposer.css';
import { createBrowserId } from '../../lib/browserId.js';

const LINE_BREAK_INPUT_TYPES = new Set(['insertLineBreak', 'insertParagraph']);
const LINE_BREAK_BEFOREINPUT_SKIP_WINDOW_MS = 500;
const IMAGE_ATTACH_TOOLTIP =
  'image attachments are coming in a future update — the channel API does not accept them yet';

interface ChannelComposerProps {
  channelTitle: string;
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
  channelTitle,
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
      })
      .catch(() => {
        // Keep the draft AND the same clientMessageId so a retry (press enter
        // again) dedupes server-side instead of double-posting.
      })
      .finally(() => {
        sendingRef.current = false;
      });
  }, [draft, onSend]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      const nativeEvent = e.nativeEvent as KeyboardEvent;
      if (e.key === 'Enter' && nativeEvent.isComposing) return;
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
    [submit]
  );

  // Mobile IME parity: some IMEs only report a beforeinput line-break intent for
  // the send key, no reliable keydown. Treat it as send before it mutates the
  // controlled draft. Copied from Composer.tsx (LINE_BREAK_INPUT_TYPES handling).
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
      submit();
    },
    [submit]
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
      <textarea
        ref={textareaRef}
        className="ch-composer__ta"
        placeholder={`message #${channelTitle}…  ·  shift+enter for newline`}
        value={draft}
        rows={1}
        enterKeyHint="send"
        aria-label="message input"
        data-pending={postPending ? 'true' : 'false'}
        onChange={(event) => setDraft(event.currentTarget.value)}
        onKeyDown={handleKeyDown}
        onPaste={swallowImagePaste}
        onDrop={swallowImageDrop}
        onDragOver={(e) => e.preventDefault()}
      />
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
          <kbd>↵</kbd>send <kbd>⇧↵</kbd>newline
        </span>
      </div>
    </div>
  );
};

export default ChannelComposer;
