import React from 'react';
import type { AgentFileChangeItemV2 } from '../../../../shared/agent-chat-protocol-v2.js';

interface FileChangeRowProps {
  item: AgentFileChangeItemV2;
}

function summarizePatch(patch: string | undefined): {
  additions: number;
  deletions: number;
} {
  if (!patch) return { additions: 0, deletions: 0 };
  let additions = 0;
  let deletions = 0;
  for (const line of patch.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) additions++;
    if (line.startsWith('-')) deletions++;
  }
  return { additions, deletions };
}

export const FileChangeRow: React.FC<FileChangeRowProps> = ({ item }) => {
  const primaryPath = item.paths[0];
  const pathLabel = primaryPath?.path ?? 'unknown file';
  const kind =
    primaryPath?.status ?? item.applyStatus ?? item.status ?? 'changed';
  const stats = summarizePatch(item.patch);

  return (
    <div
      className="fc-row"
      role="article"
      aria-label={`file change ${pathLabel}`}
    >
      <span className="fc-row__path">{pathLabel}</span>
      <span className="fc-row__stats">
        <span className="fc-row__add">+{stats.additions}</span>
        <span className="fc-row__del">-{stats.deletions}</span>
      </span>
      <span className="fc-row__kind">{kind}</span>
    </div>
  );
};

export default FileChangeRow;
