import React, {
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  forwardRef,
} from 'react';
import type { ChangedFile } from '../lib/types.js';
import { statusIcon, statusColor } from '../lib/diff-utils.js';
import { rootShortName } from '../lib/utils.js';
import './DiffFileSidebar.css';

export interface DiffFileSidebarHandle {
  moveFocus: (delta: number) => void;
  getFocusedIndex: () => number;
}

export interface DiffFileSidebarProps {
  files: ChangedFile[];
  activeFile: string | null;
  onSelectFile: (file: ChangedFile) => void;
}

function fileDir(filePath: string): string {
  const idx = filePath.lastIndexOf('/');
  return idx === -1 ? '' : filePath.slice(0, idx);
}

export const DiffFileSidebar = forwardRef<
  DiffFileSidebarHandle,
  DiffFileSidebarProps
>(function DiffFileSidebar({ files, activeFile, onSelectFile }, ref) {
  const [focusedIndex, setFocusedIndex] = useState(0);
  const focusedIndexRef = useRef(focusedIndex);
  focusedIndexRef.current = focusedIndex;

  useImperativeHandle(ref, () => ({
    moveFocus(delta: number) {
      const next = Math.max(
        0,
        Math.min(files.length - 1, focusedIndexRef.current + delta)
      );
      setFocusedIndex(next);
      const file = files[next];
      if (file) onSelectFile(file);
    },
    getFocusedIndex() {
      return focusedIndexRef.current;
    },
  }));

  useEffect(() => {
    if (activeFile) {
      const idx = files.findIndex((f) => f.path === activeFile);
      if (idx >= 0) setFocusedIndex(idx);
    }
  }, [activeFile, files]);

  return (
    <div className="diff-sidebar" role="listbox" aria-label="changed files">
      {files.map((file, i) => (
        <button
          key={file.path}
          className={[
            'sidebar-file',
            activeFile === file.path && 'active',
            focusedIndex === i && 'focused',
          ]
            .filter(Boolean)
            .join(' ')}
          role="option"
          aria-selected={activeFile === file.path}
          data-file-index={i}
          data-state={file.status}
          onClick={() => {
            setFocusedIndex(i);
            onSelectFile(file);
          }}
        >
          <span
            className="status"
            style={{ color: statusColor[file.status] ?? 'var(--text-muted)' }}
          >
            {statusIcon[file.status] ?? '?'}
          </span>
          <span className="name" title={file.path}>
            {rootShortName(file.path)}
            {fileDir(file.path) ? (
              <span className="dir">{fileDir(file.path)}/</span>
            ) : null}
          </span>
          <span className="stats">
            <span className="stat-add">+{file.additions}</span>
            <span className="stat-del">-{file.deletions}</span>
          </span>
        </button>
      ))}
    </div>
  );
});

export default DiffFileSidebar;
