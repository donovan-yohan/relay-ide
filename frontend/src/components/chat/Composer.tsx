import React, { useCallback, useEffect, useRef, useState } from 'react';
import './Composer.css';
import type {
  AgentCapabilitySetV2,
  AgentSessionLiveStateV2,
  AgentUsageV2,
} from '../../../../shared/agent-chat-protocol-v2.js';
import { SlashPalette } from './SlashPalette.js';

interface ComposerProps {
  onSend: (content: string) => void;
  onInterrupt: () => void;
  isActive: boolean;
  capabilities?: AgentCapabilitySetV2 | undefined;
  live?: AgentSessionLiveStateV2 | undefined;
  usage?: AgentUsageV2 | undefined;
}

export const Composer: React.FC<ComposerProps> = ({
  onSend,
  onInterrupt,
  isActive,
  capabilities = {},
  live,
  usage,
}) => {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
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

  const submitDraft = useCallback(() => {
    const content = draft.trim();
    if (!content) return;
    onSend(content);
    setDraft('');
  }, [draft, onSend]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        submitDraft();
      }
    },
    [submitDraft]
  );

  const contextLabel =
    usage?.contextPercent != null ? `${usage.contextPercent}% ctx` : 'ctx';

  return (
    <div className="slash-anchor">
      <SlashPalette capabilities={capabilities} draft={draft} />
      <div className="composer" role="form" aria-label="message composer">
        <textarea
          ref={textareaRef}
          className="composer__ta"
          placeholder="type a message…  /  for commands · shift+enter for newline"
          onKeyDown={handleKeyDown}
          onChange={(event) => setDraft(event.currentTarget.value)}
          value={draft}
          rows={1}
          data-streaming={isActive ? 'true' : 'false'}
          aria-label="message input"
        />
        <div className="composer__bar">
          <span className="composer__hint">
            <kbd>↵</kbd>send <kbd>⇧↵</kbd>newline <kbd>/</kbd>commands
          </span>
          <span className="right">
            <button
              className="cbar-trigger"
              type="button"
              aria-haspopup="true"
              aria-expanded="false"
            >
              {contextLabel}
            </button>
            {isActive ? (
              <button
                className="composer__btn composer__btn--interrupt"
                type="button"
                onClick={onInterrupt}
                aria-label="interrupt agent"
              >
                ■
              </button>
            ) : (
              <button
                className="composer__btn composer__btn--send"
                type="button"
                onClick={submitDraft}
                aria-label="send message"
              >
                send
              </button>
            )}
          </span>
        </div>
        {live?.error && <div className="composer__error">{live.error}</div>}
      </div>
    </div>
  );
};

export default Composer;
