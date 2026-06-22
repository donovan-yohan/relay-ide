import { describe, it, expect } from 'vitest';
import {
  EDITOR_SHORTCUTS,
  buildFilesReadCommand,
  buildFilesWriteCommand,
  toAbsoluteFilePath,
} from '../frontend/src/lib/editor-affordances.js';
import { commandSpec } from '../shared/cli-gateway-contract.js';

describe('editor-affordances: honest shortcut catalogue', () => {
  it('documents save as an active Mod-s binding', () => {
    const save = EDITOR_SHORTCUTS.find((s) => s.id === 'save');
    expect(save).toBeDefined();
    expect(save?.combo).toBe('mod+s');
    expect(save?.available).toBe(true);
  });

  it('does not claim in-file search works — marks it as a follow-up', () => {
    const find = EDITOR_SHORTCUTS.find((s) => s.id === 'find');
    expect(find).toBeDefined();
    expect(find?.available).toBe(false);
    expect(find?.note).toMatch(/follow-up/i);
  });

  it('every shortcut flagged available also carries a combo + description', () => {
    for (const shortcut of EDITOR_SHORTCUTS) {
      expect(shortcut.combo.length).toBeGreaterThan(0);
      expect(shortcut.description.length).toBeGreaterThan(0);
      if (!shortcut.available) expect(shortcut.note).toBeTruthy();
    }
  });
});

describe('editor-affordances: CLI command parity with the gateway contract', () => {
  it('builds the files.read command from the contract cli template', () => {
    const cmd = buildFilesReadCommand({
      sessionId: 'sess-1',
      path: '/repo/src/app.ts',
    });
    expect(cmd).toBe(
      'relay-ide v1 files read --session-id sess-1 --path /repo/src/app.ts --json'
    );
    // The flag skeleton must match the shipped contract so the copy affordance
    // can never drift from `relay-ide v1 files read`.
    const spec = commandSpec('files.read');
    for (const flag of ['--session-id', '--path', '--json']) {
      expect(spec.cli).toContain(flag);
      expect(cmd).toContain(flag);
    }
  });

  it('falls back to a placeholder session id when none is scoped', () => {
    const cmd = buildFilesReadCommand({ sessionId: null, path: '/repo/x.ts' });
    expect(cmd).toContain('--session-id <session-id>');
  });

  it('builds an overwrite-from-stdin files.write command', () => {
    const cmd = buildFilesWriteCommand({
      sessionId: 'sess-1',
      path: '/repo/src/app.ts',
    });
    expect(cmd).toBe(
      'relay-ide v1 files write --session-id sess-1 --path /repo/src/app.ts --mode overwrite --file - --json'
    );
    const spec = commandSpec('files.write');
    for (const flag of [
      '--session-id',
      '--path',
      '--mode',
      '--file',
      '--json',
    ]) {
      expect(spec.cli).toContain(flag);
      expect(cmd).toContain(flag);
    }
  });

  it('shell-quotes paths that contain spaces', () => {
    const cmd = buildFilesReadCommand({
      sessionId: 'sess-1',
      path: '/repo/my dir/app.ts',
    });
    expect(cmd).toContain("--path '/repo/my dir/app.ts'");
  });
});

describe('editor-affordances: toAbsoluteFilePath', () => {
  it('joins a relative path onto the workspace root', () => {
    expect(toAbsoluteFilePath('/repo', 'src/app.ts')).toBe('/repo/src/app.ts');
  });

  it('passes through an already-absolute path', () => {
    expect(toAbsoluteFilePath('/repo', '/etc/hosts')).toBe('/etc/hosts');
  });

  it('returns the relative path unchanged when the workspace root is empty', () => {
    // An evidence root with a null path passes '' — must not fabricate "/AGENTS.md".
    expect(toAbsoluteFilePath('', 'AGENTS.md')).toBe('AGENTS.md');
  });

  it('normalises a trailing workspace slash against a relative path', () => {
    expect(toAbsoluteFilePath('/repo/', 'src/app.ts')).toBe('/repo/src/app.ts');
  });
});
