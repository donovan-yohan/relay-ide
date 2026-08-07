import React, {
  forwardRef,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { createLogger } from '../../lib/logger.js';
import DialogShell, { type DialogShellHandle } from './DialogShell.js';
import TuiButton from '../TuiButton.js';
import FileBrowser, { type FileBrowserHandle } from '../FileBrowser.js';
import { addWorkspacesBulk, fetchHubNodes } from '../../lib/api.js';
import { createTerminalSession } from '../../lib/session-utils.js';
import {
  cleanCwd,
  defaultRemoteCwd,
  rememberRemoteCwd,
} from '../../lib/remote-node-cwd.js';
import { nodeShellBlockReason } from './CustomizeSessionDialog.js';
import type { HubNodeSummary } from '../../../../shared/relay-node-protocol.js';
import { DEFAULT_LOCAL_NODE_ID } from '../../../../shared/identity.js';
import { estimateTerminalDimensions } from '../../lib/utils.js';
import { useUiStore } from '../../lib/stores/ui.js';
import './AddWorkspaceDialog.css';

export interface AddWorkspaceDialogHandle {
  open(): void;
  close(): void;
}

interface Props {
  onWorkspacesAdded: (paths: string[]) => void;
  onClose?: (() => void) | undefined;
}

const LOCAL_NODE_VALUE = DEFAULT_LOCAL_NODE_ID;

const logger = createLogger('add-workspace-dialog');

const AddWorkspaceDialog = forwardRef<AddWorkspaceDialogHandle, Props>(
  function AddWorkspaceDialog({ onWorkspacesAdded, onClose }, ref) {
    const shellRef = useRef<DialogShellHandle>(null);
    const fileBrowserRef = useRef<FileBrowserHandle>(null);
    const queryClient = useQueryClient();
    const [selectedPaths, setSelectedPaths] = useState<string[]>([]);
    const [error, setError] = useState('');
    const [submitting, setSubmitting] = useState(false);
    const [nodes, setNodes] = useState<HubNodeSummary[]>([]);
    const [selectedNodeId, setSelectedNodeId] =
      useState<string>(LOCAL_NODE_VALUE);
    const [remoteCwd, setRemoteCwd] = useState('');
    const [fetchNodesError, setFetchNodesError] = useState<string | null>(null);
    const [partialErrors, setPartialErrors] = useState<
      { path: string; error: string }[]
    >([]);

    const isRemote = selectedNodeId !== LOCAL_NODE_VALUE;
    const selectedRemoteNode = isRemote
      ? (nodes.find((n) => n.nodeId === selectedNodeId) ?? null)
      : null;
    const remoteHomeDir = cleanCwd(selectedRemoteNode?.homeDir);

    useImperativeHandle(ref, () => ({
      open() {
        setSelectedPaths([]);
        setError('');
        setSubmitting(false);
        setSelectedNodeId(LOCAL_NODE_VALUE);
        setRemoteCwd('');
        setFetchNodesError(null);
        setPartialErrors([]);
        fileBrowserRef.current?.reset();
        // Fetch nodes for the host picker
        void fetchHubNodes()
          .then((result) => {
            queryClient.setQueryData(['hub-nodes'], result);
            setNodes(result);
          })
          .catch((err: unknown) => {
            logger.warn('fetchHubNodes failed', err);
            setFetchNodesError(
              'could not list remote hosts — only this host is available.'
            );
          });
        shellRef.current?.open();
      },
      close() {
        shellRef.current?.close();
      },
    }));

    function handleNodeChange(nodeId: string) {
      setSelectedNodeId(nodeId);
      setSelectedPaths([]);
      setError('');
      if (nodeId !== LOCAL_NODE_VALUE) {
        const node = nodes.find((n) => n.nodeId === nodeId) ?? null;
        const home = cleanCwd(node?.homeDir);
        setRemoteCwd(defaultRemoteCwd(home, nodeId));
      } else {
        setRemoteCwd('');
      }
    }

    async function handleRemoteSubmit(): Promise<boolean> {
      const cwd = cleanCwd(remoteCwd);
      if (!cwd) {
        setError('cwd is required for remote node sessions');
        return false;
      }
      const { cols, rows } = estimateTerminalDimensions(
        useUiStore.getState().terminalFontSize
      );
      const { session, error: sessionError } = await createTerminalSession({
        nodeId: selectedNodeId,
        mode: 'pty',
        cwd,
        sessionLane: 'remote-cwd',
        cols,
        rows,
      });
      if (sessionError && !session) {
        setError(
          sessionError instanceof Error
            ? sessionError.message
            : 'Failed to create remote terminal'
        );
        return false;
      }
      rememberRemoteCwd(selectedNodeId, cwd);
      shellRef.current?.close();
      return true;
    }

    async function handleSubmit() {
      setSubmitting(true);
      setError('');

      try {
        if (isRemote) {
          const ok = await handleRemoteSubmit();
          if (!ok) {
            setSubmitting(false);
          }
        } else {
          if (selectedPaths.length === 0) {
            setSubmitting(false);
            return;
          }
          const result = await addWorkspacesBulk(selectedPaths);

          if (result.errors.length > 0 && result.added.length === 0) {
            setError(
              result.errors.map((e) => `${e.path}: ${e.error}`).join('; ')
            );
            setSubmitting(false);
            return;
          }

          if (result.errors.length > 0 && result.added.length > 0) {
            // partial success — notify about added paths but keep dialog open
            // so the user can see and dismiss the failures
            onWorkspacesAdded(result.added.map((a) => a.path));
            setPartialErrors(result.errors);
            setSubmitting(false);
            return;
          }

          if (result.added.length > 0) {
            onWorkspacesAdded(result.added.map((a) => a.path));
          }

          shellRef.current?.close();
        }
      } catch (err) {
        logger.error(
          isRemote
            ? 'failed to create remote terminal'
            : 'failed to add workspaces',
          err
        );
        setError(
          isRemote
            ? `failed to create remote terminal: ${err instanceof Error ? err.message : String(err)}`
            : `failed to add workspaces: ${err instanceof Error ? err.message : String(err)}`
        );
      } finally {
        setSubmitting(false);
      }
    }

    const submitDisabled =
      submitting ||
      (isRemote ? !cleanCwd(remoteCwd) : selectedPaths.length === 0);

    const footer = (
      <div className="add-workspace-footer-row">
        <span className="add-workspace-selected-count">
          {!isRemote && selectedPaths.length > 0
            ? `${selectedPaths.length} selected`
            : ''}
        </span>
        <div className="add-workspace-footer-actions">
          <TuiButton variant="ghost" onClick={() => shellRef.current?.close()}>
            Cancel
          </TuiButton>
          <TuiButton
            variant="primary"
            onClick={handleSubmit}
            disabled={submitDisabled}
          >
            {submitting
              ? isRemote
                ? 'connecting...'
                : 'adding...'
              : isRemote
                ? 'open terminal'
                : `add project${selectedPaths.length > 1 ? 's' : ''}`}
          </TuiButton>
        </div>
      </div>
    );

    return (
      <DialogShell
        ref={shellRef}
        width="520px"
        title="add project"
        footer={footer}
        onClose={onClose}
      >
        <div className="add-workspace-body-content">
          {/* Block 1 — Host picker */}
          <div className="add-workspace-dialog-field">
            <label className="add-workspace-dialog-label" htmlFor="aw-node">
              host
            </label>
            <select
              id="aw-node"
              className="add-workspace-dialog-select"
              value={selectedNodeId}
              onChange={(e) => handleNodeChange(e.currentTarget.value)}
            >
              <option value={LOCAL_NODE_VALUE}>this host</option>
              {nodes.map((node) => {
                const reason = nodeShellBlockReason(node);
                return (
                  <option
                    key={node.nodeId}
                    value={node.nodeId}
                    disabled={reason !== null}
                  >
                    {node.displayName || node.nodeId}
                    {reason ? ` — ${reason}` : ''}
                  </option>
                );
              })}
            </select>
            {fetchNodesError && (
              <p className="add-workspace-error-msg">{fetchNodesError}</p>
            )}
          </div>

          {/* Block 2 — Path picker */}
          {!isRemote && (
            <>
              <p className="add-workspace-dialog-desc">
                browse for any folder on this machine. git repos get pr tracking
                + branch management automatically.
              </p>
              <FileBrowser
                ref={fileBrowserRef}
                selectedPaths={selectedPaths}
                onSelectedPathsChange={setSelectedPaths}
              />
            </>
          )}
          {isRemote && (
            <div className="add-workspace-dialog-field">
              <label
                className="add-workspace-dialog-label"
                htmlFor="aw-remote-cwd"
              >
                cwd on {selectedRemoteNode?.displayName ?? selectedNodeId}
              </label>
              <input
                id="aw-remote-cwd"
                type="text"
                className="add-workspace-dialog-input"
                placeholder={remoteHomeDir || 'absolute path on remote node'}
                value={remoteCwd}
                onChange={(e) => setRemoteCwd(e.currentTarget.value)}
                autoComplete="off"
              />
              <p className="add-workspace-dialog-note">
                remote files unavailable until file rpc lands
              </p>
            </div>
          )}

          {/* Block 3 — Save as project checkbox (local only; remote never persists) */}
          {!isRemote && (
            <div className="add-workspace-save-row">
              <input
                id="aw-save"
                type="checkbox"
                checked
                disabled
                readOnly
                className="add-workspace-checkbox"
              />
              <label
                htmlFor="aw-save"
                className="add-workspace-dialog-label add-workspace-save-label"
                title="non-git directories are saved as projects so they appear in the sidebar"
              >
                save as project
              </label>
            </div>
          )}

          {partialErrors.length > 0 && (
            <div className="add-workspace-partial-errors">
              <p className="add-workspace-error-msg">
                some paths could not be added:
              </p>
              <ul className="add-workspace-partial-errors-list">
                {partialErrors.map((e) => (
                  <li key={e.path} className="add-workspace-error-msg">
                    {e.path}: {e.error}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {error && <p className="add-workspace-error-msg">{error}</p>}
        </div>
      </DialogShell>
    );
  }
);

export default AddWorkspaceDialog;
