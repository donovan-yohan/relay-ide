import type { ChangedFile, FileChangeStatus } from './types.js';

// ── Tree node types ──

export interface FileTreeNode {
  name: string;
  path: string;
  isDirectory: boolean;
  children: FileTreeNode[];
  expanded: boolean;
  status?: FileChangeStatus;
  additions: number;
  deletions: number;
  fileCount: number;
  depth: number;
}

export interface FlatNode {
  node: FileTreeNode;
  depth: number;
}

// ── buildChangedFilesTree ──
// Groups changed files into a directory tree, collapsing single-child directories.

export function buildChangedFilesTree(files: ChangedFile[]): FileTreeNode[] {
  if (files.length === 0) return [];

  const root: FileTreeNode = {
    name: '',
    path: '',
    isDirectory: true,
    children: [],
    expanded: true,
    additions: 0,
    deletions: 0,
    fileCount: 0,
    depth: 0,
  };

  for (const file of files) {
    const parts = file.path.split('/');
    let current = root;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]!;
      const isFile = i === parts.length - 1;
      const partPath = parts.slice(0, i + 1).join('/');

      if (isFile) {
        current.children.push({
          name: part,
          path: file.path,
          isDirectory: false,
          children: [],
          expanded: false,
          status: file.status,
          additions: file.additions,
          deletions: file.deletions,
          fileCount: 1,
          depth: i,
        });
      } else {
        let dir = current.children.find(
          (c) => c.isDirectory && c.name === part
        );
        if (!dir) {
          dir = {
            name: part,
            path: partPath,
            isDirectory: true,
            children: [],
            expanded: true,
            additions: 0,
            deletions: 0,
            fileCount: 0,
            depth: i,
          };
          current.children.push(dir);
        }
        current = dir;
      }
    }
  }

  // Aggregate stats up the tree
  function aggregate(node: FileTreeNode): void {
    if (!node.isDirectory) return;
    let additions = 0;
    let deletions = 0;
    let fileCount = 0;
    for (const child of node.children) {
      aggregate(child);
      additions += child.additions;
      deletions += child.deletions;
      fileCount += child.fileCount;
    }
    node.additions = additions;
    node.deletions = deletions;
    node.fileCount = fileCount;
  }
  aggregate(root);

  // Collapse single-child directories: if a dir has exactly one child that is also a dir,
  // merge them into "parent/child"
  function collapse(nodes: FileTreeNode[]): FileTreeNode[] {
    return nodes.map((node) => {
      if (!node.isDirectory) return node;
      node.children = collapse(node.children);
      if (node.children.length === 1 && node.children[0]!.isDirectory) {
        const child = node.children[0]!;
        return {
          ...child,
          name: `${node.name}/${child.name}`,
          depth: node.depth,
          children: child.children,
        };
      }
      return node;
    });
  }

  // Sort: directories first, then alphabetically
  function sortNodes(nodes: FileTreeNode[]): FileTreeNode[] {
    nodes.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const node of nodes) {
      if (node.isDirectory) sortNodes(node.children);
    }
    return nodes;
  }

  return sortNodes(collapse(root.children));
}

// ── flattenVisibleNodes ──
// Flattens tree into a list of visible nodes (respecting expanded state) for rendering.

export function flattenVisibleNodes(
  nodes: FileTreeNode[],
  depth = 0
): FlatNode[] {
  const result: FlatNode[] = [];
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]!;
    result.push({ node, depth });
    if (node.isDirectory && node.expanded) {
      result.push(...flattenVisibleNodes(node.children, depth + 1));
    }
  }
  return result;
}

// ── findMostRecentlyChanged ──
// Given previous and current changedFiles arrays from WebSocket events,
// returns the files that are new or changed since the last event.

export function findMostRecentlyChanged(
  previousFiles: string[],
  currentFiles: string[]
): string[] {
  const prevSet = new Set(previousFiles);
  return currentFiles.filter((f) => !prevSet.has(f));
}

// ── parseLineReference ──
// Parses a diff line number reference into filepath:linenum format.

export function parseLineReference(
  filePath: string,
  lineNumber: number
): string {
  return `\`${filePath}:${lineNumber}\``;
}

// ── statusToBadge ──
// Maps file change status to the single-character badge used in the sidebar.

export function statusToBadge(status: FileChangeStatus): string {
  switch (status) {
    case 'added':
      return 'A';
    case 'modified':
      return 'M';
    case 'deleted':
      return 'D';
    case 'renamed':
      return 'R';
    case 'untracked':
      return '?';
  }
}

export function statusToBadgeColor(status: FileChangeStatus): string {
  switch (status) {
    case 'added':
      return 'var(--status-success)';
    case 'modified':
      return 'var(--status-warning)';
    case 'deleted':
      return 'var(--status-error)';
    case 'renamed':
      return 'var(--status-info)';
    case 'untracked':
      return 'var(--text-muted)';
  }
}
