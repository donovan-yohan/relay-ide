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

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');
const blocksDir = join(projectRoot, 'frontend/src/workbench/blocks');

function readBlock(name: string) {
  return readFileSync(join(blocksDir, name), 'utf-8');
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

  it('uses TanStack Query to load approved proposals', () => {
    const src = readBlock('custom.tsx');
    expect(src).toContain('useQuery');
    expect(src).toContain('fetchCustomBlockProposals');
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

  it('reads fileRef.id (not a raw path)', () => {
    const src = readBlock('file.tsx');
    expect(src).toContain('fileRef.id');
    expect(src).not.toContain('filePath');
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
// All 7 renderers: verify they all export their named renderer
// ---------------------------------------------------------------------------

describe('all 7 renderers exist and export named components', () => {
  const renderers = [
    { file: 'terminal.tsx', export: 'TerminalBlock' },
    { file: 'agent.tsx', export: 'AgentBlock' },
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
