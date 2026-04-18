import React, {
  useRef,
  useState,
  useEffect,
  useCallback,
  useMemo,
  forwardRef,
  useImperativeHandle,
} from 'react';
import { isMobileDevice } from '../lib/utils.js';
import { sendPtyData, isPtyConnected } from '../lib/ws.js';
import { processIntent } from '../../../shared/mobile-input-pipeline.js';
import type { CapturedIntent } from '../../../shared/mobile-input-pipeline.js';
import './MobileInput.css';

const SEND_DELAY = 10;

export interface MobileInputHandle {
  getInputEl: () => HTMLInputElement | null;
  focus: () => void;
  flushComposedText: () => void;
  clearInput: () => void;
  onSessionChange: () => void;
}

function ensureCursorAtEnd(inputEl: HTMLInputElement, isComposing: boolean) {
  if (isComposing) return;
  const len = inputEl.value.length;
  if (inputEl.selectionStart !== len || inputEl.selectionEnd !== len) {
    inputEl.setSelectionRange(len, len);
  }
}

function syncBuffer(inputEl: HTMLInputElement, dbg: (m: string) => void) {
  const val = inputEl.value;
  if (val.length <= 20) return;
  const lastSpace = val.lastIndexOf(' ');
  if (lastSpace >= 0) {
    const trimmed = val.slice(lastSpace + 1);
    dbg(
      'SYNC_TRIM: "' +
        val.slice(0, 30) +
        (val.length > 30 ? '...' : '') +
        '" → "' +
        trimmed +
        '"'
    );
    inputEl.value = trimmed;
    inputEl.selectionStart = inputEl.selectionEnd = trimmed.length;
  }
}

function useSendBuffer(dbg: (m: string) => void) {
  const sendBufferRef = useRef('');
  const sendTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flushSendBuffer = useCallback(() => {
    sendTimerRef.current = null;
    const buf = sendBufferRef.current;
    if (buf && isPtyConnected()) {
      const hex = Array.from(buf)
        .map((c) => c.charCodeAt(0).toString(16).padStart(2, '0'))
        .join(' ');
      dbg(
        'FLUSH: "' +
          buf.replace(/\x7f/g, '\u232b') +
          '" (' +
          buf.length +
          'B) hex=[' +
          hex +
          ']'
      );
      sendPtyData(buf);
    }
    sendBufferRef.current = '';
  }, [dbg]);

  const scheduleSend = useCallback(
    (data: string) => {
      sendBufferRef.current += data;
      if (sendTimerRef.current !== null) clearTimeout(sendTimerRef.current);
      sendTimerRef.current = setTimeout(flushSendBuffer, SEND_DELAY);
    },
    [flushSendBuffer]
  );

  return { scheduleSend, flushSendBuffer };
}

function useMobileEffects(
  inputRef: React.RefObject<HTMLInputElement | null>,
  isComposingRef: React.MutableRefObject<boolean>,
  dbg: (m: string) => void,
  dp: DebugPanelState
) {
  useEffect(() => {
    dp.setDevtoolsEnabled(localStorage.getItem('devtools-enabled') === 'true');
    const inputEl = inputRef.current;
    if (!inputEl) return;
    inputEl.setAttribute('autocomplete', 'new-terminal-input');

    const onSelectionChange = () => {
      if (document.activeElement !== inputEl) return;
      const pos = inputEl.selectionStart ?? 0;
      const len = inputEl.value.length;
      if (pos !== len && len > 0)
        dbg('SEL_DRIFT cursor=' + pos + ' len=' + len + ' → fixing');
      ensureCursorAtEnd(inputEl, isComposingRef.current);
    };
    const onTermDebug = (e: Event) => dbg((e as CustomEvent).detail);
    const onDevtoolsChanged = () => {
      const enabled = localStorage.getItem('devtools-enabled') === 'true';
      dp.setDevtoolsEnabled(enabled);
      if (!enabled) dp.setDebugVisible(false);
    };

    document.addEventListener('selectionchange', onSelectionChange);
    window.addEventListener('term-debug', onTermDebug);
    window.addEventListener('devtools-changed', onDevtoolsChanged);
    return () => {
      document.removeEventListener('selectionchange', onSelectionChange);
      window.removeEventListener('term-debug', onTermDebug);
      window.removeEventListener('devtools-changed', onDevtoolsChanged);
    };
  }, [inputRef, isComposingRef, dbg, dp]);
}

function useKeydownHandler(
  inputRef: React.RefObject<HTMLInputElement | null>,
  isComposingRef: React.MutableRefObject<boolean>,
  flushComposedText: () => void,
  dbg: (m: string) => void
) {
  return (e: React.KeyboardEvent<HTMLInputElement>) => {
    const inputEl = inputRef.current;
    if (!inputEl) return;
    dbg(
      'KEYDOWN key="' +
        e.key +
        '" shift=' +
        e.shiftKey +
        ' composing=' +
        isComposingRef.current
    );
    if (!isPtyConnected()) return;
    let handled = true;
    switch (e.key) {
      case 'Enter':
        flushComposedText();
        sendPtyData(e.shiftKey ? '\x1b[13;2u' : '\r');
        inputEl.value = '';
        break;
      case 'Backspace':
        if (inputEl.value.length === 0) sendPtyData('\x7f');
        handled = false;
        break;
      case 'Escape':
        sendPtyData('\x1b');
        inputEl.value = '';
        break;
      case 'Tab':
        sendPtyData('\t');
        break;
      case 'ArrowUp':
        sendPtyData('\x1b[A');
        break;
      case 'ArrowDown':
        sendPtyData('\x1b[B');
        break;
      default:
        handled = false;
    }
    if (handled) e.preventDefault();
  };
}

function useInputHandler(
  inputRef: React.RefObject<HTMLInputElement | null>,
  isComposingRef: React.MutableRefObject<boolean>,
  capturedIntentRef: React.MutableRefObject<CapturedIntent | null>,
  clearTimerRef: React.MutableRefObject<ReturnType<typeof setTimeout> | null>,
  scheduleSend: (d: string) => void,
  dbg: (m: string) => void
) {
  return (e: React.FormEvent<HTMLInputElement>) => {
    const ie = e as unknown as InputEvent;
    const inputEl = inputRef.current;
    if (!inputEl) return;
    const intent = capturedIntentRef.current;
    capturedIntentRef.current = null;
    const currentValue = inputEl.value;
    dbg('INPUT type="' + ie.inputType + '" val="' + currentValue + '"');
    if (clearTimerRef.current) clearTimeout(clearTimerRef.current);
    clearTimerRef.current = setTimeout(() => {
      dbg('TIMER_CLEAR');
      inputEl.value = '';
      ensureCursorAtEnd(inputEl, isComposingRef.current);
    }, 2000);
    if (!isPtyConnected() || isComposingRef.current) {
      if (isComposingRef.current) dbg('  skipped (composing)');
      return;
    }
    const fallbackIntent = {
      type: ie.inputType,
      data: ie.data,
      rangeStart: null,
      rangeEnd: null,
      valueBefore: '',
      cursorBefore: 0,
    };
    const result = processIntent(intent ?? fallbackIntent, currentValue);
    if (!intent) dbg('  WARN: no captured intent');
    if (result.payload) scheduleSend(result.payload);
    if (result.newInputValue !== undefined) {
      inputEl.value = result.newInputValue;
      ensureCursorAtEnd(inputEl, isComposingRef.current);
      syncBuffer(inputEl, dbg);
      return;
    }
    syncBuffer(inputEl, dbg);
    ensureCursorAtEnd(inputEl, isComposingRef.current);
  };
}

interface DebugPanelState {
  debugVisible: boolean;
  setDebugVisible: React.Dispatch<React.SetStateAction<boolean>>;
  debugLines: string[];
  setDebugLines: React.Dispatch<React.SetStateAction<string[]>>;
  devtoolsEnabled: boolean;
  setDevtoolsEnabled: React.Dispatch<React.SetStateAction<boolean>>;
  mirrorValue: string;
  setMirrorValue: React.Dispatch<React.SetStateAction<string>>;
  mirrorCursor: number;
  setMirrorCursor: React.Dispatch<React.SetStateAction<number>>;
}

interface DebugPanelProps {
  dp: DebugPanelState;
  onToggle: (e: React.MouseEvent) => void;
  onCopy: (e: React.MouseEvent) => void;
  onClear: (e: React.MouseEvent) => void;
}

function DebugPanel({ dp, onToggle, onCopy, onClear }: DebugPanelProps) {
  if (!dp.devtoolsEnabled) return null;
  return (
    <>
      <div className="debug-buttons">
        <button
          className="debug-toggle"
          style={{ opacity: dp.debugVisible ? 1 : 0.5 }}
          onClick={onToggle}
        >
          dbg
        </button>
        {dp.debugVisible && (
          <>
            <button className="debug-toggle" onClick={onCopy}>
              copy
            </button>
            <button className="debug-toggle" onClick={onClear}>
              clear
            </button>
          </>
        )}
      </div>
      {dp.debugVisible && (
        <div className="debug-panel">
          <div className="input-mirror-inline">
            buf: &quot;{dp.mirrorValue}&quot; cursor={dp.mirrorCursor}
          </div>
          {dp.debugLines.map((line, i) => (
            <div key={i}>{line}</div>
          ))}
        </div>
      )}
    </>
  );
}

export const MobileInput = forwardRef<MobileInputHandle, object>(
  function MobileInput(_props, ref) {
    const inputRef = useRef<HTMLInputElement>(null);
    const capturedIntentRef = useRef<CapturedIntent | null>(null);
    const isComposingRef = useRef(false);
    const clearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const [debugVisible, setDebugVisible] = useState(false);
    const [debugLines, setDebugLines] = useState<string[]>([]);
    const [devtoolsEnabled, setDevtoolsEnabled] = useState(false);
    const [mirrorValue, setMirrorValue] = useState('');
    const [mirrorCursor, setMirrorCursor] = useState(0);
    const dp = useMemo(
      () => ({
        debugVisible,
        setDebugVisible,
        debugLines,
        setDebugLines,
        devtoolsEnabled,
        setDevtoolsEnabled,
        mirrorValue,
        setMirrorValue,
        mirrorCursor,
        setMirrorCursor,
      }),
      [debugVisible, debugLines, devtoolsEnabled, mirrorValue, mirrorCursor]
    );

    const dbg = useCallback(
      (msg: string) => {
        const t = performance.now().toFixed(1);
        setDebugLines((prev) => [...prev.slice(-199), '[' + t + '] ' + msg]);
        if (inputRef.current) {
          setMirrorValue(inputRef.current.value);
          setMirrorCursor(inputRef.current.selectionStart ?? 0);
        }
      },
      [inputRef, setDebugLines, setMirrorValue, setMirrorCursor]
    ); // deps are stable refs/state setters
    const { scheduleSend, flushSendBuffer } = useSendBuffer(dbg);

    const flushComposedText = useCallback(() => {
      const inputEl = inputRef.current;
      if (!inputEl) return;
      if (isComposingRef.current && isPtyConnected() && inputEl.value) {
        dbg('FLUSH_COMPOSED: "' + inputEl.value + '"');
        scheduleSend(inputEl.value);
      }
      isComposingRef.current = false;
      flushSendBuffer();
    }, [dbg, scheduleSend, flushSendBuffer]);

    useImperativeHandle(
      ref,
      () => ({
        getInputEl: () => inputRef.current ?? null,
        focus: () => {
          dbg('FOCUS_REQ inputEl=' + (inputRef.current ? 'SET' : 'NULL'));
          inputRef.current?.focus();
        },
        flushComposedText,
        clearInput: () => {
          if (inputRef.current) {
            inputRef.current.value = '';
            inputRef.current.setSelectionRange(0, 0);
          }
        },
        onSessionChange: () => {
          isComposingRef.current = false;
        },
      }),
      [flushComposedText, dbg]
    );

    useMobileEffects(inputRef, isComposingRef, dbg, dp);

    const handleCompositionStart = (
      e: React.CompositionEvent<HTMLInputElement>
    ) => {
      dbg('COMP_START data="' + e.data + '"');
      isComposingRef.current = true;
    };
    const handleCompositionUpdate = (
      e: React.CompositionEvent<HTMLInputElement>
    ) => {
      dbg('COMP_UPDATE data="' + e.data + '"');
    };
    const handleCompositionEnd = (
      e: React.CompositionEvent<HTMLInputElement>
    ) => {
      dbg('COMP_END data="' + e.data + '"');
      isComposingRef.current = false;
      if (isPtyConnected() && e.data) {
        dbg('  → COMP_SEND: "' + e.data + '"');
        scheduleSend(e.data);
      }
    };
    const handleBlur = () => {
      dbg('BLUR');
      if (isComposingRef.current) isComposingRef.current = false;
    };

    const handleBeforeInput = (e: React.SyntheticEvent<HTMLInputElement>) => {
      const ie = e as unknown as InputEvent;
      const inputEl = inputRef.current;
      if (!inputEl) return;
      if (
        ie.inputType.startsWith('delete') &&
        inputEl.selectionStart === 0 &&
        inputEl.selectionEnd === 0 &&
        inputEl.value.length > 0
      ) {
        dbg('CURSOR0_DEL type="' + ie.inputType + '"');
        scheduleSend('\x7f');
        e.preventDefault();
        capturedIntentRef.current = null;
        return;
      }
      const ranges = ie.getTargetRanges?.() ?? [];
      const fr = ranges.length > 0 ? (ranges[0] as StaticRange) : null;
      capturedIntentRef.current = {
        type: ie.inputType,
        data: ie.data,
        rangeStart: fr ? fr.startOffset : null,
        rangeEnd: fr ? fr.endOffset : null,
        valueBefore: inputEl.value,
        cursorBefore: inputEl.selectionStart ?? 0,
      };
    };

    const handleInput = useInputHandler(
      inputRef,
      isComposingRef,
      capturedIntentRef,
      clearTimerRef,
      scheduleSend,
      dbg
    );
    const handleKeydown = useKeydownHandler(
      inputRef,
      isComposingRef,
      flushComposedText,
      dbg
    );

    const handleFormSubmit = (e: React.SyntheticEvent<HTMLFormElement>) => {
      e.preventDefault();
      const inputEl = inputRef.current;
      if (!inputEl) return;
      dbg('FORM_SUBMIT composing=' + isComposingRef.current);
      if (!isPtyConnected()) return;
      flushComposedText();
      sendPtyData('\r');
      inputEl.value = '';
    };

    if (!isMobileDevice) return null;

    return (
      <>
        <form
          className="mobile-input-form"
          action="javascript:void(0)"
          onSubmit={handleFormSubmit}
        >
          <input
            ref={inputRef}
            type="search"
            className="mobile-input"
            dir="ltr"
            autoComplete="off"
            autoCorrect="on"
            autoCapitalize="sentences"
            spellCheck={true}
            enterKeyHint="send"
            aria-label="Terminal input"
            onCompositionStart={handleCompositionStart}
            onCompositionUpdate={handleCompositionUpdate}
            onCompositionEnd={handleCompositionEnd}
            onBlur={handleBlur}
            onBeforeInput={handleBeforeInput}
            onInput={handleInput}
            onKeyDown={handleKeydown}
          />
        </form>
        <DebugPanel
          dp={dp}
          onToggle={(e) => {
            e.preventDefault();
            e.stopPropagation();
            dp.setDebugVisible((v) => !v);
          }}
          onCopy={(e) => {
            e.preventDefault();
            e.stopPropagation();
            navigator.clipboard
              .writeText(dp.debugLines.join('\n'))
              .then(() => dbg('--- LOGS COPIED ---'))
              .catch(() => dbg('--- COPY FAILED ---'));
          }}
          onClear={(e) => {
            e.preventDefault();
            e.stopPropagation();
            dp.setDebugLines([]);
          }}
        />
      </>
    );
  }
);

export default MobileInput;
