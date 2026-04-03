import React from 'react';
import './Toolbar.css';

interface ToolbarButton {
  label: string;
  key?: string;
  id?: string;
  extraClass?: string;
  html: string;
}

interface CopyModeButton {
  label: string;
  key: string;
  html: string;
  extraClass?: string;
  exitsCopyMode?: boolean;
}

export interface ToolbarProps {
  onSendKey: (key: string) => void;
  onFlushComposedText: () => void;
  onClearInput: () => void;
  onUploadImage: () => void;
  onRefocusMobileInput: () => void;
  useTmux?: boolean;
  inCopyMode?: boolean;
  onExitCopyMode?: () => void;
  isMobileDevice?: boolean;
}

const BUTTONS: ToolbarButton[] = [
  { html: 'Tab', key: '\x09', label: 'Tab' },
  { html: '&#8679;Tab', key: '\x1b[Z', label: 'Shift+Tab' },
  { html: '&#8593;', key: '\x1b[A', label: 'Up arrow', extraClass: 'tb-arrow' },
  { html: 'Esc', key: '\x1b', label: 'Escape' },
  {
    html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="square" width="14" height="14"><rect x="3" y="5" width="18" height="14"/><circle cx="12" cy="13" r="3"/><path d="M9 5l1-2h4l1 2"/></svg>',
    id: 'upload-image-btn',
    label: 'Upload image',
  },
  { html: '^V', id: 'paste-btn', label: 'Paste from clipboard' },
  { html: '^C', key: '\x03', label: 'Ctrl+C' },
  { html: '&#8592;', key: '\x1b[D', label: 'Left arrow', extraClass: 'tb-arrow' },
  { html: '&#8595;', key: '\x1b[B', label: 'Down arrow', extraClass: 'tb-arrow' },
  { html: '&#8594;', key: '\x1b[C', label: 'Right arrow', extraClass: 'tb-arrow' },
  { html: '&#8679;&#9166;', key: '\x1b[13;2u', label: 'Shift+Enter (newline)', extraClass: 'tb-newline' },
  { html: '&#9166;', key: '\x0d', label: 'Enter', extraClass: 'tb-enter' },
];

const COPY_MODE_BUTTONS: CopyModeButton[] = [
  { html: 'Sel', key: ' ', label: 'Start selection' },
  { html: 'w', key: 'w', label: 'Word forward' },
  { html: 'b', key: 'b', label: 'Word backward' },
  { html: '&#8592;', key: 'h', label: 'Left', extraClass: 'tb-arrow' },
  { html: '&#8595;', key: 'j', label: 'Down', extraClass: 'tb-arrow' },
  { html: '&#8593;', key: 'k', label: 'Up', extraClass: 'tb-arrow' },
  { html: '&#8594;', key: 'l', label: 'Right', extraClass: 'tb-arrow' },
  { html: '$', key: '$', label: 'End of line' },
  { html: '0', key: '0', label: 'Start of line' },
  { html: 'PgUp', key: '\x1b[5~', label: 'Page up' },
  { html: 'Copy', key: '\r', label: 'Copy and exit', extraClass: 'tb-enter', exitsCopyMode: true },
  { html: 'Exit', key: 'q', label: 'Cancel', exitsCopyMode: true },
];

export function Toolbar({
  onSendKey,
  onFlushComposedText,
  onClearInput,
  onUploadImage,
  onRefocusMobileInput,
  inCopyMode = false,
  onExitCopyMode,
  isMobileDevice = false,
}: ToolbarProps) {
  function handleButton(btn: ToolbarButton) {
    if (btn.id === 'upload-image-btn') {
      onUploadImage();
      if (isMobileDevice) onRefocusMobileInput();
      return;
    }
    if (btn.id === 'paste-btn') {
      if (navigator.clipboard?.readText) {
        navigator.clipboard.readText().then((text) => {
          if (text) onSendKey(text);
        }).catch(() => onUploadImage());
      } else {
        onUploadImage();
      }
      if (isMobileDevice) onRefocusMobileInput();
      return;
    }
    if (!btn.key) return;
    if (btn.key === '\r' || btn.key === '\x1b[13;2u') {
      onFlushComposedText();
    }
    onSendKey(btn.key);
    if (btn.key === '\r' || btn.key === '\x1b[13;2u') {
      onClearInput();
    }
    if (isMobileDevice) onRefocusMobileInput();
  }

  function handleCopyModeButton(btn: CopyModeButton) {
    onSendKey(btn.key);
    if (btn.exitsCopyMode) onExitCopyMode?.();
    if (isMobileDevice) onRefocusMobileInput();
  }

  function onToolbarMouseDown(e: React.MouseEvent<HTMLDivElement>) {
    e.preventDefault();
    const btn = (e.target as HTMLElement).closest('button');
    if (!btn) return;

    if (inCopyMode) {
      const match = COPY_MODE_BUTTONS.find((b) => btn.dataset['key'] === b.key);
      if (match) handleCopyModeButton(match);
      return;
    }

    const match = BUTTONS.find((b) => b.id === btn.id || (b.key && btn.dataset['key'] === b.key));
    if (match) handleButton(match);
  }

  if (!isMobileDevice) return null;

  const activeButtons = inCopyMode ? COPY_MODE_BUTTONS : BUTTONS;

  return (
    <div className="toolbar" role="toolbar" onMouseDown={onToolbarMouseDown}>
      <div className="toolbar-grid">
        {activeButtons.map((btn) => (
          <button
            key={btn.label}
            className={['tb-btn', btn.extraClass ?? ''].filter(Boolean).join(' ')}
            id={'id' in btn ? btn.id : undefined}
            data-key={btn.key}
            data-track={`toolbar.${btn.label.toLowerCase().replace(/[^a-z0-9]/g, '-')}`}
            aria-label={btn.label}
            dangerouslySetInnerHTML={{ __html: btn.html }}
          />
        ))}
      </div>
    </div>
  );
}

export default Toolbar;
