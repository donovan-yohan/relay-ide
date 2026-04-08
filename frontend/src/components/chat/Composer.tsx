import React, { useRef, useEffect, useCallback } from 'react';
import './Composer.css';

interface ComposerProps {
  onSend: (content: string) => void;
  onInterrupt: () => void;
  isActive: boolean;
}

export const Composer: React.FC<ComposerProps> = ({
  onSend,
  onInterrupt,
  isActive,
}) => {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const resize = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    const lineHeight = parseInt(getComputedStyle(el).lineHeight, 10) || 20;
    const maxHeight = lineHeight * 6 + 32; // 6 lines + padding
    el.style.height = Math.min(el.scrollHeight, maxHeight) + 'px';
  }, []);

  useEffect(() => {
    resize();
  }, [resize]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        const el = textareaRef.current;
        if (!el) return;
        const content = el.value.trim();
        if (!content) return;
        onSend(content);
        el.value = '';
        resize();
      }
    },
    [onSend, resize]
  );

  const handleInput = useCallback(() => {
    resize();
  }, [resize]);

  const handleSendClick = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    const content = el.value.trim();
    if (!content) return;
    onSend(content);
    el.value = '';
    resize();
  }, [onSend, resize]);

  return (
    <div className="composer">
      <textarea
        ref={textareaRef}
        className="composer__textarea"
        placeholder="type a message..."
        onKeyDown={handleKeyDown}
        onInput={handleInput}
        rows={1}
        disabled={isActive}
      />
      <div className="composer__actions">
        {isActive ? (
          <button
            className="composer__btn composer__btn--interrupt"
            type="button"
            onClick={onInterrupt}
          >
            interrupt
          </button>
        ) : (
          <button
            className="composer__btn composer__btn--send"
            type="button"
            onClick={handleSendClick}
          >
            send
          </button>
        )}
      </div>
    </div>
  );
};

export default Composer;
