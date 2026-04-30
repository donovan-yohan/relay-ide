import type { FileChangeStatus } from '../../lib/types.js';

export interface FileIcon {
  glyph: string;
  className: string;
}

const FOLDER_OPEN: FileIcon = { glyph: '▾', className: 'icon--folder-open' };
const FOLDER_CLOSED: FileIcon = { glyph: '▸', className: 'icon--folder' };

const ICON_BY_EXT: Record<string, FileIcon> = {
  ts: { glyph: 'TS', className: 'icon--ts' },
  tsx: { glyph: '⟨⟩', className: 'icon--tsx' },
  js: { glyph: 'JS', className: 'icon--ts' },
  jsx: { glyph: '⟨⟩', className: 'icon--tsx' },
  css: { glyph: '#', className: 'icon--css' },
  scss: { glyph: '#', className: 'icon--css' },
  md: { glyph: 'M↓', className: 'icon--md' },
  json: { glyph: '{}', className: 'icon--json' },
  rs: { glyph: 'R', className: 'icon--rs' },
  py: { glyph: 'PY', className: 'icon--md' },
  go: { glyph: 'GO', className: 'icon--md' },
  rb: { glyph: 'RB', className: 'icon--md' },
  svg: { glyph: '◆', className: 'icon--svg' },
  yml: { glyph: 'Y', className: 'icon--yml' },
  yaml: { glyph: 'Y', className: 'icon--yml' },
  toml: { glyph: 'T', className: 'icon--toml' },
  lock: { glyph: '🔒', className: 'icon--lock' },
  env: { glyph: '🔒', className: 'icon--lock' },
  html: { glyph: '<>', className: 'icon--tsx' },
  sh: { glyph: '$', className: 'icon--md' },
  bash: { glyph: '$', className: 'icon--md' },
};

const FILE_DEFAULT: FileIcon = { glyph: '·', className: 'icon--md' };

export function folderIcon(open: boolean): FileIcon {
  return open ? FOLDER_OPEN : FOLDER_CLOSED;
}

export function fileIconForName(name: string): FileIcon {
  if (name.startsWith('.env')) return ICON_BY_EXT.env!;
  if (name.endsWith('.lock') || name === 'package-lock.json')
    return ICON_BY_EXT.lock!;
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  return ICON_BY_EXT[ext] ?? FILE_DEFAULT;
}

export const GIT_LETTER: Record<FileChangeStatus, string> = {
  added: 'A',
  modified: 'M',
  deleted: 'D',
  renamed: 'R',
  untracked: 'U',
};

export const GIT_CLASS: Record<FileChangeStatus, string> = {
  added: 'git--a',
  modified: 'git--m',
  deleted: 'git--d',
  renamed: 'git--r',
  untracked: 'git--u',
};
