import { commandSpec } from '../../../shared/cli-gateway-contract.js';

/**
 * Editor usability affordances (#1004).
 *
 * Two concerns, both pure so they can be unit-tested without a DOM:
 *  1. An honest catalogue of the editor's *active* keyboard shortcuts. The help
 *     affordance renders this verbatim and must not claim shortcuts the
 *     CodeMirror setup does not actually bind — anything not wired yet is
 *     flagged `available: false` with a follow-up note instead of being hidden.
 *  2. `relay-ide v1 files read/write --json` command strings for the open file,
 *     derived from the CLI gateway contract's own `cli` template so the
 *     command-copy affordance can never drift from the shipped contract.
 */

export interface EditorShortcut {
  id: string;
  /** `mod+key` form understood by `formatShortcut`; `mod` renders ⌘ / ctrl. */
  combo: string;
  description: string;
  /**
   * Whether the active CodeMirror keymap actually binds this. `false` means the
   * help panel documents it as a known follow-up rather than pretending it works.
   */
  available: boolean;
  note?: string;
}

/**
 * Shortcuts bound by the current `CodeMirrorFileEditor` keymap. Keep in sync with
 * the `keymap.of([...])` extension list in CodeMirrorFileEditor.tsx — the editor
 * shortcut help test asserts the two stay aligned for the save binding.
 */
export const EDITOR_SHORTCUTS: readonly EditorShortcut[] = [
  { id: 'save', combo: 'mod+s', description: 'save file', available: true },
  { id: 'undo', combo: 'mod+z', description: 'undo', available: true },
  { id: 'redo', combo: 'mod+shift+z', description: 'redo', available: true },
  {
    id: 'indent',
    combo: 'tab',
    description: 'indent line / selection',
    available: true,
  },
  {
    id: 'outdent',
    combo: 'shift+tab',
    description: 'outdent line / selection',
    available: true,
  },
  {
    id: 'select-all',
    combo: 'mod+a',
    description: 'select all',
    available: true,
  },
  {
    id: 'find',
    combo: 'mod+f',
    description: 'find / search in file',
    available: false,
    note: 'follow-up: in-file search panel not yet enabled (#1004)',
  },
];

export interface FilesCommandTarget {
  /** Scoped session id the File RPC runs through; null renders a placeholder. */
  sessionId: string | null;
  /** Path as the session sees it (absolute or session-relative). */
  path: string;
}

const SESSION_ID_PLACEHOLDER = '<session-id>';

/** Quote a token for a copy-pasteable POSIX shell command line. */
function shellQuote(token: string): string {
  if (token === '') return "''";
  // Leave `<placeholder>` tokens unquoted to match the contract/docs convention
  // (`--session-id <session-id>`); real substituted values never contain `<>`.
  if (/^<[^<>]+>$/u.test(token)) return token;
  if (/^[A-Za-z0-9_\-./:@=,]+$/u.test(token)) return token;
  return `'${token.replace(/'/gu, `'\\''`)}'`;
}

function renderCli(
  tokens: readonly string[],
  substitutions: Record<string, string>
): string {
  return tokens
    .map((token) => substitutions[token] ?? token)
    .map(shellQuote)
    .join(' ');
}

/**
 * `relay-ide v1 files read --json` for the open file, rendered from the
 * `files.read` contract `cli` template.
 */
export function buildFilesReadCommand(target: FilesCommandTarget): string {
  return renderCli(commandSpec('files.read').cli, {
    [SESSION_ID_PLACEHOLDER]: target.sessionId ?? SESSION_ID_PLACEHOLDER,
    '<path>': target.path,
  });
}

/**
 * `relay-ide v1 files write --json` for the open file, rendered from the
 * `files.write` contract `cli` template. Defaults to `overwrite` mode reading
 * the new contents from stdin (`--file -`), matching the browser save semantics.
 */
export function buildFilesWriteCommand(
  target: FilesCommandTarget,
  mode: 'create' | 'overwrite' | 'append' = 'overwrite'
): string {
  return renderCli(commandSpec('files.write').cli, {
    [SESSION_ID_PLACEHOLDER]: target.sessionId ?? SESSION_ID_PLACEHOLDER,
    '<path>': target.path,
    '<create|overwrite|append>': mode,
    '<local-path|->': '-',
  });
}

/** Resolve a workspace-relative file path to an absolute path for copy/CLI. */
export function toAbsoluteFilePath(
  workspacePath: string,
  filePath: string
): string {
  if (filePath.startsWith('/')) return filePath;
  // No workspace root (e.g. an evidence root with a null path) — return the
  // relative path as-is rather than fabricating a bogus "/file" absolute path.
  if (!workspacePath) return filePath;
  return `${workspacePath.replace(/\/+$/u, '')}/${filePath.replace(/^\/+/u, '')}`;
}
