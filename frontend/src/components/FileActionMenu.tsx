import { useCallback, useMemo } from 'react';
import { ContextMenu, type MenuItem } from './ContextMenu.js';
import { showToast } from '../lib/stores/toasts.js';
import {
  buildFilesReadCommand,
  buildFilesWriteCommand,
} from '../lib/editor-affordances.js';

/**
 * Shared file action / command menu (#1004).
 *
 * One primitive consumed by every file surface so the open-file affordances stay
 * in lockstep instead of forking per surface:
 *  - the editable code tab (`CodeMirrorFileEditor`) passes `editable` and the
 *    save/reload/show-changes callbacks for the full action set;
 *  - read-only surfaces (the Evidence preview) omit them and get only the
 *    copy-path / copy-`files read`-command subset.
 *
 * The CLI affordance always renders the contract-derived
 * `relay-ide v1 files read/write --json` command via `editor-affordances`, so
 * the browser and the CLI/agent path describe the same scoped File RPC.
 */
export interface FileActionMenuProps {
  /** Display/relative path used for "copy relative path". */
  filePath: string;
  /** Absolute (or session-relative) path used for "copy absolute path" + CLI. */
  absolutePath: string;
  /** Scoped session id for the File RPC command; null renders a placeholder. */
  sessionId: string | null;
  /** Editable surface => expose save/reload + the write command. */
  editable?: boolean;
  dirty?: boolean;
  saving?: boolean;
  onSave?: (() => void) | undefined;
  onReload?: (() => void) | undefined;
  /** Open the diff/changes view; rendered only when provided. */
  onShowChanges?: (() => void) | undefined;
  canShowChanges?: boolean;
  hideTrigger?: boolean;
}

async function copyToClipboard(text: string, label: string): Promise<void> {
  const clipboard = globalThis.navigator?.clipboard;
  if (!clipboard?.writeText) {
    showToast('clipboard unavailable in this browser', 'error', 3000);
    return;
  }
  try {
    await clipboard.writeText(text);
    showToast(`copied ${label}`, 'info', 2500);
  } catch {
    showToast('copy failed', 'error', 3000);
  }
}

export function FileActionMenu({
  filePath,
  absolutePath,
  sessionId,
  editable = false,
  dirty = false,
  saving = false,
  onSave,
  onReload,
  onShowChanges,
  canShowChanges = false,
  hideTrigger = false,
}: FileActionMenuProps) {
  const readCommand = useMemo(
    () => buildFilesReadCommand({ sessionId, path: absolutePath }),
    [absolutePath, sessionId]
  );
  const writeCommand = useMemo(
    () => buildFilesWriteCommand({ sessionId, path: absolutePath }),
    [absolutePath, sessionId]
  );

  const handleReload = useCallback(() => {
    if (!onReload) return;
    if (
      dirty &&
      typeof window !== 'undefined' &&
      typeof window.confirm === 'function' &&
      !window.confirm('discard unsaved changes and reload from disk?')
    ) {
      return;
    }
    onReload();
  }, [dirty, onReload]);

  const items = useMemo<MenuItem[]>(() => {
    const next: MenuItem[] = [];
    if (editable && onSave) {
      next.push({ label: 'save', action: onSave, disabled: saving || !dirty });
    }
    if (editable && onReload) {
      next.push({
        label: 'reload from disk',
        action: handleReload,
        disabled: saving,
      });
    }
    if (onShowChanges) {
      next.push({
        label: 'show changes',
        action: onShowChanges,
        disabled: !canShowChanges,
      });
    }
    next.push({
      label: 'copy relative path',
      action: () => void copyToClipboard(filePath, 'relative path'),
    });
    next.push({
      label: 'copy absolute path',
      action: () => void copyToClipboard(absolutePath, 'absolute path'),
    });
    next.push({
      label: 'copy files-read command',
      action: () => void copyToClipboard(readCommand, 'files read command'),
    });
    if (editable) {
      next.push({
        label: 'copy files-write command',
        action: () => void copyToClipboard(writeCommand, 'files write command'),
      });
    }
    return next;
  }, [
    absolutePath,
    canShowChanges,
    dirty,
    editable,
    filePath,
    handleReload,
    onReload,
    onSave,
    onShowChanges,
    readCommand,
    saving,
    writeCommand,
  ]);

  return <ContextMenu items={items} hideTrigger={hideTrigger} />;
}

export default FileActionMenu;
