import React, {
  forwardRef,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';
import DialogShell, { type DialogShellHandle } from './DialogShell.js';
import TuiButton from '../TuiButton.js';
import FileBrowser, { type FileBrowserHandle } from '../FileBrowser.js';
import { addWorkspacesBulk } from '../../lib/api.js';
import './AddWorkspaceDialog.css';

export interface AddWorkspaceDialogHandle {
  open(): void;
  close(): void;
}

interface Props {
  onWorkspacesAdded: (paths: string[]) => void;
}

const AddWorkspaceDialog = forwardRef<AddWorkspaceDialogHandle, Props>(
  function AddWorkspaceDialog({ onWorkspacesAdded }, ref) {
    const shellRef = useRef<DialogShellHandle>(null);
    const fileBrowserRef = useRef<FileBrowserHandle>(null);
    const [selectedPaths, setSelectedPaths] = useState<string[]>([]);
    const [error, setError] = useState('');
    const [submitting, setSubmitting] = useState(false);

    useImperativeHandle(ref, () => ({
      open() {
        setSelectedPaths([]);
        setError('');
        setSubmitting(false);
        fileBrowserRef.current?.reset();
        shellRef.current?.open();
      },
      close() {
        shellRef.current?.close();
      },
    }));

    async function handleSubmit() {
      if (selectedPaths.length === 0) return;
      setSubmitting(true);
      setError('');

      try {
        const result = await addWorkspacesBulk(selectedPaths);

        if (result.errors.length > 0 && result.added.length === 0) {
          setError(
            result.errors.map((e) => `${e.path}: ${e.error}`).join('; ')
          );
          setSubmitting(false);
          return;
        }

        if (result.added.length > 0) {
          onWorkspacesAdded(result.added.map((a) => a.path));
        }

        if (result.errors.length > 0) {
          // Partial success — some workspaces failed to add
        }

        shellRef.current?.close();
      } catch {
        setError('Failed to add workspaces.');
      } finally {
        setSubmitting(false);
      }
    }

    const footer = (
      <div className="add-workspace-footer-row">
        <span className="add-workspace-selected-count">
          {selectedPaths.length > 0 ? `${selectedPaths.length} selected` : ''}
        </span>
        <div className="add-workspace-footer-actions">
          <TuiButton variant="ghost" onClick={() => shellRef.current?.close()}>
            Cancel
          </TuiButton>
          <TuiButton
            variant="primary"
            onClick={handleSubmit}
            disabled={selectedPaths.length === 0 || submitting}
          >
            {submitting
              ? 'adding...'
              : `add repo${selectedPaths.length > 1 ? 's' : ''}`}
          </TuiButton>
        </div>
      </div>
    );

    return (
      <DialogShell
        ref={shellRef}
        width="520px"
        title="add repo"
        footer={footer}
      >
        <div className="add-workspace-body-content">
          <p className="add-workspace-dialog-desc">
            browse for folders on your machine. git repos get pr tracking and
            branch management.
          </p>

          <FileBrowser
            ref={fileBrowserRef}
            selectedPaths={selectedPaths}
            onSelectedPathsChange={setSelectedPaths}
          />

          {error && <p className="add-workspace-error-msg">{error}</p>}
        </div>
      </DialogShell>
    );
  }
);

export default AddWorkspaceDialog;
