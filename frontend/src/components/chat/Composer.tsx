import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import './Composer.css';
import type {
  AgentCapabilitySetV2,
  AgentSessionLiveStateV2,
  AgentSlashCommandV2,
  AgentUsageV2,
} from '../../../../shared/agent-chat-protocol-v2.js';
import { createBrowserId } from '../../lib/browserId.js';
import { SlashPalette, useSlashCommands } from './SlashPalette.js';
import { detectSlashTrigger } from './slashTrigger.js';
import { renderInlineSkillTokens } from './skillTokens.js';

export type ClientCommandHandler = (
  args: string
) => { ok: true } | { ok: false; error: string };

/** Wire-shaped image attachment forwarded to the adapter (server Attachment). */
export interface ComposerSendAttachment {
  type: 'image';
  /** data: URI carrying the image bytes. */
  path: string;
  mimeType?: string;
}

/** Composer-local attachment state (richer than the wire shape, for chips). */
interface ComposerAttachment {
  id: string;
  dataUri: string;
  mimeType: string;
  name: string;
}

/** Reject images above this size to keep WebSocket frames sane. */
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const LINE_BREAK_INPUT_TYPES = new Set(['insertLineBreak', 'insertParagraph']);
const LINE_BREAK_BEFOREINPUT_SKIP_WINDOW_MS = 500;

interface ComposerProps {
  onSend: (content: string, attachments?: ComposerSendAttachment[]) => void;
  onInterrupt: () => void;
  isActive: boolean;
  capabilities?: AgentCapabilitySetV2 | undefined;
  live?: AgentSessionLiveStateV2 | undefined;
  usage?: AgentUsageV2 | undefined;
  slashCommands?: AgentSlashCommandV2[] | undefined;
  clientHandlers?: Record<string, ClientCommandHandler>;
  modelName?: string | undefined;
  /** Push a client-source error item to the timeline (replaces inline banners). */
  pushClientError?: (message: string, context?: string) => void;
}

function formatTokens(n: number): string {
  if (n >= 1000)
    return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1).replace(/\.0$/, '')}k`;
  return String(n);
}

/**
 * Build a command index keyed by lowercased command name (without prefix) and all aliases.
 * Used for overlay token highlighting and submit-time validation.
 */
function buildCommandIndex(commands: AgentSlashCommandV2[]): Set<string> {
  const index = new Set<string>();
  for (const cmd of commands) {
    const name = cmd.name.replace(/^[/$]/, '').toLowerCase();
    index.add(name);
    for (const alias of cmd.aliases ?? []) {
      index.add(alias.replace(/^[/$]/, '').toLowerCase());
    }
  }
  return index;
}

function toSendAttachments(
  attachments: ComposerAttachment[]
): ComposerSendAttachment[] | undefined {
  if (attachments.length === 0) return undefined;
  return attachments.map((a) => ({
    type: 'image' as const,
    path: a.dataUri,
    mimeType: a.mimeType,
  }));
}

export const Composer: React.FC<ComposerProps> = ({
  onSend,
  onInterrupt,
  isActive,
  capabilities = {},
  live: _live,
  usage,
  slashCommands,
  clientHandlers,
  modelName,
  pushClientError,
}) => {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const skipNextLineBreakBeforeInputUntilRef = useRef(0);
  const [draft, setDraft] = useState('');
  const [caret, setCaret] = useState(0);
  const [activeIndex, setActiveIndex] = useState(0);
  const [, setSendError] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const addImageFiles = useCallback(
    (files: FileList | File[]) => {
      const images = Array.from(files).filter((f) =>
        f.type.startsWith('image/')
      );
      for (const file of images) {
        if (file.size > MAX_IMAGE_BYTES) {
          pushClientError?.(
            `image too large: ${file.name} (max 8MB)`,
            'attach'
          );
          continue;
        }
        const reader = new FileReader();
        reader.onload = () => {
          const dataUri =
            typeof reader.result === 'string' ? reader.result : '';
          if (!dataUri) return;
          setAttachments((prev) => [
            ...prev,
            {
              id: createBrowserId('attachment'),
              dataUri,
              mimeType: file.type,
              name: file.name || 'image',
            },
          ]);
        };
        reader.readAsDataURL(file);
      }
    },
    [pushClientError]
  );

  const handlePaste = useCallback(
    (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      const files: File[] = [];
      for (const item of Array.from(items)) {
        if (item.kind === 'file' && item.type.startsWith('image/')) {
          const file = item.getAsFile();
          if (file) files.push(file);
        }
      }
      if (files.length > 0) {
        e.preventDefault();
        addImageFiles(files);
      }
    },
    [addImageFiles]
  );

  const handleDrop = useCallback(
    (e: React.DragEvent<HTMLTextAreaElement>) => {
      const dropped = e.dataTransfer?.files;
      if (!dropped || dropped.length === 0) return;
      const images = Array.from(dropped).filter((f) =>
        f.type.startsWith('image/')
      );
      if (images.length > 0) {
        e.preventDefault();
        addImageFiles(images);
      }
    },
    [addImageFiles]
  );

  const removeAttachment = useCallback((id: string) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  }, []);

  const filteredCommands = useSlashCommands(
    capabilities,
    draft,
    caret,
    slashCommands
  );
  const paletteVisible = filteredCommands.length > 0;

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

  // Reset active index when draft changes or palette visibility changes
  useEffect(() => {
    setActiveIndex(0);
  }, [draft]);

  // Clear send error when user types
  useEffect(() => {
    setSendError(null);
  }, [draft]);

  const updateCaret = useCallback(() => {
    const el = textareaRef.current;
    if (el) setCaret(el.selectionStart ?? 0);
  }, []);

  const commandIndex = useMemo(
    () => (slashCommands ? buildCommandIndex(slashCommands) : null),
    [slashCommands]
  );

  /** Submit-time validation per §4.4 */
  const validateAndSend = useCallback(
    (content: string): boolean => {
      // Only validate if capabilities.slashCommands is on and we have a command index
      if (capabilities.slashCommands !== true || !commandIndex) return true;

      // Find leading trigger at offset 0 or after leading newline
      const leadingTrigger = detectSlashTrigger(content, content.length);
      if (!leadingTrigger?.isLeading) return true;

      // Get the first whitespace-delimited token from the trigger
      const token = leadingTrigger.query.split(/\s/)[0];
      if (!token) return true; // empty trigger, let through

      if (!commandIndex.has(token.toLowerCase())) {
        const msg = `unknown command: ${leadingTrigger.prefix}${token}`;
        if (pushClientError) {
          pushClientError(msg);
        } else {
          setSendError(msg);
        }
        return false;
      }

      return true;
    },
    [capabilities.slashCommands, commandIndex, pushClientError]
  );

  // Intercept client-dispatch slash commands (handled in-frontend, never sent
  // to the adapter). Returns true when it fully handled the input.
  const tryClientCommand = useCallback(
    (content: string): boolean => {
      if (!clientHandlers || !slashCommands) return false;
      const leadingMatch = /^[/$](\S+)(?:\s+([\s\S]*))?$/.exec(content);
      if (!leadingMatch) return false;
      const name = (leadingMatch[1] ?? '').toLowerCase();
      const args = leadingMatch[2] ?? '';
      const matched = slashCommands.find(
        (cmd) =>
          cmd.dispatch === 'client' &&
          (cmd.name.replace(/^[/$]/, '').toLowerCase() === name ||
            (cmd.aliases ?? []).some(
              (a) => a.replace(/^[/$]/, '').toLowerCase() === name
            ))
      );
      if (!matched) return false;
      const handler =
        clientHandlers[matched.name.replace(/^[/$]/, '').toLowerCase()];
      if (!handler) {
        const missingMsg = `handler not implemented for ${matched.name}`;
        if (pushClientError) pushClientError(missingMsg, matched.name);
        else setSendError(missingMsg);
        return true;
      }
      const result = handler(args);
      if (!result.ok) {
        if (pushClientError) pushClientError(result.error, matched.name);
        else setSendError(result.error);
        return true;
      }
      setDraft('');
      setCaret(0);
      setSendError(null);
      return true;
    },
    [clientHandlers, slashCommands, pushClientError]
  );

  const submitDraft = useCallback(() => {
    const content = draft.trim();
    if (!content && attachments.length === 0) return;
    if (!validateAndSend(content)) return;
    if (tryClientCommand(content)) return;

    onSend(content, toSendAttachments(attachments));
    setDraft('');
    setCaret(0);
    setSendError(null);
    setAttachments([]);
  }, [draft, attachments, onSend, validateAndSend, tryClientCommand]);

  const applySelectedCommand = useCallback(() => {
    const cmd = filteredCommands[activeIndex];
    const trigger = detectSlashTrigger(draft, caret);
    if (!cmd || !trigger) return;
    const typedPrefix = trigger.prefix;
    const cmdName = cmd.command.replace(/^[/$]/, '');
    const replacement = `${typedPrefix}${cmdName}`;
    const newDraft =
      draft.slice(0, trigger.span[0]) +
      replacement +
      draft.slice(trigger.span[1]);
    const newCaret = trigger.span[0] + replacement.length;
    setDraft(newDraft);
    setCaret(newCaret);
    setActiveIndex(0);
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (el) {
        el.selectionStart = newCaret;
        el.selectionEnd = newCaret;
      }
    });
  }, [filteredCommands, activeIndex, draft, caret]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      const nativeEvent = e.nativeEvent as KeyboardEvent;
      if (paletteVisible) {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          setActiveIndex((i) => Math.min(i + 1, filteredCommands.length - 1));
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          setActiveIndex((i) => Math.max(i - 1, 0));
          return;
        }
        if (e.key === 'Enter' && !e.shiftKey && !nativeEvent.isComposing) {
          e.preventDefault();
          applySelectedCommand();
          return;
        }
        if (e.key === 'Tab') {
          e.preventDefault();
          applySelectedCommand();
          return;
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          setDraft('');
          setCaret(0);
          return;
        }
      }

      if (e.key === 'Enter' && nativeEvent.isComposing) return;

      if (e.key === 'Enter' && e.shiftKey) {
        skipNextLineBreakBeforeInputUntilRef.current =
          performance.now() + LINE_BREAK_BEFOREINPUT_SKIP_WINDOW_MS;
        return;
      }

      skipNextLineBreakBeforeInputUntilRef.current = 0;

      if (e.key === 'Enter') {
        e.preventDefault();
        submitDraft();
        return;
      }

      if (isActive && (e.key === 'Escape' || (e.key === 'c' && e.ctrlKey))) {
        e.preventDefault();
        onInterrupt();
      }
    },
    [
      paletteVisible,
      filteredCommands,
      applySelectedCommand,
      submitDraft,
      isActive,
      onInterrupt,
    ]
  );

  const handleBeforeInput = useCallback(
    (inputEvent: InputEvent) => {
      if (!LINE_BREAK_INPUT_TYPES.has(inputEvent.inputType)) return;

      if (inputEvent.isComposing) return;
      if (
        skipNextLineBreakBeforeInputUntilRef.current > 0 &&
        performance.now() <= skipNextLineBreakBeforeInputUntilRef.current
      ) {
        skipNextLineBreakBeforeInputUntilRef.current = 0;
        return;
      }
      skipNextLineBreakBeforeInputUntilRef.current = 0;

      // Some mobile IMEs do not emit a reliable keydown for the textarea send
      // key; they only report a beforeinput line-break intent. Treat that as
      // send before the newline mutates the controlled draft.
      inputEvent.preventDefault();
      if (paletteVisible) {
        applySelectedCommand();
        return;
      }
      submitDraft();
    },
    [paletteVisible, applySelectedCommand, submitDraft]
  );

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.addEventListener('beforeinput', handleBeforeInput);
    return () => {
      textarea.removeEventListener('beforeinput', handleBeforeInput);
    };
  }, [handleBeforeInput]);

  const ctxInput = usage?.inputTokens ?? 0;
  const ctxCached = usage?.cachedInputTokens ?? usage?.cacheReadTokens ?? 0;
  const ctxInputUncached = Math.max(0, ctxInput - ctxCached);
  const ctxOutput = usage?.outputTokens ?? 0;
  const ctxReasoning = usage?.reasoningOutputTokens ?? 0;
  const ctxUsed = ctxInputUncached + ctxCached + ctxOutput + ctxReasoning;
  const ctxWindow = usage?.contextWindowSize ?? 0;
  const ctxFree = Math.max(0, ctxWindow - ctxUsed);
  const ctxLabel =
    ctxWindow > 0
      ? `${formatTokens(ctxUsed)} / ${formatTokens(ctxWindow)}`
      : '—';
  const segments = useMemo(
    () =>
      ctxWindow > 0
        ? [
            { name: 'input', tokens: ctxInputUncached, color: 'var(--accent)' },
            { name: 'cached', tokens: ctxCached, color: 'var(--status-info)' },
            {
              name: 'output',
              tokens: ctxOutput,
              color: 'var(--status-success)',
            },
            {
              name: 'reasoning',
              tokens: ctxReasoning,
              color: 'var(--status-warning)',
            },
          ]
        : [],
    [ctxWindow, ctxInputUncached, ctxCached, ctxOutput, ctxReasoning]
  );
  const segmentPct = useCallback(
    (n: number): number =>
      ctxWindow > 0 ? Math.min(100, (n / ctxWindow) * 100) : 0,
    [ctxWindow]
  );
  const usedPct = segmentPct(ctxUsed);
  const [ctxPopOpen, setCtxPopOpen] = useState(false);
  const ctxAnchorRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!ctxPopOpen) return;
    const onDocClick = (e: MouseEvent) => {
      if (!ctxAnchorRef.current?.contains(e.target as Node)) {
        setCtxPopOpen(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setCtxPopOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [ctxPopOpen]);
  const placeholderText = isActive
    ? 'queue a message · ↵ to add to queue · ctrl+c or esc to interrupt'
    : 'type a message…  /  for commands · shift+enter for newline';
  const hintContent = isActive ? (
    <>
      <kbd>↵</kbd>queue <kbd>ctrl</kbd>+<kbd>c</kbd> or <kbd>esc</kbd> interrupt
    </>
  ) : (
    <>
      <kbd>↵</kbd>send <kbd>⇧↵</kbd>newline <kbd>/</kbd>commands
    </>
  );

  // Build overlay segments for composer highlight
  const overlaySegments = useMemo(
    () => (commandIndex ? renderInlineSkillTokens(draft, commandIndex) : null),
    [commandIndex, draft]
  );

  return (
    <div className="slash-anchor">
      <SlashPalette
        commands={filteredCommands}
        activeIndex={activeIndex}
        visible={paletteVisible}
      />
      <div className="composer" role="form" aria-label="message composer">
        <div className="composer__overlay-wrap">
          {overlaySegments && (
            <div className="composer__overlay" aria-hidden="true">
              {overlaySegments.map((seg, i) => {
                if (typeof seg === 'string') return seg;
                return (
                  <span key={i} className="token-skill">
                    {seg.text}
                  </span>
                );
              })}
            </div>
          )}
          <textarea
            ref={textareaRef}
            className="composer__ta"
            placeholder={placeholderText}
            onKeyDown={handleKeyDown}
            onChange={(event) => {
              setDraft(event.currentTarget.value);
              setCaret(event.currentTarget.selectionStart ?? 0);
            }}
            onKeyUp={updateCaret}
            onClick={updateCaret}
            onSelect={updateCaret}
            onPaste={handlePaste}
            onDrop={handleDrop}
            onDragOver={(e) => e.preventDefault()}
            value={draft}
            rows={1}
            enterKeyHint="send"
            data-streaming={isActive ? 'true' : 'false'}
            aria-label="message input"
          />
        </div>
        {attachments.length > 0 && (
          <div className="composer__attachments" aria-label="attachments">
            {attachments.map((a) => (
              <span key={a.id} className="composer__chip" title={a.name}>
                <img
                  className="composer__chip-thumb"
                  src={a.dataUri}
                  alt={a.name}
                />
                <span className="composer__chip-name">{a.name}</span>
                <button
                  type="button"
                  className="composer__chip-remove"
                  aria-label={`remove ${a.name}`}
                  onClick={() => removeAttachment(a.id)}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
        <div className="composer__bar">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange={(e) => {
              if (e.currentTarget.files) addImageFiles(e.currentTarget.files);
              e.currentTarget.value = '';
            }}
          />
          <button
            type="button"
            className="composer__attach"
            aria-label="attach image"
            title="attach image"
            onClick={() => fileInputRef.current?.click()}
          >
            +img
          </button>
          <span className="composer__hint">{hintContent}</span>
          <span className="right ctx-pop-anchor" ref={ctxAnchorRef}>
            {modelName && (
              <span style={{ color: 'var(--text-muted)' }}>{modelName}</span>
            )}
            <button
              className="cbar-trigger"
              type="button"
              aria-haspopup="true"
              aria-expanded={ctxPopOpen}
              aria-label="context usage"
              onClick={() => setCtxPopOpen((open) => !open)}
            >
              <span>{ctxLabel}</span>
              <span className="mini-bar" aria-hidden="true">
                {segments.map((s) => (
                  <span
                    key={s.name}
                    style={{
                      width: `${segmentPct(s.tokens)}%`,
                      background: s.color,
                    }}
                  />
                ))}
                <span
                  style={{
                    width: `${100 - usedPct}%`,
                    background: 'var(--surface-hover)',
                  }}
                />
              </span>
              <span className="caret">▴</span>
            </button>
            {ctxPopOpen && ctxWindow > 0 && (
              <div
                className="ctx-pop"
                role="dialog"
                aria-label="context breakdown"
              >
                <div className="ctx-pop__head">
                  <span>context</span>
                  <span>
                    <span className="ct">{formatTokens(ctxUsed)}</span> /{' '}
                    {formatTokens(ctxWindow)} tokens
                  </span>
                </div>
                <div className="ctx-pop__bar" aria-hidden="true">
                  {segments.map((s) => (
                    <span
                      key={s.name}
                      style={{
                        width: `${segmentPct(s.tokens)}%`,
                        background: s.color,
                      }}
                    />
                  ))}
                  <span
                    style={{
                      width: `${100 - usedPct}%`,
                      background: 'var(--surface-hover)',
                    }}
                  />
                </div>
                <div className="ctx-pop__legend">
                  {segments.map((s) => (
                    <span key={s.name}>
                      <span
                        className="swatch"
                        style={{ background: s.color }}
                      />
                      {s.name}
                      <span className="v">{formatTokens(s.tokens)}</span>
                    </span>
                  ))}
                </div>
                <div className="ctx-pop__foot">
                  <span>buffer free</span>
                  <span style={{ color: 'var(--text)' }}>
                    {formatTokens(ctxFree)} tokens
                  </span>
                </div>
              </div>
            )}
          </span>
        </div>
        {/* error rendering is normalized into the timeline as errorMessage items */}
      </div>
    </div>
  );
};

export default Composer;
