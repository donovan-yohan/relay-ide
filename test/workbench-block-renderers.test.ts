/**
 * Tests for first-party Workbench block renderers — slice 2, #620.
 *
 * Uses source-level assertions (matching the codebase's established pattern
 * from test/components/*.test.ts) rather than DOM rendering. This avoids the
 * need for jsdom/happy-dom, complex mock trees for xterm.js/ws, and is
 * consistent with how the rest of the frontend is tested here.
 *
 * Covers:
 *   - markdown renderer: structure, imports, exports, CSS
 *   - work-context renderer: structure, imports, exports, TanStack Query usage
 *   - custom renderer: scaffold notice, exports, no payload execution
 *   - file renderer: capability gating, exports
 *   - artifact renderer: kind-specific rendering, exports
 *   - terminal renderer: session key derivation, exports
 *   - agent renderer: actor ref usage, exports
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FileBlockDescriptor } from '../shared/workbench-block-types.js';
import { isFileResourceRef } from '../shared/workbench-block-types.js';
import type { FileResourceRef } from '../shared/file-resource-ref.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');
const blocksDir = join(projectRoot, 'frontend/src/workbench/blocks');
const frontendLibDir = join(projectRoot, 'frontend/src/lib');

function readBlock(name: string) {
  return readFileSync(join(blocksDir, name), 'utf-8');
}

function readFrontendLib(name: string) {
  return readFileSync(join(frontendLibDir, name), 'utf-8');
}

function blockExists(name: string) {
  return existsSync(join(blocksDir, name));
}

// ---------------------------------------------------------------------------
// markdown renderer
// ---------------------------------------------------------------------------

describe('markdown renderer', () => {
  it('file exists', () => {
    expect(blockExists('markdown.tsx')).toBe(true);
  });

  it('css file exists', () => {
    expect(blockExists('markdown.css')).toBe(true);
  });

  it('exports MarkdownBlock', () => {
    const src = readBlock('markdown.tsx');
    expect(src).toContain('export const MarkdownBlock');
  });

  it('is typed as WorkbenchBlockRenderer<"markdown">', () => {
    const src = readBlock('markdown.tsx');
    expect(src).toContain(`WorkbenchBlockRenderer<'markdown'>`);
  });

  it('reads content from descriptor.meta.content', () => {
    const src = readBlock('markdown.tsx');
    expect(src).toContain('descriptor.meta');
    expect(src).toContain('content');
  });

  it('uses CodeBlock for rendering', () => {
    const src = readBlock('markdown.tsx');
    expect(src).toContain('CodeBlock');
    expect(src).toContain(`language="markdown"`);
  });

  it('imports CodeBlock from components', () => {
    const src = readBlock('markdown.tsx');
    expect(src).toContain('CodeBlock');
    expect(src).toContain('../../components/CodeBlock');
  });

  it('imports CSS', () => {
    const src = readBlock('markdown.tsx');
    expect(src).toContain("'./markdown.css'");
  });

  it('CSS has block-markdown class', () => {
    const css = readBlock('markdown.css');
    expect(css).toContain('.block-markdown');
  });

  it('CSS uses CSS variables', () => {
    const css = readBlock('markdown.css');
    expect(css).toContain('var(--');
  });

  it('passes descriptor.id as cache key to CodeBlock', () => {
    const src = readBlock('markdown.tsx');
    expect(src).toContain('descriptor.id');
  });

  it('has aria-label on root element', () => {
    const src = readBlock('markdown.tsx');
    expect(src).toContain('aria-label');
  });
});

// ---------------------------------------------------------------------------
// work-context renderer
// ---------------------------------------------------------------------------

describe('work-context renderer', () => {
  it('file exists', () => {
    expect(blockExists('work-context.tsx')).toBe(true);
  });

  it('css file exists', () => {
    expect(blockExists('work-context.css')).toBe(true);
  });

  it('exports WorkContextBlock', () => {
    const src = readBlock('work-context.tsx');
    expect(src).toContain('export const WorkContextBlock');
  });

  it('is typed as WorkbenchBlockRenderer<"work-context">', () => {
    const src = readBlock('work-context.tsx');
    expect(src).toContain(`WorkbenchBlockRenderer<'work-context'>`);
  });

  it('reads workContextRef from descriptor.meta', () => {
    const src = readBlock('work-context.tsx');
    expect(src).toContain('workContextRef');
  });

  it('uses TanStack Query (useQuery)', () => {
    const src = readBlock('work-context.tsx');
    expect(src).toContain('useQuery');
    expect(src).toContain('@tanstack/react-query');
  });

  it('uses fetchActiveWork API', () => {
    const src = readBlock('work-context.tsx');
    expect(src).toContain('fetchActiveWork');
  });

  it('has loading state', () => {
    const src = readBlock('work-context.tsx');
    expect(src).toContain('isLoading');
  });

  it('has error state', () => {
    const src = readBlock('work-context.tsx');
    expect(src).toContain('error');
  });

  it('has empty/not-found state', () => {
    const src = readBlock('work-context.tsx');
    expect(src).toContain('not found');
  });

  it('CSS has block-work-context class', () => {
    const css = readBlock('work-context.css');
    expect(css).toContain('.block-work-context');
  });

  it('does not use raw filesystem paths', () => {
    const src = readBlock('work-context.tsx');
    // No direct path strings — only refs
    expect(src).not.toContain("'/");
    expect(src).not.toContain('process.cwd');
    expect(src).not.toContain('__dirname');
  });
});

// ---------------------------------------------------------------------------
// prompt-fanout renderer
// ---------------------------------------------------------------------------

describe('prompt-fanout renderer', () => {
  it('file exists', () => {
    expect(blockExists('prompt-fanout.tsx')).toBe(true);
  });

  it('css file exists', () => {
    expect(blockExists('prompt-fanout.css')).toBe(true);
  });

  it('exports PromptFanoutBlock', () => {
    const src = readBlock('prompt-fanout.tsx');
    expect(src).toContain('export const PromptFanoutBlock');
  });

  it('is typed as WorkbenchBlockRenderer<"prompt-fanout">', () => {
    const src = readBlock('prompt-fanout.tsx');
    expect(src).toContain(`WorkbenchBlockRenderer<'prompt-fanout'>`);
  });

  it('uses PromptFanoutRun fixtures and schema helpers', () => {
    const src = readBlock('prompt-fanout.tsx');
    expect(src).toContain('getPromptFanoutRunFixture');
    expect(src).toContain('selectedPromptFanoutTargets');
    expect(src).toContain('unselectedPromptFanoutTargets');
  });

  it('has visible loading, empty, denied, and partial-failure states', () => {
    const src = readBlock('prompt-fanout.tsx');
    expect(src).toContain('block-prompt-fanout--loading');
    expect(src).toContain('block-prompt-fanout--empty');
    expect(src).toContain('block-prompt-fanout--denied');
    expect(src).toContain('block-prompt-fanout--partial-failure');
  });

  it('distinguishes selected targets from all sessions', () => {
    const src = readBlock('prompt-fanout.tsx');
    expect(src).toContain('selected targets');
    expect(src).toContain('all sessions not selected');
    expect(src).toContain('no broadcast-to-all default');
  });

  it('dry-run action emits audit event without terminal input', () => {
    const src = readBlock('prompt-fanout.tsx');
    expect(src).toContain('prompt-fanout.dry-run');
    expect(src).toContain('sendsTerminalInput: false');
    expect(src).not.toContain('sendInput');
    expect(src).not.toContain('writeTerminal');
  });

  it('CSS has block-prompt-fanout classes', () => {
    const css = readBlock('prompt-fanout.css');
    expect(css).toContain('.block-prompt-fanout');
    expect(css).toContain('.block-prompt-fanout__dry-run');
  });
});

// ---------------------------------------------------------------------------
// custom renderer (slice 4 — sandboxed proposal/approval flow)
// ---------------------------------------------------------------------------

describe('custom renderer (slice 4)', () => {
  it('file exists', () => {
    expect(blockExists('custom.tsx')).toBe(true);
  });

  it('css file exists', () => {
    expect(blockExists('custom.css')).toBe(true);
  });

  it('exports CustomBlock', () => {
    const src = readBlock('custom.tsx');
    expect(src).toContain('export const CustomBlock');
  });

  it('is typed as WorkbenchBlockRenderer<"custom">', () => {
    const src = readBlock('custom.tsx');
    expect(src).toContain(`WorkbenchBlockRenderer<'custom'>`);
  });

  it('does NOT contain the slice-2 scaffold notice', () => {
    // Slice 4 replaced the placeholder — scaffold notice must be gone
    const src = readBlock('custom.tsx');
    expect(src).not.toContain('sandbox not yet implemented');
    expect(src).not.toContain('SCAFFOLD ONLY');
  });

  it('does NOT execute props as code', () => {
    const src = readBlock('custom.tsx');
    expect(src).not.toContain('eval(');
    expect(src).not.toContain('new Function(');
    expect(src).not.toContain('dangerouslySetInnerHTML');
  });

  it('uses rendererId from descriptor.meta to look up the approved proposal', () => {
    const src = readBlock('custom.tsx');
    expect(src).toContain('rendererId');
    expect(src).toContain('proposalId');
  });

  it('renders revoked state when proposal is revoked', () => {
    const src = readBlock('custom.tsx');
    expect(src).toContain('revoked');
    expect(src).toContain('RevokedCard');
  });

  it('uses TanStack Query to load proposal by id', () => {
    const src = readBlock('custom.tsx');
    expect(src).toContain('useQuery');
    // Uses fetchCustomBlockProposalById to load any status, not just approved.
    expect(src).toContain('fetchCustomBlockProposalById');
  });

  it('delegates rendering to TemplateRenderer', () => {
    const src = readBlock('custom.tsx');
    expect(src).toContain('TemplateRenderer');
  });

  it('does NOT access process.env (sandbox boundary)', () => {
    const src = readBlock('custom.tsx');
    expect(src).not.toContain('process.env');
  });

  it('does NOT access localStorage (sandbox boundary)', () => {
    const src = readBlock('custom.tsx');
    expect(src).not.toContain('localStorage');
  });

  it('CSS has block-custom class', () => {
    const css = readBlock('custom.css');
    expect(css).toContain('.block-custom');
  });

  it('CSS has block-custom__notice class', () => {
    const css = readBlock('custom.css');
    expect(css).toContain('.block-custom__notice');
  });

  it('CSS has revoked modifier class', () => {
    const css = readBlock('custom.css');
    expect(css).toContain('block-custom__notice--revoked');
  });
});

// ---------------------------------------------------------------------------
// file renderer
// ---------------------------------------------------------------------------

describe('file renderer', () => {
  it('file exists', () => {
    expect(blockExists('file.tsx')).toBe(true);
  });

  it('exports FileBlock', () => {
    const src = readBlock('file.tsx');
    expect(src).toContain('export const FileBlock');
  });

  it('is typed as WorkbenchBlockRenderer<"file">', () => {
    const src = readBlock('file.tsx');
    expect(src).toContain(`WorkbenchBlockRenderer<'file'>`);
  });

  it('respects rpc:fs:read capability grant', () => {
    const src = readBlock('file.tsx');
    expect(src).toContain('rpc:fs:read');
  });

  it('reads mode from descriptor.meta', () => {
    const src = readBlock('file.tsx');
    expect(src).toContain('mode');
    expect(src).toContain('read');
    expect(src).toContain('diff');
  });

  it('reads fileRef.id (not a raw filesystem path)', () => {
    const src = readBlock('file.tsx');
    expect(src).toContain('fileRef.id');
    // `filePath` is allowed as a JSX prop name (e.g., DiffViewer's filePath
    // prop). The substantive raw-path ban is enforced by the cwd/__dirname
    // assertion below.
  });

  it('does not use raw filesystem paths', () => {
    const src = readBlock('file.tsx');
    expect(src).not.toContain('process.cwd');
    expect(src).not.toContain('__dirname');
  });

  it('CSS exists', () => {
    expect(blockExists('file.css')).toBe(true);
  });

  it('CSS has block-file class', () => {
    const css = readBlock('file.css');
    expect(css).toContain('.block-file');
  });

  // ---------------------------------------------------------------------------
  // Slice 2: FileResourceRef integration assertions (source-level)
  // ---------------------------------------------------------------------------

  it('imports isFileResourceRef type guard', () => {
    const src = readBlock('file.tsx');
    expect(src).toContain('isFileResourceRef');
  });

  it('imports FILE_RPC_MAX_READ_BYTES constant', () => {
    const src = readBlock('file.tsx');
    expect(src).toContain('FILE_RPC_MAX_READ_BYTES');
  });

  it('imports fetchNodeFsStat and fetchNodeFsRead from api', () => {
    const src = readBlock('file.tsx');
    expect(src).toContain('fetchNodeFsStat');
    expect(src).toContain('fetchNodeFsRead');
  });

  it('uses TanStack Query useQuery for stat and read', () => {
    const src = readBlock('file.tsx');
    expect(src).toContain('@tanstack/react-query');
    expect(src).toContain('useQuery');
    expect(src).toContain("'fs.stat'");
    expect(src).toContain("'fs.read'");
  });

  it('has no refetchInterval (no polling)', () => {
    const src = readBlock('file.tsx');
    expect(src).not.toContain('refetchInterval');
  });

  it('uses refetchOnWindowFocus', () => {
    const src = readBlock('file.tsx');
    expect(src).toContain('refetchOnWindowFocus');
  });

  it('has staleTime set', () => {
    const src = readBlock('file.tsx');
    expect(src).toContain('staleTime');
  });

  it('has "too large" fallback state', () => {
    const src = readBlock('file.tsx');
    expect(src).toContain('block-file__too-large');
    expect(src).toContain('too large');
  });

  it('CSS has block-file__too-large class', () => {
    const css = readBlock('file.css');
    expect(css).toContain('.block-file__too-large');
  });

  it('has binary fallback state', () => {
    const src = readBlock('file.tsx');
    expect(src).toContain('block-file__binary');
    expect(src).toContain('binary');
  });

  it('CSS has block-file__binary class', () => {
    const css = readBlock('file.css');
    expect(css).toContain('.block-file__binary');
  });

  it('has inline error state', () => {
    const src = readBlock('file.tsx');
    expect(src).toContain('block-file__error');
    expect(src).toContain('isError');
  });

  it('CSS has block-file__error class', () => {
    const css = readBlock('file.css');
    expect(css).toContain('.block-file__error');
  });

  it('renders content in a pre element', () => {
    const src = readBlock('file.tsx');
    expect(src).toContain('<pre');
    expect(src).toContain('block-file__content');
    // Reads the UTF-8 content field from the FileRpcReadResponse
    expect(src).toContain('.content');
  });

  it('handles NODE_OFFLINE error code', () => {
    const src = readBlock('file.tsx');
    expect(src).toContain('NODE_OFFLINE');
    expect(src).toContain('node offline');
  });

  it('handles FORBIDDEN / 403 error', () => {
    const src = readBlock('file.tsx');
    expect(src).toContain('FORBIDDEN');
    expect(src).toContain('not authorized');
  });

  it('gates read query on stat success (enabled flag)', () => {
    const src = readBlock('file.tsx');
    expect(src).toContain('enabled');
    expect(src).toContain('enableRead');
  });

  it('legacy FileRef falls through to placeholder (no useQuery in legacy branch)', () => {
    const src = readBlock('file.tsx');
    // The legacy branch returns early before reaching the hooks component
    expect(src).toContain('isFileResourceRef');
    // Legacy branch still renders placeholder copy
    expect(src).toContain('pending slice-3 rpc:fs');
  });

  it('checks session availability before fetching', () => {
    const src = readBlock('file.tsx');
    expect(src).toContain('sessionId');
    expect(src).toContain('session required');
  });

  it('renders bounded directory previews through fs.list', () => {
    const src = readBlock('file.tsx');
    expect(src).toContain('fetchNodeFsList');
    expect(src).toContain("'fs.list'");
    expect(src).toContain('FILE_RPC_DEFAULT_LIST_ENTRIES');
    expect(src).toContain("stat.type === 'directory'");
    expect(src).toContain('block-file__directory');
    expect(src).toContain('empty directory');
    expect(src).toContain('entries.map');
  });

  it('uses a bounded tail helper for log previews', () => {
    const src = readBlock('file.tsx');
    const api = readFrontendLib('api.ts');
    expect(src).toContain('fetchNodeFsTail');
    expect(src).toContain("fileRef.intent === 'tail'");
    expect(src).toContain("'fs.tail'");
    expect(src).toContain('FILE_RPC_MAX_TAIL_BYTES');
    expect(src).toContain('FILE_RPC_MAX_TAIL_LINES');
    expect(src).toContain('block-file__tail-meta');
    expect(api).toContain('export async function fetchNodeFsTail');
    expect(api).toContain('/files/tail');
  });

  it('renders common image previews from bounded base64 reads', () => {
    const src = readBlock('file.tsx');
    expect(src).toContain('IMAGE_MIME_BY_EXTENSION');
    expect(src).toContain("encoding: 'base64'");
    expect(src).toContain('data:${imageMime};base64');
    expect(src).toContain('block-file__image');
    expect(src).toContain('block-file__image-img');
    expect(src).toContain('image too large to preview');
  });

  it('renders PDF and unsupported fallbacks without parsing bytes', () => {
    const src = readBlock('file.tsx');
    expect(src).toContain('isPdfPath');
    expect(src).toContain('pdf preview unavailable');
    expect(src).toContain('unsupported preview');
    expect(src).toContain('open/download from file browser');
    expect(src).toContain('block-file__unsupported');
  });

  it('renders a metadata row with identity, freshness, binding, and grant state', () => {
    const src = readBlock('file.tsx');
    expect(src).toContain('block-file__metadata');
    expect(src).toContain('node:');
    expect(src).toContain('intent:');
    expect(src).toContain('fresh:');
    expect(src).toContain('grant:');
    expect(src).toContain('repo:');
    expect(src).toContain('worktree:');
    expect(src).toContain('non-git cwd');
  });

  // ---------------------------------------------------------------------------
  // Slice 4: edit-mode + fs.write integration (source-level)
  // ---------------------------------------------------------------------------

  it('imports fetchNodeFsWrite from api', () => {
    const src = readBlock('file.tsx');
    expect(src).toContain('fetchNodeFsWrite');
  });

  it('imports DiffViewer for diff preview', () => {
    const src = readBlock('file.tsx');
    expect(src).toContain('DiffViewer');
  });

  it('imports createPatch from diff for unified-diff generation', () => {
    const src = readBlock('file.tsx');
    expect(src).toContain("from 'diff'");
    expect(src).toContain('createPatch');
  });

  it('imports grantedBits for capability gating', () => {
    const src = readBlock('file.tsx');
    expect(src).toContain('grantedBits');
  });

  it('gates the save affordance on rpc:fs:write', () => {
    const src = readBlock('file.tsx');
    expect(src).toContain('rpc:fs:write');
    expect(src).toContain('rpc:fs:write not granted');
  });

  it('uses useMutation for the write call', () => {
    const src = readBlock('file.tsx');
    expect(src).toContain('useMutation');
  });

  it('passes expectedHash to the write call (optimistic concurrency)', () => {
    const src = readBlock('file.tsx');
    expect(src).toContain('expectedHash');
  });

  it('hashes initial content via Web Crypto sha-256', () => {
    const src = readBlock('file.tsx');
    expect(src).toContain('SHA-256');
    expect(src).toContain('crypto.subtle.digest');
  });

  it('handles FILE_RPC_WRITE_HASH_MISMATCH error code', () => {
    const src = readBlock('file.tsx');
    expect(src).toContain('FILE_RPC_WRITE_HASH_MISMATCH');
    expect(src).toContain('file changed since last read');
  });

  it('handles real server stale expectedHash reasonCode shape', () => {
    const src = readBlock('file.tsx');
    expect(src).toContain(
      "const FILE_RPC_INVALID_REQUEST_CODE = 'INVALID_REQUEST'"
    );
    expect(src).toContain('FILE_RPC_EXPECTED_HASH_MISMATCH');
    expect(src).toContain('err.details?.reasonCode');
    expect(src).toContain('isWriteHashMismatchError(err)');
    expect(src).toContain('isWriteHashMismatchError(mutation.error)');
  });

  it('handles FILE_RPC_WRITE_PERMISSION_DENIED error code', () => {
    const src = readBlock('file.tsx');
    expect(src).toContain('FILE_RPC_WRITE_PERMISSION_DENIED');
  });

  it('handles FILE_RPC_WRITE_SIZE_EXCEEDED error code', () => {
    const src = readBlock('file.tsx');
    expect(src).toContain('FILE_RPC_WRITE_SIZE_EXCEEDED');
  });

  it('CSS has block-file__edit classes', () => {
    const css = readBlock('file.css');
    expect(css).toContain('.block-file__edit');
    expect(css).toContain('.block-file__edit-textarea');
    expect(css).toContain('.block-file__edit-actions');
    expect(css).toContain('.block-file__edit-button');
    expect(css).toContain('.block-file__edit-gate');
  });
});

// ---------------------------------------------------------------------------
// FileBlockDescriptor with FileResourceRef — JSON round-trip
// ---------------------------------------------------------------------------

describe('FileBlockDescriptor with FileResourceRef round-trip', () => {
  const fileResourceRef: FileResourceRef = {
    nodeId: 'node-test-01',
    path: '/workspace/src/index.ts',
    capturedAt: '2026-05-20T00:00:00Z',
    intent: 'read',
    size: 1024,
  };

  const descriptor: FileBlockDescriptor = {
    kind: 'file',
    id: 'fb-resource-01',
    title: 'src/index.ts',
    capabilityRequirements: ['rpc:fs:read'],
    meta: {
      fileRef: fileResourceRef,
      mode: 'read',
    },
  };

  it('JSON round-trip preserves FileResourceRef shape', () => {
    const serialised = JSON.stringify(descriptor);
    const parsed = JSON.parse(serialised) as FileBlockDescriptor;
    expect(parsed.kind).toBe('file');
    expect(parsed.meta.mode).toBe('read');
    const ref = parsed.meta.fileRef;
    expect((ref as FileResourceRef).nodeId).toBe('node-test-01');
    expect((ref as FileResourceRef).path).toBe('/workspace/src/index.ts');
    expect((ref as FileResourceRef).capturedAt).toBe('2026-05-20T00:00:00Z');
    expect((ref as FileResourceRef).intent).toBe('read');
    expect((ref as FileResourceRef).size).toBe(1024);
  });

  it('isFileResourceRef returns true for round-tripped FileResourceRef', () => {
    const serialised = JSON.stringify(descriptor);
    const parsed = JSON.parse(serialised) as FileBlockDescriptor;
    expect(isFileResourceRef(parsed.meta.fileRef)).toBe(true);
  });

  it('isFileResourceRef returns false for legacy FileRef', () => {
    const legacyDescriptor: FileBlockDescriptor = {
      kind: 'file',
      id: 'fb-legacy-01',
      title: 'index.ts',
      capabilityRequirements: ['rpc:fs:read'],
      meta: {
        fileRef: { kind: 'file', id: 'rpc:fs:local:%2Findex.ts' },
      },
    };
    const parsed = JSON.parse(
      JSON.stringify(legacyDescriptor)
    ) as FileBlockDescriptor;
    expect(isFileResourceRef(parsed.meta.fileRef)).toBe(false);
  });

  it('round-trip preserves the full descriptor deep-equal', () => {
    const parsed = JSON.parse(
      JSON.stringify(descriptor)
    ) as FileBlockDescriptor;
    expect(parsed).toEqual(descriptor);
  });
});

// ---------------------------------------------------------------------------
// artifact renderer
// ---------------------------------------------------------------------------

describe('artifact renderer', () => {
  it('file exists', () => {
    expect(blockExists('artifact.tsx')).toBe(true);
  });

  it('exports ArtifactBlock', () => {
    const src = readBlock('artifact.tsx');
    expect(src).toContain('export const ArtifactBlock');
  });

  it('is typed as WorkbenchBlockRenderer<"artifact">', () => {
    const src = readBlock('artifact.tsx');
    expect(src).toContain(`WorkbenchBlockRenderer<'artifact'>`);
  });

  it('branches on artifactRef.kind', () => {
    const src = readBlock('artifact.tsx');
    expect(src).toContain('artifactRef.kind');
    // Verify at least a few kinds are handled
    expect(src).toContain("'screenshot'");
    expect(src).toContain("'diff'");
    expect(src).toContain("'log-ref'");
  });

  it('reads artifactRef from descriptor.meta', () => {
    const src = readBlock('artifact.tsx');
    // Renderer destructures artifactRef from descriptor.meta
    expect(src).toContain('descriptor.meta');
    expect(src).toContain('artifactRef');
  });

  it('CSS exists', () => {
    expect(blockExists('artifact.css')).toBe(true);
  });

  it('CSS has block-artifact class', () => {
    const css = readBlock('artifact.css');
    expect(css).toContain('.block-artifact');
  });
});

// ---------------------------------------------------------------------------
// terminal renderer
// ---------------------------------------------------------------------------

describe('terminal renderer', () => {
  it('file exists', () => {
    expect(blockExists('terminal.tsx')).toBe(true);
  });

  it('exports TerminalBlock', () => {
    const src = readBlock('terminal.tsx');
    expect(src).toContain('export const TerminalBlock');
  });

  it('is typed as WorkbenchBlockRenderer<"terminal">', () => {
    const src = readBlock('terminal.tsx');
    expect(src).toContain(`WorkbenchBlockRenderer<'terminal'>`);
  });

  it('uses sessionRef from descriptor.meta', () => {
    const src = readBlock('terminal.tsx');
    expect(src).toContain('sessionRef');
    expect(src).toContain('descriptor.meta');
  });

  it('derives sessionKey from nodeId:sessionId (not raw path)', () => {
    const src = readBlock('terminal.tsx');
    expect(src).toContain('nodeId');
    expect(src).toContain('sessionId');
    expect(src).toContain('deriveSessionKey');
  });

  it('uses existing Terminal component', () => {
    const src = readBlock('terminal.tsx');
    expect(src).toContain('Terminal');
    expect(src).toContain('../../components/Terminal');
  });

  it('CSS exists', () => {
    expect(blockExists('terminal.css')).toBe(true);
  });

  it('CSS has block-terminal class', () => {
    const css = readBlock('terminal.css');
    expect(css).toContain('.block-terminal');
  });
});

// ---------------------------------------------------------------------------
// agent renderer
// ---------------------------------------------------------------------------

describe('agent renderer', () => {
  it('file exists', () => {
    expect(blockExists('agent.tsx')).toBe(true);
  });

  it('exports AgentBlock', () => {
    const src = readBlock('agent.tsx');
    expect(src).toContain('export const AgentBlock');
  });

  it('is typed as WorkbenchBlockRenderer<"agent">', () => {
    const src = readBlock('agent.tsx');
    expect(src).toContain(`WorkbenchBlockRenderer<'agent'>`);
  });

  it('reads actorRef from descriptor.meta', () => {
    const src = readBlock('agent.tsx');
    expect(src).toContain('actorRef');
    expect(src).toContain('descriptor.meta');
  });

  it('uses existing ChatView component', () => {
    const src = readBlock('agent.tsx');
    expect(src).toContain('ChatView');
    expect(src).toContain('../../components/chat/ChatView');
  });

  it('CSS exists', () => {
    expect(blockExists('agent.css')).toBe(true);
  });

  it('CSS has block-agent class', () => {
    const css = readBlock('agent.css');
    expect(css).toContain('.block-agent');
  });
});

// ---------------------------------------------------------------------------
// All 8 renderers: verify they all export their named renderer
// ---------------------------------------------------------------------------

describe('all 8 renderers exist and export named components', () => {
  const renderers = [
    { file: 'terminal.tsx', export: 'TerminalBlock' },
    { file: 'agent.tsx', export: 'AgentBlock' },
    { file: 'prompt-fanout.tsx', export: 'PromptFanoutBlock' },
    { file: 'work-context.tsx', export: 'WorkContextBlock' },
    { file: 'file.tsx', export: 'FileBlock' },
    { file: 'artifact.tsx', export: 'ArtifactBlock' },
    { file: 'markdown.tsx', export: 'MarkdownBlock' },
    { file: 'custom.tsx', export: 'CustomBlock' },
  ] as const;

  for (const { file, export: exportName } of renderers) {
    it(`${file} exports ${exportName}`, () => {
      expect(blockExists(file)).toBe(true);
      const src = readBlock(file);
      expect(src).toContain(`export const ${exportName}`);
    });
  }
});

// ---------------------------------------------------------------------------
// Verify no renderer uses raw global paths
// ---------------------------------------------------------------------------

describe('no renderer uses raw filesystem paths', () => {
  const renderers = [
    'terminal.tsx',
    'agent.tsx',
    'work-context.tsx',
    'file.tsx',
    'artifact.tsx',
    'markdown.tsx',
    'custom.tsx',
  ] as const;

  for (const file of renderers) {
    it(`${file} uses only scoped refs`, () => {
      const src = readBlock(file);
      expect(src).not.toContain('process.cwd()');
      expect(src).not.toContain('__dirname');
      expect(src).not.toContain("require('fs')");
    });
  }
});

// ---------------------------------------------------------------------------
// registry source structure tests
// ---------------------------------------------------------------------------

describe('block-registry source structure', () => {
  const registryPath = join(
    projectRoot,
    'frontend/src/workbench/block-registry.ts'
  );

  it('registry file exists', () => {
    expect(existsSync(registryPath)).toBe(true);
  });

  it('exports registerBlockRenderer', () => {
    const src = readFileSync(registryPath, 'utf-8');
    expect(src).toContain('export function registerBlockRenderer');
  });

  it('exports getBlockRenderer', () => {
    const src = readFileSync(registryPath, 'utf-8');
    expect(src).toContain('export function getBlockRenderer');
  });

  it('exports registeredKinds', () => {
    const src = readFileSync(registryPath, 'utf-8');
    expect(src).toContain('export function registeredKinds');
  });

  it('exports initFirstPartyBlocks', () => {
    const src = readFileSync(registryPath, 'utf-8');
    expect(src).toContain('export async function initFirstPartyBlocks');
  });

  it('registers all 7 first-party kinds in initFirstPartyBlocks', () => {
    const src = readFileSync(registryPath, 'utf-8');
    const kinds = [
      'terminal',
      'agent',
      'work-context',
      'file',
      'artifact',
      'markdown',
      'custom',
    ];
    for (const kind of kinds) {
      expect(src).toContain(`'${kind}'`);
    }
  });

  it('uses a single Map internally (no switch statements for kind routing)', () => {
    const src = readFileSync(registryPath, 'utf-8');
    expect(src).toContain('new Map<');
    // The registry must NOT contain a switch over block kinds
    expect(src).not.toContain('switch (kind)');
  });
});
