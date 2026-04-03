import React, { useEffect, useRef, useState } from 'react';
import DialogShell, { type DialogShellHandle } from './DialogShell.js';
import TuiButton from '../TuiButton.js';
import { pushBranch, renameBranch } from '../../lib/api.js';
import './RenameWarningModal.css';

interface Props {
  oldName: string;
  newName: string;
  workspacePath: string;
  onClose: () => void;
}

export default function RenameWarningModal({
  oldName,
  newName,
  workspacePath,
  onClose,
}: Props) {
  const shellRef = useRef<DialogShellHandle>(null);
  const [loading, setLoading] = useState<'push' | 'cancel' | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    shellRef.current?.open();
  }, []);

  async function handlePush() {
    setLoading('push');
    setErrorMsg(null);
    try {
      const data = await pushBranch(workspacePath, newName, oldName);
      if (data.success) {
        shellRef.current?.close();
        onClose();
      } else {
        setErrorMsg(data.error ?? 'Push failed');
      }
    } catch {
      setErrorMsg('Push failed');
    } finally {
      setLoading(null);
    }
  }

  async function handleCancel() {
    setLoading('cancel');
    setErrorMsg(null);
    try {
      const data = await renameBranch(workspacePath, oldName);
      if (data.success) {
        shellRef.current?.close();
        onClose();
      } else {
        setErrorMsg(data.error ?? 'Failed to undo rename');
      }
    } catch {
      setErrorMsg('Failed to undo rename');
    } finally {
      setLoading(null);
    }
  }

  function handleIgnore() {
    shellRef.current?.close();
    onClose();
  }

  const footer = (
    <div className="rename-actions">
      <TuiButton
        variant="primary"
        onClick={handlePush}
        disabled={loading !== null}
      >
        {loading === 'push' ? 'Pushing...' : 'Push'}
      </TuiButton>
      <TuiButton
        variant="ghost"
        onClick={handleIgnore}
        disabled={loading !== null}
      >
        Ignore
      </TuiButton>
      <TuiButton
        variant="ghost"
        onClick={handleCancel}
        disabled={loading !== null}
      >
        {loading === 'cancel' ? 'Undoing...' : 'Cancel (undo rename)'}
      </TuiButton>
    </div>
  );

  return (
    <DialogShell
      ref={shellRef}
      title="Branch Renamed"
      width="420px"
      footer={footer}
    >
      <div className="rename-body">
        <p className="rename-message">
          Branch renamed: <code>{oldName}</code> &rarr; <code>{newName}</code>
        </p>
        <p className="rename-detail">
          This PR&apos;s head branch no longer matches. Push the renamed branch
          to update GitHub?
        </p>
        {errorMsg && <p className="error-msg">{errorMsg}</p>}
      </div>
    </DialogShell>
  );
}
