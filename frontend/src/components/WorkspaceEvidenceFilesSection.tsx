import { useCallback, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchWorkspaceEvidenceList } from '../lib/api.js';
import type {
  WorkspaceEvidenceEntry,
  WorkspaceEvidenceRoot,
} from '../../../shared/workspace-evidence.js';
import { workspaceEvidenceErrorReason } from '../lib/workspace-evidence-view.js';
import AllFilesTree from './AllFilesTree.js';
import WorkspaceEvidencePreview from './WorkspaceEvidencePreview.js';
import './WorkspaceEvidenceFilesSection.css';

export interface WorkspaceEvidenceFilesSectionProps {
  root: WorkspaceEvidenceRoot;
}

function listQueryKey(rootId: string, dirPath: string) {
  return ['workspace-evidence-list', rootId, dirPath] as const;
}

export function WorkspaceEvidenceFilesSection({
  root,
}: WorkspaceEvidenceFilesSectionProps) {
  const rootId = root.ref.id;
  const queryClient = useQueryClient();
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
  const [childrenByPath, setChildrenByPath] = useState<
    Map<string, WorkspaceEvidenceEntry[]>
  >(new Map());

  const rootListQuery = useQuery({
    queryKey: listQueryKey(rootId, ''),
    queryFn: () => fetchWorkspaceEvidenceList({ rootRef: root.ref }),
    staleTime: 60_000,
    refetchOnWindowFocus: true,
    retry: false,
  });

  const onFileClick = useCallback((path: string) => {
    setSelectedPath(path);
  }, []);

  const onDirToggle = useCallback(
    (path: string) => {
      setExpandedPaths((prev) => {
        const next = new Set(prev);
        if (next.has(path)) {
          next.delete(path);
          return next;
        }
        next.add(path);
        return next;
      });
      if (childrenByPath.has(path)) return;
      void queryClient
        .fetchQuery({
          queryKey: listQueryKey(rootId, path),
          queryFn: () =>
            fetchWorkspaceEvidenceList({ rootRef: root.ref, path }),
          staleTime: 60_000,
        })
        .then((res) => {
          setChildrenByPath((prev) => new Map([...prev, [path, res.entries]]));
        })
        .catch(() => {
          // best-effort expansion; root-level errors surface in the tree body
        });
    },
    [childrenByPath, queryClient, root.ref, rootId]
  );

  function renderTree() {
    if (rootListQuery.isLoading) {
      return <div className="evidence-files__notice">loading…</div>;
    }
    if (rootListQuery.isError) {
      const reason = workspaceEvidenceErrorReason(rootListQuery.error);
      if (reason === 'WORKSPACE_EVIDENCE_PERMISSION_DENIED') {
        return (
          <div className="evidence-files__notice">
            permission denied reading this directory
          </div>
        );
      }
      if (reason === 'WORKSPACE_EVIDENCE_ROOT_NOT_FOUND') {
        return (
          <div className="evidence-files__notice">root path not found</div>
        );
      }
      return (
        <div className="evidence-files__error">
          failed to load files
          <button
            type="button"
            className="evidence-files__retry"
            onClick={() => void rootListQuery.refetch()}
          >
            retry
          </button>
        </div>
      );
    }
    return (
      <AllFilesTree
        entries={rootListQuery.data?.entries ?? []}
        childrenByPath={childrenByPath}
        expandedPaths={expandedPaths}
        selectedPath={selectedPath}
        onFileClick={onFileClick}
        onDirToggle={onDirToggle}
      />
    );
  }

  return (
    <div className="evidence-files" data-track="evidence.files">
      <div className="evidence-files__tree">{renderTree()}</div>
      <div className="evidence-files__preview">
        <WorkspaceEvidencePreview root={root} selectedPath={selectedPath} />
      </div>
    </div>
  );
}

export default WorkspaceEvidenceFilesSection;
