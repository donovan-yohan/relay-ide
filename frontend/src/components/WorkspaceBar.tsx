// #728: Workspace bar — the six-layer **Workspace** layer (a durable,
// user-authored grouping-of-Projects) over the view-spine sidebar. Flag-gated
// (only mounted by `ViewSpineTree` when `viewSpineEnabled`). Wires to the #733
// `/hub/ia/workspaces` CRUD API via `useIaWorkspaces`.
//
// Scope (MVP): list persisted Workspaces, CREATE (name), RENAME (inline),
// REORDER (up/down — lowest-risk vs. DnD, matches no existing drag dep in the
// sidebar), DELETE. Project assignment lives on the project rows (the parent
// passes `onAssignProject`); this bar owns workspace lifecycle only.
//
// States: empty (no workspaces → neutral copy + create affordance), loading,
// error (failed mutation → non-destructive inline message, list refetches),
// in-flight (controls disabled while a mutation is pending). Reuses existing
// TUI primitives + design tokens — no new visual language.
import { useState } from 'react';

import type { IaWorkspace } from '../lib/api.js';
import { useIaWorkspaces } from '../lib/hooks/use-ia-workspaces.js';
import { createLogger } from '../lib/logger.js';
import './WorkspaceBar.css';

const logger = createLogger('workspace-bar');

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

function WorkspaceRow({
  workspace,
  index,
  count,
  busy,
  onRename,
  onMoveUp,
  onMoveDown,
  onDelete,
}: {
  workspace: IaWorkspace;
  index: number;
  count: number;
  busy: boolean;
  onRename: (name: string) => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(workspace.name);

  function commit() {
    const trimmed = draft.trim();
    setEditing(false);
    if (trimmed.length === 0 || trimmed === workspace.name) {
      setDraft(workspace.name);
      return;
    }
    onRename(trimmed);
  }

  return (
    <li className="workspace-bar__row">
      {editing ? (
        <input
          type="text"
          className="workspace-bar__input workspace-bar__row-input"
          value={draft}
          autoFocus
          disabled={busy}
          onChange={(e) => setDraft(e.currentTarget.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              commit();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              setDraft(workspace.name);
              setEditing(false);
            }
          }}
          aria-label={`rename workspace ${workspace.name}`}
        />
      ) : (
        <button
          type="button"
          className="workspace-bar__name"
          disabled={busy}
          onClick={() => {
            setDraft(workspace.name);
            setEditing(true);
          }}
          title="rename"
        >
          {workspace.name}
        </button>
      )}
      <div className="workspace-bar__row-actions">
        <button
          type="button"
          className="workspace-bar__icon-btn"
          disabled={busy || index === 0}
          onClick={onMoveUp}
          aria-label={`move ${workspace.name} up`}
          title="move up"
        >
          ↑
        </button>
        <button
          type="button"
          className="workspace-bar__icon-btn"
          disabled={busy || index === count - 1}
          onClick={onMoveDown}
          aria-label={`move ${workspace.name} down`}
          title="move down"
        >
          ↓
        </button>
        <button
          type="button"
          className="workspace-bar__icon-btn workspace-bar__icon-btn--danger"
          disabled={busy}
          onClick={onDelete}
          aria-label={`delete ${workspace.name}`}
          title="delete workspace"
        >
          ×
        </button>
      </div>
    </li>
  );
}

export function WorkspaceBar() {
  const {
    workspaces,
    isLoading,
    isError,
    refetch,
    createMutation,
    updateMutation,
    deleteMutation,
  } = useIaWorkspaces();
  const [newName, setNewName] = useState('');
  const [actionError, setActionError] = useState<string | null>(null);

  // Any pending mutation disables the controls (in-flight guard). Ordered by
  // `order` asc then id (the API already returns this order, but re-sort defends
  // against any partial cache).
  const pending =
    createMutation.isPending ||
    updateMutation.isPending ||
    deleteMutation.isPending;
  const ordered = [...workspaces].sort(
    (a, b) => a.order - b.order || a.id.localeCompare(b.id)
  );

  function clearError() {
    setActionError(null);
  }

  function handleCreate() {
    const name = newName.trim();
    if (name.length === 0 || pending) return;
    clearError();
    createMutation.mutate(
      { name },
      {
        onSuccess: () => setNewName(''),
        onError: (err) => {
          logger.warn('create workspace failed', err);
          setActionError(errorMessage(err, 'could not create workspace'));
        },
      }
    );
  }

  function handleRename(workspace: IaWorkspace, name: string) {
    clearError();
    updateMutation.mutate(
      { id: workspace.id, patch: { name } },
      {
        onError: (err) => {
          logger.warn('rename workspace failed', err);
          setActionError(errorMessage(err, 'could not rename workspace'));
        },
      }
    );
  }

  // Reorder by swapping the `order` of two adjacent workspaces. Two PATCHes;
  // correctness-first (no optimistic UI). The list invalidates and refetches.
  function handleSwap(a: IaWorkspace, b: IaWorkspace) {
    clearError();
    updateMutation.mutate(
      { id: a.id, patch: { order: b.order } },
      {
        onError: (err) => {
          logger.warn('reorder workspace failed', err);
          setActionError(errorMessage(err, 'could not reorder workspace'));
        },
      }
    );
    updateMutation.mutate(
      { id: b.id, patch: { order: a.order } },
      {
        onError: (err) => {
          logger.warn('reorder workspace failed', err);
          setActionError(errorMessage(err, 'could not reorder workspace'));
        },
      }
    );
  }

  function handleDelete(workspace: IaWorkspace) {
    clearError();
    deleteMutation.mutate(workspace.id, {
      onError: (err) => {
        logger.warn('delete workspace failed', err);
        setActionError(errorMessage(err, 'could not delete workspace'));
      },
    });
  }

  return (
    <section className="workspace-bar" aria-label="workspaces">
      <div className="workspace-bar__header">
        <span className="workspace-bar__title">workspaces</span>
      </div>

      {isLoading ? (
        <div className="workspace-bar__hint">loading workspaces…</div>
      ) : ordered.length === 0 ? (
        <div className="workspace-bar__hint">
          no workspaces yet — create one to group your projects
        </div>
      ) : (
        <ul className="workspace-bar__list">
          {ordered.map((ws, index) => (
            <WorkspaceRow
              key={ws.id}
              workspace={ws}
              index={index}
              count={ordered.length}
              busy={pending}
              onRename={(name) => handleRename(ws, name)}
              onMoveUp={() => {
                const prev = ordered[index - 1];
                if (prev) handleSwap(ws, prev);
              }}
              onMoveDown={() => {
                const next = ordered[index + 1];
                if (next) handleSwap(ws, next);
              }}
              onDelete={() => handleDelete(ws)}
            />
          ))}
        </ul>
      )}

      <div className="workspace-bar__create-row">
        <input
          type="text"
          className="workspace-bar__input"
          placeholder="new workspace name"
          value={newName}
          disabled={pending}
          onChange={(e) => setNewName(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              handleCreate();
            }
          }}
          aria-label="new workspace name"
        />
        <button
          type="button"
          className="workspace-bar__create-btn"
          disabled={pending || newName.trim().length === 0}
          onClick={handleCreate}
        >
          {createMutation.isPending ? 'adding…' : '+ add'}
        </button>
      </div>

      {actionError ? (
        <div className="workspace-bar__error" role="alert">
          <span>{actionError}</span>
          <button
            type="button"
            className="workspace-bar__retry"
            onClick={() => {
              clearError();
              void refetch();
            }}
          >
            retry
          </button>
        </div>
      ) : isError ? (
        <div className="workspace-bar__error" role="alert">
          <span>could not load workspaces</span>
          <button
            type="button"
            className="workspace-bar__retry"
            onClick={() => void refetch()}
          >
            retry
          </button>
        </div>
      ) : null}
    </section>
  );
}

export default WorkspaceBar;
