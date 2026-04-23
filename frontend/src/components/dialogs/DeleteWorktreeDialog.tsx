import React, {
  forwardRef,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';
import DialogShell, { type DialogShellHandle } from './DialogShell.js';
import TuiButton from '../TuiButton.js';
import { deleteWorktree } from '../../lib/api.js';
import { useSessionsStore } from '../../lib/stores/sessions.js';
import type { WorktreeInfo } from '../../lib/types.js';
import './DeleteWorktreeDialog.css';

export interface DeleteWorktreeDialogHandle {
  open(wt: WorktreeInfo, hasActiveSessions: boolean): void;
  close(): void;
}

const DeleteWorktreeDialog = forwardRef<DeleteWorktreeDialogHandle>(
  function DeleteWorktreeDialog(_props, ref) {
    const shellRef = useRef<DialogShellHandle>(null);
    const [worktree, setWorktree] = useState<WorktreeInfo | null>(null);
    const [error, setError] = useState('');
    const [deleting, setDeleting] = useState(false);
    const [hasActiveSessions, setHasActiveSessions] = useState(false);

    useImperativeHandle(ref, () => ({
      open(wt: WorktreeInfo, hasActiveSessions: boolean) {
        setWorktree(wt);
        setHasActiveSessions(hasActiveSessions);
        setError('');
        setDeleting(false);
        shellRef.current?.open();
      },
      close() {
        shellRef.current?.close();
      },
    }));

    async function handleConfirm() {
      if (!worktree || deleting) return;
      setDeleting(true);
      setError('');
      useSessionsStore.getState().setLoading(worktree.path);
      try {
        await deleteWorktree(worktree.path, worktree.repoPath, true);
        shellRef.current?.close();
      } catch (err: unknown) {
        setError(
          err instanceof Error ? err.message : 'Failed to delete worktree.'
        );
      } finally {
        setDeleting(false);
        if (worktree) useSessionsStore.getState().clearLoading(worktree.path);
      }
    }

    function handleCancel() {
      shellRef.current?.close();
    }

    const footer = (
      <div className="delete-worktree-footer-row">
        <TuiButton variant="ghost" onClick={handleCancel} disabled={deleting}>
          Cancel
        </TuiButton>
        <TuiButton variant="danger" onClick={handleConfirm} disabled={deleting}>
          {deleting ? 'Deleting...' : 'Delete'}
        </TuiButton>
      </div>
    );

    return (
      <DialogShell
        ref={shellRef}
        width="400px"
        title="Delete Worktree"
        footer={footer}
      >
        <div className="delete-worktree-body">
          {worktree && (
            <>
              <p className="delete-worktree-confirm-msg">
                Are you sure you want to delete the worktree{' '}
                <strong className="delete-worktree-wt-name">
                  {worktree.name}
                </strong>
                ?
              </p>
              <p className="delete-worktree-wt-path">{worktree.path}</p>
              <p className="delete-worktree-warning-msg">
                This worktree has uncommitted changes that will be lost.
              </p>
              {hasActiveSessions && (
                <p className="delete-worktree-warning-msg">
                  Active sessions will be terminated.
                </p>
              )}
            </>
          )}
          {error && <p className="delete-worktree-error-msg">{error}</p>}
        </div>
      </DialogShell>
    );
  }
);

export default DeleteWorktreeDialog;
